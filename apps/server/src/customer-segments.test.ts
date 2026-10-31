import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, localDateKey } from "@masalapos/domain";
import { auth, createUser, enableIntegration, freshApp, setupAdmin } from "./test-helpers.js";

describe("customer segments and CRM insights", () => {
  let app: FastifyInstance; let token: string; let productId: string;
  beforeEach(async () => {
    app = freshApp(); ({ token } = await setupAdmin(app)); enableIntegration(app, "crm");
    const c = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const p = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Thali", categoryId: c.json().category.id, pricePaise: 50000, gstRate: 5, kotStationId: null } });
    productId = p.json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  const request = (method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", url: string, payload?: object, as = token) => app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  async function customer(name: string, phone: string, extra: object = {}) {
    return (await request("POST", "/api/customers", { name, phone, ...extra })).json().customer as { id: string };
  }
  async function bill(customerId: string, qty = 1) {
    const id = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order.id as string;
    await request("POST", `/api/orders/${id}/items`, { items: [{ productId, qty, clientRef: uuidv7() }] });
    await request("PATCH", `/api/orders/${id}/customer`, { customerId });
    const preview = await request("POST", `/api/orders/${id}/bill-preview`, {});
    expect((await request("POST", `/api/orders/${id}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey })).statusCode).toBe(201);
  }
  const preview = async (filter: object) => (await request("POST", "/api/customer-segments/preview", { filter })).json();

  it("previews segments by spend, visits, tags and opt-in", async () => {
    const priya = await customer("Priya", "9876543210", { tags: ["Vegan"], marketingOptIn: true });
    const ravi = await customer("Ravi", "9123456780");
    await customer("Asha", "9000000001", { tags: ["vegan"] });
    await bill(priya.id, 3); await bill(priya.id); await bill(ravi.id);

    expect((await preview({})).count).toBe(3);
    const big = await preview({ minSpendPaise: 100_000 });
    expect(big.customers.map((c: { name: string }) => c.name)).toEqual(["Priya"]);
    expect(big.customers[0]).toMatchObject({ visits: 2, spendPaise: 200_000, tags: ["Vegan"] });
    expect((await preview({ tags: ["VEGAN"] })).count).toBe(2);
    expect((await preview({ minVisits: 1, optedInOnly: true })).count).toBe(1);
    expect((await preview({ notVisitedForDays: 30 })).count).toBe(0);
  });

  it("saves segments and exports opted-in customers as CSV for admins only", async () => {
    await customer("Priya", "9876543210", { marketingOptIn: true, birthDate: "--03-14" });
    await customer("=cmd", "9123456780");
    const saved = await request("POST", "/api/customer-segments", { name: "Everyone", filter: {} });
    expect(saved.statusCode).toBe(201);
    expect((await request("POST", "/api/customer-segments", { name: "everyone", filter: {} })).statusCode).toBe(409);
    const id = saved.json().segment.id;
    expect((await request("PUT", `/api/customer-segments/${id}`, { name: "All guests", filter: { minVisits: 0 } })).json().segment)
      .toMatchObject({ name: "All guests", filter: { minVisits: 0, tags: [] } });
    expect((await request("GET", "/api/customer-segments")).json().segments).toHaveLength(1);

    const csv = await request("POST", "/api/customer-segments/export", { filter: {} });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    const lines = csv.body.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Priya","9876543210"');
    const all = (await request("POST", "/api/customer-segments/export", { filter: {}, all: true })).body;
    expect(all).toContain(`"'=cmd"`);

    const cashier = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
    expect((await request("POST", "/api/customer-segments/export", { filter: {} }, cashier.token)).statusCode).toBe(403);
    expect((await request("POST", "/api/customer-segments/preview", { filter: {} }, cashier.token)).statusCode).toBe(200);
    expect((await request("DELETE", `/api/customer-segments/${id}`)).statusCode).toBe(204);
  });

  it("reports new and returning customers, points and ratings", async () => {
    await request("PUT", "/api/loyalty-settings", { enabled: true, pointsPer100: 1, pointValuePaise: 50, minRedeemPoints: 0, tiersEnabled: true });
    await request("POST", "/api/loyalty-tiers", { name: "Gold", minSpendPaise: 100_000 });
    const priya = await customer("Priya", "9876543210");
    const ravi = await customer("Ravi", "9123456780");
    await bill(priya.id, 2); await bill(priya.id); await bill(ravi.id);
    const today = localDateKey(Date.now());
    const report = (await request("GET", `/api/reports/crm?from=${today}&to=${today}`)).json();
    expect(report.customers).toMatchObject({ total: 2, active: 2, new: 2, returning: 0, repeatRate: 0.5 });
    expect(report.bills).toMatchObject({ bills: 3, withCustomer: 3, attachRate: 1 });
    expect(report.points).toMatchObject({ issued: 20, redeemed: 0, outstanding: 20, liabilityPaise: 1000 });
    expect(report.tiers).toEqual([{ name: "Gold", customers: 1 }, { name: "No tier", customers: 1 }]);
    expect(report.topCustomers[0]).toMatchObject({ name: "Priya", visits: 2, spendPaise: 150_000, tierName: "Gold" });
    const waiter = await createUser(app, token, { name: "Arun", pin: "5555", role: "waiter" });
    expect((await request("GET", "/api/reports/crm", undefined, waiter.token)).statusCode).toBe(403);
  });
});
