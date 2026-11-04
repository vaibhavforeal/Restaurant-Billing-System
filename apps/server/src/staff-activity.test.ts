import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { localDateKey, uuidv7, type Bill, type OperationalReport } from "@masalapos/domain";
import { auth, createUser, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";

describe("staff activity report", () => {
  let app: FastifyInstance, token: string, cashier: { id: string; token: string }, thali: string, kebab: string;
  const request = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object, as = token) =>
    app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  async function ok(method: "POST" | "PUT" | "PATCH", url: string, payload: object, as = token) {
    const res = await request(method, url, payload, as);
    expect(res.statusCode, res.body).toBeLessThan(400); return res.json();
  }
  async function order(as: string, productId: string) {
    const { order: created } = await ok("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" }, as);
    const { order: punched } = await ok("POST", `/api/orders/${created.id}/items`, { items: [{ productId, qty: 1, clientRef: uuidv7() }] }, as);
    return punched as { id: string; items: Array<{ id: string }> };
  }
  async function bill(as: string, discount: object = {}) {
    const { id } = await order(as, thali);
    const { preview } = await ok("POST", `/api/orders/${id}/bill-preview`, discount, as);
    return (await ok("POST", `/api/orders/${id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey, ...discount }, as)).bill as Bill;
  }
  const today = () => localDateKey(Date.now());
  const report = async (as = token) => {
    const res = await request("GET", `/api/reports/staff-activity?from=${today()}&to=${today()}`, undefined, as);
    return { status: res.statusCode, report: res.statusCode === 200 ? res.json().report as OperationalReport & { kind: string } : null, headers: res.headers };
  };
  const whys = (r: OperationalReport) => r.tables[0]!.rows.map((row) => `${row.staff}: ${row.why}`).sort();

  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app));
    cashier = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
    const { category } = await ok("POST", "/api/categories", { name: "Food" });
    const kitchen = (app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string }).id;
    const { printer } = await ok("POST", "/api/printers", { name: "Kitchen", kind: "network", connection: "127.0.0.1:9100", paperWidth: 80 });
    await ok("PATCH", `/api/kot-stations/${kitchen}`, { printerId: printer.id });
    thali = (await ok("POST", "/api/products", { name: "Thali", categoryId: category.id, pricePaise: 25000, gstRate: 0, kotStationId: null })).product.id;
    kebab = (await ok("POST", "/api/products", { name: "Kebab", categoryId: category.id, pricePaise: 30000, gstRate: 0, kotStationId: kitchen })).product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  it("lists each person's activity and flags a paid bill voided, a big discount, a big pay-out and a short drawer", async () => {
    const { shift } = await ok("POST", "/api/shifts", { clientRef: uuidv7(), openingFloatPaise: 100000 }, cashier.token);
    const paid = await bill(cashier.token);
    await ok("POST", `/api/bills/${paid.id}/settle`, { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: paid.totalPaise }] }, cashier.token);
    await ok("POST", `/api/bills/${paid.id}/void`, { clientRef: uuidv7(), reason: "Wrong order", approverPin: "1234", refunds: [{ mode: "cash", amountPaise: paid.totalPaise }] }, cashier.token);
    await bill(token, { discountPaise: 7500, discountNote: "Friend" });
    const sent = await order(cashier.token, kebab);
    const kot = await request("POST", `/api/orders/${sent.id}/send`, undefined, cashier.token);
    expect(kot.statusCode, kot.body).toBeLessThan(400);
    await ok("POST", `/api/order-items/${sent.items[0]!.id}/cancel`, { reason: "Guest left" }, cashier.token);
    await ok("POST", `/api/shifts/${shift.id}/cash-movements`, { clientRef: uuidv7(), kind: "pay_out", amountPaise: 60000, reason: "Vegetables" }, cashier.token);
    // Expected: ₹1,000 float + ₹250 sale − ₹250 refund − ₹600 pay-out = ₹400; counted ₹100, so ₹300 short.
    await ok("POST", `/api/shifts/${shift.id}/close`, { clientRef: uuidv7(), countedCashPaise: 10000, note: "" }, cashier.token);

    const { status, report: r, headers } = await report();
    expect(status).toBe(200);
    expect(headers["cache-control"]).toBe("no-store");
    expect(r!.kind).toBe("staff-activity");
    expect(whys(r!)).toEqual(["Asha: Discount of 20% or more", "Meena: Cash short by ₹200.00 or more", "Meena: Paid bill voided", "Meena: Pay-out over ₹500.00"]);
    const voided = r!.tables[0]!.rows.find((row) => row.why === "Paid bill voided")!;
    expect(voided).toMatchObject({ what: "Void or refund", amount: 25000, reference: `Bill #${paid.billNo}` });
    expect(String(voided.detail)).toMatch(/Wrong order.*approved by Asha/);
    const meena = r!.tables[1]!.rows.find((row) => row.staff === "Meena")!;
    expect(meena).toMatchObject({ cancelled: 1, creditNotes: 1, creditPaise: 25000, cashShortPaise: 30000, payOutPaise: 60000, flags: 3 });
  });

  it("is for admins only", async () => {
    expect((await report(cashier.token)).status).toBe(403);
  });

  it("reads and saves the alert limits, which the report then uses", async () => {
    const defaults = await request("GET", "/api/settings/activity-alerts");
    expect(defaults.json()).toEqual({ thresholds: { cashShortPaise: 20000, discountPercent: 20, payOutPaise: 50000, multiplier: 2, minEvents: 3 } });
    await bill(token, { discountPaise: 7500, discountNote: "Friend" });
    expect(whys((await report()).report!)).toEqual(["Asha: Discount of 20% or more"]);
    const saved = await request("PUT", "/api/settings/activity-alerts", { cashShortPaise: 50000, discountPercent: 40, payOutPaise: 100000, multiplier: 3, minEvents: 5 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().thresholds).toEqual({ cashShortPaise: 50000, discountPercent: 40, payOutPaise: 100000, multiplier: 3, minEvents: 5 });
    expect(whys((await report()).report!)).toEqual([]);
    expect((await request("PUT", "/api/settings/activity-alerts", { cashShortPaise: 50000, discountPercent: 40, payOutPaise: 100000, multiplier: 0.5, minEvents: 5 })).statusCode).toBe(400);
    expect((await request("PUT", "/api/settings/activity-alerts", { cashShortPaise: 1, discountPercent: 1, payOutPaise: 1, multiplier: 2, minEvents: 1 }, cashier.token)).statusCode).toBe(403);
  });
});
