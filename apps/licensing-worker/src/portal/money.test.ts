import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { addMonths, DAY_MS } from "../dates.js";
import type { Env } from "../env.js";
import { latestLicense } from "../store.js";
import { activation, keyPair, send, testEnv, withSecret } from "../testing/harness.js";
import { as, signIn, type PortalClient } from "../testing/portal.js";
import type { CustomerDetail, InvoiceDetail, InvoiceSummary, OrderDetail } from "./api-types.js";
import { financialYear, numberInWords, rupeesInWords } from "./words.js";

// 10:00 IST on 30 October 2026.
const T0 = Date.UTC(2026, 9, 30, 4, 30, 0);
const keys = keyPair();
const COUNTER = "77777777-7777-4777-8777-777777777777", OTHER = "88888888-8888-4888-8888-888888888888";
let env: Env;
let fingerprint: string;
let admin: PortalClient & { staff: { email: string } };
let accounts: PortalClient & { staff: { email: string } };
let razorpay: Array<{ url: string; body: Record<string, unknown> | null }>;
let razorpayReply: (url: string) => Response;
beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); fingerprint = await keys.fingerprint(); });
beforeEach(async () => {
  vi.setSystemTime(T0);
  env = testEnv(keys.privatePem);
  razorpay = [];
  let n = 0;
  razorpayReply = (url) => url.endsWith("/cancel") ? new Response("{}") : new Response(JSON.stringify({ id: `plink_Test${++n}abc`, short_url: `https://rzp.io/i/test${n}`, status: "created" }));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    razorpay.push({ url, body: init.body ? JSON.parse(init.body as string) : null });
    return razorpayReply(url);
  });
  admin = await as(env, "admin", { name: "Asha" });
  accounts = await as(env, "accounts", { name: "Imran" });
  await admin.ok("PUT", "/settings", {
    seller: { legalName: "ForkFlow Technologies LLP", gstin: "27AAPFU0939F1ZV", address: "Baner Road", city: "Pune", stateCode: "27", pincode: "411045", email: "accounts@forkflow.in", phone: "" },
    invoice: { prefix: "FF", sac: "997331", gstRateBp: 1800, bankDetails: "HDFC Bank, A/c 5020001234", terms: "Due in 15 days." }, prices: [], extraDevicePaise: 0, trialDays: 7,
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function confirmedOrder(over: Record<string, unknown> = {}, customerOver: Record<string, unknown> = {}) {
  const { customer } = await admin.ok<{ customer: CustomerDetail }>("POST", "/customers", {
    businessName: "Spice Route", contactName: "Meera", phone: "98220 12345", email: "meera@spiceroute.in", gstin: "27AAKFS3412M1Z9", address: "FC Road", city: "Pune",
    stateCode: "", pincode: "411004", notes: "", ...customerOver,
  });
  const { order } = await admin.ok<{ order: OrderDetail }>("POST", "/orders", {
    customerId: customer.id, kind: "new", plan: "pro", termMonths: 12, outlets: 1, maxDevices: 5, modules: {}, pricePerOutletPaise: 1_000_000, discountPaise: 0,
    extras: [], installationIds: [], notes: "", ...over,
  });
  return { customer, order: (await admin.ok<{ order: OrderDetail }>("POST", `/orders/${order.id}/confirm`)).order };
}
const pay = (client: PortalClient, orderId: string, amountPaise: number, over: Record<string, unknown> = {}) =>
  client.call("POST", `/orders/${orderId}/payments`, { amountPaise, method: "upi", reference: "UPI-4411", receivedAt: Date.now(), note: "", ...over });
const enrol = (installationId: string, customer: CustomerDetail, order: OrderDetail) =>
  send(env, "POST", "/v1/enroll", { activation: activation(installationId, fingerprint), customerId: customer.code, orderId: order.code }, withSecret());
const invoices = (client: PortalClient = admin) => client.ok<{ invoices: InvoiceSummary[] }>("GET", "/invoices").then((r) => r.invoices);
const webhook = (event: string, eventId: string, linkId: string, payment?: { id: string; amount: number }) => {
  const body = JSON.stringify({ event, payload: { payment_link: { entity: { id: linkId, status: event.slice("payment_link.".length) } }, ...(payment ? { payment: { entity: { ...payment, status: "captured", method: "upi" } } } : {}) } });
  return send(env, "POST", "/webhooks/razorpay", body, { "x-razorpay-signature": createHmac("sha256", "whsec").update(body).digest("hex"), "x-razorpay-event-id": eventId });
};

describe("offline payments", () => {
  it("a part payment waits; the payment that completes it marks the order paid and issues its tax invoice", async () => {
    const { order } = await confirmedOrder();
    expect(order.totalPaise).toBe(1_180_000);
    expect((await pay(accounts, order.id, 500_000)).status).toBe(201);
    let detail = (await admin.ok<{ order: OrderDetail }>("GET", `/orders/${order.id}`)).order;
    expect(detail).toMatchObject({ status: "confirmed", paidPaise: 500_000, invoices: [] });
    detail = (await (await pay(accounts, order.id, 680_000)).json() as { order: OrderDetail }).order;
    expect(detail).toMatchObject({ status: "paid", paidPaise: 1_180_000 });
    expect(detail.invoices).toEqual([expect.objectContaining({ number: "FF/26-27/00001", totalPaise: 1_180_000, cancelledAt: null })]);
    expect((await pay(accounts, order.id, 100)).status).toBe(409);
  });

  it("only accounts and admins record payments, and never on a draft or a trial", async () => {
    const { order } = await confirmedOrder();
    for (const role of ["sales", "support"] as const) expect((await pay(await as(env, role), order.id, 100)).status).toBe(403);
    expect((await pay(admin, order.id, 100)).status).toBe(201);
  });

  it("a cheque counts once it clears; a bounced cheque never does", async () => {
    const { order } = await confirmedOrder();
    const recorded = (await (await pay(accounts, order.id, 1_180_000, { method: "cheque", reference: "Chq 004512", pending: true })).json() as { order: OrderDetail }).order;
    expect(recorded).toMatchObject({ status: "confirmed", paidPaise: 0 });
    const cheque = recorded.payments[0]!;
    expect(cheque.status).toBe("pending");
    const bounced = await accounts.ok<{ order: OrderDetail }>("POST", `/payments/${cheque.id}/status`, { status: "bounced" });
    expect(bounced.order.status).toBe("confirmed");
    expect((await accounts.call("POST", `/payments/${cheque.id}/status`, { status: "cleared" })).status).toBe(409);
    const again = (await (await pay(accounts, order.id, 1_180_000, { method: "cheque", pending: true })).json() as { order: OrderDetail }).order;
    const cleared = await accounts.ok<{ order: OrderDetail }>("POST", `/payments/${again.payments[1]!.id}/status`, { status: "cleared" });
    expect(cleared.order).toMatchObject({ status: "paid", paidPaise: 1_180_000 });
  });

  it("paying an order that was on credit gives its counter the full term from activation", async () => {
    const { customer, order } = await confirmedOrder();
    await admin.ok("POST", `/orders/${order.id}/credit`, { until: T0 + 10 * DAY_MS });
    await enrol(COUNTER, customer, order);
    expect((await latestLicense(env.DB, COUNTER))!.expiresAt).toBe(T0 + 10 * DAY_MS);
    await pay(accounts, order.id, 1_180_000);
    expect(await latestLicense(env.DB, COUNTER)).toMatchObject({ revision: 2, expiresAt: addMonths(T0, 12) });
  });
});

describe("GST invoices", () => {
  it("number without gaps within a financial year and restart in April, in India time", async () => {
    const first = await confirmedOrder();
    await pay(accounts, first.order.id, 1_180_000);
    // 23:59 IST on 31 March 2027 is still 2026-27; a minute later is 2027-28.
    vi.setSystemTime(Date.UTC(2027, 2, 31, 18, 29));
    admin = Object.assign(await signIn(env, admin.staff), { staff: admin.staff }); accounts = Object.assign(await signIn(env, accounts.staff), { staff: accounts.staff });
    const second = await confirmedOrder();
    await pay(accounts, second.order.id, 1_180_000);
    vi.setSystemTime(Date.UTC(2027, 2, 31, 18, 31));
    const third = await confirmedOrder();
    await pay(accounts, third.order.id, 1_180_000);
    expect((await invoices()).map((i) => i.number)).toEqual(["FF/27-28/00001", "FF/26-27/00002", "FF/26-27/00001"]);
    expect([financialYear(Date.UTC(2027, 2, 31, 18, 29)), financialYear(Date.UTC(2027, 2, 31, 18, 31)), financialYear(Date.UTC(2027, 0, 5))]).toEqual(["26-27", "27-28", "26-27"]);
  });

  it("copy the seller, buyer and lines as they were, with CGST and SGST or IGST and the amount in words", async () => {
    const { order } = await confirmedOrder({ outlets: 2, discountPaise: 150_000, extras: [{ description: "Training", sac: "999293", quantity: 1, unitPricePaise: 250_000 }] });
    await pay(accounts, order.id, order.totalPaise);
    const [summary] = await invoices();
    const { invoice } = await admin.ok<{ invoice: InvoiceDetail }>("GET", `/invoices/${summary!.id}`);
    expect(invoice).toMatchObject({
      intraState: true, placeOfSupply: "Maharashtra (27)", subtotalPaise: 2_100_000, cgstPaise: 189_000, sgstPaise: 189_000, igstPaise: 0, totalPaise: 2_478_000,
      amountInWords: "Rupees Twenty-Four Thousand Seven Hundred Eighty Only",
      seller: { name: "ForkFlow Technologies LLP", gstin: "27AAPFU0939F1ZV", bankDetails: "HDFC Bank, A/c 5020001234" }, buyer: { name: "Spice Route", gstin: "27AAKFS3412M1Z9" },
    });
    expect(invoice.lines.map((l) => [l.sac, l.quantity, l.taxablePaise])).toEqual([["997331", 2, 1_850_000], ["999293", 1, 250_000]]);
    // Later changes to the settings or the customer do not touch an issued invoice.
    await admin.ok("PUT", "/settings", { seller: { legalName: "Renamed LLP", gstin: "", address: "", city: "", stateCode: "27", pincode: "", email: "", phone: "" },
      invoice: { prefix: "XY", sac: "997331", gstRateBp: 1800, bankDetails: "", terms: "" }, prices: [], extraDevicePaise: 0, trialDays: 7 });
    expect((await admin.ok<{ invoice: InvoiceDetail }>("GET", `/invoices/${summary!.id}`)).invoice.seller.name).toBe("ForkFlow Technologies LLP");
    const karnataka = await confirmedOrder({}, { businessName: "Udupi Grand", gstin: "29AABCU7781K1ZP" });
    await pay(accounts, karnataka.order.id, karnataka.order.totalPaise);
    const igst = (await invoices()).find((i) => i.orderId === karnataka.order.id)!;
    expect((await admin.ok<{ invoice: InvoiceDetail }>("GET", `/invoices/${igst.id}`)).invoice).toMatchObject({ number: "XY/26-27/00002", intraState: false, igstPaise: 180_000, placeOfSupply: "Karnataka (29)" });
  });

  it("make a PDF, even for a name in another script", async () => {
    const { order } = await confirmedOrder({}, { businessName: "स्वाद Spice Route — “Café”" });
    await pay(accounts, order.id, order.totalPaise);
    const [summary] = await invoices();
    const res = await admin.call("GET", `/invoices/${summary!.id}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("ForkFlow-invoice-FF-26-27-00001.pdf");
    const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect([pdf.getTitle(), pdf.getPageCount()]).toEqual(["Tax invoice FF/26-27/00001", 1]);
  });

  it("can be issued before payment for a customer on credit, never twice; an admin cancels one and a new number follows", async () => {
    const { order } = await confirmedOrder();
    expect((await (await as(env, "sales")).call("POST", `/orders/${order.id}/invoice`)).status).toBe(403);
    expect((await accounts.call("POST", `/orders/${order.id}/invoice`)).status).toBe(201);
    expect((await accounts.call("POST", `/orders/${order.id}/invoice`)).status).toBe(409);
    await pay(accounts, order.id, order.totalPaise);
    expect((await invoices()).map((i) => i.number)).toEqual(["FF/26-27/00001"]);
    const [invoice] = await invoices();
    expect((await accounts.call("POST", `/invoices/${invoice!.id}/cancel`, { reason: "Wrong GSTIN" })).status).toBe(403);
    expect((await admin.ok<{ invoice: InvoiceDetail }>("POST", `/invoices/${invoice!.id}/cancel`, { reason: "Wrong GSTIN" })).invoice.cancelledAt).toBe(T0);
    await accounts.ok("POST", `/orders/${order.id}/invoice`);
    expect((await invoices()).map((i) => [i.number, i.cancelledAt === null])).toEqual([["FF/26-27/00002", true], ["FF/26-27/00001", false]]);
  });

  it("words follow the Indian system", () => {
    expect(numberInWords(12_345_678)).toBe("One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight");
    expect(numberInWords(100_000)).toBe("One Lakh");
    expect(rupeesInWords(4_306_764)).toBe("Rupees Forty-Three Thousand Sixty-Seven and Sixty-Four Paise Only");
    expect(rupeesInWords(50)).toBe("Rupees Zero and Fifty Paise Only");
  });
});

describe("Razorpay payment links", () => {
  it("are sent for what is still owed, with a fresh reference each time, and refused without a contact or keys", async () => {
    const { order } = await confirmedOrder();
    await pay(accounts, order.id, 180_000);
    const ritu = await as(env, "sales");
    expect((await ritu.call("POST", `/orders/${order.id}/payment-link`)).status).toBe(404);
    const first = await admin.ok<{ link: { shortUrl: string } }>("POST", `/orders/${order.id}/payment-link`);
    expect(first.link.shortUrl).toBe("https://rzp.io/i/test1");
    expect(razorpay[0]).toMatchObject({ url: "https://api.razorpay.com/v1/payment_links", body: {
      amount: 1_000_000, currency: "INR", reference_id: `${order.code}-1`, customer: { name: "Spice Route", email: "meera@spiceroute.in", contact: "+919822012345" },
      notify: { sms: true, email: true }, expire_by: Math.floor((T0 + 15 * DAY_MS) / 1000), notes: { orderId: order.id, orderCode: order.code },
    } });
    await admin.ok("POST", `/orders/${order.id}/payment-link`);
    expect(razorpay[1]!.body!["reference_id"]).toBe(`${order.code}-2`);
    const silent = await confirmedOrder({}, { businessName: "No Contact", phone: "", email: "" });
    expect(await (await admin.call("POST", `/orders/${silent.order.id}/payment-link`)).json()).toMatchObject({ code: "no_contact" });
    env.RAZORPAY_KEY_ID = "";
    expect((await admin.call("POST", `/orders/${order.id}/payment-link`)).status).toBe(503);
  });

  it("a paid link records the payment once, completes the order with one invoice, and cancels the other open link", async () => {
    const { customer, order } = await confirmedOrder();
    await enrol(COUNTER, customer, order).then((r) => expect(r.status).toBe(409));
    await admin.ok("POST", `/orders/${order.id}/payment-link`);
    await admin.ok("POST", `/orders/${order.id}/payment-link`);
    const paid = await webhook("payment_link.paid", "evt_1", "plink_Test2abc", { id: "pay_ABC", amount: 1_180_000 });
    expect(await paid.json()).toEqual({ outcome: "paid" });
    const detail = (await admin.ok<{ order: OrderDetail }>("GET", `/orders/${order.id}`)).order;
    expect(detail).toMatchObject({ status: "paid", paidPaise: 1_180_000 });
    expect(detail.payments).toEqual([expect.objectContaining({ method: "razorpay", reference: "pay_ABC", status: "cleared" })]);
    expect(detail.links.map((l) => [l.id, l.status])).toEqual([["plink_Test2abc", "paid"], ["plink_Test1abc", "cancelled"]]);
    expect(razorpay.at(-1)!.url).toBe("https://api.razorpay.com/v1/payment_links/plink_Test1abc/cancel");
    expect(await (await webhook("payment_link.paid", "evt_1", "plink_Test2abc", { id: "pay_ABC", amount: 1_180_000 })).json()).toEqual({ outcome: "duplicate" });
    expect(await (await webhook("payment_link.paid", "evt_2", "plink_Test2abc", { id: "pay_ABC", amount: 1_180_000 })).json()).toEqual({ outcome: "duplicate_payment" });
    expect(await invoices()).toHaveLength(1);
    expect((await enrol(COUNTER, customer, order)).status).toBe(200);
  });

  it("one payment for a renewal extends every counter on it; unknown links and other events change nothing", async () => {
    const { customer, order } = await confirmedOrder({ outlets: 2, pricePerOutletPaise: 0 });
    await enrol(COUNTER, customer, order); await enrol(OTHER, customer, order);
    const { order: renewal } = await admin.ok<{ order: OrderDetail }>("POST", "/orders", {
      customerId: customer.id, kind: "renewal", plan: "pro", termMonths: 12, outlets: 0, maxDevices: 5, modules: {}, pricePerOutletPaise: 900_000, discountPaise: 0,
      extras: [], installationIds: [COUNTER, OTHER], notes: "",
    });
    await admin.ok("POST", `/orders/${renewal.id}/confirm`);
    const { link } = await admin.ok<{ link: { shortUrl: string } }>("POST", `/orders/${renewal.id}/payment-link`);
    expect(link.shortUrl).toMatch(/^https:\/\/rzp\.io/);
    expect(await (await webhook("payment_link.paid", "evt_x", "plink_Unknown99", { id: "pay_X", amount: 100 })).json()).toEqual({ outcome: "unmatched" });
    expect(await (await webhook("payment_link.expired", "evt_y", "plink_Test1abc")).json()).toEqual({ outcome: "status" });
    expect(await (await webhook("payment_link.paid", "evt_z", "plink_Test1abc", { id: "pay_R", amount: 2_124_000 })).json()).toEqual({ outcome: "paid" });
    for (const id of [COUNTER, OTHER]) expect(await latestLicense(env.DB, id)).toMatchObject({ revision: 2, expiresAt: addMonths(addMonths(T0, 12), 12) });
  });
});

describe("payments that land together, and orders that change underneath a request", () => {
  const rows = (client: PortalClient, id: string) => client.ok<{ order: OrderDetail }>("GET", `/orders/${id}`).then((r) => r.order);
  const hooked = (target: Env) => target.DB as unknown as { batch: Env["DB"]["batch"] };
  const sqlOf = (statement: unknown) => (statement as { sql: string }).sql;

  it("two payments that together cover an order complete it once, whichever lands last", async () => {
    const { order } = await confirmedOrder();
    await admin.ok("POST", `/orders/${order.id}/payment-link`);
    // The webhook for the other half runs completely between the manual payment's checks and its write: neither sees the other's payment.
    const real = hooked(env).batch.bind(env.DB);
    let hookStatus = 0;
    hooked(env).batch = async (statements) => {
      if (!hookStatus && statements.some((s) => sqlOf(s).includes("INSERT INTO payments") && sqlOf(s).includes("recorded_by"))) {
        hookStatus = (await webhook("payment_link.partially_paid", "evt_a", "plink_Test1abc", { id: "pay_HALF", amount: 590_000 })).status;
      }
      return real(statements);
    };
    const manual = await pay(accounts, order.id, 590_000);
    expect([manual.status, hookStatus]).toEqual([201, 200]);
    const detail = await rows(admin, order.id);
    expect(detail).toMatchObject({ status: "paid", paidPaise: 1_180_000 });
    expect(detail.payments).toHaveLength(2);
    expect(await invoices()).toHaveLength(1);
  });

  it("a payment is recorded and the order completed even when the invoice cannot be built; the invoice follows once the state is fixed", async () => {
    const { customer, order } = await confirmedOrder();
    await admin.ok("POST", `/orders/${order.id}/payment-link`);
    await env.DB.prepare(`UPDATE customers SET gstin = NULL, state_code = NULL WHERE id = ?`).bind(customer.id).run();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await webhook("payment_link.paid", "evt_s", "plink_Test1abc", { id: "pay_S", amount: order.totalPaise });
    expect([res.status, await res.json()]).toEqual([200, { outcome: "paid" }]);
    expect(await rows(admin, order.id)).toMatchObject({ status: "paid", paidPaise: order.totalPaise, invoices: [] });
    await env.DB.prepare(`UPDATE customers SET state_code = '27' WHERE id = ?`).bind(customer.id).run();
    await admin.ok("POST", `/orders/${order.id}/invoice`);
    expect(await invoices()).toHaveLength(1);
  });

  it("a delivery that follows an attempt which recorded the payment but stopped completes the order", async () => {
    const { order } = await confirmedOrder();
    await admin.ok("POST", `/orders/${order.id}/payment-link`);
    await env.DB.prepare(`INSERT INTO payments (id, order_id, amount_paise, method, reference, status, received_at, note, razorpay_payment_id, created_at, updated_at)
      VALUES (?, ?, ?, 'razorpay', 'pay_LATE', 'cleared', ?, '', 'pay_LATE', ?, ?)`).bind(crypto.randomUUID(), order.id, order.totalPaise, T0, T0, T0).run();
    expect(await (await webhook("payment_link.paid", "evt_retry", "plink_Test1abc", { id: "pay_LATE", amount: order.totalPaise })).json()).toEqual({ outcome: "duplicate_payment" });
    expect(await rows(admin, order.id)).toMatchObject({ status: "paid" });
    expect(await invoices()).toHaveLength(1);
  });

  it("cancelling an order that is paid between the checks and the write fails; it never cancels a paid order", async () => {
    const { order } = await confirmedOrder();
    const real = hooked(env).batch.bind(env.DB);
    let hit = false;
    hooked(env).batch = async (statements) => {
      if (!hit && statements.some((s) => sqlOf(s).includes("SET status = 'cancelled'"))) { hit = true; await pay(accounts, order.id, order.totalPaise); }
      return real(statements);
    };
    const res = await admin.call("POST", `/orders/${order.id}/cancel`, { reason: "customer withdrew" });
    expect([res.status, await res.json()]).toEqual([409, expect.objectContaining({ code: "changed" })]);
    expect(await rows(admin, order.id)).toMatchObject({ status: "paid", cancelledAt: null });
  });

  it("a confirmed order keeps the tax it was priced with when the customer's state changes later", async () => {
    // An odd taxable value: CGST + SGST round twice, IGST once, so recomputing under the other split would be a paisa out.
    const { customer, order } = await confirmedOrder({ pricePerOutletPaise: 1_000_050 });
    expect(order.intraState).toBe(true);
    await env.DB.prepare(`UPDATE customers SET gstin = NULL, state_code = '29' WHERE id = ?`).bind(customer.id).run();
    const after = await rows(admin, order.id);
    expect(after.intraState).toBe(false);
    expect([after.subtotalPaise, after.taxPaise, after.totalPaise]).toEqual([order.subtotalPaise, order.taxPaise, order.totalPaise]);
    expect(after.subtotalPaise + after.taxPaise).toBe(after.totalPaise);
    expect(after.cgstPaise + after.sgstPaise + after.igstPaise).toBe(after.taxPaise);
  });

  it("the Payments filter of the activity log includes a Razorpay payment and its link, not only payments recorded by hand", async () => {
    const { order } = await confirmedOrder();
    await pay(accounts, order.id, 100_000);
    await admin.ok("POST", `/orders/${order.id}/payment-link`);
    await webhook("payment_link.paid", "evt_act", "plink_Test1abc", { id: "pay_ACT", amount: 1_080_000 });
    const { entries } = await admin.ok<{ entries: Array<{ action: string }> }>("GET", "/activity?entityType=payment");
    expect(entries.map((e) => e.action).sort()).toEqual(["payment.link_sent", "payment.received", "payment.recorded"]);
    // Other kinds are unchanged: the order's own rows still list under Orders.
    const orders = await admin.ok<{ entries: Array<{ action: string }> }>("GET", "/activity?entityType=order");
    expect(orders.entries.map((e) => e.action)).toContain("order.paid");
  });

  it("the activity log's ForkFlow (automatic) option shows only what the system did, as the portal asks for it", async () => {
    const { order } = await confirmedOrder();
    await admin.ok("POST", `/orders/${order.id}/payment-link`);
    await webhook("payment_link.paid", "evt_sys", "plink_Test1abc", { id: "pay_SYS", amount: order.totalPaise });
    type Page = { entries: Array<{ action: string; actor: unknown }> };
    const everything = await admin.ok<Page>("GET", "/activity"), system = await admin.ok<Page>("GET", "/activity?system=true");
    expect(system.entries.map((e) => e.action)).toContain("payment.received");
    expect(system.entries.every((e) => e.actor === null)).toBe(true);
    expect(system.entries.length).toBeLessThan(everything.entries.length);
  });

  it("an invoice with long terms continues on a second page instead of running off the first", async () => {
    await admin.ok("PUT", "/settings", {
      seller: { legalName: "ForkFlow Technologies LLP", gstin: "27AAPFU0939F1ZV", address: "Baner Road", city: "Pune", stateCode: "27", pincode: "411045", email: "accounts@forkflow.in", phone: "" },
      invoice: { prefix: "FF", sac: "997331", gstRateBp: 1800, bankDetails: "HDFC Bank, A/c 5020001234", terms: Array.from({ length: 60 }, (_, i) => `Term ${i + 1}`).join("\n") },
      prices: [], extraDevicePaise: 0, trialDays: 7,
    });
    const { order } = await confirmedOrder();
    await pay(accounts, order.id, order.totalPaise);
    const [summary] = await invoices();
    const res = await admin.call("GET", `/invoices/${summary!.id}/pdf`);
    const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
  });
});
