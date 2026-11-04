import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { localDateKey, uuidv7, type PrepForecast } from "@masalapos/domain";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

const DAY = 24 * 60 * 60 * 1000;
const dayKey = (offset: number) => localDateKey(Date.now() + offset * DAY);

describe("prep forecast", () => {
  let app: FastifyInstance, token: string, paneer: string;
  const request = (method: "GET" | "POST" | "PUT", url: string, payload?: object, as = token) =>
    app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  async function post(url: string, payload: object) {
    const res = await request("POST", url, payload);
    expect(res.statusCode, res.body).toBeLessThan(400); return res.json();
  }
  /** Bills `qty` of the dish, dated `daysAgo` days back at the same time of day. */
  async function sold(qty: number, daysAgo: number) {
    const { order } = await post("/api/orders", { clientRef: uuidv7(), type: "parcel" });
    await post(`/api/orders/${order.id}/items`, { items: [{ productId: paneer, qty, clientRef: uuidv7() }] });
    const { preview } = await post(`/api/orders/${order.id}/bill-preview`, {});
    const { bill } = await post(`/api/orders/${order.id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey });
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(Date.now() - daysAgo * DAY, bill.id);
  }
  const forecast = (query: string, as = token) => request("GET", `/api/prep-forecast${query}`, undefined, as);

  beforeEach(async () => {
    app = freshApp(); ({ token } = await setupAdmin(app));
    const { category } = await post("/api/categories", { name: "Mains" });
    paneer = (await post("/api/products", { name: "Paneer tikka", categoryId: category.id, pricePaise: 24000, gstRate: 5, kotStationId: null })).product.id;
    const { item } = await post("/api/stock-items", { clientRef: uuidv7(), name: "Paneer", unit: "kg", openingQty: 2, lowStockThreshold: null });
    expect((await request("PUT", `/api/products/${paneer}/stock-links`, { expectedVersion: 0, stockItemId: item.id, qtyPerSale: 0.2 })).statusCode).toBe(200);
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  it("forecasts tomorrow by default from the same weekday in recent weeks", async () => {
    // Tomorrow's weekday was 6, 13, 20 and 27 days ago.
    await sold(4, 6); await sold(2, 13); await sold(6, 27); await sold(30, 5);
    const res = await forecast("");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json().forecast as PrepForecast;
    expect(body.date).toBe(dayKey(1));
    expect(body.basedOn).toEqual([dayKey(-6), dayKey(-13), dayKey(-20), dayKey(-27)]);
    expect(body.dishes).toEqual([{ productId: paneer, variantId: null, name: "Paneer tikka", category: "Mains", average: 3, days: [4, 2, 0, 6] }]);
    // Sales deduct stock, so what is on hand is the opening 2 kg less 42 × 0.2 kg.
    expect(body.ingredients).toMatchObject([{ name: "Paneer", unit: "kg", need: 0.6 }]);
    expect(body.ingredients[0]!.onHand).toBeCloseTo(2 - 0.2 * 42);
  });

  it("accepts today up to 7 days ahead", async () => {
    expect((await forecast(`?date=${dayKey(0)}`)).statusCode).toBe(200);
    expect((await forecast(`?date=${dayKey(7)}`)).json().forecast.date).toBe(dayKey(7));
    expect((await forecast(`?date=${dayKey(8)}`)).statusCode).toBe(400);
    expect((await forecast(`?date=${dayKey(-1)}`)).statusCode).toBe(400);
    expect((await forecast("?date=tomorrow")).statusCode).toBe(400);
  });

  it("is for staff who can view stock", async () => {
    const cashier = await createUser(app, token, { name: "Ravi", pin: "4321", role: "cashier" });
    expect((await forecast("", cashier.token)).statusCode).toBe(200);
    const kitchen = await createUser(app, token, { name: "Kiran", pin: "4567", role: "kitchen" });
    expect((await forecast("", kitchen.token)).statusCode).toBe(403);
  });
});
