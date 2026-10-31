import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type Bill } from "@masalapos/domain";
import { auth, createUser, enableIntegration, freshApp, setupAdmin } from "./test-helpers.js";
import { receiptHtml, receiptSlip } from "./print/receipt.js";

describe("customers and loyalty", () => {
  let app: FastifyInstance; let token: string; let productId: string;
  beforeEach(async () => {
    app = freshApp(); ({ token } = await setupAdmin(app)); enableIntegration(app, "crm");
    const c = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const p = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Thali", categoryId: c.json().category.id, pricePaise: 50000, gstRate: 5, kotStationId: null } });
    productId = p.json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  const request = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object, as = token) => app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  async function customer(name = "Priya", phone = "98765 43210", typeId: string | null = null) {
    const res = await request("POST", "/api/customers", { name, phone, typeId });
    expect(res.statusCode).toBe(201); return res.json().customer as { id: string; pointsBalance: number };
  }
  async function order(customerId: string | null, qty = 1) {
    const id = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order.id as string;
    await request("POST", `/api/orders/${id}/items`, { items: [{ productId, qty, clientRef: uuidv7() }] });
    if (customerId) expect((await request("PATCH", `/api/orders/${id}/customer`, { customerId })).statusCode).toBe(200);
    return id;
  }
  async function bill(orderId: string, extra: Record<string, unknown> = {}, as = token) {
    const preview = await request("POST", `/api/orders/${orderId}/bill-preview`, extra, as);
    expect(preview.statusCode).toBe(200);
    const res = await request("POST", `/api/orders/${orderId}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey, ...extra }, as);
    expect(res.statusCode).toBe(201); return res.json().bill as Bill;
  }
  const loyalty = (body: object) => request("PUT", "/api/loyalty-settings", { enabled: true, pointsPer100: 1, pointValuePaise: 100, minRedeemPoints: 0, ...body });

  it("saves customers by mobile number and finds them by number or name", async () => {
    const priya = await customer();
    expect((await request("POST", "/api/customers", { name: "Other", phone: "+91 9876543210" })).statusCode).toBe(409);
    expect((await request("POST", "/api/customers", { name: "Bad", phone: "12345" })).statusCode).toBe(400);
    expect((await request("GET", "/api/customers?q=98765")).json().customers.map((c: { id: string }) => c.id)).toEqual([priya.id]);
    expect((await request("GET", "/api/customers?q=pri")).json().customers).toHaveLength(1);
    expect((await request("GET", "/api/customers?q=+91%209876543210")).json().customers).toHaveLength(1);
    const waiter = await createUser(app, token, { name: "Arun", pin: "5555", role: "waiter" });
    expect((await request("GET", "/api/customers", undefined, waiter.token)).statusCode).toBe(200);
    expect((await request("POST", "/api/customers", { name: "X", phone: "9123456780" }, waiter.token)).statusCode).toBe(403);
    const cashier = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
    expect((await request("POST", "/api/customers", { name: "X", phone: "9123456780" }, cashier.token)).statusCode).toBe(201);
    expect((await request("PUT", "/api/loyalty-settings", { enabled: true, pointsPer100: 1, pointValuePaise: 100, minRedeemPoints: 0 }, cashier.token)).statusCode).toBe(403);
  });

  it("applies the best customer-type slab on top of the manual discount, outside the cashier's limit", async () => {
    const type = await request("POST", "/api/customer-types", { name: "Regular", slabs: [{ minBillPaise: 0, percent: 5 }, { minBillPaise: 100000, percent: 10 }] });
    expect(type.statusCode).toBe(201);
    const priya = await customer("Priya", "9876543210", type.json().customerType.id);
    const cashier = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
    const small = await bill(await order(priya.id), {}, cashier.token);
    expect(small.discountPaise).toBe(2500);
    expect(small.discountNote).toBe("Regular 5%");
    expect(small.receipt.customer).toMatchObject({ name: "Priya", phone: "******3210", typeName: "Regular", slabPercent: 5, customerDiscountPaise: 2500 });
    // ₹1,000: the 10% slab (₹100) plus a manual ₹50 (5%, within the 10% limit) = ₹150.
    const big = await bill(await order(priya.id, 2), { discountPaise: 5000, discountNote: "Birthday" }, cashier.token);
    expect(big.discountPaise).toBe(15000);
    expect(big.discountNote).toBe("Birthday · Regular 10%");
    expect(app.db.prepare("SELECT customer_id, customer_discount_paise FROM bills WHERE id = ?").get(big.id)).toEqual({ customer_id: priya.id, customer_discount_paise: 10000 });
    await request("PATCH", `/api/customer-types/${type.json().customerType.id}`, { isActive: false });
    expect((await bill(await order(priya.id))).discountPaise).toBe(0);
  });

  it("earns points on the bill total, redeems them as a discount, and shows them on the receipt", async () => {
    await loyalty({ pointsPer100: 2 });
    const priya = await customer();
    const first = await bill(await order(priya.id, 2));
    expect(first.receipt.customer).toMatchObject({ pointsEarned: 20, pointsBalance: 20 });
    expect((await request("GET", `/api/customers/${priya.id}`)).json().customer.pointsBalance).toBe(20);
    expect((await request("POST", `/api/orders/${await order(priya.id)}/bill-preview`, { redeemPoints: 21 })).statusCode).toBe(400);
    const second = await bill(await order(priya.id), { redeemPoints: 15 });
    expect(second.discountPaise).toBe(1500);
    expect(second.discountNote).toBe("15 loyalty points");
    // ₹500 − ₹15 = ₹485 → 4 × 2 points.
    expect(second.receipt.customer).toMatchObject({ pointsRedeemed: 15, pointsValuePaise: 1500, pointsEarned: 8, pointsBalance: 13 });
    expect(receiptSlip(second, 80).toString("latin1")).toContain("Points earned: 8 | Balance: 13");
    expect(receiptHtml(second)).toContain("Points redeemed: 15");
    await loyalty({ minRedeemPoints: 50 });
    expect((await request("POST", `/api/orders/${await order(priya.id)}/bill-preview`, { redeemPoints: 10 })).statusCode).toBe(400);
    await loyalty({ enabled: false });
    expect((await bill(await order(priya.id))).receipt.customer?.pointsEarned).toBeUndefined();
    expect((await request("POST", `/api/orders/${await order(null)}/bill-preview`, { redeemPoints: 1 })).statusCode).toBe(400);
  });

  it("takes points back on a void and a refund, and returns redeemed points on a void", async () => {
    await loyalty({});
    const priya = await customer();
    await request("POST", `/api/customers/${priya.id}/loyalty-adjustments`, { clientRef: uuidv7(), points: 10, note: "Welcome" });
    const voided = await bill(await order(priya.id, 2), { redeemPoints: 10 });
    expect((await request("GET", `/api/customers/${priya.id}`)).json().customer.pointsBalance).toBe(9);
    expect((await request("POST", `/api/bills/${voided.id}/void`, { clientRef: uuidv7(), reason: "Wrong order", refunds: [] })).statusCode).toBe(201);
    expect((await request("GET", `/api/customers/${priya.id}`)).json().customer.pointsBalance).toBe(10);

    const refunded = await bill(await order(priya.id, 4));
    expect((await request("GET", `/api/customers/${priya.id}`)).json().customer.pointsBalance).toBe(30);
    const settle = await request("POST", `/api/bills/${refunded.id}/settle`, { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: refunded.totalPaise }] });
    expect(settle.statusCode).toBe(200);
    const itemId = (app.db.prepare("SELECT order_item_id AS id FROM bill_report_lines WHERE bill_id = ?").get(refunded.id) as { id: string }).id;
    const lines = [{ orderItemId: itemId, qty: 1 }];
    const credit = (await request("POST", `/api/bills/${refunded.id}/credit-preview`, { kind: "refund", lines })).json();
    const refund = await request("POST", `/api/bills/${refunded.id}/refund`, { clientRef: uuidv7(), reason: "Cold", lines, refunds: [{ mode: "cash", amountPaise: credit.preview.totals.totalPaise }] });
    expect(refund.statusCode).toBe(201);
    // A quarter of the bill credited: a quarter of the 20 points comes back off the balance.
    expect((await request("GET", `/api/customers/${priya.id}`)).json().customer.pointsBalance).toBe(25);
    const ledger = (await request("GET", `/api/customers/${priya.id}`)).json().ledger as Array<{ kind: string; points: number }>;
    expect(ledger.map((l) => `${l.kind}:${l.points}`).sort()).toEqual(["adjust:10", "earn:20", "earn:9", "redeem:-10", "reverse:-5", "reverse:-9", "reverse:10"]);
  });

  it("attaches customers only to open non-Zomato orders", async () => {
    const priya = await customer();
    const id = await order(null);
    expect((await request("PATCH", `/api/orders/${id}/customer`, { customerId: "missing" })).statusCode).toBe(400);
    const attached = await request("PATCH", `/api/orders/${id}/customer`, { customerId: priya.id });
    expect(attached.json().order.customer).toMatchObject({ name: "Priya", phone: "9876543210" });
    expect((await request("PATCH", `/api/orders/${id}/customer`, { customerId: null })).json().order.customer).toBeNull();
    await bill(id);
    expect((await request("PATCH", `/api/orders/${id}/customer`, { customerId: priya.id })).statusCode).toBe(409);
  });
});
