import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type Bill } from "@forkflow/domain";
import { auth, createUser, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";
import { billUpiPayment } from "./print/upi.js";

describe("billing and day-end", () => {
  let app: FastifyInstance;
  let token: string;
  let productId: string;
  let fake: ReturnType<typeof freshAppWithFakeSink>["fake"];
  beforeEach(async () => {
    ({ app, fake } = freshAppWithFakeSink());
    ({ token } = await setupAdmin(app));
    const category = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const product = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Meal", categoryId: category.json().category.id, pricePaise: 10000, gstRate: 5, kotStationId: null } });
    expect(product.statusCode).toBe(201); productId = product.json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });
  async function order(tableId?: string, empty = false) {
    const res = await app.inject({ method: "POST", url: "/api/orders", headers: auth(token), payload: { clientRef: uuidv7(), type: tableId ? "dine_in" : "parcel", tableId: tableId ?? null } });
    const id = res.json().order.id as string;
    if (!empty) {
      const add = await app.inject({ method: "POST", url: `/api/orders/${id}/items`, headers: auth(token), payload: { items: [{ productId, qty: 1, clientRef: uuidv7() }] } });
      expect(add.statusCode).toBe(200);
    }
    return id;
  }
  async function billRequest(orderId: string, extra: Record<string, unknown> = {}) {
    const preview = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill-preview`, headers: auth(token), payload: { discountPaise: 0, ...extra } });
    expect(preview.statusCode).toBe(200);
    return { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey, ...extra };
  }
  async function issue(orderId: string) {
    const res = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill`, headers: auth(token), payload: await billRequest(orderId) });
    expect(res.statusCode).toBe(201); return res.json().bill as Bill;
  }
  const pay = (bill: Bill, clientRef = uuidv7()) => app.inject({ method: "POST", url: `/api/bills/${bill.id}/settle`, headers: auth(token), payload: { clientRef, payments: bill.totalPaise ? [{ mode: "cash", amountPaise: bill.totalPaise }] : [] } });

  it("issues once, consumes stationless items, freezes mutations, replays without reprinting", async () => {
    const p = await app.inject({ method: "POST", url: "/api/printers", headers: auth(token), payload: { name: "Receipt", kind: "network", connection: "127.0.0.1:9100", paperWidth: 58 } });
    const id = await order(); const body = await billRequest(id, { printerId: p.json().printer.id });
    const send = () => app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: body });
    const first = await send(); const replay = await send();
    expect(first.statusCode).toBe(201); expect(replay.statusCode).toBe(200);
    expect(replay.json().bill).toEqual(first.json().bill);
    expect(first.json().bill.totalPaise).toBe(10500);
    expect(first.json().order.items[0].status).toBe("sent");
    expect(fake.sent).toHaveLength(1);
    const jobs = await app.inject({ url: `/api/bills/${first.json().bill.id}/print-jobs`, headers: auth(token) });
    expect(jobs.json().jobs).toHaveLength(1);
    expect(jobs.json().jobs[0].kind).toBe("receipt");
    const mutate = await app.inject({ method: "PATCH", url: `/api/order-items/${first.json().order.items[0].id}`, headers: auth(token), payload: { qty: 2 } });
    expect(mutate.statusCode).toBe(409);
    const active = await app.inject({ url: "/api/orders", headers: auth(token) });
    expect(active.json().orders.map((o: { id: string }) => o.id)).toContain(id);
  });
  it("rejects stale previews and conflicting reference reuse without gaps", async () => {
    const id = await order(); const body = await billRequest(id);
    await app.inject({ method: "POST", url: `/api/orders/${id}/items`, headers: auth(token), payload: { items: [{ productId, qty: 1 }] } });
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: body })).statusCode).toBe(409);
    const fresh = await billRequest(id);
    const issued = await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: fresh });
    expect(issued.json().bill.billNo).toBe(1);
    const conflict = await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: { ...fresh, discountPaise: 100, discountNote: "changed" } });
    expect(conflict.statusCode).toBe(409);
    expect((await issue(await order())).billNo).toBe(2);
  });
  it("rolls the bill sequence back on a database write failure", async () => {
    const id = await order(); const body = await billRequest(id);
    app.db.exec("CREATE TRIGGER reject_tax BEFORE INSERT ON bill_taxes BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: body })).statusCode).toBe(500);
    expect(app.db.prepare("SELECT value FROM sequences WHERE name = 'bill_no'").get()).toEqual({ value: 0 });
    expect(app.db.prepare("SELECT status FROM orders WHERE id = ?").get(id)).toEqual({ status: "open" });
    app.db.exec("DROP TRIGGER reject_tax");
    expect((await issue(id)).billNo).toBe(1);
  });
  it("rejects empty and unsent kitchen orders but allows takeaway billing after KOT", async () => {
    const empty = await order(undefined, true);
    expect((await app.inject({ method: "POST", url: `/api/orders/${empty}/bill-preview`, headers: auth(token), payload: {} })).statusCode).toBe(409);
    const station = app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string };
    app.db.prepare("UPDATE products SET kot_station_id = ? WHERE id = ?").run(station.id, productId);
    const id = await order();
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/bill-preview`, headers: auth(token), payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/send`, headers: auth(token) })).statusCode).toBe(200);
    expect((await issue(id)).totalPaise).toBe(10500);
  });
  it("blocks table previews and direct billing until the kitchen accepts, without waiting for Done", async () => {
    const table = await app.inject({ method: "POST", url: "/api/tables", headers: auth(token), payload: { name: "T1" } });
    const station = app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string };
    app.db.prepare("UPDATE products SET kot_station_id = ? WHERE id = ?").run(station.id, productId);
    const id = await order(table.json().table.id);
    const sent = await app.inject({ method: "POST", url: `/api/orders/${id}/send`, headers: auth(token) });
    const kotId = sent.json().kots[0].id;
    for (const url of [`/api/orders/${id}/bill-preview`, `/api/orders/${id}/bill`]) {
      const blocked = await app.inject({ method: "POST", url, headers: auth(token), payload: { clientRef: uuidv7(), previewKey: "a".repeat(64) } });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toBe("Wait for the kitchen to accept all tickets before billing this table order");
    }
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bills").get()).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT value FROM sequences WHERE name = 'bill_no'").get()).toEqual({ value: 0 });
    expect(app.db.prepare("SELECT status FROM orders WHERE id = ?").get(id)).toEqual({ status: "open" });
    const kitchen = await createUser(app, token, { name: "Kitchen", pin: "4567", role: "kitchen" });
    const accepted = await app.inject({ method: "POST", url: `/api/kots/${kotId}/accept`, headers: auth(kitchen.token) });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().kot.acceptedAt).toBeGreaterThan(0);
    expect(accepted.json().kot.doneAt).toBeNull();
    const body = await billRequest(id);
    const sendBill = () => app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: body });
    const issued = await sendBill();
    expect(issued.statusCode).toBe(201);
    expect(issued.json().bill.totalPaise).toBe(10500);
    expect((await sendBill()).json().bill).toEqual(issued.json().bill);
    expect(app.db.prepare("SELECT done_at FROM kots WHERE id = ?").get(kotId)).toEqual({ done_at: null });
  });
  it("still issues the bill when the receipt cannot be queued for printing", async () => {
    const p = await app.inject({ method: "POST", url: "/api/printers", headers: auth(token), payload: { name: "Receipt", kind: "network", connection: "127.0.0.1:9100", paperWidth: 58 } });
    const id = await order(); const body = await billRequest(id, { printerId: p.json().printer.id });
    app.db.prepare("UPDATE printers SET receipt_profile = 'not json' WHERE id = ?").run(p.json().printer.id);
    const res = await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: body });
    expect(res.statusCode).toBe(201);
    expect(res.json().job).toBeNull();
    expect(res.json().printError).toMatch(/could not be queued for printing/);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bills").get()).toEqual({ n: 1 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM print_jobs").get()).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT status FROM orders WHERE id = ?").get(id)).toEqual({ status: "billed" });
  });
  it("bills a table without kitchen acceptance once the setting is turned off", async () => {
    const table = await app.inject({ method: "POST", url: "/api/tables", headers: auth(token), payload: { name: "T1" } });
    const station = app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string };
    app.db.prepare("UPDATE products SET kot_station_id = ? WHERE id = ?").run(station.id, productId);
    const id = await order(table.json().table.id);
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/send`, headers: auth(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/bill-preview`, headers: auth(token), payload: {} })).statusCode).toBe(409);
    const saved = await app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { restaurantName: "Cafe", requireKitchenAcceptance: false } });
    expect(saved.json().settings.requireKitchenAcceptance).toBe(false);
    expect((await app.inject({ method: "GET", url: `/api/orders/${id}`, headers: auth(token) })).json().order.kitchenAcceptanceRequired).toBe(false);
    expect((await issue(id)).totalPaise).toBe(10500);
  });
  it("requires every kitchen station and each later KOT round to be accepted before table billing", async () => {
    const table = await app.inject({ method: "POST", url: "/api/tables", headers: auth(token), payload: { name: "T1" } });
    const firstStation = app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string };
    const secondStation = await app.inject({ method: "POST", url: "/api/kot-stations", headers: auth(token), payload: { name: "Drinks" } });
    app.db.prepare("UPDATE products SET kot_station_id = ? WHERE id = ?").run(firstStation.id, productId);
    const { category_id: categoryId } = app.db.prepare("SELECT category_id FROM products WHERE id = ?").get(productId) as { category_id: string };
    const secondProduct = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: {
      name: "Drink", categoryId,
      pricePaise: 1000, gstRate: 5, kotStationId: secondStation.json().station.id,
    } });
    const id = await order(table.json().table.id);
    await app.inject({ method: "POST", url: `/api/orders/${id}/items`, headers: auth(token), payload: { items: [{ productId: secondProduct.json().product.id, qty: 1 }] } });
    const sent = await app.inject({ method: "POST", url: `/api/orders/${id}/send`, headers: auth(token) });
    expect(sent.json().kots).toHaveLength(2);
    const [first, second] = sent.json().kots;
    const accept = (kotId: string) => app.inject({ method: "POST", url: `/api/kots/${kotId}/accept`, headers: auth(token) });
    await accept(first.id);
    const preview = () => app.inject({ method: "POST", url: `/api/orders/${id}/bill-preview`, headers: auth(token), payload: {} });
    expect((await preview()).statusCode).toBe(409);
    await accept(second.id);
    const stale = await billRequest(id);
    await app.inject({ method: "POST", url: `/api/orders/${id}/items`, headers: auth(token), payload: { items: [{ productId, qty: 1 }] } });
    const later = await app.inject({ method: "POST", url: `/api/orders/${id}/send`, headers: auth(token) });
    expect(later.json().kots).toHaveLength(1);
    expect((await preview()).statusCode).toBe(409);
    const staleBill = await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: stale });
    expect(staleBill.statusCode).toBe(409);
    expect(staleBill.json().error).toContain("accept all tickets");
    await accept(later.json().kots[0].id);
    expect((await issue(id)).totalPaise).toBe(22100);
  });
  it("keeps the acceptance requirement after a product is unrouted and ignores cancelled-only tickets", async () => {
    const table = await app.inject({ method: "POST", url: "/api/tables", headers: auth(token), payload: { name: "T1" } });
    const station = app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string };
    app.db.prepare("UPDATE products SET kot_station_id = ? WHERE id = ?").run(station.id, productId);
    const id = await order(table.json().table.id);
    const sent = await app.inject({ method: "POST", url: `/api/orders/${id}/send`, headers: auth(token) });
    app.db.prepare("UPDATE products SET kot_station_id = NULL WHERE id = ?").run(productId);
    const preview = () => app.inject({ method: "POST", url: `/api/orders/${id}/bill-preview`, headers: auth(token), payload: {} });
    expect((await preview()).statusCode).toBe(409);
    await app.inject({ method: "POST", url: `/api/order-items/${sent.json().order.items[0].id}/cancel`, headers: auth(token), payload: { reason: "Guest changed order" } });
    await app.inject({ method: "POST", url: `/api/orders/${id}/items`, headers: auth(token), payload: { items: [{ productId, qty: 1 }] } });
    expect((await issue(id)).totalPaise).toBe(10500);
    expect(app.db.prepare("SELECT accepted_at FROM kots WHERE id = ?").get(sent.json().kots[0].id)).toEqual({ accepted_at: null });
  });
  it("records exact split payments once and leaves a split table occupied until all settle", async () => {
    const t = await app.inject({ method: "POST", url: "/api/tables", headers: auth(token), payload: { name: "T1" } });
    const tableId = t.json().table.id as string;
    const a = await issue(await order(tableId)); const b = await issue(await order(tableId));
    const clientRef = uuidv7(); const payload = { clientRef, payments: [{ mode: "cash", amountPaise: 5000 }, { mode: "upi", amountPaise: 5500, refNote: "txn-123" }] };
    const settle = () => app.inject({ method: "POST", url: `/api/bills/${a.id}/settle`, headers: auth(token), payload });
    expect((await settle()).statusCode).toBe(200); expect((await settle()).statusCode).toBe(200);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 2 });
    expect((await app.inject({ url: "/api/tables", headers: auth(token) })).json().tables[0].status).toBe("billed");
    expect((await pay(b)).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/tables", headers: auth(token) })).json().tables[0].status).toBe("free");
    const changed = await app.inject({ method: "POST", url: `/api/bills/${a.id}/settle`, headers: auth(token), payload: { ...payload, payments: [{ mode: "card", amountPaise: 10500 }] } });
    expect(changed.statusCode).toBe(409);
  });
  it("rejects short or excess payment and settles a fully discounted bill without a zero payment row", async () => {
    const b = await issue(await order());
    for (const amountPaise of [10499, 10501]) expect((await app.inject({ method: "POST", url: `/api/bills/${b.id}/settle`, headers: auth(token), payload: { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise }] } })).statusCode).toBe(400);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 0 });
    const id = await order(); const payload = await billRequest(id, { discountPaise: 10000, discountNote: "Complimentary" });
    const free = (await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload })).json().bill as Bill;
    expect(free.totalPaise).toBe(0); expect((await pay(free)).statusCode).toBe(200);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 0 });
  });
  it("saves inclusive mode and receipt snapshots despite later settings/catalog edits", async () => {
    const profile = { restaurantName: "Original", gstin: "29ABCDE1234F1Z5", fssai: "12345678901234", taxInclusive: true };
    await app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: profile });
    await app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { restaurantName: "Original", gstin: profile.gstin, fssai: profile.fssai } });
    expect((await app.inject({ url: "/api/settings", headers: auth(token) })).json().settings.taxInclusive).toBe(true);
    app.db.prepare("UPDATE products SET price_paise = 10500 WHERE id = ?").run(productId);
    const bill = await issue(await order());
    expect(bill.taxInclusive).toBe(true); expect(bill.totalPaise).toBe(10500); expect(bill.cgstPaise).toBe(250);
    await app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { restaurantName: "Changed", taxInclusive: false } });
    app.db.prepare("UPDATE products SET name = 'Changed', price_paise = 20000 WHERE id = ?").run(productId);
    const stored = (await app.inject({ url: `/api/bills/${bill.id}`, headers: auth(token) })).json().bill;
    expect(stored).toEqual(bill);
    const receipt = await app.inject({ url: `/api/bills/${bill.id}/receipt`, headers: auth(token) });
    expect(receipt.body).toContain("Original"); expect(receipt.body).toContain("Prices include GST"); expect(receipt.body).not.toContain("Changed");
    expect((await issue(await order())).taxInclusive).toBe(false);
  });
  it("freezes UPI destination per bill, rejects a stale destination preview, and removes paid QR", async () => {
    const save = (upiId: string) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { restaurantName: "Cafe", upiId } });
    await save("original@bank");
    const bill = await issue(await order());
    const uri = billUpiPayment(bill)!.uri;
    const nextOrder = await order(), stale = await billRequest(nextOrder);
    await save("changed@bank");
    expect((await app.inject({ method: "POST", url: `/api/orders/${nextOrder}/bill`, headers: auth(token), payload: stale })).statusCode).toBe(409);
    expect(billUpiPayment((await issue(nextOrder)))!.upiId).toBe("changed@bank");
    const stored = (await app.inject({ url: `/api/bills/${bill.id}`, headers: auth(token) })).json().bill;
    expect(billUpiPayment(stored)!.uri).toBe(uri);
    const receipt = await app.inject({ url: `/api/bills/${bill.id}/receipt`, headers: auth(token) });
    expect(receipt.body).toContain("original@bank"); expect(receipt.body).not.toContain("changed@bank");
    expect(receipt.headers["cache-control"]).toBe("no-store");
    const qr = await app.inject({ url: `/api/bills/${bill.id}/upi-qr?amountPaise=1`, headers: auth(token) });
    expect(qr.statusCode).toBe(200);
    expect(qr.headers["cache-control"]).toBe("no-store");
    expect(qr.json().payment).toMatchObject({ billId: bill.id, billNo: bill.billNo, restaurantName: "Cafe", upiId: "original@bank", amountPaise: bill.totalPaise });
    expect(qr.json().payment.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(qr.json().payment.qrDataUrl.split(",")[1], "base64").toString()).toContain('aria-label="Scan to pay this bill by UPI"');
    expect(fake.sent).toHaveLength(0);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 0 });
    const paid = await app.inject({ method: "POST", url: `/api/bills/${bill.id}/settle`, headers: auth(token), payload: { clientRef: uuidv7(), payments: [{ mode: "upi", amountPaise: bill.totalPaise, refNote: "Verified in bank app" }] } });
    expect(paid.statusCode).toBe(200);
    expect((await app.inject({ url: `/api/bills/${bill.id}/receipt`, headers: auth(token) })).body).not.toContain('aria-label="UPI payment"');
    expect((await app.inject({ url: `/api/bills/${bill.id}/upi-qr`, headers: auth(token) })).json().payment).toBeNull();
    await save("");
    const unconfigured = await issue(await order());
    expect(billUpiPayment(unconfigured)).toBeNull();
    expect((await app.inject({ url: `/api/bills/${unconfigured.id}/upi-qr`, headers: auth(token) })).json().payment).toBeNull();
  });

  it("enforces roles and the cashier 10% discount limit at the API", async () => {
    const waiter = await createUser(app, token, { name: "Waiter", pin: "2222", role: "waiter" });
    const cashier = await createUser(app, token, { name: "Cashier", pin: "3333", role: "cashier" });
    const id = await order();
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/bill-preview`, headers: auth(waiter.token), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/bill-preview`, headers: auth(cashier.token), payload: { discountPaise: 1001, discountNote: "Test" } })).statusCode).toBe(403);
    const prev = await app.inject({ method: "POST", url: `/api/orders/${id}/bill-preview`, headers: auth(cashier.token), payload: { discountPaise: 1000, discountNote: "Test" } });
    expect(prev.statusCode).toBe(200);
    const issued = await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(cashier.token), payload: { clientRef: uuidv7(), previewKey: prev.json().preview.previewKey, discountPaise: 1000, discountNote: "Test" } });
    expect(issued.statusCode).toBe(201);
    for (const url of ["/api/bills", "/api/billing-printers", "/api/reports/day-end", `/api/bills/${issued.json().bill.id}/receipt`, `/api/bills/${issued.json().bill.id}/upi-qr`]) {
      expect((await app.inject({ url, headers: auth(waiter.token) })).statusCode).toBe(403);
      expect((await app.inject({ url })).statusCode).toBe(401);
    }
  });
  it("reports bill-date sales separately from collection-date payments and validates dates", async () => {
    const old = await issue(await order()); const today = await issue(await order());
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(new Date(2026, 8, 26, 23, 59).getTime(), old.id);
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(new Date(2026, 8, 27, 0, 0).getTime(), today.id);
    await pay(old);
    app.db.prepare("UPDATE payments SET created_at = ? WHERE bill_id = ?").run(new Date(2026, 8, 27, 12).getTime(), old.id);
    const report = (await app.inject({ url: "/api/reports/day-end?date=2026-09-27", headers: auth(token) })).json().report;
    expect(report.sales).toMatchObject({ billCount: 1, totalPaise: 10500, outstandingPaise: 10500 });
    expect(report.payments).toEqual([{ mode: "cash", amountPaise: 10500 }]);
    expect(report.taxes).toEqual([{ gstRate: 5, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250 }]);
    expect((await app.inject({ url: "/api/reports/day-end?date=2026-02-30", headers: auth(token) })).statusCode).toBe(400);
  });
});
