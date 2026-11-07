import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@masalapos/domain";
import { auth, createUser, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";

describe("table summary", () => {
  let app: FastifyInstance, token: string, adminId: string, tableId: string, productId: string;
  const request = (method: "GET" | "POST" | "PATCH", url: string, payload?: object, as = token) => app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink());
    const admin = await setupAdmin(app); token = admin.token; adminId = admin.user.id;
    tableId = (await request("POST", "/api/tables", { name: "T1", priceTier: "ac" })).json().table.id;
    const categoryId = (await request("POST", "/api/categories", { name: "Meals" })).json().category.id;
    productId = (await request("POST", "/api/products", { name: "Thali", categoryId, pricePaise: 10000, acPricePaise: 12000, takeawayPricePaise: 11000, gstRate: 5 })).json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });
  async function order(type = "dine_in") {
    const res = await request("POST", "/api/orders", { clientRef: uuidv7(), type, ...(type === "dine_in" ? { tableId } : {}) });
    expect(res.statusCode).toBe(201); return res.json().order;
  }
  const details = (id: string, body: object) => request("PATCH", `/api/orders/${id}/summary`, { expectedRevision: 0, ...body });
  const service = (id: string, body: object) => request("PATCH", `/api/orders/${id}/service-type`, { expectedRevision: 0, ...body });
  const add = (id: string) => request("POST", `/api/orders/${id}/items`, { items: [{ productId, qty: 1, clientRef: uuidv7() }] });

  it("persists notes, guest count and sales staff separately from the captain and opening user", async () => {
    const cashier = await createUser(app, token, { name: "Meena", role: "cashier", pin: "2345" });
    const original = await order();
    expect(original).toMatchObject({ notes: "", guestCount: null, soldById: adminId, soldByName: "Asha", summaryRevision: 0 });
    const res = await details(original.id, { notes: "  Birthday table\nBring cake after dinner  ", guestCount: 4, soldById: cashier.id });
    expect(res.statusCode).toBe(200);
    expect((await request("GET", `/api/orders/${original.id}`)).json().order).toMatchObject({ notes: "Birthday table\nBring cake after dinner", guestCount: 4, soldById: cashier.id, soldByName: "Meena", openedBy: adminId, captainId: null, summaryRevision: 1 });
    expect((await details(original.id, { notes: "", guestCount: null, expectedRevision: 1 })).json().order).toMatchObject({ notes: "", guestCount: null });
  });

  it("rejects stale edits without overwriting another counter's notes", async () => {
    const o = await order();
    await details(o.id, { notes: "Saved by first counter" });
    expect((await details(o.id, { notes: "Stale replacement" })).statusCode).toBe(409);
    expect((await service(o.id, { orderTypeId: "parcel" })).statusCode).toBe(409);
    expect((await request("GET", `/api/orders/${o.id}`)).json().order.notes).toBe("Saved by first counter");
  });

  it("validates notes, guest counts, active staff, permissions and order state", async () => {
    const o = await order();
    for (const body of [{ notes: "x".repeat(1001) }, { guestCount: 0 }, { guestCount: 1.5 }, { guestCount: 1000 }, { arbitrary: true }, {}]) {
      expect((await details(o.id, body)).statusCode).toBe(400);
    }
    const kitchen = await createUser(app, token, { name: "Kitchen", role: "kitchen", pin: "4567" });
    expect((await details(o.id, { soldById: kitchen.id })).statusCode).toBe(400);
    expect((await request("GET", "/api/order-staff")).json().staff.some((s: { id: string }) => s.id === kitchen.id)).toBe(false);
    expect((await request("PATCH", `/api/orders/${o.id}/summary`, { expectedRevision: 0, notes: "No" }, kitchen.token)).statusCode).toBe(403);
    const waiter = await createUser(app, token, { name: "Ravi", role: "waiter", pin: "3456" });
    app.db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(waiter.id);
    expect((await details(o.id, { soldById: waiter.id })).statusCode).toBe(400);
    expect((await details((await order("parcel")).id, { guestCount: 2 })).statusCode).toBe(409);
    expect((await details("missing", { notes: "x" })).statusCode).toBe(404);
    await request("POST", `/api/orders/${o.id}/cancel`, {});
    expect((await details(o.id, { notes: "x" })).statusCode).toBe(409);
  });

  it("changes service type, frees the table, retains existing prices and uses new prices for later dishes", async () => {
    const o = await order(); await add(o.id);
    const res = await service(o.id, { orderTypeId: "parcel" });
    expect(res.statusCode).toBe(200);
    expect(res.json().order).toMatchObject({ type: "parcel", tableId: null, splitLabel: null, priceTier: "takeaway", summaryRevision: 1 });
    expect(res.json().order.items[0].pricePaise).toBe(12000);
    expect((await request("GET", "/api/tables")).json().tables.find((t: { id: string }) => t.id === tableId).status).toBe("free");
    const added = await add(o.id);
    expect(added.json().order.items.map((i: { pricePaise: number }) => i.pricePaise)).toEqual([12000, 11000]);
    const returned = await service(o.id, { orderTypeId: "dine_in", tableId, expectedRevision: 1 });
    expect(returned.statusCode).toBe(200);
    expect(returned.json().order).toMatchObject({ type: "dine_in", tableId, priceTier: "ac", summaryRevision: 2 });
  });

  it("supports delivery types and rejects inactive types, missing tables and Zomato", async () => {
    const delivery = (await request("POST", "/api/order-types", { name: "Home delivery", kind: "delivery" })).json().orderType;
    const o = await order();
    expect((await service(o.id, { orderTypeId: delivery.id })).json().order).toMatchObject({ type: "parcel", orderTypeName: "Home delivery" });
    expect((await service(o.id, { orderTypeId: "dine_in", expectedRevision: 1 })).statusCode).toBe(400);
    expect((await service(o.id, { orderTypeId: "dine_in", tableId: "missing", expectedRevision: 1 })).statusCode).toBe(400);
    expect((await service(o.id, { orderTypeId: "zomato", expectedRevision: 1 })).statusCode).toBe(400);
    await request("PATCH", `/api/order-types/${delivery.id}`, { isActive: false });
    expect((await service((await order()).id, { orderTypeId: delivery.id })).statusCode).toBe(400);
  });

  it("protects kitchen tickets, bills and merged tables from type changes", async () => {
    const sent = await order();
    const station = app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string };
    await request("PATCH", `/api/products/${productId}`, { kotStationId: station.id });
    await add(sent.id); await request("POST", `/api/orders/${sent.id}/send`);
    expect((await service(sent.id, { orderTypeId: "parcel" })).statusCode).toBe(409);
    await request("PATCH", `/api/products/${productId}`, { kotStationId: null });
    const billed = await order(); await add(billed.id);
    const preview = await request("POST", `/api/orders/${billed.id}/bill-preview`, {});
    const bill = await request("POST", `/api/orders/${billed.id}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey });
    expect(bill.statusCode).toBe(201);
    expect((await service(billed.id, { orderTypeId: "parcel" })).statusCode).toBe(409);
    expect((await details(billed.id, { notes: "x" })).statusCode).toBe(409);
    const receiving = await order(), folded = await order();
    const merged = await request("POST", `/api/orders/${folded.id}/merge`, { clientRef: uuidv7(), targetOrderId: receiving.id });
    expect(merged.statusCode).toBe(200);
    expect((await service(receiving.id, { orderTypeId: "parcel" })).statusCode).toBe(409);
  });
});
