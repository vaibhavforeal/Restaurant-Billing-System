import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type Bill, type ComboGroup } from "@forkflow/domain";
import { auth, enableIntegration, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";

type Item = { id: string; productId: string; name: string; qty: number; pricePaise: number; status: string; kotId: string | null; parentItemId: string | null };
type Product = { id: string; kind: string; combo?: ComboGroup[] };

describe("combos", () => {
  let app: FastifyInstance; let token: string; let categoryId: string;
  let kitchen: string; let bar: string;
  let burger: string; let fries: string; let coke: string; let lassi: string; let cokeLarge: string;
  let stockId: string;

  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app));
    categoryId = (await post("/api/categories", { name: "Meals" })).json().category.id;
    kitchen = (app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string }).id;
    bar = (await post("/api/kot-stations", { name: "Bar", printerId: null })).json().station.id;
    const printer = (await post("/api/printers", { name: "Kitchen", kind: "network", connection: "127.0.0.1:9100", paperWidth: 80 })).json().printer.id;
    for (const station of [kitchen, bar]) await app.inject({ method: "PATCH", url: `/api/kot-stations/${station}`, headers: auth(token), payload: { printerId: printer } });
    burger = await product("Veg Burger", 12000, kitchen);
    fries = await product("Fries", 8000, kitchen);
    coke = await product("Coke", 5000, bar, [{ name: "Large", pricePaise: 7000 }]);
    cokeLarge = (app.db.prepare("SELECT id FROM variants WHERE product_id = ?").get(coke) as { id: string }).id;
    lassi = await product("Lassi", 6000, bar);
    const stock = await post("/api/stock-items", { clientRef: uuidv7(), name: "Potato", unit: "kg", openingQty: 10, lowStockThreshold: null });
    stockId = stock.json().item.id;
    await app.inject({ method: "PUT", url: `/api/products/${fries}/stock-links`, headers: auth(token), payload: { expectedVersion: 0, stockItemId: stockId, qtyPerSale: 0.25 } });
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  const post = (url: string, payload: object) => app.inject({ method: "POST", url, headers: auth(token), payload });
  async function product(name: string, pricePaise: number, kotStationId: string | null, variants: object[] = []) {
    const res = await post("/api/products", { name, categoryId, pricePaise, gstRate: 5, kotStationId, variants });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().product.id as string;
  }
  /** Burger and fries always; one drink, a large Coke costing ₹20 more. */
  const slots = () => [
    { name: "Included", minPicks: 2, maxPicks: 2, options: [{ productId: burger }, { productId: fries }] },
    { name: "Drink", minPicks: 1, maxPicks: 1, options: [{ productId: coke }, { productId: coke, variantId: cokeLarge, extraPricePaise: 2000 }, { productId: lassi }] },
  ];
  async function combo(extra: object = {}) {
    const res = await post("/api/products", { name: "Lunch Combo", categoryId, pricePaise: 19900, takeawayPricePaise: 21900, gstRate: 5, kind: "combo", combo: slots(), ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().product as Product;
  }
  const option = (c: Product, name: string) => c.combo!.flatMap((g) => g.options).find((o) => o.name === name)!.id;
  async function order(type: "parcel" | "dine_in" = "parcel") {
    return (await post("/api/orders", { clientRef: uuidv7(), type })).json().order.id as string;
  }
  const addCombo = (orderId: string, comboId: string, comboPicks: string[], qty = 1) =>
    post(`/api/orders/${orderId}/items`, { items: [{ clientRef: uuidv7(), productId: comboId, qty, comboPicks }] });
  const balance = () => (app.db.prepare("SELECT qty FROM stock_items WHERE id = ?").get(stockId) as { qty: number }).qty;

  it("saves slots with the product and lists them with their items' names", async () => {
    const c = await combo();
    expect(c.kind).toBe("combo");
    expect(c.combo!.map((g) => [g.name, g.minPicks, g.maxPicks, g.options.map((o) => o.name)])).toEqual([
      ["Included", 2, 2, ["Veg Burger", "Fries"]],
      ["Drink", 1, 1, ["Coke", "Coke (Large)", "Lassi"]],
    ]);
    const listed = ((await app.inject({ url: "/api/products", headers: auth(token) })).json().products as Product[]).find((p) => p.id === c.id)!;
    expect(listed.combo).toEqual(c.combo);
    expect(((await app.inject({ url: "/api/products", headers: auth(token) })).json().products as Product[]).find((p) => p.id === burger)).not.toHaveProperty("combo");
  });

  it("refuses combos inside combos, a kitchen station, variants, and slots that cannot be filled", async () => {
    const c = await combo();
    expect((await post("/api/products", { name: "Mega", categoryId, pricePaise: 1, kind: "combo", combo: [{ name: "x", minPicks: 1, maxPicks: 1, options: [{ productId: c.id }] }] })).statusCode).toBe(400);
    expect((await post("/api/products", { name: "Mega", categoryId, pricePaise: 1, kind: "combo", kotStationId: kitchen, combo: slots() })).statusCode).toBe(400);
    expect((await post(`/api/products/${c.id}/variants`, { name: "Big", pricePaise: 1 })).statusCode).toBe(400);
    expect((await post("/api/products", { name: "Mega", categoryId, pricePaise: 1, kind: "combo", combo: [{ name: "Drink", minPicks: 2, maxPicks: 3, options: [{ productId: coke }, { productId: lassi }] }] })).statusCode).toBe(400);
    expect((await post("/api/products", { name: "Mega", categoryId, pricePaise: 1, kind: "combo" })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/products/${burger}`, headers: auth(token), payload: { combo: slots() } })).statusCode).toBe(400);
  });

  it("keeps option ids when slots are saved again, so carts punched earlier still match", async () => {
    const c = await combo();
    const edited = c.combo!.map((g) => ({ ...g, options: g.options.map(({ id, productId, variantId, qty, extraPricePaise }) => ({ id, productId, variantId, qty, extraPricePaise })) }));
    edited[1]!.options.push({ id: "made-up", productId: burger, variantId: null, qty: 1, extraPricePaise: 0 });
    const res = await app.inject({ method: "PATCH", url: `/api/products/${c.id}`, headers: auth(token), payload: { combo: edited } });
    expect(res.statusCode, res.body).toBe(200);
    const saved = res.json().product as Product;
    expect(saved.combo![1]!.options.slice(0, 3).map((o) => o.id)).toEqual(c.combo![1]!.options.map((o) => o.id));
    expect(saved.combo![1]!.options[3]!.id).not.toBe("made-up");
  });

  it("prices a combo for the order's tier plus extras and adds its items as ₹0 lines", async () => {
    const c = await combo();
    const orderId = await order();
    expect((await addCombo(orderId, c.id, [])).json()).toMatchObject({ code: "combo_picks", error: "Lunch Combo: Choose 1 from Drink" });
    expect((await addCombo(orderId, c.id, [option(c, "Coke"), option(c, "Lassi")])).statusCode).toBe(409);
    const res = await addCombo(orderId, c.id, [option(c, "Coke (Large)")], 2);
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().order.items as Item[];
    const line = items.find((i) => !i.parentItemId)!;
    expect(line).toMatchObject({ name: "Lunch Combo", pricePaise: 21900 + 2000, qty: 2 });
    expect(items.filter((i) => i.parentItemId === line.id).map((i) => [i.name, i.qty, i.pricePaise])).toEqual([
      ["Veg Burger", 2, 0], ["Fries", 2, 0], ["Coke (Large)", 2, 0],
    ]);
    // Changing the combo's quantity carries its items along; the items themselves cannot be changed on their own.
    const changed = await app.inject({ method: "PATCH", url: `/api/order-items/${line.id}`, headers: auth(token), payload: { qty: 3, note: "No onion" } });
    expect((changed.json().order.items as Item[]).filter((i) => i.parentItemId).map((i) => i.qty)).toEqual([3, 3, 3]);
    const child = items.find((i) => i.parentItemId)!;
    expect((await app.inject({ method: "PATCH", url: `/api/order-items/${child.id}`, headers: auth(token), payload: { qty: 1 } })).statusCode).toBe(409);
  });

  it("refuses a combo while a fixed item is sold out", async () => {
    const c = await combo();
    await app.inject({ method: "PATCH", url: `/api/products/${fries}`, headers: auth(token), payload: { isSoldOut: true } });
    const res = await addCombo(await order(), c.id, [option(c, "Coke")]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Lunch Combo: Fries is not available");
  });

  it("sends each item to its own station, bills one line and reports items sold in combos", async () => {
    enableIntegration(app, "kds");
    const c = await combo();
    const orderId = await order();
    const added = await addCombo(orderId, c.id, [option(c, "Lassi")]);
    const line = (added.json().order.items as Item[]).find((i) => !i.parentItemId)!;
    // Naming just the combo sends what is in it.
    const sent = await post(`/api/orders/${orderId}/send`, { clientRef: uuidv7(), itemIds: [line.id] });
    expect(sent.statusCode, sent.body).toBe(200);
    const kots = sent.json().kots as Array<{ stationId: string; items: Array<{ name: string }> }>;
    expect(kots.map((k) => [k.stationId, k.items.map((i) => i.name)]).sort()).toEqual([[bar, ["Lassi"]], [kitchen, ["Veg Burger", "Fries"]]].sort());
    expect((sent.json().order.items as Item[]).every((i) => i.status === "sent")).toBe(true);
    expect(balance()).toBe(9.75);
    // The combo's line cannot be edited after send; its items cannot be cancelled one by one.
    expect((await post(`/api/order-items/${line.id}/edit-sent`, { clientRef: uuidv7(), note: "x" })).json().code).toBe("combo_item");

    const preview = await post(`/api/orders/${orderId}/bill-preview`, {});
    expect(preview.json().preview.subtotalPaise).toBe(21900);
    expect(preview.json().preview.receipt.items).toEqual([{ name: "Lunch Combo", qty: 1, pricePaise: 21900, gstRate: 5, contents: ["Veg Burger", "Fries", "Lassi"] }]);
    const billed = await post(`/api/orders/${orderId}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey });
    expect(billed.statusCode, billed.body).toBe(201);
    const bill = billed.json().bill as Bill;
    const lines = app.db.prepare("SELECT name, qty, total_paise, parent_order_item_id FROM bill_report_lines WHERE bill_id = ? ORDER BY parent_order_item_id IS NOT NULL, name").all(bill.id);
    expect(lines).toEqual([
      { name: "Lunch Combo", qty: 1, total_paise: bill.totalPaise, parent_order_item_id: null },
      { name: "Fries", qty: 1, total_paise: 0, parent_order_item_id: line.id },
      { name: "Lassi", qty: 1, total_paise: 0, parent_order_item_id: line.id },
      { name: "Veg Burger", qty: 1, total_paise: 0, parent_order_item_id: line.id },
    ]);

    const day = new Date().toISOString().slice(0, 10);
    const report = await app.inject({ url: `/api/reports/operations/items?from=${day}&to=${day}`, headers: auth(token) });
    expect(report.statusCode, report.body).toBe(200);
    const tables = report.json().report.tables as Array<{ title: string; rows: Array<{ name: string; qty: number }> }>;
    expect(tables.find((t) => t.title === "Item sales")!.rows.map((r) => r.name)).toEqual(["Lunch Combo"]);
    expect(tables.find((t) => t.title === "Items sold in combos")!.rows.map((r) => [r.name, r.qty]).sort()).toEqual([["Fries", 1], ["Lassi", 1], ["Veg Burger", 1]]);
  });

  it("costs a combo in the profit report from the recipes of the items in it", async () => {
    app.db.prepare("UPDATE stock_items SET unit_cost_milli_paise = 4000000 WHERE id = ?").run(stockId); // ₹40 a kg: ₹10 of potato per portion
    const c = await combo();
    const orderId = await order();
    await addCombo(orderId, c.id, [option(c, "Coke")]);
    await app.inject({ method: "POST", url: `/api/orders/${orderId}/send`, headers: auth(token) });
    const preview = await post(`/api/orders/${orderId}/bill-preview`, {});
    expect((await post(`/api/orders/${orderId}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey })).statusCode).toBe(201);
    const day = new Date().toISOString().slice(0, 10);
    const profit = await app.inject({ url: `/api/reports/profit?from=${day}&to=${day}`, headers: auth(token) });
    expect(profit.statusCode, profit.body).toBe(200);
    const tables = profit.json().report.tables as Array<{ title: string; rows: Array<Record<string, unknown>> }>;
    expect(tables[0]!.rows.find((r) => r.metric === "Ingredient cost")!.amount).toBe(1000);
    expect(tables.flatMap((t) => t.rows).filter((r) => r.name === "Lunch Combo").map((r) => r.status)).not.toContain("No recipe");
    expect(tables.flatMap((t) => t.rows).some((r) => r.name === "Fries")).toBe(false);
  });

  it("cancels a sent combo with all its items, returns their stock and slips each kitchen", async () => {
    const c = await combo();
    const orderId = await order();
    const added = await addCombo(orderId, c.id, [option(c, "Coke")]);
    const line = (added.json().order.items as Item[]).find((i) => !i.parentItemId)!;
    await app.inject({ method: "POST", url: `/api/orders/${orderId}/send`, headers: auth(token) });
    expect(balance()).toBe(9.75);
    const child = (added.json().order.items as Item[]).find((i) => i.parentItemId)!;
    expect((await post(`/api/order-items/${child.id}/cancel`, { reason: "x" })).json().code).toBe("combo_item");
    expect((await post(`/api/order-items/${line.id}/cancel`, {})).statusCode).toBe(400);
    const res = await post(`/api/order-items/${line.id}/cancel`, { reason: "Guest left" });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().order.items as Item[]).every((i) => i.status === "cancelled")).toBe(true);
    expect(balance()).toBe(10);
    const cancels = (app.db.prepare("SELECT job_json FROM print_jobs").all() as Array<{ job_json: string }>).map((r) => JSON.parse(r.job_json)).filter((j) => j.kind === "cancel");
    expect(cancels).toHaveLength(3);
    // Nothing is left to bill.
    expect((await post(`/api/orders/${orderId}/bill-preview`, {})).statusCode).toBe(409);
  });
});
