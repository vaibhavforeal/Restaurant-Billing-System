import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@masalapos/domain";
import { auth, createUser, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";

describe("menu insights", () => {
  let app: FastifyInstance, token: string, meal: string, juice: string, lassi: string;
  async function post(url: string, payload: object) {
    const res = await app.inject({ method: "POST", url, payload, headers: auth(token) });
    expect(res.statusCode, res.body).toBeLessThan(400); return res.json();
  }
  async function sell(productId: string, qty: number, ...others: string[]) {
    const { order } = await post("/api/orders", { clientRef: uuidv7(), type: "parcel" });
    await post(`/api/orders/${order.id}/items`, { items: [productId, ...others].map((id, n) => ({ productId: id, qty: n === 0 ? qty : 1, clientRef: uuidv7() })) });
    const { preview } = await post(`/api/orders/${order.id}/bill-preview`, {});
    await post(`/api/orders/${order.id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey });
  }
  const insights = (as = token) => app.inject({ url: "/api/menu/insights", headers: auth(as) });
  const setPopular = (on: boolean) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { restaurantName: "Cafe", popularItemsEnabled: on } });
  const setTogether = (on: boolean) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { restaurantName: "Cafe", orderedTogetherEnabled: on } });

  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app));
    const { category } = await post("/api/categories", { name: "Meals" });
    meal = (await post("/api/products", { name: "Meal", categoryId: category.id, pricePaise: 10000, gstRate: 5, kotStationId: null })).product.id;
    juice = (await post("/api/products", { name: "Juice", categoryId: category.id, pricePaise: 5000, gstRate: 5, kotStationId: null })).product.id;
    const drinks = (await post("/api/categories", { name: "Drinks" })).category;
    lassi = (await post("/api/products", { name: "Lassi", categoryId: drinks.id, pricePaise: 6000, gstRate: 5, kotStationId: null })).product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  it("lists each category's best-seller for anyone who can take orders", async () => {
    await sell(meal, 2); await sell(juice, 4);
    const waiter = await createUser(app, token, { name: "Wes", pin: "3456", role: "waiter" });
    const res = await insights(waiter.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ popularProductIds: [juice], pairs: {} });
  });

  it("needs a signed-in user", async () => {
    expect((await app.inject({ url: "/api/menu/insights" })).statusCode).toBe(401);
  });

  it("lists nothing while the setting is off, and the setting reads back", async () => {
    await sell(juice, 4);
    expect((await setPopular(false)).json().settings.popularItemsEnabled).toBe(false);
    expect((await insights()).json().popularProductIds).toEqual([]);
    expect((await setPopular(true)).json().settings.popularItemsEnabled).toBe(true);
    expect((await insights()).json().popularProductIds).toEqual([juice]);
  });

  it("lists dishes ordered together, and none while that setting is off", async () => {
    for (let n = 0; n < 3; n++) await sell(meal, 1, lassi);
    expect((await insights()).json().pairs).toEqual({ [meal]: [{ productId: lassi, variantId: null }], [lassi]: [{ productId: meal, variantId: null }] });
    expect((await setTogether(false)).json().settings.orderedTogetherEnabled).toBe(false);
    expect((await insights()).json()).toEqual({ popularProductIds: [meal], pairs: {} });
    expect((await setTogether(true)).json().settings.orderedTogetherEnabled).toBe(true);
  });
});
