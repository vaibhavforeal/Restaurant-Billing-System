import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@masalapos/domain";
import { auth, createUser, enableIntegration, freshApp, setupAdmin } from "./test-helpers.js";

describe("customer's usual", () => {
  let app: FastifyInstance, token: string, paneer: string, naan: string, customerId: string;
  const request = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object, as = token) =>
    app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  async function post(url: string, payload: object) {
    const res = await request("POST", url, payload);
    expect(res.statusCode, res.body).toBeLessThan(400); return res.json();
  }
  /** A billed takeaway for the customer with these [productId, qty] lines. */
  async function visit(lines: Array<[string, number]>) {
    const { order } = await post("/api/orders", { clientRef: uuidv7(), type: "parcel" });
    await post(`/api/orders/${order.id}/items`, { items: lines.map(([productId, qty]) => ({ productId, qty, clientRef: uuidv7() })) });
    expect((await request("PATCH", `/api/orders/${order.id}/customer`, { customerId })).statusCode).toBe(200);
    const { preview } = await post(`/api/orders/${order.id}/bill-preview`, {});
    return (await post(`/api/orders/${order.id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey })).bill as { billNo: number; createdAt: number };
  }
  const usual = (as = token, id = customerId) => request("GET", `/api/customers/${id}/usual`, undefined, as);

  beforeEach(async () => {
    app = freshApp(); ({ token } = await setupAdmin(app)); enableIntegration(app, "crm");
    const { category } = await post("/api/categories", { name: "Food" });
    paneer = (await post("/api/products", { name: "Paneer tikka", categoryId: category.id, pricePaise: 24000, gstRate: 5, kotStationId: null })).product.id;
    naan = (await post("/api/products", { name: "Butter naan", categoryId: category.id, pricePaise: 6000, gstRate: 5, kotStationId: null })).product.id;
    customerId = (await post("/api/customers", { name: "Priya", phone: "98765 43210" })).customer.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  it("lists the customer's usual dishes and their last order", async () => {
    await visit([[paneer, 1], [naan, 2]]);
    const last = await visit([[paneer, 2], [naan, 1], [naan, 1]]);
    const res = await usual();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      dishes: [{ productId: naan, variantId: null, bills: 2 }, { productId: paneer, variantId: null, bills: 2 }],
      lastOrder: { billNo: last.billNo, createdAt: last.createdAt, items: [
        { productId: paneer, variantId: null, name: "Paneer tikka", qty: 2 },
        { productId: naan, variantId: null, name: "Butter naan", qty: 2 },
      ] },
    });
  });

  it("returns nothing for a customer without bills, and 404 for an unknown customer", async () => {
    expect((await usual()).json()).toEqual({ dishes: [], lastOrder: null });
    expect((await usual(token, "missing")).statusCode).toBe(404);
  });

  it("needs permission to view customers and CRM switched on", async () => {
    const kitchen = await createUser(app, token, { name: "Kiran", pin: "4567", role: "kitchen" });
    expect((await usual(kitchen.token)).statusCode).toBe(403);
    app.db.prepare("UPDATE integration_state SET enabled = 0 WHERE id = 'crm'").run();
    expect((await usual()).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("returns nothing while the setting is off, and the setting reads back", async () => {
    await visit([[paneer, 1]]); await visit([[paneer, 1]]);
    const off = await request("PUT", "/api/settings", { restaurantName: "Cafe", customerUsualEnabled: false });
    expect(off.json().settings.customerUsualEnabled).toBe(false);
    expect((await usual()).json()).toEqual({ dishes: [], lastOrder: null });
    const on = await request("PUT", "/api/settings", { restaurantName: "Cafe", customerUsualEnabled: true });
    expect(on.json().settings.customerUsualEnabled).toBe(true);
    expect((await usual()).json().dishes).toHaveLength(1);
  });

  it("leaves add-ons out of the usual dishes, the last order and the favourites", async () => {
    const { category } = await post("/api/categories", { name: "Extras" });
    const cheese = (await post("/api/products", { name: "Cheese", categoryId: category.id, pricePaise: 3000, gstRate: 5, kotStationId: null, addonOnly: true })).product.id;
    const raita = (await post("/api/products", { name: "Raita", categoryId: category.id, pricePaise: 4000, gstRate: 5, kotStationId: null })).product.id;
    const { group } = await post("/api/addon-groups", { name: "Sides", minPicks: 0, maxPicks: 2, options: [{ productId: cheese }, { productId: raita }] });
    expect((await request("PATCH", `/api/products/${paneer}`, { addonGroupIds: [group.id] })).statusCode).toBe(200);
    for (let i = 0; i < 2; i++) {
      const { order } = await post("/api/orders", { clientRef: uuidv7(), type: "parcel" });
      await post(`/api/orders/${order.id}/items`, { items: [{ productId: paneer, qty: 1, clientRef: uuidv7(), addonPicks: group.options.map((o: { id: string }) => o.id) }] });
      expect((await request("PATCH", `/api/orders/${order.id}/customer`, { customerId })).statusCode).toBe(200);
      const { preview } = await post(`/api/orders/${order.id}/bill-preview`, {});
      await post(`/api/orders/${order.id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey });
    }
    const body = (await usual()).json();
    expect(body.dishes.map((d: { productId: string }) => d.productId)).toEqual([paneer]);
    expect(body.lastOrder.items.map((i: { name: string }) => i.name)).toEqual(["Paneer tikka"]);
    const favourites = (await request("GET", `/api/customers/${customerId}`)).json().stats.favourites as Array<{ name: string }>;
    expect(favourites.map((f) => f.name)).toEqual(["Paneer tikka"]);
  });
});
