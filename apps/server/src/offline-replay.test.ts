import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@masalapos/domain";
import { auth, freshApp, setupAdmin } from "./test-helpers.js";

describe("replaying saved offline actions", () => {
  let app: FastifyInstance; let token: string; let productId: string; let tableId: string;
  beforeEach(async () => {
    app = freshApp(); ({ token } = await setupAdmin(app));
    const c = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    productId = (await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Tea", categoryId: c.json().category.id, pricePaise: 2000, gstRate: 5, kotStationId: null } })).json().product.id;
    tableId = (await app.inject({ method: "POST", url: "/api/tables", headers: auth(token), payload: { name: "T1" } })).json().table.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });
  const request = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });

  it("lets a counter choose a new order's id and replays it as the same order", async () => {
    const id = uuidv7(), clientRef = uuidv7();
    const first = await request("POST", "/api/orders", { id, clientRef, type: "dine_in", tableId });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().order.id).toBe(id);
    const replay = await request("POST", "/api/orders", { id, clientRef, type: "dine_in", tableId });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().order.id).toBe(id);
    // The same reference with another id, or the same id with another reference, is a different request.
    expect((await request("POST", "/api/orders", { id: uuidv7(), clientRef, type: "dine_in", tableId })).statusCode).toBe(409);
    expect((await request("POST", "/api/orders", { id, clientRef: uuidv7(), type: "dine_in", tableId })).statusCode).toBe(409);
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n).toBe(1);
  });

  it("accepts a replayed punch after the order was billed, but not an item reference from another order", async () => {
    const orderId = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order.id as string;
    const punch = { items: [{ productId, qty: 2, clientRef: uuidv7() }] };
    expect((await request("POST", `/api/orders/${orderId}/items`, punch)).statusCode).toBe(200);
    const preview = await request("POST", `/api/orders/${orderId}/bill-preview`, {});
    expect((await request("POST", `/api/orders/${orderId}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey })).statusCode).toBe(201);
    // The reply to the punch was lost; the counter sends it again after the bill.
    const replay = await request("POST", `/api/orders/${orderId}/items`, punch);
    expect(replay.statusCode, replay.body).toBe(200);
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM order_items").get() as { n: number }).n).toBe(1);
    // New items on a billed order are still refused.
    expect((await request("POST", `/api/orders/${orderId}/items`, { items: [{ productId, qty: 1, clientRef: uuidv7() }] })).statusCode).toBe(409);
    const other = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order.id as string;
    const stolen = await request("POST", `/api/orders/${other}/items`, punch);
    expect(stolen.statusCode).toBe(409);
    expect(stolen.json().error).toBe("Item reference already used on another order");
  });

  it("treats cancelling an item or an order twice as success", async () => {
    const orderId = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order.id as string;
    const order = (await request("POST", `/api/orders/${orderId}/items`, { items: [{ productId, qty: 1, clientRef: uuidv7() }, { productId, qty: 1, clientRef: uuidv7() }] })).json().order;
    const itemId = order.items[0].id as string;
    expect((await request("POST", `/api/order-items/${itemId}/cancel`, {})).statusCode).toBe(200);
    const again = await request("POST", `/api/order-items/${itemId}/cancel`, {});
    expect(again.statusCode).toBe(200);
    expect(again.json().order.items.find((i: { id: string }) => i.id === itemId).status).toBe("cancelled");
    expect((await request("POST", `/api/orders/${orderId}/cancel`, { reason: "Guest left" })).statusCode).toBe(200);
    const twice = await request("POST", `/api/orders/${orderId}/cancel`, { reason: "Guest left" });
    expect(twice.statusCode).toBe(200);
    expect(twice.json().order.status).toBe("cancelled");
  });

  it("sends items to the kitchen by the references the counter gave them, once", async () => {
    const kitchen = (await request("GET", "/api/kot-stations")).json().stations[0].id as string;
    const c = (await request("POST", "/api/categories", { name: "Mains" })).json().category.id as string;
    const dish = (await request("POST", "/api/products", { name: "Thali", categoryId: c, pricePaise: 50000, gstRate: 5, kotStationId: kitchen })).json().product.id as string;
    const orderId = uuidv7();
    // Everything below could have been saved offline: the order id and item references are the counter's own.
    await request("POST", "/api/orders", { id: orderId, clientRef: uuidv7(), type: "dine_in", tableId });
    const refs = [uuidv7(), uuidv7()];
    await request("POST", `/api/orders/${orderId}/items`, { items: refs.map((clientRef) => ({ productId: dish, qty: 1, clientRef })) });
    const send = { clientRef: uuidv7(), itemRefs: refs };
    const first = await request("POST", `/api/orders/${orderId}/send`, send);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().kots).toHaveLength(1);
    const replay = await request("POST", `/api/orders/${orderId}/send`, send);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().kots.map((k: { id: string }) => k.id)).toEqual(first.json().kots.map((k: { id: string }) => k.id));
    expect((app.db.prepare("SELECT COUNT(*) AS n FROM kots").get() as { n: number }).n).toBe(1);
    expect((await request("POST", `/api/orders/${orderId}/send`, { clientRef: uuidv7(), itemRefs: [uuidv7()] })).statusCode).toBe(409);
    expect((await request("POST", `/api/orders/${orderId}/send`, { clientRef: uuidv7(), itemRefs: refs, itemIds: [uuidv7()] })).statusCode).toBe(400);
  });
});
