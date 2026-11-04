import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type Bill } from "@masalapos/domain";
import { auth, createUser, enableIntegration, freshApp, setupAdmin } from "./test-helpers.js";

describe("CRM & Loyalty as a Marketplace add-on", () => {
  let app: FastifyInstance; let token: string; let productId: string;
  beforeEach(async () => {
    app = freshApp(); ({ token } = await setupAdmin(app));
    const c = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const p = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Thali", categoryId: c.json().category.id, pricePaise: 50000, gstRate: 5, kotStationId: null } });
    productId = p.json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  const request = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) => app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });
  const toggle = (enabled: boolean) => request("PATCH", "/api/integrations/crm", { enabled });
  async function order() {
    const id = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order.id as string;
    await request("POST", `/api/orders/${id}/items`, { items: [{ productId, qty: 2, clientRef: uuidv7() }] });
    return id;
  }
  async function bill(orderId: string) {
    const preview = await request("POST", `/api/orders/${orderId}/bill-preview`, {});
    const res = await request("POST", `/api/orders/${orderId}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey });
    expect(res.statusCode).toBe(201); return res.json().bill as Bill;
  }

  it("starts off on a new installation and refuses CRM requests until turned on", async () => {
    for (const [method, url] of [["GET", "/api/customers"], ["GET", "/api/loyalty-settings"], ["GET", "/api/loyalty-tiers"], ["GET", "/api/customer-segments"],
      ["GET", "/api/feedback"], ["GET", "/api/reports/crm"]] as const) {
      const res = await request(method, url);
      expect(res.statusCode, url).toBe(409);
      expect(res.json().code).toBe("module_off");
    }
    expect((await toggle(true)).json().integration).toMatchObject({ id: "crm", enabled: true, licensed: true });
    expect((await request("GET", "/api/customers")).statusCode).toBe(200);
  });

  it("bills with no customer discount, points or feedback QR while off, and works again when back on", async () => {
    enableIntegration(app, "crm");
    await request("PUT", "/api/loyalty-settings", { enabled: true, pointsPer100: 1, pointValuePaise: 100, minRedeemPoints: 0, feedbackEnabled: true });
    const priya = (await request("POST", "/api/customers", { name: "Priya", phone: "9876543210" })).json().customer;
    const first = await order();
    await request("PATCH", `/api/orders/${first}/customer`, { customerId: priya.id });

    await toggle(false);
    const second = await order();
    expect((await request("PATCH", `/api/orders/${second}/customer`, { customerId: priya.id })).statusCode).toBe(409);
    expect((await request("PATCH", `/api/orders/${second}/customer`, { customerId: null })).statusCode).toBe(200);
    const plain = await bill(first);
    expect(plain.receipt.customer).toBeUndefined();
    expect(plain.feedbackUrl).toBeUndefined();
    expect((app.db.prepare("SELECT customer_id, feedback_token FROM bills WHERE id = ?").get(plain.id))).toEqual({ customer_id: null, feedback_token: null });
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM loyalty_ledger").get() as { n: number }).n).toBe(0);

    await toggle(true);
    const third = await order();
    await request("PATCH", `/api/orders/${third}/customer`, { customerId: priya.id });
    const loyal = await bill(third);
    expect(loyal.receipt.customer).toMatchObject({ name: "Priya", pointsEarned: 10 });
    expect(loyal.feedbackUrl).toBeDefined();
  });

  it("leaves the attached customer out of order responses for someone who may not view customers", async () => {
    enableIntegration(app, "crm");
    const priya = (await request("POST", "/api/customers", { name: "Priya", phone: "9876543210", email: "priya@example.com" })).json().customer;
    const id = await order();
    await request("PATCH", `/api/orders/${id}/customer`, { customerId: priya.id });
    const waiter = await createUser(app, token, { name: "Wren", pin: "5678", role: "waiter" });
    const as = (user: string, method: "GET" | "POST", url: string, payload?: object) =>
      app.inject({ method, url, headers: auth(user), ...(payload ? { payload } : {}) });

    // A waiter can view customers by default and sees who the order is for.
    expect((await as(waiter.token, "GET", `/api/orders/${id}`)).json().order.customer).toMatchObject({ id: priya.id, phone: "9876543210" });

    expect((await request("PUT", `/api/users/${waiter.id}/permissions`, { overrides: { "customers.read": false } })).statusCode).toBe(200);
    const one = await as(waiter.token, "GET", `/api/orders/${id}`);
    expect(one.statusCode).toBe(200);
    expect(one.json().order).toMatchObject({ id, customer: null });
    const list = (await as(waiter.token, "GET", "/api/orders")).json().orders as Array<{ id: string; customer: unknown }>;
    expect(list.find((o) => o.id === id)).toMatchObject({ customer: null });
    expect(JSON.stringify(list)).not.toContain("9876543210");
    // Routes that hand back the changed order are covered too, not just the two reads.
    const added = await as(waiter.token, "POST", `/api/orders/${id}/items`, { items: [{ productId, qty: 1, clientRef: uuidv7() }] });
    expect(added.statusCode).toBe(200);
    expect(added.json().order).toMatchObject({ id, customer: null });

    // The admin still sees everything.
    expect((await request("GET", `/api/orders/${id}`)).json().order.customer).toMatchObject({ id: priya.id, email: "priya@example.com" });
  });
});
