import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@masalapos/domain";
import { auth, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";

type Item = { id: string; clientRef: string | null; productId: string; status: string; held: boolean; kotId: string | null; parentItemId: string | null };

describe("hold orders", () => {
  let app: FastifyInstance; let token: string; let categoryId: string; let kitchen: string;
  let paneer: string; let naan: string; let lunch: string;

  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app));
    categoryId = (await post("/api/categories", { name: "Food" })).json().category.id;
    kitchen = (app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string }).id;
    const printer = (await post("/api/printers", { name: "Kitchen", kind: "network", connection: "127.0.0.1:9100", paperWidth: 80 })).json().printer.id;
    await app.inject({ method: "PATCH", url: `/api/kot-stations/${kitchen}`, headers: auth(token), payload: { printerId: printer } });
    paneer = await product("Paneer Tikka", 24000);
    naan = await product("Butter Naan", 6000);
    const combo = await post("/api/products", { name: "Thali", categoryId, pricePaise: 30000, gstRate: 5, kind: "combo",
      combo: [{ name: "Included", minPicks: 2, maxPicks: 2, options: [{ productId: paneer }, { productId: naan }] }] });
    expect(combo.statusCode, combo.body).toBe(201);
    lunch = combo.json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  const post = (url: string, payload: object) => app.inject({ method: "POST", url, headers: auth(token), payload });
  const patch = (url: string, payload: object) => app.inject({ method: "PATCH", url, headers: auth(token), payload });
  async function product(name: string, pricePaise: number) {
    const res = await post("/api/products", { name, categoryId, pricePaise, gstRate: 5, kotStationId: kitchen });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().product.id as string;
  }
  async function order(type: "parcel" | "dine_in" = "parcel", extra: object = {}) {
    const res = await post("/api/orders", { clientRef: uuidv7(), type, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().order.id as string;
  }
  async function punch(orderId: string, items: object[]) {
    const res = await post(`/api/orders/${orderId}/items`, { items: items.map((i) => ({ clientRef: uuidv7(), qty: 1, ...i })) });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().order.items as Item[];
  }
  const sendAll = (orderId: string) => app.inject({ method: "POST", url: `/api/orders/${orderId}/send`, headers: auth(token) });
  const items = async (orderId: string) => (await app.inject({ url: `/api/orders/${orderId}`, headers: auth(token) })).json().order.items as Item[];
  const setHoldOrders = (on: boolean) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { restaurantName: "Cafe", holdOrdersEnabled: on } });

  describe("marking items held", () => {
    it("punch stores held per item", async () => {
      const id = await order();
      const saved = await punch(id, [{ productId: paneer, held: true }, { productId: naan }]);
      expect(saved.find((i) => i.productId === paneer)!.held).toBe(true);
      expect(saved.find((i) => i.productId === naan)!.held).toBe(false);
    });

    it("PATCH toggles held on a pending item and keeps qty and note", async () => {
      const id = await order();
      const [item] = await punch(id, [{ productId: paneer, qty: 2, note: "Less spicy" }]);
      const on = await patch(`/api/order-items/${item!.id}`, { held: true });
      expect(on.statusCode, on.body).toBe(200);
      expect(on.json().order.items[0]).toMatchObject({ held: true, qty: 2, note: "Less spicy" });
      const off = await patch(`/api/order-items/${item!.id}`, { held: false });
      expect(off.json().order.items[0].held).toBe(false);
    });

    it("PATCH held on a sent item is refused", async () => {
      const id = await order();
      const [item] = await punch(id, [{ productId: paneer }]);
      expect((await sendAll(id)).statusCode).toBe(200);
      const res = await patch(`/api/order-items/${item!.id}`, { held: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().error ?? res.json().message).toContain("item is not pending");
    });

    it("a held combo line carries the flag, its items do not", async () => {
      const id = await order();
      await punch(id, [{ productId: lunch, held: true, comboPicks: [] }]);
      const rows = app.db.prepare("SELECT parent_item_id, held FROM order_items WHERE order_id = ?").all(id) as Array<{ parent_item_id: string | null; held: number }>;
      expect(rows.filter((r) => !r.parent_item_id).map((r) => r.held)).toEqual([1]);
      expect(rows.filter((r) => r.parent_item_id).map((r) => r.held)).toEqual([0, 0]);
    });

    it("setting off refuses new held items but still lets staff un-hold", async () => {
      const id = await order();
      const [held] = await punch(id, [{ productId: paneer, held: true }]);
      const plain = (await punch(id, [{ productId: naan }])).find((i) => i.productId === naan);
      await setHoldOrders(false);
      const add = await post(`/api/orders/${id}/items`, { items: [{ clientRef: uuidv7(), productId: naan, qty: 1, held: true }] });
      expect(add.statusCode).toBe(409);
      expect(add.body).toContain("Hold orders is turned off in Settings");
      const hold = await patch(`/api/order-items/${plain!.id}`, { held: true });
      expect(hold.statusCode).toBe(409);
      expect(hold.body).toContain("Hold orders is turned off in Settings");
      expect((await patch(`/api/order-items/${held!.id}`, { held: false })).statusCode).toBe(200);
    });
  });
});
