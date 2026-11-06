import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type Bill } from "@masalapos/domain";
import { auth, createUser, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";
import { billUpiPayment } from "./print/upi.js";

describe("billing and day-end", () => {
  let app: FastifyInstance;
  let token: string;
  let adminName: string;
  let productId: string;
  let fake: ReturnType<typeof freshAppWithFakeSink>["fake"];
  beforeEach(async () => {
    ({ app, fake } = freshAppWithFakeSink());
    let admin;
    ({ token, user: admin } = await setupAdmin(app)); adminName = admin.name;
    const category = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const product = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Meal", categoryId: category.json().category.id, pricePaise: 10500, gstRate: 5, kotStationId: null } });
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
  it("bills a table with sent, not-done KOTs", async () => {
    const table = await app.inject({ method: "POST", url: "/api/tables", headers: auth(token), payload: { name: "T1" } });
    const station = app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string };
    app.db.prepare("UPDATE products SET kot_station_id = ? WHERE id = ?").run(station.id, productId);
    const id = await order(table.json().table.id);
    const sent = await app.inject({ method: "POST", url: `/api/orders/${id}/send`, headers: auth(token) });
    const kotId = sent.json().kots[0].id;
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/bill-preview`, headers: auth(token), payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/orders/${id}`, headers: auth(token) })).json().order).not.toHaveProperty("kitchenAcceptanceRequired");
    expect((await issue(id)).totalPaise).toBe(10500);
    expect(app.db.prepare("SELECT accepted_at, done_at FROM kots WHERE id = ?").get(kotId)).toEqual({ accepted_at: null, done_at: null });
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
    const id = await order(); const payload = await billRequest(id, { discountPaise: 10500, discountNote: "Complimentary" });
    const free = (await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload })).json().bill as Bill;
    expect(free.totalPaise).toBe(0); expect((await pay(free)).statusCode).toBe(200);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 0 });
  });
  const putSettings = (fields: object) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { restaurantName: "Cafe", gstin: "29ABCDE1234F1Z5", ...fields } });
  it("issues a tax invoice in included mode and keeps the receipt snapshot despite later settings and catalog edits", async () => {
    const profile = { restaurantName: "Original", address: "12 MG Road", gstin: "29ABCDE1234F1Z5", fssai: "12345678901234", gstMode: "included", receiptStyle: "modern" };
    expect((await app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: profile })).statusCode).toBe(200);
    const bill = await issue(await order());
    expect(bill.receipt.gstMode).toBe("included");
    expect(bill).toMatchObject({ subtotalPaise: 10500, totalPaise: 10500, cgstPaise: 250, sgstPaise: 250 });
    expect(bill.taxes).toEqual([{ gstRate: 5, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250 }]);
    expect(bill.receipt.receiptStyle).toBe("modern");
    expect(bill.receipt).toMatchObject({ address: "12 MG Road, Bengaluru, Karnataka - 560001", phone: "9845012345" });
    await app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { restaurantName: "Changed", gstMode: "none", receiptStyle: "compact" } });
    app.db.prepare("UPDATE products SET name = 'Changed', price_paise = 20000 WHERE id = ?").run(productId);
    const stored = (await app.inject({ url: `/api/bills/${bill.id}`, headers: auth(token) })).json().bill;
    expect(stored).toEqual(bill);
    const receipt = await app.inject({ url: `/api/bills/${bill.id}/receipt`, headers: auth(token) });
    expect(receipt.body).toContain("Original"); expect(receipt.body).not.toContain("Changed");
    expect(receipt.body).toContain("<h2>Tax invoice</h2>"); expect(receipt.body).toContain("Includes GST");
    expect(receipt.body).toContain('class="bill bill--modern"');
    const later = await issue(await order());
    expect(later.receipt.gstMode).toBe("none"); expect(later.cgstPaise).toBe(0);
  });
  it("freezes header, print toggles and served-by into the bill", async () => {
    expect((await putSettings({ receiptHeader: "Pure veg", billShowItemGst: true })).statusCode).toBe(200);
    const bill = await issue(await order());
    expect(bill.receipt).toMatchObject({ receiptHeader: "Pure veg", billShow: { fssai: true, customer: true, table: true, servedBy: false, itemGst: true }, servedBy: adminName });
    expect((await putSettings({ receiptHeader: "Changed", billShowItemGst: false, billShowServedBy: true })).statusCode).toBe(200);
    const stored = (await app.inject({ url: `/api/bills/${bill.id}`, headers: auth(token) })).json().bill as Bill;
    expect(stored.receipt.receiptHeader).toBe("Pure veg");
    expect(stored.receipt.billShow).toEqual({ fssai: true, customer: true, table: true, servedBy: false, itemGst: true });
  });
  it("issues a GST-free bill in none mode, whatever the GSTIN, and leaves earlier bills alone", async () => {
    const before = await issue(await order());
    expect(before.receipt.gstMode).toBe("included");
    expect((await putSettings({ gstMode: "none" })).json().settings.gstMode).toBe("none");
    const bill = await issue(await order());
    expect(bill).toMatchObject({ subtotalPaise: 10500, cgstPaise: 0, sgstPaise: 0, totalPaise: 10500 });
    expect(bill.receipt.gstMode).toBe("none");
    expect(app.db.prepare("SELECT taxable_paise AS t, cgst_paise + sgst_paise AS tax FROM bill_report_lines WHERE bill_id = ?").get(bill.id)).toEqual({ t: 10500, tax: 0 });
    const receipt = (await app.inject({ url: `/api/bills/${bill.id}/receipt`, headers: auth(token) })).body;
    expect(receipt).toContain("Bill of supply"); expect(receipt).toContain("GSTIN: 29ABCDE1234F1Z5");
    expect(receipt).not.toMatch(/CGST|SGST|Taxable @|Includes GST/);
    await putSettings({ gstMode: "included" });
    expect((await issue(await order())).cgstPaise).toBe(250);
    expect((await app.inject({ url: `/api/bills/${before.id}`, headers: auth(token) })).json().bill).toEqual(before);
  });
  it("keeps report lines non-negative and adding up to the bill in every GST mode", async () => {
    const category = (await app.inject({ url: "/api/categories", headers: auth(token) })).json().categories[0].id as string;
    const soda = (await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Soda", categoryId: category, pricePaise: 9013, gstRate: 18, kotStationId: null } })).json().product.id as string;
    for (const gstMode of ["included", "exclusive", "none"]) {
      expect((await putSettings({ gstMode })).statusCode, gstMode).toBe(200);
      const res = await app.inject({ method: "POST", url: "/api/orders", headers: auth(token), payload: { clientRef: uuidv7(), type: "parcel", tableId: null } });
      const id = res.json().order.id as string;
      await app.inject({ method: "POST", url: `/api/orders/${id}/items`, headers: auth(token), payload: { items: [{ productId, qty: 1, clientRef: uuidv7() }, { productId: soda, qty: 2, clientRef: uuidv7() }] } });
      const bill = (await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: await billRequest(id, { discountPaise: 4603, discountNote: "Regular" }) })).json().bill as Bill;
      expect(bill.receipt.gstMode).toBe(gstMode);
      const lines = app.db.prepare("SELECT discount_paise AS d, taxable_paise AS t, cgst_paise AS c, sgst_paise AS s, rounding_paise AS r, total_paise AS total FROM bill_report_lines WHERE bill_id = ? AND parent_order_item_id IS NULL").all(bill.id) as Array<{ d: number; t: number; c: number; s: number; r: number; total: number }>;
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line.d, gstMode).toBeGreaterThanOrEqual(0);
        expect(line.total, gstMode).toBe(line.t + line.c + line.s + line.r);
      }
      expect(lines.reduce((sum, l) => sum + l.d, 0), gstMode).toBe(4603);
      expect(lines.reduce((sum, l) => sum + l.total, 0), gstMode).toBe(bill.totalPaise);
    }
  });
  it("issues a tax invoice with GST added on top and keeps it when the setting switches back", async () => {
    expect((await putSettings({ gstMode: "exclusive" })).statusCode).toBe(200);
    const bill = await issue(await order());
    // ₹105 before GST at 5%: CGST = SGST = round-half-up(262.5) = 263; 110.26 rounds to 110.
    expect(bill).toMatchObject({ subtotalPaise: 10500, cgstPaise: 263, sgstPaise: 263, roundingPaise: -26, totalPaise: 11000 });
    expect(bill.taxes).toEqual([{ gstRate: 5, taxablePaise: 10500, cgstPaise: 263, sgstPaise: 263 }]);
    expect(bill.receipt).toMatchObject({ gstMode: "exclusive", sacCode: "996331" });
    expect((await putSettings({ gstMode: "included" })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/bills/${bill.id}`, headers: auth(token) })).json().bill).toEqual(bill);
    const receipt = (await app.inject({ url: `/api/bills/${bill.id}/receipt`, headers: auth(token) })).body;
    expect(receipt).toContain("<h2>Tax invoice</h2>"); expect(receipt).toContain("CGST 2.5% on 105.00"); expect(receipt).not.toContain("Includes GST");
    const day = (await app.inject({ url: "/api/reports/day-end", headers: auth(token) })).json().report;
    expect(day.sales).toMatchObject({ billCount: 1, totalPaise: 11000 });
    expect(day.taxes).toEqual([{ gstRate: 5, taxablePaise: 10500, cgstPaise: 263, sgstPaise: 263 }]);
    expect(day.noGstSalesPaise).toBe(0);
  });
  it("refuses to issue a bill from a preview taken before the GST mode changed", async () => {
    const id = await order(); const body = await billRequest(id);
    expect((await putSettings({ gstMode: "none" })).statusCode).toBe(200);
    const res = await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: body });
    expect(res.statusCode).toBe(409);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bills").get()).toEqual({ n: 0 });
    const fresh = await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: await billRequest(id) });
    expect(fresh.statusCode).toBe(201); expect(fresh.json().bill.receipt.gstMode).toBe("none");
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
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/bill-preview`, headers: auth(cashier.token), payload: { discountPaise: 1051, discountNote: "Test" } })).statusCode).toBe(403);
    const prev = await app.inject({ method: "POST", url: `/api/orders/${id}/bill-preview`, headers: auth(cashier.token), payload: { discountPaise: 1050, discountNote: "Test" } });
    expect(prev.statusCode).toBe(200);
    const issued = await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(cashier.token), payload: { clientRef: uuidv7(), previewKey: prev.json().preview.previewKey, discountPaise: 1050, discountNote: "Test" } });
    expect(issued.statusCode).toBe(201);
    for (const url of ["/api/bills", "/api/billing-printers", "/api/reports/day-end", `/api/bills/${issued.json().bill.id}/receipt`, `/api/bills/${issued.json().bill.id}/upi-qr`]) {
      expect((await app.inject({ url, headers: auth(waiter.token) })).statusCode).toBe(403);
      expect((await app.inject({ url })).statusCode).toBe(401);
    }
  });
  it("reports sales without GST on their own line, outside the GST breakdown, net taxable value and credited tax", async () => {
    const gst = await issue(await order());
    app.db.prepare("UPDATE settings SET gst_mode = 'none' WHERE id = 1").run();
    const plain = await issue(await order());
    expect(plain.totalPaise).toBe(10500);
    const day = (await app.inject({ url: "/api/reports/day-end", headers: auth(token) })).json().report;
    expect(day.sales).toMatchObject({ billCount: 2, totalPaise: gst.totalPaise + plain.totalPaise });
    expect(day.taxes).toEqual([{ gstRate: 5, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250 }]);
    expect(day.noGstSalesPaise).toBe(plain.totalPaise);
    expect(day.net).toEqual({ totalPaise: 21000, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250 });
    expect(day.zomatoSuppliesPaise).toBe(0);

    // Refunding one of the no-GST bill lines lowers the credited total only: it carries no taxable value or tax rows.
    await pay(plain);
    const orderItemId = (app.db.prepare("SELECT order_item_id AS id FROM bill_report_lines WHERE bill_id = ?").get(plain.id) as { id: string }).id;
    const refund = await app.inject({ method: "POST", url: `/api/bills/${plain.id}/refund`, headers: auth(token),
      payload: { clientRef: uuidv7(), reason: "Cold food", lines: [{ orderItemId, qty: 1 }], refunds: [{ mode: "cash", amountPaise: 10500 }], approverPin: "1234" } });
    expect(refund.statusCode, refund.body).toBe(201);
    const after = (await app.inject({ url: "/api/reports/day-end", headers: auth(token) })).json().report;
    expect(after.creditNotes).toEqual({ count: 1, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, totalPaise: 10500, taxes: [] });
    expect(after.noGstSalesPaise).toBe(plain.totalPaise);
    expect(after.net).toEqual({ totalPaise: 10500, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250 });
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

  describe("invoice numbers and round-off", () => {
    afterEach(() => { vi.useRealTimers(); });
    const at = (d: Date) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(d); };
    const putSetting = async (fields: object) => expect((await app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { restaurantName: "Cafe", ...fields } })).statusCode).toBe(200);
    /** An open order holding one item at the given price. */
    async function orderAt(pricePaise: number) {
      const category = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: `Cat${pricePaise}` } });
      const product = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: `Item${pricePaise}`, categoryId: category.json().category.id, pricePaise, gstRate: 5, kotStationId: null } });
      const id = (await app.inject({ method: "POST", url: "/api/orders", headers: auth(token), payload: { clientRef: uuidv7(), type: "parcel", tableId: null } })).json().order.id as string;
      await app.inject({ method: "POST", url: `/api/orders/${id}/items`, headers: auth(token), payload: { items: [{ productId: product.json().product.id, qty: 1, clientRef: uuidv7() }] } });
      return id;
    }
    const previewOf = async (orderId: string) => (await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill-preview`, headers: auth(token), payload: { discountPaise: 0 } })).json().preview;

    it("numbers bills per financial year and adds the prefix", async () => {
      at(new Date(2026, 2, 31, 22, 0));
      expect((await issue(await order())).invoiceNo).toBe("25-26/0001");
      expect((await issue(await order())).invoiceNo).toBe("25-26/0002");
      at(new Date(2026, 3, 1, 0, 5));
      expect((await issue(await order())).invoiceNo).toBe("26-27/0001");
      await putSetting({ invoicePrefix: "MP" });
      expect((await issue(await order())).invoiceNo).toBe("MP/26-27/0002");
    });
    it("replays keep the number and a rejected request leaves no gap", async () => {
      at(new Date(2026, 5, 1, 12, 0));
      const id = await order(); const body = await billRequest(id);
      const send = () => app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: body });
      const first = await send(); const replay = await send();
      expect(first.statusCode).toBe(201); expect(replay.statusCode).toBe(200);
      expect(first.json().bill.invoiceNo).toBe("26-27/0001"); expect(replay.json().bill.invoiceNo).toBe("26-27/0001");
      const other = await order();
      const stale = await app.inject({ method: "POST", url: `/api/orders/${other}/bill`, headers: auth(token), payload: { clientRef: uuidv7(), discountPaise: 0, previewKey: "stale" } });
      expect(stale.statusCode).toBe(409);
      expect((await issue(other)).invoiceNo).toBe("26-27/0002");
    });
    it("rolls the invoice number back when the bill fails after the number is taken", async () => {
      at(new Date(2026, 5, 1, 12, 0));
      expect((await issue(await order())).invoiceNo).toBe("26-27/0001");
      const id = await order(); const body = await billRequest(id);
      app.db.exec("CREATE TRIGGER reject_tax_no BEFORE INSERT ON bill_taxes BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
      expect((await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: body })).statusCode).toBe(500);
      app.db.exec("DROP TRIGGER reject_tax_no");
      expect((await issue(id)).invoiceNo).toBe("26-27/0002");
      expect((await issue(await order())).invoiceNo).toBe("26-27/0003");
    });
    it("round-off off bills the exact amount", async () => {
      await putSetting({ roundOff: "off" });
      const bill = await issue(await orderAt(12345));
      expect(bill.totalPaise).toBe(12345); expect(bill.roundingPaise).toBe(0);
      const settle = await pay(bill);
      expect(settle.statusCode).toBe(200); expect(settle.json().bill.status).toBe("paid");
      const receipt = await app.inject({ url: `/api/bills/${bill.id}/receipt`, headers: auth(token) });
      expect(receipt.body).not.toContain("Round off");
    });
    it("round-off half rounds to 50 paise and changes the preview key", async () => {
      await putSetting({ roundOff: "half" });
      expect((await issue(await orderAt(12375))).totalPaise).toBe(12400);
      const id = await orderAt(12325);
      await putSetting({ roundOff: "rupee" });
      const rupee = await previewOf(id);
      await putSetting({ roundOff: "half" });
      const half = await previewOf(id);
      expect(rupee.totalPaise).toBe(12300); expect(half.totalPaise).toBe(12350);
      expect(half.previewKey).not.toBe(rupee.previewKey);
    });
    it("a bill from before invoice numbers shows its bill number", async () => {
      const bill = await issue(await order());
      app.db.prepare("UPDATE bills SET invoice_no = NULL WHERE id = ?").run(bill.id);
      const got = (await app.inject({ url: `/api/bills/${bill.id}`, headers: auth(token) })).json().bill as Bill;
      expect(got.invoiceNo).toBe(String(bill.billNo));
    });
    it("the UPI QR payload carries the invoice number", async () => {
      await putSetting({ upiId: "cafe@upi" });
      const bill = await issue(await order());
      const qr = (await app.inject({ url: `/api/bills/${bill.id}/upi-qr`, headers: auth(token) })).json();
      expect(qr.payment.invoiceNo).toBe(bill.invoiceNo);
    });
  });

  describe("service and packaging charges", () => {
    const charges = { serviceChargeBp: 1000, packagingChargePaise: 2000 };
    const post = (orderId: string, payload: object) => app.inject({ method: "POST", url: `/api/orders/${orderId}/bill`, headers: auth(token), payload });
    const previewOf = async (orderId: string, extra: object = {}) => (await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill-preview`, headers: auth(token), payload: extra })).json().preview;
    async function dineIn(empty = false) {
      const table = (await app.inject({ method: "POST", url: "/api/tables", headers: auth(token), payload: { name: `T${uuidv7().slice(-6)}` } })).json().table.id as string;
      return order(table, empty);
    }
    async function customParcel(kind: "delivery" | "takeaway") {
      const type = (await app.inject({ method: "POST", url: "/api/order-types", headers: auth(token), payload: { name: `Custom ${kind}`, kind } })).json().orderType.id as string;
      const id = await order();
      app.db.prepare("UPDATE orders SET order_type_id = ? WHERE id = ?").run(type, id);
      return id;
    }
    beforeEach(async () => { expect((await putSettings(charges)).statusCode).toBe(200); });

    it("charges service on dine-in and packaging on takeaway and delivery parcels, and records the order kind", async () => {
      const dine = await issue(await dineIn());
      expect(dine.charges).toEqual([{ kind: "service", label: "Service charge", percentBp: 1000, gstRate: 5, amountPaise: 1050, taxablePaise: expect.any(Number), cgstPaise: expect.any(Number), sgstPaise: expect.any(Number) }]);
      expect(dine.receipt.orderTypeKind).toBe("dine_in");
      expect(app.db.prepare("SELECT charges_paise FROM bills WHERE id = ?").get(dine.id)).toEqual({ charges_paise: 1050 });
      const takeaway = await issue(await order());
      expect(takeaway.charges!.map((c) => [c.kind, c.amountPaise, c.percentBp])).toEqual([["packaging", 2000, undefined]]);
      expect(takeaway.receipt.orderTypeKind).toBe("takeaway");
      const delivery = await issue(await customParcel("delivery"));
      expect(delivery.charges!.map((c) => c.kind)).toEqual(["packaging"]);
      expect(delivery.receipt.orderTypeKind).toBe("delivery");
    });
    it("lets the cashier remove the service charge, with a different preview key, and records it", async () => {
      const id = await dineIn();
      const kept = await previewOf(id), removed = await previewOf(id, { serviceCharge: false });
      expect(kept.charges).toHaveLength(1); expect(removed.charges).toEqual([]);
      expect(removed.previewKey).not.toBe(kept.previewKey);
      expect((await post(id, { clientRef: uuidv7(), previewKey: kept.previewKey, serviceCharge: false })).statusCode).toBe(409);
      const res = await post(id, { clientRef: uuidv7(), previewKey: removed.previewKey, serviceCharge: false });
      expect(res.statusCode).toBe(201);
      expect(res.json().bill.charges).toEqual([]);
      expect(res.json().bill.receipt.serviceChargeRemoved).toBe(true);
    });
    it("refuses a preview taken before a charge setting changed", async () => {
      const id = await dineIn(); const key = (await previewOf(id)).previewKey;
      expect((await putSettings({ serviceChargeBp: 500 })).statusCode).toBe(200);
      const res = await post(id, { clientRef: uuidv7(), previewKey: key });
      expect(res.statusCode).toBe(409); expect(res.json().error).toBe("Order changed; review a fresh bill preview");
    });
    it("reprints the same charges and labels after the settings are cleared", async () => {
      await putSettings({ serviceChargeLabel: "Service" });
      const bill = await issue(await dineIn());
      await putSettings({ serviceChargeBp: 0, packagingChargePaise: 0 });
      const stored = (await app.inject({ url: `/api/bills/${bill.id}`, headers: auth(token) })).json().bill as Bill;
      expect(stored.charges).toEqual(bill.charges); expect(stored.charges![0]).toMatchObject({ label: "Service", percentBp: 1000 });
    });
    it("includes the charge tax in the day report on an exclusive bill", async () => {
      await putSettings({ ...charges, gstMode: "exclusive" });
      const bill = await issue(await dineIn());
      // 10500 + 1050 service; CGST = SGST = round-half-up(0.025 * 11550) = 289 (288.75).
      expect(bill).toMatchObject({ cgstPaise: 289, sgstPaise: 289 });
      const day = (await app.inject({ url: "/api/reports/day-end", headers: auth(token) })).json().report;
      expect(day.sales.totalPaise).toBe(bill.totalPaise);
      expect(day.taxes).toEqual([{ gstRate: 5, taxablePaise: 11550, cgstPaise: 289, sgstPaise: 289 }]);
    });
    it("keeps report lines adding up with the charges in every GST mode, with no line for a charge", async () => {
      const category = (await app.inject({ url: "/api/categories", headers: auth(token) })).json().categories[0].id as string;
      const soda = (await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Soda", categoryId: category, pricePaise: 9013, gstRate: 18, kotStationId: null } })).json().product.id as string;
      for (const gstMode of ["included", "exclusive", "none"]) {
        await putSettings({ ...charges, gstMode, gstRate: 18 });
        for (const dine of [true, false]) {
          const id = dine ? await dineIn(true) : await order(undefined, true);
          await app.inject({ method: "POST", url: `/api/orders/${id}/items`, headers: auth(token), payload: { items: [{ productId, qty: 1, clientRef: uuidv7() }, { productId: soda, qty: 2, clientRef: uuidv7() }] } });
          const bill = (await post(id, await billRequest(id, { discountPaise: 4603, discountNote: "Regular" }))).json().bill as Bill;
          expect(bill.charges, gstMode).toHaveLength(1);
          const lines = app.db.prepare("SELECT discount_paise AS d, total_paise AS total FROM bill_report_lines WHERE bill_id = ? AND parent_order_item_id IS NULL").all(bill.id) as Array<{ d: number; total: number }>;
          expect(lines, gstMode).toHaveLength(2);
          for (const line of lines) expect(line.d, gstMode).toBeGreaterThanOrEqual(0);
          expect(lines.reduce((sum, l) => sum + l.d, 0), gstMode).toBe(4603);
          const chargeTotal = bill.charges!.reduce((sum, c) => sum + c.taxablePaise + c.cgstPaise + c.sgstPaise, 0);
          expect(lines.reduce((sum, l) => sum + l.total, 0) + chargeTotal, gstMode).toBe(bill.totalPaise);
        }
      }
    });
  });
});
