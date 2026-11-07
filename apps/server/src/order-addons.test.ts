import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@masalapos/domain";
import { auth, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";

type Item = { id: string; productId: string; name: string; qty: number; pricePaise: number; gstRate: number; status: string; kotId: string | null;
  parentItemId: string | null; addonOfItemId: string | null; held: boolean; note: string | null; cancelReason: string | null };
type Group = { id: string; options: Array<{ id: string; name: string }> };

describe("orders with add-ons", () => {
  let app: FastifyInstance; let token: string; let categoryId: string;
  let kitchen: string; let bar: string;
  let margherita: string; let cheese: string; let coke: string; let thin: string; let pan: string; let farmhouse: string;
  let toppings: Group; let base: Group; let other: Group;

  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app));
    categoryId = (await post("/api/categories", { name: "Pizza" })).json().category.id;
    kitchen = (app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string }).id;
    bar = (await post("/api/kot-stations", { name: "Bar", printerId: null })).json().station.id;
    const printer = (await post("/api/printers", { name: "Kitchen", kind: "network", connection: "127.0.0.1:9100", paperWidth: 80 })).json().printer.id;
    for (const station of [kitchen, bar]) await app.inject({ method: "PATCH", url: `/api/kot-stations/${station}`, headers: auth(token), payload: { printerId: printer } });
    margherita = await product("Margherita", 25000, 5, kitchen);
    farmhouse = await product("Farmhouse", 30000, 5, kitchen);
    cheese = await product("Cheese", 3000, 5, null);
    coke = await product("Coke", 5000, 18, bar);
    thin = await product("Thin", 0, 5, null);
    pan = await product("Pan", 4000, 5, null);
    toppings = await group("Toppings", 0, 2, [cheese, coke]);
    base = await group("Base", 1, 1, [thin, pan]);
    other = await group("Sauces", 0, 1, [cheese]);
    await patch(`/api/products/${margherita}`, { addonGroupIds: [toppings.id, base.id] });
    await patch(`/api/products/${farmhouse}`, { addonGroupIds: [other.id] });
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  const post = (url: string, payload: object) => app.inject({ method: "POST", url, headers: auth(token), payload });
  const patch = (url: string, payload: object) => app.inject({ method: "PATCH", url, headers: auth(token), payload });
  async function product(name: string, pricePaise: number, gstRate: number, kotStationId: string | null) {
    const res = await post("/api/products", { name, categoryId, pricePaise, gstRate, kotStationId });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().product.id as string;
  }
  async function group(name: string, minPicks: number, maxPicks: number, productIds: string[]) {
    const res = await post("/api/addon-groups", { name, minPicks, maxPicks, options: productIds.map((productId) => ({ productId })) });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().group as Group;
  }
  const option = (g: Group, name: string) => g.options.find((o) => o.name === name)!.id;
  async function order(type: "parcel" | "dine_in" = "parcel", tableId?: string) {
    const res = await post("/api/orders", { clientRef: uuidv7(), type, ...(tableId ? { tableId } : {}) });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().order.id as string;
  }
  const add = (orderId: string, productId: string, addonPicks?: string[], extra: object = {}) =>
    post(`/api/orders/${orderId}/items`, { items: [{ clientRef: uuidv7(), productId, qty: 1, ...(addonPicks ? { addonPicks } : {}), ...extra }] });
  const send = (orderId: string, payload?: object) => app.inject({ method: "POST", url: `/api/orders/${orderId}/send`, headers: auth(token), ...(payload ? { payload } : {}) });
  const items = async (orderId: string) => (await app.inject({ url: `/api/orders/${orderId}`, headers: auth(token) })).json().order.items as Item[];

  describe("taking orders", () => {
    it("adds the item with its add-ons as their own lines", async () => {
      const id = await order();
      const res = await add(id, margherita, [option(toppings, "Cheese"), option(base, "Pan")], { qty: 2 });
      expect(res.statusCode, res.body).toBe(200);
      const lines = await items(id);
      expect(lines.map((l) => [l.name, l.pricePaise, l.qty, l.gstRate])).toEqual([["Margherita", 25000, 2, 5], ["Cheese", 3000, 2, 5], ["Pan", 4000, 2, 5]]);
      expect(lines.slice(1).map((l) => [l.addonOfItemId, l.parentItemId])).toEqual([[lines[0]!.id, null], [lines[0]!.id, null]]);
      expect(lines[0]!.addonOfItemId).toBeNull();
    });

    it("prices add-ons for the order's tier and with their own GST rate", async () => {
      await patch(`/api/products/${cheese}`, { takeawayPricePaise: 3500 });
      const id = await order("parcel");
      expect((await add(id, margherita, [option(toppings, "Cheese"), option(toppings, "Coke"), option(base, "Thin")])).statusCode).toBe(200);
      expect((await items(id)).map((l) => [l.name, l.pricePaise, l.gstRate])).toEqual([["Margherita", 25000, 5], ["Cheese", 3500, 5], ["Coke", 5000, 18], ["Thin", 0, 5]]);
    });

    it("rejects bad picks with addon_picks and saves nothing", async () => {
      const id = await order();
      const missingBase = await add(id, margherita, [option(toppings, "Cheese")]);
      expect(missingBase.statusCode).toBe(409);
      expect(missingBase.json()).toMatchObject({ code: "addon_picks" });
      expect(missingBase.body).toContain("Margherita: Choose 1 from Base");
      const foreign = await add(id, margherita, [option(other, "Cheese"), option(base, "Thin")]);
      expect(foreign.statusCode).toBe(409);
      expect(foreign.json().code).toBe("addon_picks");
      const noGroups = await add(id, cheese, [option(toppings, "Cheese")]);
      expect(noGroups.statusCode).toBe(409);
      await patch(`/api/products/${pan}`, { isSoldOut: true });
      expect((await add(id, margherita, [option(base, "Pan")])).json().code).toBe("addon_picks");
      expect(await items(id)).toHaveLength(0);
    });

    it("refuses add-on-only products on their own", async () => {
      await patch(`/api/products/${cheese}`, { addonOnly: true });
      const id = await order();
      const res = await add(id, cheese);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("addon_only");
      expect((await add(id, margherita, [option(toppings, "Cheese"), option(base, "Thin")])).statusCode).toBe(200);
    });

    it("replays without duplicating add-ons", async () => {
      const id = await order();
      const payload = { items: [{ clientRef: uuidv7(), productId: margherita, qty: 1, addonPicks: [option(toppings, "Cheese"), option(base, "Thin")] }] };
      expect((await post(`/api/orders/${id}/items`, payload)).statusCode).toBe(200);
      expect((await post(`/api/orders/${id}/items`, payload)).statusCode).toBe(200);
      expect(await items(id)).toHaveLength(3);
    });

    it("ignores an archived required group", async () => {
      await patch(`/api/addon-groups/${base.id}`, { isActive: false });
      const id = await order();
      const res = await add(id, margherita, []);
      expect(res.statusCode, res.body).toBe(200);
      expect(await items(id)).toHaveLength(1);
    });
  });

  describe("changing, cancelling and moving a dish", () => {
    const pizza = async (type: "parcel" | "dine_in" = "parcel", tableId?: string) => {
      const id = await order(type, tableId);
      expect((await add(id, margherita, [option(toppings, "Cheese"), option(base, "Pan")])).statusCode).toBe(200);
      const [dish, cheeseLine, panLine] = await items(id);
      return { id, dish: dish!, cheeseLine: cheeseLine!, panLine: panLine! };
    };
    const cancel = (itemId: string, reason?: string) => post(`/api/order-items/${itemId}/cancel`, reason ? { reason } : {});

    it("changing the dish's qty changes its add-ons", async () => {
      const { id, dish } = await pizza();
      expect((await patch(`/api/order-items/${dish.id}`, { qty: 3 })).statusCode).toBe(200);
      expect((await items(id)).map((l) => [l.name, l.qty])).toEqual([["Margherita", 3], ["Cheese", 3], ["Pan", 3]]);
    });

    it("a cancelled add-on keeps its qty", async () => {
      const { id, dish, cheeseLine } = await pizza();
      expect((await cancel(cheeseLine.id)).statusCode).toBe(200);
      expect((await patch(`/api/order-items/${dish.id}`, { qty: 2 })).statusCode).toBe(200);
      expect((await items(id)).map((l) => [l.name, l.qty, l.status])).toEqual([["Margherita", 2, "pending"], ["Cheese", 1, "cancelled"], ["Pan", 2, "pending"]]);
    });

    it("add-on lines refuse qty and hold but take a note", async () => {
      const { cheeseLine } = await pizza();
      const qty = await patch(`/api/order-items/${cheeseLine.id}`, { qty: 2 });
      expect(qty.statusCode).toBe(409);
      expect(qty.json()).toMatchObject({ code: "addon_line", error: "Change the dish, not its add-on" });
      expect((await patch(`/api/order-items/${cheeseLine.id}`, { held: true })).json().code).toBe("addon_line");
      expect((await patch(`/api/order-items/${cheeseLine.id}`, { note: "extra crispy" })).statusCode).toBe(200);
    });

    it("cancelling the dish cancels its add-ons", async () => {
      const { id, dish } = await pizza();
      expect((await cancel(dish.id, "Guest left")).statusCode).toBe(200);
      expect((await items(id)).map((l) => [l.status, l.cancelReason])).toEqual([["cancelled", "Guest left"], ["cancelled", "Guest left"], ["cancelled", "Guest left"]]);
    });

    it("an add-on can be cancelled alone", async () => {
      const { id, panLine } = await pizza();
      expect((await cancel(panLine.id)).statusCode).toBe(200);
      expect((await items(id)).map((l) => [l.name, l.status])).toEqual([["Margherita", "pending"], ["Cheese", "pending"], ["Pan", "cancelled"]]);
    });

    it("transfer carries add-ons, including a cancelled one", async () => {
      const table = async (name: string) => (await post("/api/tables", { name })).json().table.id as string;
      const { id, dish, cheeseLine, panLine } = await pizza("dine_in", await table("T1"));
      const target = await order("dine_in", await table("T2"));
      expect((await cancel(cheeseLine.id)).statusCode).toBe(200);
      const alone = await post(`/api/orders/${id}/transfer-items`, { clientRef: uuidv7(), targetOrderId: target, items: [{ id: panLine.id, qty: 1 }] });
      expect(alone.statusCode).toBe(409);
      expect(alone.json().code).toBe("addon_line");
      const moved = await post(`/api/orders/${id}/transfer-items`, { clientRef: uuidv7(), targetOrderId: target, items: [{ id: dish.id, qty: 1 }] });
      expect(moved.statusCode, moved.body).toBe(200);
      expect((await items(target)).map((l) => [l.name, l.status])).toEqual([["Margherita", "pending"], ["Cheese", "cancelled"], ["Pan", "pending"]]);
      expect(await items(id)).toHaveLength(0);
    });

    it("a sent dish with add-ons cannot be edited", async () => {
      const { id, dish } = await pizza();
      expect((await send(id)).statusCode).toBe(200);
      for (const itemId of [dish.id]) {
        const res = await post(`/api/order-items/${itemId}/edit-sent`, { clientRef: uuidv7(), note: "less salt" });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe("addon_line");
      }
    });
  });
});
