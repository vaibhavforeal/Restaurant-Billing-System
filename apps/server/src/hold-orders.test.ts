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

  describe("kitchen send and fire", () => {
    const send = (orderId: string, body: object) => post(`/api/orders/${orderId}/send`, { clientRef: uuidv7(), ...body });
    const kotCount = () => (app.db.prepare("SELECT COUNT(*) AS n FROM kots").get() as { n: number }).n;
    const byProduct = (list: Item[], productId: string) => list.find((i) => i.productId === productId && !i.parentItemId)!;

    it("KOT skips held items", async () => {
      const id = await order();
      await punch(id, [{ productId: paneer, held: true }, { productId: naan }]);
      const res = await sendAll(id);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().kots).toHaveLength(1);
      expect(res.json().kots[0].items.map((i: { name: string }) => i.name)).toEqual(["Butter Naan"]);
      const after = await items(id);
      expect(byProduct(after, paneer)).toMatchObject({ status: "pending", held: true });
      expect(byProduct(after, naan).status).toBe("sent");
    });

    it("skips a named held item (a stale screen cannot cook it)", async () => {
      const id = await order();
      const [item] = await punch(id, [{ productId: paneer }]);
      await patch(`/api/order-items/${item!.id}`, { held: true });
      const res = await send(id, { itemIds: [item!.id] });
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain("nothing to send");
      expect(byProduct(await items(id), paneer)).toMatchObject({ status: "pending", held: true });
    });

    it("skips the items of a held combo", async () => {
      const id = await order();
      await punch(id, [{ productId: lunch, held: true, comboPicks: [] }]);
      const res = await sendAll(id);
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain("nothing to send");
    });

    it("fire sends held items and clears held", async () => {
      const id = await order();
      const saved = await punch(id, [{ productId: paneer, held: true }, { productId: lunch, held: true, comboPicks: [] }]);
      const res = await send(id, { itemIds: [byProduct(saved, paneer).id, byProduct(saved, lunch).id], fire: true });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().kots).toHaveLength(1);
      const after = await items(id);
      expect(after.every((i) => i.status === "sent" && !i.held)).toBe(true);
    });

    it("fire is idempotent on its clientRef", async () => {
      const id = await order();
      const [item] = await punch(id, [{ productId: paneer, held: true }]);
      const body = { clientRef: uuidv7(), itemIds: [item!.id], fire: true };
      const first = await post(`/api/orders/${id}/send`, body);
      const again = await post(`/api/orders/${id}/send`, body);
      expect(again.statusCode).toBe(200);
      expect(again.json().kots.map((k: { id: string }) => k.id)).toEqual(first.json().kots.map((k: { id: string }) => k.id));
      expect(kotCount()).toBe(1);
    });

    it("fire refuses an item that is not held, and needs named items", async () => {
      const id = await order();
      const [item] = await punch(id, [{ productId: naan }]);
      const res = await send(id, { itemIds: [item!.id], fire: true });
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain("Only held items can be fired");
      expect((await send(id, { fire: true })).statusCode).toBe(400);
    });

    it("fire by item reference works for items punched offline", async () => {
      const id = await order();
      const ref = uuidv7();
      await punch(id, [{ productId: paneer, held: true, clientRef: ref }]);
      const res = await send(id, { itemRefs: [ref], fire: true });
      expect(res.statusCode, res.body).toBe(200);
      expect(byProduct(await items(id), paneer)).toMatchObject({ status: "sent", held: false });
    });

    it("fire works with the setting off", async () => {
      const id = await order();
      const [item] = await punch(id, [{ productId: paneer, held: true }]);
      await setHoldOrders(false);
      const res = await send(id, { itemIds: [item!.id], fire: true });
      expect(res.statusCode, res.body).toBe(200);
    });

    it("billing waits for held items", async () => {
      const id = await order();
      const [item] = await punch(id, [{ productId: paneer, held: true }]);
      const preview = () => post(`/api/orders/${id}/bill-preview`, {});
      const blocked = await preview();
      expect(blocked.statusCode).toBe(409);
      expect(blocked.body).toContain("Send kitchen items before billing");
      expect((await send(id, { itemIds: [item!.id], fire: true })).statusCode).toBe(200);
      expect((await preview()).statusCode).toBe(200);
    });

    it("merge keeps held", async () => {
      const t1 = (await post("/api/tables", { name: "T1", area: null, sortOrder: 0, priceTier: "non_ac" })).json().table.id;
      const t2 = (await post("/api/tables", { name: "T2", area: null, sortOrder: 1, priceTier: "non_ac" })).json().table.id;
      const folded = await order("dine_in", { tableId: t1 });
      const receiving = await order("dine_in", { tableId: t2 });
      await punch(folded, [{ productId: paneer, held: true }]);
      const res = await post(`/api/orders/${folded}/merge`, { clientRef: uuidv7(), targetOrderId: receiving });
      expect(res.statusCode, res.body).toBe(200);
      expect(byProduct(await items(receiving), paneer).held).toBe(true);
    });
  });
});
