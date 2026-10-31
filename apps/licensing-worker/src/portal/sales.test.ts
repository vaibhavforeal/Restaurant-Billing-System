import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMonths, DAY_MS, GRACE_MS } from "../dates.js";
import type { Env } from "../env.js";
import { getInstallation, latestLicense } from "../store.js";
import { activation, keyPair, send, testEnv, withSecret } from "../testing/harness.js";
import { as, signIn, type PortalClient } from "../testing/portal.js";
import { TEST_SECRET } from "../testing/secret.js";
import type { CustomerDetail, InstallationDetail, OrderDetail, OrderSummary } from "./api-types.js";

const T0 = Date.UTC(2026, 9, 10, 4, 30, 0);
const keys = keyPair();
const COUNTER = "77777777-7777-4777-8777-777777777777", OTHER_COUNTER = "88888888-8888-4888-8888-888888888888";
let env: Env;
let fingerprint: string;
let admin: PortalClient & { staff: { email: string } };
beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); fingerprint = await keys.fingerprint(); });
beforeEach(async () => {
  vi.setSystemTime(T0);
  env = testEnv(keys.privatePem);
  admin = await as(env, "admin", { name: "Asha" });
  await admin.ok("PUT", "/settings", {
    seller: { legalName: "MasalaPOS Technologies LLP", gstin: "27AAPFU0939F1ZV", address: "Baner Road", city: "Pune", stateCode: "27", pincode: "411045", email: "", phone: "" },
    invoice: { prefix: "FF", sac: "997331", gstRateBp: 1800, bankDetails: "", terms: "" }, prices: [], extraDevicePaise: 50_000, trialDays: 7,
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const newCustomer = (client: PortalClient, over: Record<string, unknown> = {}) => client.ok<{ customer: CustomerDetail }>("POST", "/customers", {
  businessName: "Spice Route", contactName: "Meera Joshi", phone: "98220 12345", email: "meera@spiceroute.in", gstin: "", address: "FC Road", city: "Pune",
  stateCode: "27", pincode: "411004", notes: "", ...over,
}).then((r) => r.customer);
const orderBody = (customerId: string, over: Record<string, unknown> = {}) => ({
  customerId, kind: "new", plan: "pro", termMonths: 12, outlets: 1, maxDevices: 5, modules: {}, pricePerOutletPaise: 1_200_000, discountPaise: 0,
  extras: [], installationIds: [], notes: "", ...over,
});
const newOrder = (client: PortalClient, customerId: string, over: Record<string, unknown> = {}) =>
  client.ok<{ order: OrderDetail }>("POST", "/orders", orderBody(customerId, over)).then((r) => r.order);
const enrol = (installationId: string, customerCode: string, orderCode: string) =>
  send(env, "POST", "/v1/enroll", { activation: activation(installationId, fingerprint), customerId: customerCode, orderId: orderCode }, withSecret());

describe("customers", () => {
  it("get a Customer ID and belong to the rep who added them; reps see only their own", async () => {
    const ritu = await as(env, "sales", { name: "Ritu" }), kabir = await as(env, "sales", { name: "Kabir" });
    const mine = await newCustomer(ritu);
    expect(mine.code).toMatch(/^FC-[0-9A-Z]{4}-[0-9A-Z]{3}$/);
    expect(mine.owner).toEqual({ id: ritu.staff.id, name: "Ritu" });
    await newCustomer(kabir, { businessName: "Bombay Bites" });
    expect((await ritu.ok<{ customers: Array<{ businessName: string }> }>("GET", "/customers")).customers.map((c) => c.businessName)).toEqual(["Spice Route"]);
    expect((await admin.ok<{ total: number }>("GET", "/customers")).total).toBe(2);
    expect((await kabir.call("GET", `/customers/${mine.id}`)).status).toBe(404);
    expect((await kabir.call("PATCH", `/customers/${mine.id}`, { businessName: "Taken" })).status).toBe(404);
    expect((await ritu.ok<{ customers: unknown[] }>("GET", `/customers?q=${encodeURIComponent(mine.code.toLowerCase())}`)).customers).toHaveLength(1);
    expect((await kabir.ok<{ hits: unknown[] }>("GET", `/search?q=${mine.code}`)).hits).toEqual([]);
    expect((await ritu.ok<{ hits: Array<{ kind: string; title: string }> }>("GET", "/search?q=spice")).hits).toEqual([expect.objectContaining({ kind: "customer", title: "Spice Route" })]);
  });

  it("checks the details and keeps the state in step with the GSTIN; only admins move a customer to another rep", async () => {
    const ritu = await as(env, "sales");
    const bad = await ritu.call("POST", "/customers", { ...orderBody(""), businessName: "X", contactName: "", phone: "", email: "", gstin: "29AAPFU0939F1ZV", address: "", city: "", stateCode: "27", pincode: "", notes: "" });
    expect(bad.status).toBe(400);
    const withGstin = await newCustomer(ritu, { gstin: "29aapfu0939f1zv", stateCode: "" });
    expect(withGstin).toMatchObject({ gstin: "29AAPFU0939F1ZV", stateCode: "29" });
    const kabir = await as(env, "sales", { name: "Kabir" });
    const fields = { businessName: "Spice Route", contactName: "", phone: "", email: "", gstin: "", address: "", city: "", stateCode: "27", pincode: "", notes: "" };
    expect((await ritu.call("PATCH", `/customers/${withGstin.id}`, { ...fields, ownerId: kabir.staff.id })).status).toBe(403);
    expect((await admin.ok<{ customer: CustomerDetail }>("PATCH", `/customers/${withGstin.id}`, { ...fields, ownerId: kabir.staff.id })).customer.owner?.name).toBe("Kabir");
    expect((await ritu.call("GET", `/customers/${withGstin.id}`)).status).toBe(404);
  });
});

describe("orders", () => {
  it("are priced per outlet with extra devices and extra lines, and taxed CGST and SGST within Maharashtra, IGST outside", async () => {
    const customer = await newCustomer(admin);
    const order = await newOrder(admin, customer.id, { outlets: 2, maxDevices: 7, discountPaise: 100_000, extras: [{ description: "On-site installation", sac: "998734", quantity: 1, unitPricePaise: 300_000 }] });
    expect(order).toMatchObject({ status: "draft", intraState: true, seatsUsed: 0, outlets: 2 });
    expect(order.lines.map((l) => [l.description, l.quantity, l.unitPricePaise, l.taxablePaise])).toEqual([
      ["MasalaPOS Pro licence, 1 year, per outlet", 2, 1_200_000, 2_300_000],
      ["Extra devices beyond the plan's 5, 1 year", 4, 50_000, 200_000],
      ["On-site installation", 1, 300_000, 300_000],
    ]);
    expect(order).toMatchObject({ subtotalPaise: 2_800_000, cgstPaise: 252_000, sgstPaise: 252_000, igstPaise: 0, taxPaise: 504_000, totalPaise: 3_304_000 });
    const karnataka = await newCustomer(admin, { businessName: "Udupi House", stateCode: "29" });
    const igst = await newOrder(admin, karnataka.id);
    expect(igst).toMatchObject({ intraState: false, igstPaise: 216_000, cgstPaise: 0, totalPaise: 1_416_000 });
  });

  it("are confirmed only with the seller and buyer states known, and are fixed once confirmed", async () => {
    const noState = await newCustomer(admin, { stateCode: "" });
    const draft = await newOrder(admin, noState.id);
    expect(draft.intraState).toBeNull();
    const refused = await admin.call("POST", `/orders/${draft.id}/confirm`);
    expect(await refused.json()).toMatchObject({ code: "buyer_state_missing" });
    const customer = await newCustomer(admin);
    const order = await newOrder(admin, customer.id);
    expect((await admin.ok<{ order: OrderDetail }>("PATCH", `/orders/${order.id}`, orderBody(customer.id, { outlets: 3 }))).order.lines[0]!.quantity).toBe(3);
    const confirmed = (await admin.ok<{ order: OrderDetail }>("POST", `/orders/${order.id}/confirm`)).order;
    expect(confirmed).toMatchObject({ status: "confirmed", totalPaise: 4_248_000 });
    expect((await admin.call("PATCH", `/orders/${order.id}`, orderBody(customer.id))).status).toBe(409);
    expect((await enrol(COUNTER, customer.code, order.code)).status).toBe(409);
  });

  it("a trial is ready at once, costs nothing and runs the trial length from settings", async () => {
    const ritu = await as(env, "sales");
    const customer = await newCustomer(ritu);
    const trial = await newOrder(ritu, customer.id, { kind: "trial", pricePerOutletPaise: 999 });
    expect(trial).toMatchObject({ status: "confirmed", termDays: 7, termMonths: null, lines: [], totalPaise: 0 });
    const res = await enrol(COUNTER, customer.code, trial.code);
    expect(res.status).toBe(200);
    expect(keys.claims((await res.json() as { license: string }).license)).toMatchObject({ trial: true, expiresAt: T0 + 7 * DAY_MS });
  });

  it("an order worth nothing is paid when confirmed", async () => {
    const customer = await newCustomer(admin);
    const free = await newOrder(admin, customer.id, { pricePerOutletPaise: 0 });
    expect((await admin.ok<{ order: OrderDetail }>("POST", `/orders/${free.id}/confirm`)).order).toMatchObject({ status: "paid", totalPaise: 0 });
    expect((await enrol(COUNTER, customer.code, free.code)).status).toBe(200);
  });

  it("on credit: an admin approves, the counter's licence ends on the credit date, and payment gives the full term", async () => {
    const ritu = await as(env, "sales");
    const customer = await newCustomer(ritu);
    const order = await newOrder(ritu, customer.id);
    await ritu.ok("POST", `/orders/${order.id}/confirm`);
    expect((await ritu.call("POST", `/orders/${order.id}/credit`, { until: T0 + 10 * DAY_MS })).status).toBe(403);
    await admin.ok("POST", `/orders/${order.id}/credit`, { until: T0 + 10 * DAY_MS });
    const res = await enrol(COUNTER, customer.code, order.code);
    expect(keys.claims((await res.json() as { license: string }).license)).toMatchObject({ expiresAt: T0 + 10 * DAY_MS });
    vi.setSystemTime(T0 + DAY_MS);
    // A day later the morning's session has ended.
    const later = await signIn(env, admin.staff);
    await later.ok("POST", `/orders/${order.id}/credit`, { until: T0 + 20 * DAY_MS });
    expect(await latestLicense(env.DB, COUNTER)).toMatchObject({ revision: 2, expiresAt: T0 + 20 * DAY_MS });
  });

  it("a renewal extends each chosen counter from its current end date with the order's plan, devices and modules", async () => {
    const customer = await newCustomer(admin);
    const first = await newOrder(admin, customer.id, { outlets: 2, pricePerOutletPaise: 0 });
    await admin.ok("POST", `/orders/${first.id}/confirm`);
    await enrol(COUNTER, customer.code, first.code);
    await enrol(OTHER_COUNTER, customer.code, first.code);
    const firstEnd = addMonths(T0, 12);
    vi.setSystemTime(T0 + 300 * DAY_MS);
    admin = Object.assign(await signIn(env, admin.staff), { staff: admin.staff });
    const other = await newCustomer(admin, { businessName: "Other" });
    expect((await admin.call("POST", "/orders", orderBody(other.id, { kind: "renewal", installationIds: [COUNTER] }))).status).toBe(400);
    const renewal = await newOrder(admin, customer.id, { kind: "renewal", plan: "basic", maxDevices: 2, modules: { kds: true }, installationIds: [COUNTER], pricePerOutletPaise: 0 });
    expect(renewal.renewalTargets.map((t) => t.id)).toEqual([COUNTER]);
    expect((await admin.ok<{ order: OrderDetail }>("POST", `/orders/${renewal.id}/confirm`)).order.status).toBe("paid");
    const licence = await latestLicense(env.DB, COUNTER);
    expect(licence).toMatchObject({ revision: 2, plan: "basic", expiresAt: addMonths(firstEnd, 12), graceUntil: addMonths(firstEnd, 12) + GRACE_MS });
    expect(keys.claims(licence!.envelope)).toMatchObject({ maxDevices: 2, orderCode: renewal.code, modules: expect.objectContaining({ kds: true }) });
    expect((await latestLicense(env.DB, OTHER_COUNTER))!.revision).toBe(1);
    // The counter picks the renewal up at its next check.
    const check = await send(env, "POST", "/v1/activate", activation(COUNTER, fingerprint, { ...held(licence!.envelope), currentRevision: 1 }), withSecret());
    expect((await check.json() as { license: string }).license).toBe(licence!.envelope);
  });

  it("lists by status with counts, and only admins cancel", async () => {
    const ritu = await as(env, "sales");
    const customer = await newCustomer(ritu);
    const a = await newOrder(ritu, customer.id);
    await newOrder(ritu, customer.id, { kind: "trial" });
    const list = await ritu.ok<{ orders: OrderSummary[]; counts: Record<string, number> }>("GET", "/orders?status=draft");
    expect(list.orders.map((o) => o.code)).toEqual([a.code]);
    expect(list.counts).toEqual({ draft: 1, confirmed: 1 });
    expect((await ritu.call("POST", `/orders/${a.id}/cancel`, { reason: "Duplicate" })).status).toBe(403);
    expect((await admin.ok<{ order: OrderDetail }>("POST", `/orders/${a.id}/cancel`, { reason: "Duplicate" })).order.status).toBe("cancelled");
    expect((await enrol(COUNTER, customer.code, a.code)).status).toBe(409);
  });
});

describe("counters", () => {
  async function enrolledCounter() {
    const customer = await newCustomer(admin);
    const order = await newOrder(admin, customer.id, { outlets: 1, pricePerOutletPaise: 0 });
    await admin.ok("POST", `/orders/${order.id}/confirm`);
    expect((await enrol(COUNTER, customer.code, order.code)).status).toBe(200);
    return { customer, order };
  }

  it("module switches sign the next revision; a stale page is refused", async () => {
    await enrolledCounter();
    const { installation } = await admin.ok<{ installation: InstallationDetail }>("GET", `/installations/${COUNTER}`);
    expect(installation.modules.find((m) => m.id === "kds")).toMatchObject({ inPlan: true, override: null, allowed: true });
    vi.setSystemTime(T0 + 60_000);
    const res = await admin.ok<{ installation: InstallationDetail; issuedRevision: number }>("PATCH", `/installations/${COUNTER}/modules`, { modules: { kds: false }, expectedUpdatedAt: installation.modulesUpdatedAt });
    expect(res.issuedRevision).toBe(2);
    expect(keys.claims((await latestLicense(env.DB, COUNTER))!.envelope).modules.kds).toBe(false);
    expect(res.installation.moduleEvents[0]).toMatchObject({ moduleId: "kds", allowed: false, actorName: "Asha" });
    expect((await admin.call("PATCH", `/installations/${COUNTER}/modules`, { modules: { crm: false }, expectedUpdatedAt: installation.modulesUpdatedAt })).status).toBe(409);
  });

  it("an admin changes devices or the end date with a reason, and later licences keep the devices", async () => {
    await enrolledCounter();
    const support = await as(env, "support");
    expect((await support.call("POST", `/installations/${COUNTER}/licence`, { maxDevices: 9, note: "Bought 4 more" })).status).toBe(403);
    expect((await admin.call("POST", `/installations/${COUNTER}/licence`, { maxDevices: 9, note: "" })).status).toBe(400);
    await admin.ok("POST", `/installations/${COUNTER}/licence`, { maxDevices: 9, expiresAt: T0 + 400 * DAY_MS, note: "Bought 4 more" });
    expect(keys.claims((await latestLicense(env.DB, COUNTER))!.envelope)).toMatchObject({ maxDevices: 9, expiresAt: T0 + 400 * DAY_MS, graceUntil: T0 + 400 * DAY_MS + GRACE_MS });
    const { installation } = await admin.ok<{ installation: InstallationDetail }>("GET", `/installations/${COUNTER}`);
    await admin.ok("PATCH", `/installations/${COUNTER}/modules`, { modules: { crm: false }, expectedUpdatedAt: installation.modulesUpdatedAt });
    expect(keys.claims((await latestLicense(env.DB, COUNTER))!.envelope).maxDevices).toBe(9);
  });

  it("releasing a seat that another request has just released does not count it twice", async () => {
    const { order } = await enrolledCounter();
    const support = await as(env, "support");
    const hooked = env.DB as unknown as { batch: Env["DB"]["batch"] };
    const real = hooked.batch.bind(env.DB);
    hooked.batch = async (statements) => {
      if (statements.some((s) => (s as unknown as { sql: string }).sql.includes("seats_used = seats_used - 1"))) {
        hooked.batch = real;
        await support.call("POST", `/installations/${COUNTER}/release`); // the other staff member's click lands first
      }
      return real(statements);
    };
    expect((await support.call("POST", `/installations/${COUNTER}/release`)).status).toBe(200);
    expect(await env.DB.prepare(`SELECT seats_used AS used FROM orders WHERE id = ?`).bind(order.id).first()).toEqual({ used: 0 });
  });

  it("support releases a seat for a reinstall and resets pairing; the new computer then activates", async () => {
    const { customer, order } = await enrolledCounter();
    const support = await as(env, "support");
    expect((await enrol(OTHER_COUNTER, customer.code, order.code)).status).toBe(409);
    const released = await support.ok<{ installation: InstallationDetail }>("POST", `/installations/${COUNTER}/release`);
    expect(released.installation).toMatchObject({ enrolled: false, order: null });
    expect((await enrol(OTHER_COUNTER, customer.code, order.code)).status).toBe(200);
    expect((await support.ok<{ installation: InstallationDetail }>("POST", `/installations/${COUNTER}/reset-pairing`)).installation.paired).toBe(false);
    expect((await getInstallation(env.DB, COUNTER))!.secretHash).toBeNull();
    const file = await support.ok<{ license: string; fileName: string }>("GET", `/installations/${OTHER_COUNTER}/licence`);
    expect(file.fileName).toMatch(/^masalapos-licence-88888888-r1\.txt$/);
    expect(keys.claims(file.license).installationId).toBe(OTHER_COUNTER);
  });

  it("an admin moves a trial counter onto the paid order, and activates an offline counter from its request file", async () => {
    const customer = await newCustomer(admin);
    const trial = await newOrder(admin, customer.id, { kind: "trial" });
    await enrol(COUNTER, customer.code, trial.code);
    const paid = await newOrder(admin, customer.id, { outlets: 2, pricePerOutletPaise: 0 });
    expect((await admin.call("POST", `/installations/${COUNTER}/move`, { orderId: paid.id })).status).toBe(409);
    await admin.ok("POST", `/orders/${paid.id}/confirm`);
    const moved = await admin.ok<{ installation: InstallationDetail }>("POST", `/installations/${COUNTER}/move`, { orderId: paid.id });
    expect(moved.installation).toMatchObject({ order: { id: paid.id }, licence: { trial: false, revision: 2, delivered: false } });
    const request = JSON.stringify(activation(OTHER_COUNTER, fingerprint, { outletName: "Spice Route, Kothrud" }));
    const offline = await admin.ok<{ license: string }>("POST", `/orders/${paid.id}/offline-licence`, { activationRequest: request });
    expect(keys.claims(offline.license)).toMatchObject({ installationId: OTHER_COUNTER, orderCode: paid.code });
    expect(await getInstallation(env.DB, OTHER_COUNTER)).toMatchObject({ outletName: "Spice Route, Kothrud", secretHash: null, revisionFloor: 1 });
    // Online later, the counter claims its row with its secret and is up to date.
    const check = await send(env, "POST", "/v1/activate", activation(OTHER_COUNTER, fingerprint, { ...held(offline.license), currentRevision: 1 }), withSecret({}, TEST_SECRET));
    expect(await check.json()).toEqual({ license: null, enrolled: true });
  });
});

describe("who may do what", () => {
  it("every role against the sales endpoints: allowed, refused (403), or not even shown (404)", async () => {
    const ritu = await as(env, "sales"), kabir = await as(env, "sales"), accounts = await as(env, "accounts"), support = await as(env, "support");
    const customer = await newCustomer(ritu);
    const order = await newOrder(ritu, customer.id);
    const fields = { businessName: "Spice Route", contactName: "", phone: "", email: "", gstin: "", address: "", city: "", stateCode: "27", pincode: "", notes: "" };
    const checks: Array<[string, string, unknown, Record<string, number>]> = [
      ["GET", `/customers/${customer.id}`, undefined, { admin: 200, ritu: 200, kabir: 404, accounts: 200, support: 200 }],
      ["PATCH", `/customers/${customer.id}`, fields, { admin: 200, ritu: 200, kabir: 404, accounts: 403, support: 403 }],
      ["POST", "/customers", fields, { admin: 201, ritu: 201, kabir: 201, accounts: 403, support: 403 }],
      ["GET", `/orders/${order.id}`, undefined, { admin: 200, ritu: 200, kabir: 404, accounts: 200, support: 200 }],
      ["POST", "/orders", orderBody(customer.id), { admin: 201, ritu: 201, kabir: 404, accounts: 403, support: 403 }],
      ["PATCH", `/orders/${order.id}`, orderBody(customer.id), { admin: 200, ritu: 200, kabir: 404, accounts: 403, support: 403 }],
      ["GET", `/customers/${customer.id}/activity`, undefined, { admin: 200, ritu: 200, kabir: 404, accounts: 200, support: 200 }],
    ];
    const clients: Record<string, PortalClient> = { admin, ritu, kabir, accounts, support };
    for (const [method, url, body, expected] of checks) {
      for (const [name, client] of Object.entries(clients)) {
        expect([method, url, name, (await client.call(method, url, body)).status]).toEqual([method, url, name, expected[name]]);
      }
    }
  });
});

/** The identifiers a counter holding this licence reports. */
function held(envelope: string) {
  const { licenseId, organizationId, outletId } = keys.claims(envelope);
  return { licenseId, organizationId, outletId };
}
