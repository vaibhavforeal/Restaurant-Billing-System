import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@forkflow/domain";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

describe("discount caps", () => {
  let app: FastifyInstance;
  let token: string;
  let productId: string;
  beforeEach(async () => {
    app = freshApp();
    ({ token } = await setupAdmin(app));
    const category = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const product = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Meal", categoryId: category.json().category.id, pricePaise: 10000, gstRate: 5, kotStationId: null } });
    productId = product.json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });
  async function order(): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/orders", headers: auth(token), payload: { clientRef: uuidv7(), type: "parcel", tableId: null } });
    const id = res.json().order.id as string;
    await app.inject({ method: "POST", url: `/api/orders/${id}/items`, headers: auth(token), payload: { items: [{ productId, qty: 1, clientRef: uuidv7() }] } });
    return id;
  }
  const preview = (orderId: string, tok: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/orders/${orderId}/bill-preview`, headers: auth(tok), payload });
  const put = (caps: unknown) => app.inject({ method: "PUT", url: "/api/discount-caps", headers: auth(token), payload: { caps } });

  it("lists the seeded limits and lets an admin change them", async () => {
    const list = await app.inject({ url: "/api/discount-caps", headers: auth(token) });
    expect(list.json().caps).toEqual([
      { role: "admin", maxPercent: null }, { role: "cashier", maxPercent: 10 },
      { role: "waiter", maxPercent: 0 }, { role: "kitchen", maxPercent: 0 },
    ]);
    expect((await put([{ role: "cashier", maxPercent: 25 }])).json().caps[1]).toEqual({ role: "cashier", maxPercent: 25 });
    expect((await put([{ role: "cashier", maxPercent: 101 }])).statusCode).toBe(400);
    expect((await put([{ role: "admin", maxPercent: 5 }])).statusCode).toBe(400);
    const cashier = await createUser(app, token, { name: "Cashier", pin: "3333", role: "cashier" });
    expect((await app.inject({ url: "/api/discount-caps", headers: auth(cashier.token) })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/discount-caps/mine", headers: auth(cashier.token) })).json()).toEqual({ maxPercent: 25 });
  });

  it("uses a per-user override ahead of the role limit, and null returns to the role", async () => {
    const cashier = await createUser(app, token, { name: "Cashier", pin: "3333", role: "cashier" });
    const id = await order();
    expect((await preview(id, cashier.token, { discountPaise: 1500, discountNote: "Regular" })).statusCode).toBe(403);
    const set = await app.inject({ method: "PATCH", url: `/api/users/${cashier.id}`, headers: auth(token), payload: { maxDiscountPercent: 20 } });
    expect(set.json().user.maxDiscountPercent).toBe(20);
    expect((await preview(id, cashier.token, { discountPaise: 1500, discountNote: "Regular" })).statusCode).toBe(200);
    await app.inject({ method: "PATCH", url: `/api/users/${cashier.id}`, headers: auth(token), payload: { maxDiscountPercent: null } });
    expect((await preview(id, cashier.token, { discountPaise: 1500, discountNote: "Regular" })).statusCode).toBe(403);
  });

  it("asks for an admin PIN above the limit, never stores it, and records the approver", async () => {
    const cashier = await createUser(app, token, { name: "Cashier", pin: "3333", role: "cashier" });
    const id = await order();
    const payload = { discountPaise: 2000, discountNote: "Complaint" };
    const refused = await preview(id, cashier.token, payload);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("discount_cap");
    expect((await preview(id, cashier.token, { ...payload, approverPin: "9999" })).statusCode).toBe(401);
    const ok = await preview(id, cashier.token, { ...payload, approverPin: "1234" });
    expect(ok.statusCode).toBe(200);
    const bill = { clientRef: uuidv7(), previewKey: ok.json().preview.previewKey, ...payload };
    const noPin = await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(cashier.token), payload: bill });
    expect(noPin.statusCode).toBe(403);
    const send = () => app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(cashier.token), payload: { ...bill, approverPin: "1234" } });
    const issued = await send();
    expect(issued.statusCode).toBe(201);
    const row = app.db.prepare("SELECT discount_approved_by AS by, request_json AS req FROM bills").get() as { by: string; req: string };
    expect(row.by).toBe((app.db.prepare("SELECT id FROM users WHERE role = 'admin'").get() as { id: string }).id);
    expect(row.req).not.toContain("1234");
    // A retry with the same reference answers from the saved bill even with the PIN omitted.
    const replay = await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(cashier.token), payload: bill });
    expect(replay.statusCode).toBe(200);
  });

  it("lets an admin discount without a PIN and treats a role with no limit row as 0%", async () => {
    const id = await order();
    expect((await preview(id, token, { discountPaise: 9000, discountNote: "Owner" })).statusCode).toBe(200);
    app.db.prepare("DELETE FROM discount_caps WHERE role = 'cashier'").run();
    const cashier = await createUser(app, token, { name: "Cashier", pin: "3333", role: "cashier" });
    expect((await preview(id, cashier.token, { discountPaise: 100, discountNote: "Tiny" })).statusCode).toBe(403);
  });
});
