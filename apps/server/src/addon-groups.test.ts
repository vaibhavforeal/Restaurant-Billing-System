import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auth, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";

type Option = { id: string; productId: string; variantId: string | null; name: string; unavailable?: true };
type Group = { id: string; name: string; minPicks: number; maxPicks: number; isActive: boolean; options: Option[]; productIds: string[] };
type Product = { id: string; addonOnly: boolean; addonGroupIds: string[] };

describe("add-on groups", () => {
  let app: FastifyInstance; let token: string; let categoryId: string;
  let cheese: string; let olives: string; let coke: string; let cokeLarge: string; let margherita: string; let combo: string;

  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app));
    categoryId = (await post("/api/categories", { name: "Pizza" })).json().category.id;
    cheese = await product("Cheese", 3000);
    olives = await product("Olives", 2000);
    coke = await product("Coke", 5000, [{ name: "Large", pricePaise: 7000 }]);
    cokeLarge = (app.db.prepare("SELECT id FROM variants WHERE product_id = ?").get(coke) as { id: string }).id;
    margherita = await product("Margherita", 25000);
    const res = await post("/api/products", { name: "Meal", categoryId, pricePaise: 30000, kind: "combo", combo: [{ name: "Main", minPicks: 1, maxPicks: 1, options: [{ productId: margherita }] }] });
    expect(res.statusCode, res.body).toBe(201);
    combo = res.json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  const post = (url: string, payload: object) => app.inject({ method: "POST", url, headers: auth(token), payload });
  const patch = (url: string, payload: object) => app.inject({ method: "PATCH", url, headers: auth(token), payload });
  async function product(name: string, pricePaise: number, variants: object[] = []) {
    const res = await post("/api/products", { name, categoryId, pricePaise, gstRate: 5, variants });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().product.id as string;
  }
  const groups = async () => (await app.inject({ url: "/api/addon-groups", headers: auth(token) })).json().groups as Group[];
  const products = async () => (await app.inject({ url: "/api/products", headers: auth(token) })).json().products as Product[];
  async function group(payload: object = {}) {
    const res = await post("/api/addon-groups", { name: "Toppings", minPicks: 0, maxPicks: 2, options: [{ productId: cheese }, { productId: coke, variantId: cokeLarge }], ...payload });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().group as Group;
  }

  it("creates, lists and edits a group, keeping option ids", async () => {
    const g = await group();
    expect(g.options.map((o) => o.name)).toEqual(["Cheese", "Coke (Large)"]);
    expect(g).toMatchObject({ name: "Toppings", minPicks: 0, maxPicks: 2, isActive: true, productIds: [] });
    const cheeseOption = g.options[0]!.id;
    const edited = await patch(`/api/addon-groups/${g.id}`, { name: "Extras", options: [{ id: cheeseOption, productId: cheese }, { productId: olives }] });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().group.options.map((o: Option) => [o.name, o.id === cheeseOption])).toEqual([["Cheese", true], ["Olives", false]]);
    expect((await groups()).map((x) => [x.name, x.options.length, x.productIds])).toEqual([["Extras", 2, []]]);
  });

  it("rejects bad options and bounds", async () => {
    const bad = (options: object[], extra: object = {}) => post("/api/addon-groups", { name: "T", minPicks: 0, maxPicks: 1, options, ...extra });
    expect((await bad([{ productId: combo }])).statusCode).toBe(400);
    expect((await bad([{ productId: coke }])).statusCode).toBe(400);
    expect((await bad([{ productId: cheese, variantId: cokeLarge }])).statusCode).toBe(400);
    expect((await bad([{ productId: "missing" }])).statusCode).toBe(400);
    expect((await bad([{ productId: cheese }], { minPicks: 2, maxPicks: 2 })).statusCode).toBe(400);
    expect((await bad([{ productId: cheese }, { productId: cheese }])).statusCode).toBe(400);
    await patch(`/api/products/${olives}`, { isActive: false });
    expect((await bad([{ productId: olives }])).statusCode).toBe(400);
    const g = await group();
    expect((await patch(`/api/addon-groups/${g.id}`, { minPicks: 3 })).statusCode).toBe(400);
    expect((await patch("/api/addon-groups/missing", { name: "X" })).statusCode).toBe(404);
  });

  it("marks options unavailable while their product is sold out", async () => {
    const g = await group();
    await patch(`/api/products/${cheese}`, { isSoldOut: true });
    expect((await groups()).find((x) => x.id === g.id)!.options.map((o) => o.unavailable ?? false)).toEqual([true, false]);
  });

  it("archives a group", async () => {
    const g = await group();
    const res = await patch(`/api/addon-groups/${g.id}`, { isActive: false });
    expect(res.statusCode, res.body).toBe(200);
    expect((await groups())[0]!.isActive).toBe(false);
  });

  it("attaches groups to an item", async () => {
    const g = await group();
    const res = await patch(`/api/products/${margherita}`, { addonGroupIds: [g.id] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().product).toMatchObject({ addonOnly: false, addonGroupIds: [g.id] });
    expect((await products()).find((p) => p.id === margherita)!.addonGroupIds).toEqual([g.id]);
    expect((await groups())[0]!.productIds).toEqual([margherita]);
    const created = await post("/api/products", { name: "Farmhouse", categoryId, pricePaise: 30000, addonGroupIds: [g.id] });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().product.addonGroupIds).toEqual([g.id]);
    expect((await patch(`/api/products/${margherita}`, { addonGroupIds: [] })).json().product.addonGroupIds).toEqual([]);
  });

  it("refuses groups on combos and add-on-only items, and unknown or archived ids", async () => {
    const g = await group();
    expect((await patch(`/api/products/${combo}`, { addonGroupIds: [g.id] })).statusCode).toBe(400);
    expect((await patch(`/api/products/${combo}`, { addonOnly: true })).statusCode).toBe(400);
    expect((await patch(`/api/products/${margherita}`, { addonGroupIds: ["missing"] })).statusCode).toBe(400);
    await patch(`/api/products/${margherita}`, { addonGroupIds: [g.id] });
    expect((await patch(`/api/products/${margherita}`, { addonOnly: true })).statusCode).toBe(400);
    const addonOnly = await patch(`/api/products/${cheese}`, { addonOnly: true });
    expect(addonOnly.statusCode, addonOnly.body).toBe(200);
    expect(addonOnly.json().product.addonOnly).toBe(true);
    expect((await patch(`/api/products/${cheese}`, { addonGroupIds: [g.id] })).statusCode).toBe(400);
    const archived = await group({ name: "Old" });
    await patch(`/api/addon-groups/${archived.id}`, { isActive: false });
    expect((await patch(`/api/products/${olives}`, { addonGroupIds: [archived.id] })).statusCode).toBe(400);
  });

  it("lets a dish keep an archived group it already has", async () => {
    const g = await group();
    await patch(`/api/products/${margherita}`, { addonGroupIds: [g.id] });
    await patch(`/api/addon-groups/${g.id}`, { isActive: false });
    const res = await patch(`/api/products/${margherita}`, { pricePaise: 26000, addonGroupIds: [g.id] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().product.addonGroupIds).toEqual([g.id]);
  });

  it("swaps the items of two kept options without an error", async () => {
    const g = await group();
    const [a, b] = g.options;
    const res = await patch(`/api/addon-groups/${g.id}`, { options: [{ id: a!.id, productId: coke, variantId: cokeLarge }, { id: b!.id, productId: cheese }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().group.options.map((o: Option) => [o.id, o.name])).toEqual([[a!.id, "Coke (Large)"], [b!.id, "Cheese"]]);
  });
});
