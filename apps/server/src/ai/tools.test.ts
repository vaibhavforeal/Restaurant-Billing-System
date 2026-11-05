import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { localDateKey, uuidv7 } from "@masalapos/domain";
import { auth, enableIntegration, freshApp, setupAdmin } from "../test-helpers.js";
import { AI_TOOLS, firstName, runTool } from "./tools.js";

describe("assistant lookups", () => {
  let app: FastifyInstance, token: string, paneer: string, naan: string, lassi: string;
  const now = () => Date.now();
  const today = () => localDateKey(Date.now());
  async function post(url: string, payload: object) {
    const res = await app.inject({ method: "POST", url, payload, headers: auth(token) });
    expect(res.statusCode, res.body).toBeLessThan(400); return res.json();
  }
  async function bill(lines: Array<[string, number]>, extra: { customerId?: string; discountPaise?: number } = {}) {
    const { order } = await post("/api/orders", { clientRef: uuidv7(), type: "parcel" });
    await post(`/api/orders/${order.id}/items`, { items: lines.map(([productId, qty]) => ({ productId, qty, clientRef: uuidv7() })) });
    if (extra.customerId) expect((await app.inject({ method: "PATCH", url: `/api/orders/${order.id}/customer`, payload: { customerId: extra.customerId }, headers: auth(token) })).statusCode).toBe(200);
    const discount = extra.discountPaise ? { discountPaise: extra.discountPaise, discountNote: "Priya's birthday" } : {};
    const { preview } = await post(`/api/orders/${order.id}/bill-preview`, discount);
    return (await post(`/api/orders/${order.id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey, ...discount })).bill;
  }
  const json = (name: string, args: object = {}) => JSON.parse(runTool(app.db, name, JSON.stringify(args), now()).content);

  beforeEach(async () => {
    app = freshApp(); ({ token } = await setupAdmin(app)); enableIntegration(app, "crm");
    const mains = (await post("/api/categories", { name: "Mains" })).category.id;
    const drinks = (await post("/api/categories", { name: "Drinks" })).category.id;
    const product = async (name: string, categoryId: string, pricePaise: number) => (await post("/api/products", { name, categoryId, pricePaise, gstRate: 0, kotStationId: null })).product.id as string;
    paneer = await product("Paneer tikka", mains, 24000); naan = await product("Butter naan", mains, 6000); lassi = await product("Lassi", drinks, 9000);
    const customer = (await post("/api/customers", { name: "Priya Sharma", phone: "98765 43210" })).customer;
    await bill([[paneer, 2], [naan, 3]], { customerId: customer.id });
    await bill([[lassi, 1], [naan, 1]], { customerId: customer.id, discountPaise: 2000 });
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  it("offers exactly the planned lookups", () => {
    expect(AI_TOOLS.map((t) => t.name)).toEqual(["sales_by_day", "sales_by_hour", "item_sales", "category_sales", "order_types", "menu_engineering", "prep_forecast", "staff_activity", "today"]);
    for (const tool of AI_TOOLS) expect(tool.parameters).toMatchObject({ type: "object" });
  });

  it("sales_by_day returns each date with orders and sales", () => {
    const result = runTool(app.db, "sales_by_day", JSON.stringify({ from: today(), to: today() }), now());
    expect(JSON.parse(result.content).days).toEqual([{ date: today(), orders: 2, salesRs: expect.any(Number) }]);
    expect(result.used).toBe(`Sales by day, ${today()} to ${today()}`);
  });

  it("item_sales returns at most 30 dishes and filters by category", () => {
    expect(json("item_sales").dishes[0]).toEqual({ dish: "Butter naan", category: "Mains", plates: 4, salesRs: expect.any(Number) });
    expect(json("item_sales", { category: "drinks" }).dishes.map((d: { dish: string }) => d.dish)).toEqual(["Lassi"]);
    expect(json("item_sales").dishes.length).toBeLessThanOrEqual(30);
  });

  it("category_sales, order_types and sales_by_hour return figures", () => {
    expect(json("category_sales").categories.map((c: { category: string }) => c.category).sort()).toEqual(["Drinks", "Mains"]);
    expect(json("order_types").types.find((t: { type: string }) => t.type === "parcel")).toMatchObject({ orders: 2 });
    expect(json("sales_by_hour").hours.reduce((n: number, h: { orders: number }) => n + h.orders, 0)).toBe(2);
  });

  it("today returns the hub date, weekday and timezone", () => {
    expect(json("today")).toEqual({ date: today(), weekday: expect.any(String), timezone: expect.any(String) });
  });

  it("menu_engineering returns dish, category, plates, margin and group, or an error while Dish costing is off", () => {
    const dishes = json("menu_engineering").dishes as Array<Record<string, unknown>>;
    expect(dishes.find((d) => d.dish === "Butter naan")).toMatchObject({ category: "Mains", plates: 4, group: "Needs a recipe cost" });
    app.db.prepare("INSERT INTO integration_state (id, enabled, updated_at, updated_by) VALUES ('costing', 0, 0, (SELECT id FROM users LIMIT 1)) ON CONFLICT(id) DO UPDATE SET enabled = 0").run();
    expect(json("menu_engineering").error).toMatch(/Dish costing/);
  });

  it("prep_forecast returns dishes and ingredients for the date", () => {
    expect(json("prep_forecast", { date: today() })).toMatchObject({ date: today(), dishes: expect.any(Array), ingredients: expect.any(Array) });
  });

  it("staff_activity names staff by first name only and leaves out typed notes", () => {
    app.db.prepare("UPDATE users SET name = 'Asha Rao'").run();
    const text = runTool(app.db, "staff_activity", "{}", now()).content;
    expect(text).toContain("Asha");
    expect(text).not.toContain("Rao");
    expect(text).not.toContain("birthday");
    expect(JSON.parse(text).byStaff[0]).toMatchObject({ staff: "Asha", discounts: 1 });
    expect(firstName("  Asha  Rao ")).toBe("Asha");
  });

  it("never returns customer details", () => {
    for (const tool of AI_TOOLS) {
      const content = runTool(app.db, tool.name, JSON.stringify(tool.name === "prep_forecast" ? { date: today() } : {}), now()).content;
      expect(content, tool.name).not.toContain("Priya");
      expect(content, tool.name).not.toContain("98765");
    }
  });

  it("bad arguments and unknown tools return an error result", () => {
    for (const [name, args] of [["item_sales", "{not json"], ["drop_tables", "{}"], ["sales_by_day", JSON.stringify({ from: "2020-01-01", to: "2026-11-04" })], ["prep_forecast", "{}"]]) {
      const result = runTool(app.db, name!, args!, now());
      expect(result.content, name).toMatch(/"error"/);
      expect(result.used).toBe("");
    }
  });
});
