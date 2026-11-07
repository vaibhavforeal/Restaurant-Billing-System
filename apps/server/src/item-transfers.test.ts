import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@masalapos/domain";
import { auth, createUser, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";

describe("item transfers", () => {
  let app: FastifyInstance, token: string, source: string, target: string, productId: string;
  const request = (method: "GET" | "POST", url: string, payload?: object, as = token) => app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app));
    const category = (await request("POST", "/api/categories", { name: "Meals" })).json().category;
    productId = (await request("POST", "/api/products", { name: "Thali", categoryId: category.id, pricePaise: 12000, gstRate: 5 })).json().product.id;
    const open = async (name: string) => {
      const table = (await request("POST", "/api/tables", { name })).json().table;
      return (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "dine_in", tableId: table.id })).json().order.id as string;
    };
    source = await open("T1"); target = await open("T2");
  });
  afterEach(async () => { await app.close(); app.db.close(); });
  async function add(qty = 2) {
    const ref = uuidv7();
    const res = await request("POST", `/api/orders/${source}/items`, { items: [{ productId, qty, note: "No onion", clientRef: ref }] });
    return res.json().order.items.find((i: { clientRef: string }) => i.clientRef === ref) as { id: string; qty: number; pricePaise: number };
  }
  const move = (items: Array<{ id: string; qty: number }>, extra = {}) => request("POST", `/api/orders/${source}/transfer-items`, { clientRef: uuidv7(), targetOrderId: target, items: items.map(({ id, qty }) => ({ id, qty })), ...extra });

  it("moves complete rows with their prices and holds, keeps the source open, and replays safely", async () => {
    const item = await add();
    app.db.prepare("UPDATE order_items SET held = 1 WHERE id = ?").run(item.id);
    const clientRef = uuidv7();
    const first = await move([item], { clientRef });
    expect(first.statusCode).toBe(200);
    expect(first.json().order).toMatchObject({ status: "open", items: [] });
    expect(first.json().targetOrder.items[0]).toMatchObject({ id: item.id, qty: 2, pricePaise: 12000, held: true, note: "No onion" });
    expect((await move([item], { clientRef })).statusCode).toBe(200);
    expect((await move([item], { clientRef, targetOrderId: source })).statusCode).toBe(409);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM order_item_transfers").get()).toEqual({ n: 1 });
  });

  it("moves combo contents with their parent and never permits selecting a child alone", async () => {
    const parent = await add(), child = await add(4);
    app.db.prepare("UPDATE order_items SET parent_item_id = ?, price_paise_snapshot = 0 WHERE id = ?").run(parent.id, child.id);
    expect((await move([child])).statusCode).toBe(409);
    const result = await move([parent]);
    expect(result.statusCode).toBe(200);
    expect(result.json().targetOrder.items).toHaveLength(2);
    expect(result.json().order.items).toHaveLength(0);
  });

  it("refuses stale quantities and rolls the entire transfer back if any item is invalid", async () => {
    const one = await add(), two = await add();
    app.db.prepare("UPDATE order_items SET qty = 3 WHERE id = ?").run(two.id);
    expect((await move([one, two])).statusCode).toBe(409);
    expect((await request("GET", `/api/orders/${source}`)).json().order.items).toHaveLength(2);
    expect((await request("GET", `/api/orders/${target}`)).json().order.items).toHaveLength(0);
    expect((await move([one, one])).statusCode).toBe(400);
    expect((await move([{ id: uuidv7(), qty: 1 }])).statusCode).toBe(409);
  });

  it("rejects kitchen and guest QR rows and a combo with a sent child", async () => {
    const item = await add();
    app.db.prepare("UPDATE order_items SET status = 'sent' WHERE id = ?").run(item.id);
    expect((await move([item])).statusCode).toBe(409);
    app.db.prepare("UPDATE order_items SET status = 'pending', client_ref = 'guest:request:0' WHERE id = ?").run(item.id);
    expect((await move([item])).statusCode).toBe(409);
    const parent = await add(), child = await add();
    app.db.prepare("UPDATE order_items SET parent_item_id = ?, status = 'sent' WHERE id = ?").run(parent.id, child.id);
    expect((await move([parent])).statusCode).toBe(409);
  });

  it("enforces permissions and refuses billed, closed and non-table destinations", async () => {
    const item = await add();
    const kitchen = await createUser(app, token, { name: "Kitchen", role: "kitchen", pin: "4567" });
    expect((await request("POST", `/api/orders/${source}/transfer-items`, { clientRef: uuidv7(), targetOrderId: target, items: [{ id: item.id, qty: item.qty }] }, kitchen.token)).statusCode).toBe(403);
    const parcel = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order;
    expect((await move([item], { targetOrderId: parcel.id })).statusCode).toBe(409);
    expect((await move([item], { targetOrderId: source })).statusCode).toBe(409);
    const preview = (await request("POST", `/api/orders/${source}/bill-preview`, {})).json().preview;
    await request("POST", `/api/orders/${source}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey });
    expect((await move([item])).statusCode).toBe(409);
  });
});
