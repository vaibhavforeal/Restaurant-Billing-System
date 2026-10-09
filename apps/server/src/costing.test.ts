import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { localDateKey, uuidv7, type OperationalReport, type StockItem, type StockMove, type StockCostChange } from "@forkflow/domain";
import { freshApp, setupAdmin, auth, createUser } from "./test-helpers.js";

// Roles are code and only admins hold stock.manage, so a test hook lets one role name behave as a stock
// manager without cost access.
const roleOverrides = vi.hoisted(() => new Map<string, { name: string; permissions: string[] }>());
vi.mock("@forkflow/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@forkflow/domain")>();
  return { ...actual, roleFor: (name: string) => roleOverrides.get(name) ?? actual.roleFor(name as Parameters<typeof actual.roleFor>[0]) };
});

describe("stock costing", () => {
  let app: FastifyInstance; let token: string;
  beforeEach(async () => { app = freshApp(); ({ token } = await setupAdmin(app)); });
  afterEach(async () => { roleOverrides.clear(); await app.close(); app.db.close(); });
  const request = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object, as = token) =>
    app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  async function stock(qty = 10, name = "Paneer"): Promise<StockItem> {
    const res = await request("POST", "/api/stock-items", { clientRef: uuidv7(), name, unit: "kg", openingQty: qty, lowStockThreshold: null });
    expect(res.statusCode).toBe(201); return res.json().item;
  }
  const version = (id: string) => (app.db.prepare("SELECT version FROM stock_items WHERE id = ?").get(id) as { version: number }).version;
  const unitCost = (id: string, unitCostMilliPaise: number, extra: object = {}, as = token) =>
    request("POST", `/api/stock-items/${id}/unit-cost`, { clientRef: uuidv7(), expectedVersion: version(id), unitCostMilliPaise, note: "Opening cost", ...extra }, as);
  const purchase = (id: string, payload: object = {}) =>
    request("POST", `/api/stock-items/${id}/movements`, { clientRef: uuidv7(), expectedVersion: version(id), reason: "purchase", quantity: 10, note: "Invoice 12", ...payload });
  const history = (id: string, as = token, query = "") => request("GET", `/api/stock-items/${id}/movements${query}`, undefined, as);

  it("sets a starting cost, receives priced stock, and shows cost in history to admins", async () => {
    const item = await stock();
    const set = await unitCost(item.id, 30_000_000); 
    expect(set.statusCode).toBe(201);
    expect(set.json().unitCostMilliPaise).toBe(30_000_000);
    expect(set.json().item.id).toBe(item.id);
    expect(set.json().item.version).toBe(item.version + 1);
    const bought = await purchase(item.id, { costPaise: 340_000 });
    expect(bought.statusCode).toBe(201);
    const res = await history(item.id);
    expect(res.statusCode).toBe(200);
    const { movements, costChanges } = res.json() as { movements: StockMove[]; costChanges: StockCostChange[] };
    expect(movements.find((m) => m.reason === "purchase")?.costPaise).toBe(340_000);
    expect(costChanges[0]?.newCostMilliPaise).toBe(30_000_000);
    expect(costChanges[0]?.oldCostMilliPaise).toBeNull();
    expect(costChanges[0]?.note).toBe("Opening cost");
    expect(costChanges[0]?.createdByName).toBe("Asha");
  });

  it("retries a unit-cost change and rejects a reused reference", async () => {
    const item = await stock();
    const body = { clientRef: uuidv7(), expectedVersion: item.version, unitCostMilliPaise: 5_000, note: "Opening cost" };
    const first = await request("POST", `/api/stock-items/${item.id}/unit-cost`, body);
    expect(first.statusCode).toBe(201);
    const retry = await request("POST", `/api/stock-items/${item.id}/unit-cost`, body);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().unitCostMilliPaise).toBe(5_000);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM stock_cost_changes").get()).toEqual({ n: 1 });
    expect(version(item.id)).toBe(item.version + 1);
    expect((await request("POST", `/api/stock-items/${item.id}/unit-cost`, { ...body, unitCostMilliPaise: 6_000 })).statusCode).toBe(409);
    const stale = await unitCost(item.id, 7_000, { expectedVersion: item.version });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatch(/changed on another counter/);
    const second = await unitCost(item.id, 8_000);
    expect(second.statusCode).toBe(201);
    const rows = app.db.prepare("SELECT old_cost_milli_paise AS o, new_cost_milli_paise AS n FROM stock_cost_changes ORDER BY created_at, id").all();
    expect(rows).toEqual([{ o: null, n: 5_000 }, { o: 5_000, n: 8_000 }]);
    const archived = await request("PATCH", `/api/stock-items/${item.id}`, { expectedVersion: version(item.id), isActive: false });
    expect(archived.statusCode).toBe(200);
    expect((await unitCost(item.id, 9_000)).statusCode).toBe(409);
    const missing = await request("POST", "/api/stock-items/missing/unit-cost", { clientRef: uuidv7(), expectedVersion: 0, unitCostMilliPaise: 9_000, note: "x" });
    expect(missing.statusCode).toBe(404);
  });

  it("returns 409 when a purchase reference is reused with a different amount", async () => {
    const item = await stock();
    const body = { clientRef: uuidv7(), expectedVersion: item.version, reason: "purchase", quantity: 5, note: "Invoice 7", costPaise: 100_000 };
    const first = await request("POST", `/api/stock-items/${item.id}/movements`, body);
    expect(first.statusCode).toBe(201);
    expect((await request("POST", `/api/stock-items/${item.id}/movements`, body)).statusCode).toBe(200);
    expect((await request("POST", `/api/stock-items/${item.id}/movements`, { ...body, costPaise: 100_001 })).statusCode).toBe(409);
    expect((await request("POST", `/api/stock-items/${item.id}/movements`, { ...body, costPaise: undefined })).statusCode).toBe(409);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE reason = 'purchase'").get()).toEqual({ n: 1 });
  });

  it("hides cost from cashiers", async () => {
    const item = await stock();
    expect((await unitCost(item.id, 30_000_000)).statusCode).toBe(201);
    expect((await purchase(item.id, { costPaise: 340_000 })).statusCode).toBe(201);
    const { token: cashier } = await createUser(app, token, { name: "Ravi", pin: "4321", role: "cashier" });
    const denied = await unitCost(item.id, 1_000, {}, cashier);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().permission).toBe("costs.read");
    const res = await history(item.id, cashier);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { movements: StockMove[]; costChanges?: unknown };
    expect(body.movements.length).toBeGreaterThan(0);
    for (const m of body.movements) expect("costPaise" in m).toBe(false);
    expect("costChanges" in body).toBe(false);
    const items = (await request("GET", "/api/stock-items", undefined, cashier)).json().items as object[];
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(Object.keys(i).filter((k) => /cost/i.test(k))).toEqual([]);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM stock_cost_changes").get()).toEqual({ n: 1 });
  });

  it("hides cost after a downgrade to Basic", async () => {
    const item = await stock();
    expect((await unitCost(item.id, 30_000_000)).statusCode).toBe(201);
    expect((await purchase(item.id, { costPaise: 340_000 })).statusCode).toBe(201);
    const real = app.licensing.status.bind(app.licensing);
    vi.spyOn(app.licensing, "status").mockImplementation((credential: unknown) =>
      ({ ...real(credential), canOperate: true, features: { recipes: false, qrOrdering: false, kds: false } }));
    const res = await history(item.id);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { movements: StockMove[]; costChanges?: unknown };
    expect(body.movements.length).toBeGreaterThan(0);
    for (const m of body.movements) expect("costPaise" in m).toBe(false);
    expect("costChanges" in body).toBe(false);
    const before = app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves").get();
    expect((await purchase(item.id, { costPaise: 1_000 })).statusCode).toBe(403);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves").get()).toEqual(before);
    expect((await unitCost(item.id, 1_000)).statusCode).toBe(403);
    // Unpriced receiving still works on Basic.
    expect((await purchase(item.id)).statusCode).toBe(201);
  });

  it("windows cost changes to the movement page (ruling R2)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Stock history is append-only, so movement times come from the (fake) clock.
      vi.setSystemTime(500);
      const item = await stock(1);
      const admin = (app.db.prepare("SELECT id FROM users WHERE name = 'Asha'").get() as { id: string }).id;
      const insert = app.db.prepare("INSERT INTO stock_cost_changes (id, stock_item_id, old_cost_milli_paise, new_cost_milli_paise, note, created_at, created_by) VALUES (?, ?, NULL, ?, 'n', ?, ?)");
      insert.run("c-a", item.id, 1, 1_000, admin);
      insert.run("c-b", item.id, 2, 2_000, admin);
      insert.run("c-c", item.id, 3, 3_000, admin);
      // Opening balance at t=500 plus 100 purchases at t=1500..2490: the first page is full, the second holds the opening move.
      for (let i = 0; i < 100; i++) {
        vi.setSystemTime(1_500 + i * 10);
        expect((await purchase(item.id, { quantity: 1 })).statusCode).toBe(201);
      }
      // Page 1: lower bound is its oldest movement (1500), so c-a (1000) is excluded.
      const page1 = (await history(item.id)).json() as { movements: StockMove[]; costChanges: StockCostChange[] };
      expect(page1.movements).toHaveLength(100);
      expect(page1.costChanges.map((c) => c.id)).toEqual(["c-c", "c-b"]);
      // Page 2: one movement left (last page, no lower bound); upper bound is the cursor movement time (1500).
      const cursor = page1.movements[99]!.id;
      const page2 = (await history(item.id, token, `?before=${cursor}`)).json() as { movements: StockMove[]; costChanges: StockCostChange[] };
      expect(page2.movements).toHaveLength(1);
      expect(page2.costChanges.map((c) => c.id)).toEqual(["c-a"]);
    } finally { vi.useRealTimers(); }
  });

  it("refuses a priced purchase from a stock manager without cost access", async () => {
    const item = await stock();
    const { token: manager } = await createUser(app, token, { name: "Ravi", pin: "4321", role: "cashier" });
    roleOverrides.set("cashier", { name: "cashier", permissions: ["stock.read", "stock.manage"] });
    const body = { clientRef: uuidv7(), expectedVersion: item.version, reason: "purchase", quantity: 5, note: "Invoice 9" };
    const priced = await request("POST", `/api/stock-items/${item.id}/movements`, { ...body, costPaise: 50_000 }, manager);
    expect(priced.statusCode).toBe(403);
    expect(priced.json().error).toBe("Not allowed to record cost");
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE reason = 'purchase'").get()).toEqual({ n: 0 });
    // Unpriced receiving stays available to them, and they still never see cost in history.
    expect((await request("POST", `/api/stock-items/${item.id}/movements`, body, manager)).statusCode).toBe(201);
    const res = (await history(item.id, manager)).json() as { movements: StockMove[]; costChanges?: unknown };
    for (const m of res.movements) expect("costPaise" in m).toBe(false);
    expect("costChanges" in res).toBe(false);
  });

  describe("stock value and dish costing", () => {
    const costed = async (name: string, qty: number, unitCostMilliPaise: number | null) => {
      const item = await stock(qty, name);
      if (unitCostMilliPaise !== null) expect((await unitCost(item.id, unitCostMilliPaise)).statusCode).toBe(201);
      return item;
    };
    async function category(): Promise<string> {
      const res = await request("POST", "/api/categories", { name: "Mains" });
      expect(res.statusCode).toBe(201); return res.json().category.id;
    }
    async function product(categoryId: string, payload: object = {}): Promise<{ id: string; variants: Array<{ id: string; name: string }> }> {
      const res = await request("POST", "/api/products", { name: "Paneer Tikka", categoryId, pricePaise: 10_500, gstRate: 5, kotStationId: null, ...payload });
      expect(res.statusCode).toBe(201); return res.json().product;
    }
    async function recipe(productId: string, ingredients: Array<{ stockItemId: string; qtyPerSale: number }>) {
      const res = await request("PUT", `/api/products/${productId}/recipe`, { expectedVersion: 0, ingredients });
      expect(res.statusCode).toBe(200);
    }
    type Dish = { productId: string; variantId: string | null; name: string; categoryName: string; costPaise: number | null; status: string; missing: string[]; prices: Array<{ tier: string; pricePaise: number; preGstPaise: number; costPercent: number | null; marginPaise: number | null }> };
    const dishes = async (as = token) => (await request("GET", "/api/costing/dishes", undefined, as)).json() as { dishes: Dish[]; gstMode: "included" | "none" };

    it("values stock on hand", async () => {
      const paneer = await costed("Paneer", 10, 32_000_000);
      const salt = await costed("Salt", 5, null);
      const res = await request("GET", "/api/costing/stock");
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ stockItemId: string; name: string; unit: string; qty: number; isActive: boolean; unitCostMilliPaise: number | null; valuePaise: number | null }>; totalValuePaise: number };
      expect(body.items.find((i) => i.stockItemId === paneer.id)).toMatchObject({ name: "Paneer", unit: "kg", qty: 10, isActive: true, unitCostMilliPaise: 32_000_000, valuePaise: 320_000 });
      expect(body.items.find((i) => i.stockItemId === salt.id)?.valuePaise).toBeNull();
      expect(body.totalValuePaise).toBe(320_000);
    });

    it("values negative stock negatively and leaves archived items out of the total", async () => {
      const oil = await costed("Oil", 1, 100_000_000);
      const old = await costed("Old", 2, 50_000_000);
      expect((await request("PATCH", `/api/stock-items/${old.id}`, { expectedVersion: version(old.id), isActive: false })).statusCode).toBe(200);
      app.db.prepare("UPDATE stock_items SET qty = -0.5 WHERE id = ?").run(oil.id);
      const body = (await request("GET", "/api/costing/stock")).json() as { items: Array<{ stockItemId: string; valuePaise: number | null; isActive: boolean }>; totalValuePaise: number };
      expect(body.items.find((i) => i.stockItemId === oil.id)?.valuePaise).toBe(-50_000);
      expect(body.items.find((i) => i.stockItemId === old.id)).toMatchObject({ isActive: false, valuePaise: 100_000 });
      expect(body.totalValuePaise).toBe(-50_000);
    });

    it("costs dishes against each service price, pre-GST", async () => {
      const paneer = await costed("Paneer", 10, 32_000_000);
      const cat = await category();
      const p = await product(cat, { acPricePaise: 12_600 });
      await recipe(p.id, [{ stockItemId: paneer.id, qtyPerSale: 0.15 }]);
      const body = await dishes();
      expect(body.gstMode).toBe("included");
      expect(body.dishes).toHaveLength(1);
      expect(body.dishes[0]).toMatchObject({
        productId: p.id, variantId: null, name: "Paneer Tikka", categoryName: "Mains", costPaise: 4_800, status: "complete", missing: [],
        prices: [
          { tier: "non_ac", preGstPaise: 10_000, costPercent: 48 },
          { tier: "ac", preGstPaise: 12_000, costPercent: 40 },
          { tier: "takeaway", preGstPaise: 10_000, costPercent: 48 },
          { tier: "zomato", preGstPaise: 10_500, costPercent: 45.7 },
        ],
      });
      expect(body.dishes[0]!.prices.map((x) => x.marginPaise)).toEqual([5_200, 7_200, 5_200, 5_700]);
      expect(body.dishes[0]!.prices[0]!.pricePaise).toBe(10_500);
    });

    it("backs the restaurant default rate out of an item with no rate of its own, and its own rate out of an override", async () => {
      const paneer = await costed("Paneer", 10, 32_000_000);
      const cat = await category();
      const byDefault = await product(cat, { name: "Default", gstRate: null });
      const override = await product(cat, { name: "Override", gstRate: 18, pricePaise: 11_800 });
      await recipe(byDefault.id, [{ stockItemId: paneer.id, qtyPerSale: 0.15 }]);
      await recipe(override.id, [{ stockItemId: paneer.id, qtyPerSale: 0.15 }]);
      let body = await dishes();
      expect(body.gstMode).toBe("included");
      expect(body.dishes.find((d) => d.productId === byDefault.id)!.prices[0]).toMatchObject({ pricePaise: 10_500, preGstPaise: 10_000 });
      expect(body.dishes.find((d) => d.productId === override.id)!.prices[0]).toMatchObject({ pricePaise: 11_800, preGstPaise: 10_000 });
      // A new default applies to items that follow it, while an override keeps its own rate.
      expect((await request("PUT", "/api/settings", { restaurantName: "Cafe", gstRate: 12 })).statusCode).toBe(200);
      body = await dishes();
      expect(body.dishes.find((d) => d.productId === byDefault.id)!.prices[0]).toMatchObject({ pricePaise: 10_500, preGstPaise: 9_375 });
      expect(body.dishes.find((d) => d.productId === override.id)!.prices[0]!.preGstPaise).toBe(10_000);
    });

    it("costs a Zomato price on its own, with no GST backed out because Zomato bills carry none", async () => {
      const paneer = await costed("Paneer", 10, 32_000_000);
      const cat = await category();
      const p = await product(cat, { zomatoPricePaise: 12_000 });
      await recipe(p.id, [{ stockItemId: paneer.id, qtyPerSale: 0.15 }]);
      const dish = (await dishes()).dishes[0]!;
      expect(dish.prices.map((x) => x.tier)).toEqual(["non_ac", "ac", "takeaway", "zomato"]);
      expect(dish.prices[3]).toMatchObject({ tier: "zomato", pricePaise: 12_000, preGstPaise: 12_000, costPercent: 40, marginPaise: 7_200 });
      expect(dish.prices[2]).toMatchObject({ tier: "takeaway", pricePaise: 10_500, preGstPaise: 10_000, marginPaise: 5_200 });
    });

    it("backs no GST out of any price when the restaurant charges none", async () => {
      const paneer = await costed("Paneer", 10, 32_000_000);
      const cat = await category();
      const p = await product(cat, {});
      await recipe(p.id, [{ stockItemId: paneer.id, qtyPerSale: 0.15 }]);
      const override = await product(cat, { name: "Override", gstRate: 18 });
      await recipe(override.id, [{ stockItemId: paneer.id, qtyPerSale: 0.15 }]);
      expect((await request("PUT", "/api/settings", { restaurantName: "Cafe", gstMode: "none" })).statusCode).toBe(200);
      const body = await dishes();
      expect(body.gstMode).toBe("none");
      expect(body.dishes).toHaveLength(2);
      expect(body.dishes.every((d) => d.prices.every((x) => x.preGstPaise === x.pricePaise))).toBe(true);
    });

    it("prices a blank Zomato tier at Takeaway and a Zomato price of zero at zero", async () => {
      const paneer = await costed("Paneer", 10, 32_000_000);
      const cat = await category();
      const viaTakeaway = await product(cat, { name: "Tikka", takeawayPricePaise: 9_600 });
      const free = await product(cat, { name: "Sample", takeawayPricePaise: 9_600, zomatoPricePaise: 0 });
      await recipe(viaTakeaway.id, [{ stockItemId: paneer.id, qtyPerSale: 0.15 }]);
      await recipe(free.id, [{ stockItemId: paneer.id, qtyPerSale: 0.15 }]);
      const body = await dishes();
      expect(body.dishes.find((d) => d.productId === viaTakeaway.id)!.prices[3]).toMatchObject({ tier: "zomato", pricePaise: 9_600, marginPaise: 4_800 });
      expect(body.dishes.find((d) => d.productId === free.id)!.prices[3]).toMatchObject({ tier: "zomato", pricePaise: 0, preGstPaise: 0, costPercent: null, marginPaise: null });
    });

    it("costs each active variant on its own prices and leaves inactive ones out", async () => {
      const paneer = await costed("Paneer", 10, 32_000_000);
      const cat = await category();
      const p = await product(cat, { gstRate: 0, variants: [{ name: "Half", pricePaise: 6_000 }, { name: "Full", pricePaise: 10_000, takeawayPricePaise: 9_600 }, { name: "Jumbo", pricePaise: 20_000 }] });
      await recipe(p.id, [{ stockItemId: paneer.id, qtyPerSale: 0.15 }]);
      app.db.prepare("UPDATE variants SET is_active = 0 WHERE name = 'Jumbo'").run();
      app.db.prepare("INSERT INTO products (id, category_id, name, price_paise, gst_rate, is_active, created_at) VALUES ('p-off', ?, 'Retired', 100, 5, 0, 1)").run(cat);
      const body = await dishes();
      expect(body.dishes.map((d) => d.name).sort()).toEqual(["Paneer Tikka · Full", "Paneer Tikka · Half"]);
      const half = body.dishes.find((d) => d.name.endsWith("Half"))!;
      const full = body.dishes.find((d) => d.name.endsWith("Full"))!;
      expect(half.variantId).toBe(p.variants.find((v) => v.name === "Half")!.id);
      expect(half.productId).toBe(p.id);
      expect(half.costPaise).toBe(4_800);
      expect(half.prices.map((x) => [x.preGstPaise, x.costPercent])).toEqual([[6_000, 80], [6_000, 80], [6_000, 80], [6_000, 80]]);
      expect(full.prices.map((x) => [x.pricePaise, x.costPercent, x.marginPaise])).toEqual([[10_000, 48, 5_200], [10_000, 48, 5_200], [9_600, 50, 4_800], [9_600, 50, 4_800]]);
    });

    it("flags incomplete and unlinked dishes", async () => {
      const paneer = await costed("Paneer", 10, 32_000_000);
      const cream = await costed("Cream", 4, null);
      const cat = await category();
      const incomplete = await product(cat, { name: "Malai Paneer" });
      await recipe(incomplete.id, [{ stockItemId: paneer.id, qtyPerSale: 0.1 }, { stockItemId: cream.id, qtyPerSale: 0.05 }]);
      const bare = await product(cat, { name: "Water", pricePaise: 0 });
      const body = await dishes();
      const a = body.dishes.find((d) => d.productId === incomplete.id)!;
      expect(a).toMatchObject({ status: "incomplete", missing: ["Cream"], costPaise: null });
      for (const price of a.prices) expect(price).toMatchObject({ costPercent: null, marginPaise: null });
      const b = body.dishes.find((d) => d.productId === bare.id)!;
      expect(b).toMatchObject({ status: "no_recipe", missing: [], costPaise: null });
      for (const price of b.prices) expect(price).toMatchObject({ costPercent: null, marginPaise: null });
    });

    it("leaves percent and margin empty when the pre-GST price is zero", async () => {
      const paneer = await costed("Paneer", 10, 32_000_000);
      const cat = await category();
      const free = await product(cat, { name: "Free Sample", pricePaise: 0 });
      await recipe(free.id, [{ stockItemId: paneer.id, qtyPerSale: 0.1 }]);
      const dish = (await dishes()).dishes[0]!;
      expect(dish.costPaise).toBe(3_200);
      for (const price of dish.prices) expect(price).toMatchObject({ preGstPaise: 0, costPercent: null, marginPaise: null });
    });

    it("refuses cashiers", async () => {
      const { token: cashier } = await createUser(app, token, { name: "Ravi", pin: "4321", role: "cashier" });
      for (const url of ["/api/costing/stock", "/api/costing/dishes"]) {
        const res = await request("GET", url, undefined, cashier);
        expect(res.statusCode).toBe(403);
        expect(res.json().permission).toBe("costs.read");
      }
    });
  });

  describe("profit report", () => {
    const today = () => localDateKey(Date.now());
    const profit = (query = `?from=${today()}&to=${today()}`, as = token) => request("GET", `/api/reports/profit${query}`, undefined, as);
    const summary = (report: OperationalReport) => Object.fromEntries(report.tables[0]!.rows.map((row) => [row.metric, row]));
    async function sellParcel(productId: string, qty = 1) {
      const order = await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel", tableId: null });
      expect(order.statusCode).toBe(201);
      const id = order.json().order.id as string;
      expect((await request("POST", `/api/orders/${id}/items`, { items: [{ productId, qty, clientRef: uuidv7() }] })).statusCode).toBe(200);
      const preview = await request("POST", `/api/orders/${id}/bill-preview`, { discountPaise: 0 });
      expect(preview.statusCode).toBe(200);
      const bill = await request("POST", `/api/orders/${id}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey, discountPaise: 0 });
      expect(bill.statusCode).toBe(201);
      return { orderId: id, billId: bill.json().bill.id as string };
    }
    async function dish(name: string, links: Array<{ stockItemId: string; qtyPerSale: number }>) {
      const cat = await request("POST", "/api/categories", { name: `Cat ${name}` });
      const product = await request("POST", "/api/products", { name, categoryId: cat.json().category.id, pricePaise: 10_000, gstRate: 0, kotStationId: null });
      expect(product.statusCode).toBe(201);
      const id = product.json().product.id as string;
      if (links.length) expect((await request("PUT", `/api/products/${id}/recipe`, { expectedVersion: 0, ingredients: links })).statusCode).toBe(200);
      return id;
    }

    it("reports profit from frozen costs and never rewrites the past", async () => {
      const paneer = await stock(10);
      expect((await unitCost(paneer.id, 32_000_000)).statusCode).toBe(201);
      const tikka = await dish("Paneer Tikka", [{ stockItemId: paneer.id, qtyPerSale: 0.15 }]);
      await sellParcel(tikka);
      const first = await profit();
      expect(first.statusCode).toBe(200);
      const report = first.json().report as OperationalReport & { kind: string };
      expect(report.kind).toBe("profit");
      expect(report.from).toBe(today());
      const s = summary(report);
      expect(s["Revenue (pre-GST)"]!.amount).toBe(10_000);
      expect(s["Ingredient cost"]!.amount).toBe(4_800);
      expect(s["Gross profit"]!.amount).toBe(5_200);
      expect(s["Food cost %"]!.percent).toBe(48);
      expect(report.tables[2]!.rows[0]).toMatchObject({ name: "Paneer Tikka", qty: 1, revenue: 10_000, cost: 4_800, profit: 5_200, costPercent: 48, status: "Costed" });
      expect(report.tables[1]!.rows[0]).toMatchObject({ name: "Cat Paneer Tikka", cost: 4_800 });
      // A later purchase at a new price and a manual cost change must not touch history.
      expect((await purchase(paneer.id, { quantity: 10, costPaise: 500_000 })).statusCode).toBe(201);
      expect((await unitCost(paneer.id, 60_000_000)).statusCode).toBe(201);
      const second = (await profit()).json().report as OperationalReport;
      expect(second.tables).toEqual(report.tables);
    });

    it("takes credit-note taxable value off revenue on the credit date, leaving ingredient cost unchanged", async () => {
      const paneer = await stock(10);
      expect((await unitCost(paneer.id, 32_000_000)).statusCode).toBe(201);
      const tikka = await dish("Paneer Tikka", [{ stockItemId: paneer.id, qtyPerSale: 0.15 }]);
      const { billId } = await sellParcel(tikka, 2);
      expect((await request("POST", `/api/bills/${billId}/settle`, { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: 20_000 }] })).statusCode).toBe(200);
      const orderItemId = (app.db.prepare("SELECT order_item_id AS id FROM bill_report_lines WHERE bill_id = ?").get(billId) as { id: string }).id;
      const refund = await request("POST", `/api/bills/${billId}/refund`, { clientRef: uuidv7(), reason: "Cold food", lines: [{ orderItemId, qty: 1 }], refunds: [{ mode: "cash", amountPaise: 10_000 }] });
      expect(refund.statusCode, refund.body).toBe(201);
      const report = (await profit()).json().report as OperationalReport;
      const s = summary(report);
      expect(s["Revenue (pre-GST)"]!.amount).toBe(10_000);
      expect(s["Costed revenue"]!.amount).toBe(10_000);
      expect(s["Ingredient cost"]!.amount).toBe(9_600);
      expect(s["Gross profit"]!.amount).toBe(400);
      expect(report.tables[2]!.rows[0]).toMatchObject({ name: "Paneer Tikka", qty: 1, revenue: 10_000, cost: 9_600, status: "Costed" });
    });

    it("excludes cost-unknown and no-recipe sales and reverses cancelled consumption", async () => {
      const paneer = await stock(10);
      const salt = await stock(10, "Salt");
      expect((await unitCost(paneer.id, 32_000_000)).statusCode).toBe(201);
      const costedDish = await dish("Tikka", [{ stockItemId: paneer.id, qtyPerSale: 0.15 }]);
      const unknownDish = await dish("Salted", [{ stockItemId: salt.id, qtyPerSale: 0.01 }]);
      const plain = await dish("Water", []);
      await sellParcel(costedDish); await sellParcel(unknownDish); await sellParcel(plain);
      const report = (await profit()).json().report as OperationalReport;
      const s = summary(report);
      expect(s["Revenue (pre-GST)"]!.amount).toBe(30_000);
      expect(s["Costed revenue"]!.amount).toBe(10_000);
      expect(s["Excluded: cost unknown"]!.amount).toBe(10_000);
      expect(s["Excluded: no recipe"]!.amount).toBe(10_000);
      expect(report.tables[2]!.rows.map((r) => [r.name, r.status])).toEqual([["Salted", "Cost unknown"], ["Tikka", "Costed"], ["Water", "No recipe"]]);
      expect(report.notes).toContain("Sales before costing was set up have no recorded cost.");
    });

    it("treats a dish with one costed and one uncosted ingredient as cost unknown", async () => {
      const paneer = await stock(10);
      const cream = await stock(10, "Cream");
      expect((await unitCost(paneer.id, 32_000_000)).statusCode).toBe(201);
      const malai = await dish("Malai Paneer", [{ stockItemId: paneer.id, qtyPerSale: 0.15 }, { stockItemId: cream.id, qtyPerSale: 0.05 }]);
      await sellParcel(malai);
      // The paneer sale movement has a frozen cost; the cream one does not.
      expect(app.db.prepare("SELECT COUNT(cost_paise) AS costed, COUNT(*) AS total FROM stock_moves WHERE reason = 'sale'").get()).toEqual({ costed: 1, total: 2 });
      const report = (await profit()).json().report as OperationalReport;
      const s = summary(report);
      expect(report.tables[2]!.rows[0]).toMatchObject({ name: "Malai Paneer", revenue: 10_000, costedRevenue: null, cost: null, profit: null, costPercent: null, status: "Cost unknown" });
      expect(s["Excluded: cost unknown"]!.amount).toBe(10_000);
      expect(s["Costed revenue"]!.amount).toBe(0);
      expect(s["Ingredient cost"]!.amount).toBe(0); // the paneer's partial 4,800 is not counted
      expect(s["Gross profit"]!.amount).toBe(0);
    });

    it("does not count opening balances as count adjustments", async () => {
      const paneer = await stock(10);
      const salt = await stock(10, "Salt");
      expect((await unitCost(paneer.id, 32_000_000)).statusCode).toBe(201);
      const fresh = (await profit()).json().report as OperationalReport;
      expect(fresh.notes.some((n) => /count adjustment/.test(n))).toBe(false);
      expect(summary(fresh)["Count adjustments (net)"]!.amount).toBe(0);
      const count = (id: string, quantity: number) =>
        request("POST", `/api/stock-items/${id}/movements`, { clientRef: uuidv7(), expectedVersion: version(id), reason: "adjustment", quantity, note: "Count" });
      expect((await count(paneer.id, 9)).statusCode).toBe(201);
      expect((await count(salt.id, 9)).statusCode).toBe(201);
      const counted = (await profit()).json().report as OperationalReport;
      expect(summary(counted)["Count adjustments (net)"]!.amount).toBe(32_000);
      expect(counted.notes.filter((n) => /count adjustment/.test(n))).toEqual(["1 count adjustment has no recorded cost and is not in the net adjustment cost."]);
    });

    it("tells clients not to cache cost data", async () => {
      for (const url of [`/api/reports/profit?from=${today()}&to=${today()}`, "/api/costing/stock", "/api/costing/dishes"]) {
        const res = await request("GET", url);
        expect(res.statusCode).toBe(200);
        expect(res.headers["cache-control"]).toBe("no-store");
      }
    });

    it("ignores sale movements that were reversed", async () => {
      const paneer = await stock(10);
      expect((await unitCost(paneer.id, 32_000_000)).statusCode).toBe(201);
      const tikka = await dish("Paneer Tikka", [{ stockItemId: paneer.id, qtyPerSale: 0.15 }]);
      await sellParcel(tikka);
      const sale = app.db.prepare("SELECT id, order_item_id AS orderItemId FROM stock_moves WHERE reason = 'sale'").get() as { id: string; orderItemId: string };
      app.db.prepare(`INSERT INTO stock_moves (id, stock_item_id, delta, reason, created_at, order_item_id, reversal_of, cost_paise)
        VALUES (?, ?, 0.15, 'cancel_reversal', ?, ?, ?, 4800)`).run(uuidv7(), paneer.id, Date.now(), sale.orderItemId, sale.id);
      const report = (await profit()).json().report as OperationalReport;
      expect(report.tables[2]!.rows[0]).toMatchObject({ revenue: 10_000, cost: null, status: "No recipe" });
      expect(summary(report)["Ingredient cost"]!.amount).toBe(0);
    });

    it("counts wastage and count adjustments by movement date, leaving unknown cost out", async () => {
      const paneer = await stock(10);
      const salt = await stock(10, "Salt");
      expect((await unitCost(paneer.id, 32_000_000)).statusCode).toBe(201);
      const move = (id: string, reason: string, quantity: number) =>
        request("POST", `/api/stock-items/${id}/movements`, { clientRef: uuidv7(), expectedVersion: version(id), reason, quantity, note: "Test" });
      expect((await move(paneer.id, "wastage", 0.5)).statusCode).toBe(201);
      expect((await move(paneer.id, "adjustment", 8.5)).statusCode).toBe(201);
      expect((await move(salt.id, "wastage", 1)).statusCode).toBe(201);
      const report = (await profit()).json().report as OperationalReport;
      const s = summary(report);
      expect(s["Wastage cost"]!.amount).toBe(16_000);
      expect(s["Count adjustments (net)"]!.amount).toBe(32_000);
      expect(report.notes.some((n) => /1 wastage movement has no recorded cost/.test(n))).toBe(true);
      const empty = (await profit("?from=2020-01-01&to=2020-01-02")).json().report as OperationalReport;
      expect(summary(empty)["Wastage cost"]!.amount).toBe(0);
    });

    it("rejects ranges over 366 days and refuses cashiers", async () => {
      expect((await profit("?from=2024-01-01&to=2025-01-02")).statusCode).toBe(400);
      expect((await profit("?from=2024-01-01&to=2024-12-31")).statusCode).toBe(200);
      const { token: cashier } = await createUser(app, token, { name: "Ravi", pin: "4321", role: "cashier" });
      const res = await profit(undefined, cashier);
      expect(res.statusCode).toBe(403);
      expect(res.json().permission).toBe("costs.read");
    });
  });
});
