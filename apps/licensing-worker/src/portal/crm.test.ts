import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMonths, DAY_MS } from "../dates.js";
import type { Env } from "../env.js";
import { activation, keyPair, send, testEnv, withSecret } from "../testing/harness.js";
import { as, signIn, type PortalClient } from "../testing/portal.js";
import type { CustomerDetail, FollowUp, HomeData, LeadDetail, LeadSummary, OrderDetail, RenewalRow, ReportData, TicketDetail, TicketSummary } from "./api-types.js";

// 10:00 IST on 30 October 2026.
const T0 = Date.UTC(2026, 9, 30, 4, 30, 0);
const keys = keyPair();
let env: Env;
let fingerprint: string;
let admin: PortalClient & { staff: { id: string; email: string } };
beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); fingerprint = await keys.fingerprint(); });
beforeEach(async () => {
  vi.setSystemTime(T0);
  env = testEnv(keys.privatePem);
  admin = await as(env, "admin", { name: "Asha" });
  await admin.ok("PUT", "/settings", {
    seller: { legalName: "ForkFlow Technologies LLP", gstin: "", address: "", city: "Pune", stateCode: "27", pincode: "", email: "", phone: "" },
    invoice: { prefix: "FF", sac: "997331", gstRateBp: 1800, bankDetails: "", terms: "" }, prices: [], extraDevicePaise: 0, trialDays: 7,
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const leadBody = (over: Record<string, unknown> = {}) => ({
  businessName: "Chai Point Baner", contactName: "Rohit", phone: "98500 11223", email: "", city: "Pune", stateCode: "27", source: "walk_in",
  expectedPlan: "pro", expectedOutlets: 2, estimatedValuePaise: 3_000_000, notes: "", ...over,
});
const customer = (client: PortalClient, name = "Spice Route") => client.ok<{ customer: CustomerDetail }>("POST", "/customers", {
  businessName: name, contactName: "", phone: "98220 12345", email: "", gstin: "", address: "", city: "Pune", stateCode: "27", pincode: "", notes: "",
}).then((r) => r.customer);
const orderFor = async (client: PortalClient, c: CustomerDetail, over: Record<string, unknown> = {}) => {
  const { order } = await client.ok<{ order: OrderDetail }>("POST", "/orders", { customerId: c.id, kind: "new", plan: "pro", termMonths: 12, outlets: 1, maxDevices: 5, modules: {},
    pricePerOutletPaise: 0, discountPaise: 0, extras: [], installationIds: [], notes: "", ...over });
  return order.status === "draft" ? (await client.ok<{ order: OrderDetail }>("POST", `/orders/${order.id}/confirm`)).order : order;
};
const enrol = (id: string, c: CustomerDetail, o: OrderDetail) =>
  send(env, "POST", "/v1/enroll", { activation: activation(id, fingerprint), customerId: c.code, orderId: o.code }, withSecret());

describe("leads", () => {
  it("belong to the rep who adds them, move through the pipeline, and a lost lead needs a reason", async () => {
    const ritu = await as(env, "sales", { name: "Ritu" }), kabir = await as(env, "sales", { name: "Kabir" });
    const { lead } = await ritu.ok<{ lead: LeadDetail }>("POST", "/leads", leadBody());
    expect(lead).toMatchObject({ stage: "new", owner: { name: "Ritu" } });
    expect((await kabir.call("GET", `/leads/${lead.id}`)).status).toBe(404);
    expect((await (await as(env, "accounts")).call("GET", "/leads")).status).toBe(403);
    await ritu.ok("POST", `/leads/${lead.id}/stage`, { stage: "demo_scheduled" });
    expect((await ritu.call("POST", `/leads/${lead.id}/stage`, { stage: "lost" })).status).toBe(400);
    const list = await ritu.ok<{ leads: LeadSummary[]; counts: Record<string, number> }>("GET", "/leads?stage=open");
    expect(list.counts).toEqual({ demo_scheduled: 1 });
    expect(list.leads.map((l) => l.businessName)).toEqual(["Chai Point Baner"]);
    const lost = await ritu.ok<{ lead: LeadDetail }>("POST", `/leads/${lead.id}/stage`, { stage: "lost", lostReason: "Went with another POS" });
    expect(lost.lead).toMatchObject({ stage: "lost", lostReason: "Went with another POS", closedAt: T0 });
  });

  it("convert into a customer with a Customer ID, keeping the rep and the open follow-ups", async () => {
    const ritu = await as(env, "sales", { name: "Ritu" });
    const { lead } = await ritu.ok<{ lead: LeadDetail }>("POST", "/leads", leadBody());
    await ritu.ok("POST", "/follow-ups", { leadId: lead.id, kind: "demo", dueAt: T0 + DAY_MS, note: "Demo at the outlet" });
    const converted = await ritu.ok<{ customerId: string; code: string }>("POST", `/leads/${lead.id}/convert`);
    expect(converted.code).toMatch(/^FC-/);
    const { customer: c } = await ritu.ok<{ customer: CustomerDetail }>("GET", `/customers/${converted.customerId}`);
    expect(c).toMatchObject({ businessName: "Chai Point Baner", phone: "98500 11223", owner: { name: "Ritu" } });
    expect((await ritu.ok<{ lead: LeadDetail }>("GET", `/leads/${lead.id}`)).lead).toMatchObject({ stage: "won", customerId: c.id, followUps: [] });
    const { followUps } = await ritu.ok<{ followUps: FollowUp[] }>("GET", `/customers/${c.id}/follow-ups`);
    expect(followUps.map((f) => [f.note, f.customer?.name])).toEqual([["Demo at the outlet", "Chai Point Baner"]]);
    expect((await ritu.call("POST", `/leads/${lead.id}/convert`)).status).toBe(409);
  });
});

describe("follow-ups", () => {
  it("are listed for their owner, overdue first, and are done or moved with an outcome", async () => {
    const ritu = await as(env, "sales");
    const c = await customer(ritu);
    await ritu.ok("POST", "/follow-ups", { customerId: c.id, kind: "call", dueAt: T0 + 2 * DAY_MS, note: "Ask about the second outlet" });
    const { followUp } = await ritu.ok<{ followUp: FollowUp }>("POST", "/follow-ups", { customerId: c.id, kind: "payment", dueAt: T0 - DAY_MS, note: "Chase the payment" });
    expect((await ritu.ok<{ followUps: FollowUp[] }>("GET", "/follow-ups")).followUps.map((f) => f.note)).toEqual(["Chase the payment", "Ask about the second outlet"]);
    expect((await admin.ok<{ followUps: FollowUp[] }>("GET", "/follow-ups")).followUps).toEqual([]);
    expect((await admin.ok<{ followUps: FollowUp[] }>("GET", "/follow-ups?ownerId=all")).followUps).toHaveLength(2);
    const done = await ritu.ok<{ followUp: FollowUp }>("PATCH", `/follow-ups/${followUp.id}`, { status: "done", outcome: "Paying by NEFT on Monday" });
    expect(done.followUp).toMatchObject({ status: "done", outcome: "Paying by NEFT on Monday", doneAt: T0 });
    const kabir = await as(env, "sales");
    expect((await kabir.call("PATCH", `/follow-ups/${followUp.id}`, { status: "open" })).status).toBe(404);
    expect((await kabir.call("POST", "/follow-ups", { customerId: c.id, kind: "call", dueAt: T0, note: "x" })).status).toBe(404);
  });

  it("the Done list includes dropped follow-ups, and the activity log's Follow-ups filter finds every follow-up row", async () => {
    const ritu = await as(env, "sales");
    const c = await customer(ritu);
    const make = async (kind: string, note: string) => (await ritu.ok<{ followUp: FollowUp }>("POST", "/follow-ups", { customerId: c.id, kind, dueAt: T0 + DAY_MS, note })).followUp;
    const call = await make("call", "Call back"), demo = await make("demo", "Demo");
    await ritu.ok("PATCH", `/follow-ups/${call.id}`, { status: "done", outcome: "Spoke to the owner" });
    await ritu.ok("PATCH", `/follow-ups/${demo.id}`, { status: "cancelled" });
    const done = await ritu.ok<{ followUps: FollowUp[] }>("GET", "/follow-ups?status=done");
    expect(done.followUps.map((f) => [f.note, f.status]).sort()).toEqual([["Call back", "done"], ["Demo", "cancelled"]]);
    expect((await ritu.ok<{ followUps: FollowUp[] }>("GET", "/follow-ups")).followUps).toEqual([]);
    const log = await admin.ok<{ entries: Array<{ action: string }> }>("GET", "/activity?entityType=followup");
    expect(log.entries.map((e) => e.action).sort()).toEqual(["followup.cancelled", "followup.created", "followup.created", "followup.done"]);
    // The same rows still list under the customer they are about.
    const about = await admin.ok<{ entries: Array<{ action: string }> }>("GET", "/activity?entityType=customer");
    expect(about.entries.map((e) => e.action)).toContain("followup.done");
  });
});

describe("tickets", () => {
  it("are numbered from T-1001, worked by support, and a rep only reads their own customers' tickets", async () => {
    const ritu = await as(env, "sales"), neha = await as(env, "support", { name: "Neha" });
    const c = await customer(ritu);
    const { ticket } = await neha.ok<{ ticket: TicketDetail }>("POST", "/tickets", { customerId: c.id, installationId: null, subject: "KOT printer prints blank",
      description: "Since this morning", category: "printing", priority: "high", assigneeId: neha.staff.id });
    expect(ticket).toMatchObject({ number: 1001, status: "open", assignee: { name: "Neha" } });
    const second = await neha.ok<{ ticket: TicketDetail }>("POST", "/tickets", { customerId: c.id, installationId: null, subject: "Needs GST report training", description: "",
      category: "training", priority: "urgent", assigneeId: null });
    expect(second.ticket.number).toBe(1002);
    const commented = await neha.ok<{ ticket: TicketDetail }>("POST", `/tickets/${ticket.id}/comments`, { body: "Asked them to update the printer driver." });
    expect(commented.ticket).toMatchObject({ status: "in_progress", comments: [expect.objectContaining({ body: "Asked them to update the printer driver.", author: expect.objectContaining({ name: "Neha" }) })] });
    vi.setSystemTime(T0 + 90 * 60_000);
    const resolved = await neha.ok<{ ticket: TicketDetail }>("PATCH", `/tickets/${ticket.id}`, { status: "resolved" });
    expect(resolved.ticket.resolvedAt).toBe(T0 + 90 * 60_000);
    const active = await ritu.ok<{ tickets: TicketSummary[]; counts: Record<string, number> }>("GET", "/tickets");
    expect(active.tickets.map((t) => t.number)).toEqual([1002]);
    expect(active.counts).toEqual({ open: 1, resolved: 1 });
    expect((await ritu.call("POST", `/tickets/${ticket.id}/comments`, { body: "x" })).status).toBe(403);
    expect((await (await as(env, "sales")).call("GET", `/tickets/${ticket.id}`)).status).toBe(404);
    expect((await neha.ok<{ hits: Array<{ kind: string }> }>("GET", "/search?q=T-1001")).hits).toEqual([expect.objectContaining({ kind: "ticket" })]);
  });
});

describe("renewals, home and reports", () => {
  it("list counters by how soon their licence ends, and the home screen counts what needs doing", async () => {
    const ritu = await as(env, "sales");
    const c = await customer(ritu);
    const shortOrder = await orderFor(ritu, c, { termMonths: 1, outlets: 1 });
    const yearOrder = await orderFor(ritu, c, { outlets: 1 });
    const trial = await orderFor(ritu, c, { kind: "trial" });
    await enrol("11111111-1111-4111-8111-111111111111", c, shortOrder);
    await enrol("22222222-2222-4222-8222-222222222222", c, yearOrder);
    await enrol("33333333-3333-4333-8333-333333333333", c, trial);
    const due = await ritu.ok<{ renewals: RenewalRow[]; counts: Record<string, number> }>("GET", "/renewals?window=60");
    expect(due.renewals.map((r) => [r.installation.id.slice(0, 1), r.installation.licence?.expiresAt])).toEqual([["1", addMonths(T0, 1)]]);
    expect(due.counts).toMatchObject({ "7": 0, "30": 0, "60": 1, expired: 0, trials: 1 });
    const { order: renewal } = await ritu.ok<{ order: OrderDetail }>("POST", "/orders", { customerId: c.id, kind: "renewal", plan: "pro", termMonths: 12, outlets: 0, maxDevices: 5,
      modules: {}, pricePerOutletPaise: 900_000, discountPaise: 0, extras: [], installationIds: ["11111111-1111-4111-8111-111111111111"], notes: "" });
    expect((await ritu.ok<{ renewals: RenewalRow[] }>("GET", "/renewals?window=60")).renewals[0]!.openRenewal).toMatchObject({ code: renewal.code, status: "draft" });
    await ritu.ok("POST", "/follow-ups", { customerId: c.id, kind: "renewal", dueAt: T0 - 3_600_000, note: "Call about renewing" });
    await ritu.ok("POST", `/orders/${renewal.id}/confirm`);
    const home = await ritu.ok<HomeData>("GET", "/home");
    expect(home).toMatchObject({ followUps: { overdue: 1, dueToday: 0 }, orders: { waiting: 1, owedPaise: 1_062_000 }, renewals: { due30: 0 }, leads: { open: 0 }, tickets: { open: 0 } });
    expect(home.followUps.items.map((f) => f.note)).toEqual(["Call about renewing"]);
    vi.setSystemTime(addMonths(T0, 1) + DAY_MS);
    const later = await signIn(env, ritu.staff);
    expect((await later.ok<{ counts: Record<string, number> }>("GET", "/renewals")).counts).toMatchObject({ expired: 1, trials: 0 });
  });

  it("report the money, the pipeline, renewals, trials and support for the period, a rep seeing only theirs", async () => {
    const ritu = await as(env, "sales", { name: "Ritu" }), kabir = await as(env, "sales", { name: "Kabir" }), accounts = await as(env, "accounts");
    const mine = await customer(ritu, "Spice Route"), theirs = await customer(kabir, "Udupi Grand");
    // Spice Route tried ForkFlow for a week before buying.
    vi.setSystemTime(T0 - 7 * DAY_MS);
    await orderFor(await signIn(env, ritu.staff), mine, { kind: "trial" });
    vi.setSystemTime(T0);
    for (const [client, c] of [[ritu, mine], [kabir, theirs]] as const) {
      const order = await orderFor(client, c, { pricePerOutletPaise: 1_000_000 });
      await accounts.ok("POST", `/orders/${order.id}/payments`, { amountPaise: order.totalPaise, method: "upi", reference: "", receivedAt: T0, note: "" });
    }
    const { lead } = await ritu.ok<{ lead: LeadDetail }>("POST", "/leads", leadBody());
    await ritu.ok("POST", `/leads/${lead.id}/convert`);
    await ritu.ok("POST", "/leads", leadBody({ businessName: "Second lead", source: "referral" }));
    const all = await admin.ok<ReportData>("GET", "/reports");
    expect(all.revenueByMonth).toHaveLength(12);
    expect(all.revenueByMonth.at(-1)).toEqual({ month: "2026-10", paise: 2_360_000 });
    expect(all.revenueByPlan).toEqual([{ plan: "pro", paise: 2_360_000, orders: 2 }, { plan: "basic", paise: 0, orders: 0 }]);
    expect(all.funnel.filter((f) => f.count)).toEqual([{ stage: "new", count: 1 }, { stage: "won", count: 1 }]);
    expect(all.sources).toEqual([{ source: "walk_in", leads: 1, won: 1 }, { source: "referral", leads: 1, won: 0 }]);
    expect(all.reps.map((r) => [r.rep.name, r.ordersPaid, r.revenuePaise])).toEqual([["Kabir", 1, 1_180_000], ["Ritu", 1, 1_180_000], ["Asha", 0, 0]]);
    expect(all.trials).toEqual({ started: 1, converted: 1 });
    const own = await ritu.ok<ReportData>("GET", "/reports");
    expect(own.revenueByMonth.at(-1)!.paise).toBe(1_180_000);
    expect(own.reps.map((r) => r.rep.name)).toEqual(["Ritu"]);
    expect((await admin.call("GET", `/reports?from=${T0}&to=${T0 - 1}`)).status).toBe(400);
  });
});
