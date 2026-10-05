import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MIGRATIONS, PLANS, migrate, openDb, type Bill, type BillTotals, type LicenseClaims, type ReceiptSnapshot } from "@forkflow/domain";
import { buildServer } from "./server.js";
import { makeFakeSink } from "./print/sinks.js";
import { SETUP } from "./test-helpers.js";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const apps: FastifyInstance[] = [];
type Headers = { authorization: string; "x-forkflow-device": string };
type Item = { id: string; productId: string; qty: number; pricePaise: number; status: string };
type Order = { id: string; type: string; tableId: string | null; tableName: string | null; splitLabel: string | null; status: string; items: Item[] };
type Preview = BillTotals & { receipt: ReceiptSnapshot; previewKey: string };
type Draft = { productId: string; qty: number; clientRef: string };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) { await app.close(); app.db.close(); }
});

// Every fixture uses a signed Basic license, proving core takeaway billing is
// available without the recipe or QR ordering entitlements.
async function fixture(taxInclusive = false) {
  const now = Date.now(), installationId = randomUUID(), db = openDb(":memory:"); migrate(db, MIGRATIONS);
  const fake = makeFakeSink();
  const app = buildServer({ db, sinkSend: fake.send, licensing: { publicKey, installationId } }); apps.push(app);
  const device = "a".repeat(64);
  const setup = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: { "x-forkflow-device": device } });
  expect(setup.statusCode, setup.body).toBe(201);
  const headers: Headers = { authorization: `Bearer ${setup.json().token}`, "x-forkflow-device": device };
  const api = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object, as = headers) =>
    app.inject({ method, url, headers: as, ...(payload === undefined ? {} : { payload }) });
  const claims: LicenseClaims = { version: 1, installationId, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(),
    revision: 1, plan: "basic", features: PLANS.basic.features, maxDevices: PLANS.basic.maxDevices,
    issuedAt: now - 1000, expiresAt: now + 600_000, graceUntil: now + 1_200_000 };
  const message = `ff1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const activated = await api("PUT", "/api/license", { license: `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString("base64url")}` });
  expect(activated.statusCode, activated.body).toBe(200);
  expect((await api("POST", "/api/license/devices", { name: "Main counter" })).statusCode).toBe(200);
  expect((await api("PUT", "/api/settings", { restaurantName: SETUP.restaurantName, taxInclusive })).statusCode).toBe(200);
  const category = await api("POST", "/api/categories", { name: "Takeaway" });
  const stationId = (db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string }).id;
  async function product(name: string, pricePaise: number, gstRate: number, kotStationId: string | null) {
    const response = await api("POST", "/api/products", { categoryId: category.json().category.id, name, pricePaise, gstRate, kotStationId });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().product as { id: string };
  }
  const meal = await product("Meal", taxInclusive ? 10500 : 10000, 5, stationId);
  const drink = await product("Bottled drink", taxInclusive ? 5900 : 5000, 18, null);
  async function stock(name: string, unit: "kg" | "pcs", openingQty: number, productId: string, qtyPerSale: number) {
    const response = await api("POST", "/api/stock-items", { clientRef: randomUUID(), name, unit, openingQty });
    expect(response.statusCode, response.body).toBe(201);
    const id = response.json().item.id as string;
    expect((await api("PUT", `/api/products/${productId}/stock-links`, { expectedVersion: 0, stockItemId: id, qtyPerSale })).statusCode).toBe(200);
    return id;
  }
  const riceId = await stock("Rice", "kg", 5, meal.id, 0.125), drinkStockId = await stock("Drink bottles", "pcs", 20, drink.id, 1);
  const balances = () => [riceId, drinkStockId].map((id) => (db.prepare("SELECT qty FROM stock_items WHERE id = ?").get(id) as { qty: number }).qty);
  const draft = (): Draft[] => [{ productId: meal.id, qty: 2, clientRef: randomUUID() }, { productId: drink.id, qty: 1, clientRef: randomUUID() }];
  async function punch(items = draft(), as = headers) {
    const createBody = { clientRef: randomUUID(), type: "parcel", tableId: null };
    const created = await api("POST", "/api/orders", createBody, as);
    expect(created.statusCode, created.body).toBe(201);
    const orderId = created.json().order.id as string, addBody = { items };
    const added = await api("POST", `/api/orders/${orderId}/items`, addBody, as);
    expect(added.statusCode, added.body).toBe(200);
    return { order: added.json().order as Order, createBody, addBody };
  }
  async function send(order: Order, as = headers) {
    const sendBody = { clientRef: randomUUID(), itemIds: order.items.filter((item) => item.productId === meal.id && item.status === "pending").map((item) => item.id) };
    const sent = await api("POST", `/api/orders/${order.id}/send`, sendBody, as);
    expect(sent.statusCode, sent.body).toBe(200);
    return { sendBody, order: sent.json().order as Order, kotIds: sent.json().kots.map((kot: { id: string }) => kot.id) as string[] };
  }
  async function preview(orderId: string, as = headers): Promise<Preview> {
    const response = await api("POST", `/api/orders/${orderId}/bill-preview`, {}, as);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().preview;
  }
  async function issue(orderId: string, value: Preview, as = headers, printerId: string | null = null) {
    const issueBody = { clientRef: randomUUID(), previewKey: value.previewKey, printerId };
    const response = await api("POST", `/api/orders/${orderId}/bill`, issueBody, as);
    expect(response.statusCode, response.body).toBe(201);
    return { bill: response.json().bill as Bill, issueBody };
  }
  async function staff(role: "cashier" | "waiter" | "kitchen"): Promise<Headers> {
    const pin = { cashier: "2345", waiter: "3456", kitchen: "4567" }[role];
    expect((await api("POST", "/api/users", { name: role, role, pin })).statusCode).toBe(201);
    const loggedIn = await api("POST", "/api/login", { pin });
    expect(loggedIn.statusCode, loggedIn.body).toBe(200);
    return { authorization: `Bearer ${loggedIn.json().token}`, "x-forkflow-device": device };
  }
  return { app, fake, api, headers, meal, drink, riceId, drinkStockId, stationId, balances, draft, punch, send, preview, issue, staff };
}

describe("quick takeaway orchestration", () => {
  it("creates a table-free parcel and recovers exact add/send/bill/payment retries without duplicate stock or printing", async () => {
    const f = await fixture();
    const printer = await f.api("POST", "/api/printers", { name: "Counter printer", kind: "network", connection: "127.0.0.1:9100", paperWidth: 80 });
    expect(printer.statusCode, printer.body).toBe(201);
    const printerId = printer.json().printer.id as string;
    expect((await f.api("PATCH", `/api/kot-stations/${f.stationId}`, { printerId })).statusCode).toBe(200);
    const table = await f.api("POST", "/api/tables", { name: "T1" });
    expect(table.statusCode).toBe(201);
    const punched = await f.punch();
    expect(punched.order).toMatchObject({ type: "parcel", tableId: null, tableName: null, splitLabel: null, status: "open" });
    const createRetry = await f.api("POST", "/api/orders", punched.createBody);
    expect(createRetry.statusCode).toBe(200);
    expect(createRetry.json().order.id).toBe(punched.order.id);
    const addRetry = await f.api("POST", `/api/orders/${punched.order.id}/items`, punched.addBody);
    expect(addRetry.statusCode).toBe(200);
    expect(addRetry.json().order.items).toEqual(punched.order.items);
    expect(f.balances()).toEqual([5, 20]);
    expect((await f.api("POST", `/api/orders/${punched.order.id}/bill-preview`, {})).statusCode).toBe(409);
    const sent = await f.send(punched.order);
    const sendRetry = await f.api("POST", `/api/orders/${punched.order.id}/send`, sent.sendBody);
    expect(sendRetry.statusCode).toBe(200);
    expect(sendRetry.json().kots.map((kot: { id: string }) => kot.id)).toEqual(sent.kotIds);
    expect(f.balances()).toEqual([4.75, 20]);
    expect(sent.order.items.find((item) => item.productId === f.drink.id)?.status).toBe("pending");
    const preview = await f.preview(punched.order.id);
    expect(preview).toMatchObject({ subtotalPaise: 25000, cgstPaise: 950, sgstPaise: 950, totalPaise: 26900,
      receipt: { orderType: "parcel", tableName: null, splitLabel: null } });
    const { bill, issueBody } = await f.issue(punched.order.id, preview, f.headers, printerId);
    expect(bill.receipt).toEqual(preview.receipt);
    expect(bill.taxes).toEqual(preview.taxes);
    expect(f.balances()).toEqual([4.75, 19]);
    expect((await f.api("POST", `/api/orders/${punched.order.id}/bill`, issueBody)).statusCode).toBe(200);
    const payment = { clientRef: randomUUID(), payments: [{ mode: "cash", amountPaise: bill.totalPaise }] };
    const paid = await f.api("POST", `/api/bills/${bill.id}/settle`, payment);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ bill: { status: "paid" }, order: { status: "settled", tableId: null } });
    expect((await f.api("POST", `/api/bills/${bill.id}/settle`, payment)).json()).toEqual(paid.json());
    expect((await f.api("POST", `/api/orders/${punched.order.id}/bill`, issueBody)).json().bill.status).toBe("paid");
    expect((await f.api("POST", `/api/orders/${punched.order.id}/send`, sent.sendBody)).statusCode).toBe(200);
    // Once billed, recovery resumes the saved step; item addition is closed.
    expect((await f.api("POST", `/api/orders/${punched.order.id}/items`, punched.addBody)).statusCode).toBe(409);
    expect(f.balances()).toEqual([4.75, 19]);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 1 });
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM order_items").get()).toEqual({ n: 2 });
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM kots").get()).toEqual({ n: 1 });
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM bills").get()).toEqual({ n: 1 });
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 1 });
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE reason = 'sale'").get()).toEqual({ n: 2 });
    expect((await f.api("GET", "/api/tables")).json().tables[0]).toMatchObject({ status: "free", activeOrders: [] });
    await vi.waitFor(() => expect(f.fake.sent).toHaveLength(2));
    expect((await f.api("POST", `/api/bills/${bill.id}/settle`, { ...payment, payments: [{ mode: "card", amountPaise: bill.totalPaise }] })).statusCode).toBe(409);
  });

  it("can preview and bill an entirely stationless takeaway without a kitchen send", async () => {
    const f = await fixture(); const punched = await f.punch([{ productId: f.drink.id, qty: 2, clientRef: randomUUID() }]);
    const preview = await f.preview(punched.order.id);
    expect(preview.totalPaise).toBe(11800);
    expect(f.balances()).toEqual([5, 20]);
    const { bill } = await f.issue(punched.order.id, preview);
    expect(bill.totalPaise).toBe(11800);
    expect(f.balances()).toEqual([5, 18]);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM kots").get()).toEqual({ n: 0 });
  });

  it.each([false, true])("uses the confirmed price and GST preview when taxInclusive=%s", async (inclusive) => {
    const f = await fixture(inclusive); const punched = await f.punch(); await f.send(punched.order);
    const preview = await f.preview(punched.order.id);
    expect(preview).toMatchObject({ taxInclusive: inclusive, subtotalPaise: inclusive ? 26900 : 25000,
      cgstPaise: 950, sgstPaise: 950, roundingPaise: 0, totalPaise: 26900,
      taxes: [{ gstRate: 5, taxablePaise: 20000, cgstPaise: 500, sgstPaise: 500 }, { gstRate: 18, taxablePaise: 5000, cgstPaise: 450, sgstPaise: 450 }] });
    // Catalog edits affect later punches, while the confirmed order prices stay frozen.
    expect((await f.api("PATCH", `/api/products/${f.meal.id}`, { pricePaise: 50000, name: "Renamed meal", gstRate: 18 })).statusCode).toBe(200);
    const { bill } = await f.issue(punched.order.id, preview);
    expect(bill).toMatchObject({ taxInclusive: preview.taxInclusive, subtotalPaise: preview.subtotalPaise, totalPaise: preview.totalPaise,
      cgstPaise: preview.cgstPaise, sgstPaise: preview.sgstPaise, receipt: preview.receipt, taxes: preview.taxes });
    const settled = await f.api("POST", `/api/bills/${bill.id}/settle`, { clientRef: randomUUID(), payments: [{ mode: "upi", amountPaise: preview.totalPaise }] });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json().bill).toMatchObject({ status: "paid", totalPaise: preview.totalPaise, receipt: preview.receipt });
  });

  it.each(["cash", "upi", "card"] as const)("allows a Basic cashier to complete a quick takeaway with %s", async (mode) => {
    const f = await fixture(); const cashier = await f.staff("cashier");
    const punched = await f.punch(undefined, cashier); await f.send(punched.order, cashier);
    const preview = await f.preview(punched.order.id, cashier);
    const { bill } = await f.issue(punched.order.id, preview, cashier);
    const payment = { clientRef: randomUUID(), payments: [{ mode, amountPaise: bill.totalPaise }] };
    const paid = await f.api("POST", `/api/bills/${bill.id}/settle`, payment, cashier);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().bill).toMatchObject({ status: "paid", payments: [{ mode, amountPaise: bill.totalPaise }] });
    expect((await f.api("POST", `/api/bills/${bill.id}/settle`, payment, cashier)).statusCode).toBe(200);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 1 });
    expect(f.balances()).toEqual([4.75, 19]);
  });

  it("denies waiter and kitchen users access to billing and payment despite a valid Basic device", async () => {
    const f = await fixture(); const waiter = await f.staff("waiter"), kitchen = await f.staff("kitchen");
    const punched = await f.punch(undefined, waiter); await f.send(punched.order, waiter);
    const preview = await f.preview(punched.order.id);
    for (const actor of [waiter, kitchen]) {
      expect((await f.api("POST", `/api/orders/${punched.order.id}/bill-preview`, {}, actor)).statusCode).toBe(403);
      expect((await f.api("POST", `/api/orders/${punched.order.id}/bill`, { clientRef: randomUUID(), previewKey: preview.previewKey }, actor)).statusCode).toBe(403);
    }
    const { bill } = await f.issue(punched.order.id, preview);
    for (const actor of [waiter, kitchen]) expect((await f.api("POST", `/api/bills/${bill.id}/settle`, {
      clientRef: randomUUID(), payments: [{ mode: "cash", amountPaise: bill.totalPaise }],
    }, actor)).statusCode).toBe(403);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 0 });
    expect((await f.api("GET", `/api/bills/${bill.id}`)).json().bill.status).toBe("unpaid");
  });

  it("rejects a confirmed preview after another counter changes a pending quantity", async () => {
    const f = await fixture(); const punched = await f.punch(); await f.send(punched.order);
    const preview = await f.preview(punched.order.id);
    const drink = punched.order.items.find((item) => item.productId === f.drink.id)!;
    expect((await f.api("PATCH", `/api/order-items/${drink.id}`, { qty: 2 })).statusCode).toBe(200);
    const issueBody = { clientRef: randomUUID(), previewKey: preview.previewKey };
    const rejected = await f.api("POST", `/api/orders/${punched.order.id}/bill`, issueBody);
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(f.balances()).toEqual([4.75, 20]);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM bills").get()).toEqual({ n: 0 });
    expect(f.app.db.prepare("SELECT value FROM sequences WHERE name = 'bill_no'").get()).toEqual({ value: 0 });
    const refreshed = await f.preview(punched.order.id);
    expect(refreshed.previewKey).not.toBe(preview.previewKey);
    expect(refreshed.totalPaise).toBe(32800);
    const { bill } = await f.issue(punched.order.id, refreshed);
    expect(bill.billNo).toBe(1);
    expect(f.balances()).toEqual([4.75, 18]);
  });

  it("requires a fresh confirmation if GST settings change after the displayed preview", async () => {
    const f = await fixture(); const punched = await f.punch(); await f.send(punched.order);
    const preview = await f.preview(punched.order.id);
    expect((await f.api("PUT", "/api/settings", { restaurantName: SETUP.restaurantName, taxInclusive: true })).statusCode).toBe(200);
    const rejected = await f.api("POST", `/api/orders/${punched.order.id}/bill`, { clientRef: randomUUID(), previewKey: preview.previewKey });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM bills").get()).toEqual({ n: 0 });
    const next = await f.preview(punched.order.id);
    expect(next.taxInclusive).toBe(true);
    expect(next.totalPaise).toBe(25000);
    expect(next.previewKey).not.toBe(preview.previewKey);
  });

  it("does not include a later remote kitchen punch in the captured send request or charge before it is reviewed", async () => {
    const f = await fixture(); const punched = await f.punch();
    const later = await f.api("POST", `/api/orders/${punched.order.id}/items`, { items: [{ productId: f.meal.id, qty: 1, clientRef: randomUUID() }] });
    expect(later.statusCode).toBe(200);
    const sent = await f.send(punched.order);
    expect(sent.order.items.filter((item) => item.productId === f.meal.id && item.status === "pending")).toHaveLength(1);
    expect((await f.api("POST", `/api/orders/${punched.order.id}/send`, sent.sendBody)).statusCode).toBe(200);
    expect((await f.api("POST", `/api/orders/${punched.order.id}/bill-preview`, {})).statusCode).toBe(409);
    expect(f.balances()).toEqual([4.75, 20]);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM bills").get()).toEqual({ n: 0 });
  });

  it("recovers a payment failure from the already-issued bill without issuing or deducting anything again", async () => {
    const f = await fixture(); const punched = await f.punch(); await f.send(punched.order);
    const { bill, issueBody } = await f.issue(punched.order.id, await f.preview(punched.order.id));
    const payment = { clientRef: randomUUID(), payments: [{ mode: "card", amountPaise: bill.totalPaise }] };
    f.app.db.exec("CREATE TRIGGER fail_takeaway_payment BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT, 'test'); END");
    expect((await f.api("POST", `/api/bills/${bill.id}/settle`, payment)).statusCode).toBe(500);
    expect((await f.api("GET", `/api/orders/${punched.order.id}/bill`)).json().bill).toMatchObject({ id: bill.id, status: "unpaid" });
    expect((await f.api("GET", `/api/orders/${punched.order.id}`)).json().order.status).toBe("billed");
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM bill_settlements").get()).toEqual({ n: 0 });
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 0 });
    expect(f.balances()).toEqual([4.75, 19]);
    f.app.db.exec("DROP TRIGGER fail_takeaway_payment");
    expect((await f.api("POST", `/api/orders/${punched.order.id}/bill`, issueBody)).statusCode).toBe(200);
    const recovered = await f.api("POST", `/api/bills/${bill.id}/settle`, payment);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json().order.status).toBe("settled");
    expect((await f.api("POST", `/api/bills/${bill.id}/settle`, payment)).statusCode).toBe(200);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM bills").get()).toEqual({ n: 1 });
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 1 });
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM kots").get()).toEqual({ n: 1 });
    expect(f.balances()).toEqual([4.75, 19]);
  });
});
