import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MIGRATIONS, PLANS, migrate, openDb, uuidv7,
  type Bill, type LicenseClaims, type RecipeUpdateInput, type StockItem, type StockLink, type StockUnit } from "@forkflow/domain";
import { buildServer } from "./server.js";
import { makeFakeSink } from "./print/sinks.js";
import { SETUP } from "./test-helpers.js";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const apps: FastifyInstance[] = [];
type Headers = { authorization: string; "x-forkflow-device": string };
type Recipe = { links: StockLink[]; version: number };
type Ingredient = RecipeUpdateInput["ingredients"][number];
type Order = { id: string; items: Array<{ id: string; status: string; variantId: string | null }> };

afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) { await app.close(); app.db.close(); }
});

// Use the actual commercial guard for every recipe request, with a signed
// offline Pro grant and a registered counter backed by a real SQLite database.
async function fixture() {
  const now = Date.now();
  const installationId = randomUUID();
  const db = openDb(":memory:"); migrate(db, MIGRATIONS);
  let app = buildServer({ db, sinkSend: makeFakeSink().send, licensing: { publicKey, installationId } });
  apps.push(app);
  const device = "a".repeat(64);
  const setup = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: { "x-forkflow-device": device } });
  expect(setup.statusCode, setup.body).toBe(201);
  const headers: Headers = { authorization: `Bearer ${setup.json().token}`, "x-forkflow-device": device };
  const request = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object, as = headers) =>
    app.inject({ method, url, headers: as, ...(payload === undefined ? {} : { payload }) });
  const claims: LicenseClaims = { version: 1, installationId, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(),
    revision: 1, plan: "pro", features: PLANS.pro.features, maxDevices: PLANS.pro.maxDevices,
    issuedAt: now - 1000, expiresAt: now + 600_000, graceUntil: now + 1_200_000 };
  async function activate(plan: "basic" | "pro", revision: number) {
    const next: LicenseClaims = { ...claims, plan, revision, features: PLANS[plan].features, maxDevices: PLANS[plan].maxDevices };
    const message = `ff1.${Buffer.from(JSON.stringify(next)).toString("base64url")}`;
    const license = `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString("base64url")}`;
    const response = await request("PUT", "/api/license", { license });
    expect(response.statusCode, response.body).toBe(200);
  }
  await activate("pro", 1);
  const registered = await request("POST", "/api/license/devices", { name: "Main counter" });
  expect(registered.statusCode, registered.body).toBe(200);
  const category = await request("POST", "/api/categories", { name: "Meals" });
  expect(category.statusCode, category.body).toBe(201);
  const created = await request("POST", "/api/products", { name: "Rice bowl", categoryId: category.json().category.id,
    pricePaise: 10000, gstRate: 5, kotStationId: null,
    variants: [{ name: "Regular", pricePaise: 10000 }, { name: "Large", pricePaise: 15000 }] });
  expect(created.statusCode, created.body).toBe(201);
  const product = created.json().product as { id: string; variants: Array<{ id: string; name: string }> };
  const productId = product.id;

  async function stock(name: string, unit: StockUnit = "kg", openingQty = 5): Promise<StockItem> {
    const response = await request("POST", "/api/stock-items", { clientRef: uuidv7(), name, unit, openingQty });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().item;
  }
  async function recipe(as = headers): Promise<Recipe> {
    const response = await request("GET", `/api/products/${productId}/stock-links`, undefined, as);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function save(ingredients: Ingredient[], expectedVersion?: number): Promise<Recipe> {
    const response = await request("PUT", `/api/products/${productId}/recipe`, {
      expectedVersion: expectedVersion ?? (await recipe()).version, ingredients,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  const balance = (id: string) => (db.prepare("SELECT qty FROM stock_items WHERE id = ?").get(id) as { qty: number }).qty;
  async function order(items = [{ qty: 1, variantId: null as string | null }], kitchen = false): Promise<Order> {
    if (kitchen) {
      const station = db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string };
      const updated = await request("PATCH", `/api/products/${productId}`, { kotStationId: station.id });
      expect(updated.statusCode, updated.body).toBe(200);
    }
    const opened = await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" });
    expect(opened.statusCode, opened.body).toBe(201);
    const added = await request("POST", `/api/orders/${opened.json().order.id}/items`, {
      items: items.map((item) => ({ ...item, productId, clientRef: uuidv7() })),
    });
    expect(added.statusCode, added.body).toBe(200);
    return added.json().order;
  }
  async function issue(orderId: string) {
    const preview = await request("POST", `/api/orders/${orderId}/bill-preview`, {});
    expect(preview.statusCode, preview.body).toBe(200);
    const payload = { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey };
    const issued = await request("POST", `/api/orders/${orderId}/bill`, payload);
    expect(issued.statusCode, issued.body).toBe(201);
    return { bill: issued.json().bill as Bill, payload };
  }
  async function cashier(): Promise<Headers> {
    const created = await request("POST", "/api/users", { name: "Cashier", pin: "2345", role: "cashier" });
    expect(created.statusCode, created.body).toBe(201);
    const login = await request("POST", "/api/login", { pin: "2345" });
    expect(login.statusCode, login.body).toBe(200);
    return { authorization: `Bearer ${login.json().token}`, "x-forkflow-device": device };
  }
  async function restart() {
    await app.close(); apps.splice(apps.indexOf(app), 1);
    app = buildServer({ db, sinkSend: makeFakeSink().send, licensing: { publicKey, installationId } });
    apps.push(app);
  }
  return { app, productId, variants: product.variants, headers, request, stock, recipe, save, balance, order, issue, activate, cashier, restart };
}

describe("recipe editing", () => {
  it("persists multiple ingredients with their units and quantities across a server restart", async () => {
    const f = await fixture();
    const rice = await f.stock("Rice", "kg");
    const milk = await f.stock("Milk", "L");
    const box = await f.stock("Box", "pcs", 10);
    const saved = await f.save([{ stockItemId: rice.id, qtyPerSale: 0.125 }, { stockItemId: milk.id, qtyPerSale: 0.05 }, { stockItemId: box.id, qtyPerSale: 1 }]);
    expect(saved.version).toBe(1);
    expect(saved.links).toEqual([
      expect.objectContaining({ stockItemId: rice.id, stockName: "Rice", unit: "kg", qtyPerSale: 0.125 }),
      expect.objectContaining({ stockItemId: milk.id, stockName: "Milk", unit: "L", qtyPerSale: 0.05 }),
      expect.objectContaining({ stockItemId: box.id, stockName: "Box", unit: "pcs", qtyPerSale: 1 }),
    ]);
    expect(f.app.db.prepare("SELECT stock_item_id, qty_per_sale FROM product_stock_links WHERE product_id = ? ORDER BY id").all(f.productId)).toEqual([
      { stock_item_id: rice.id, qty_per_sale: 0.125 }, { stock_item_id: milk.id, qty_per_sale: 0.05 }, { stock_item_id: box.id, qty_per_sale: 1 },
    ]);
    expect([f.balance(rice.id), f.balance(milk.id), f.balance(box.id)]).toEqual([5, 5, 10]);
    await f.restart();
    expect(await f.recipe()).toEqual(saved);
  });

  it("replaces changed quantities and removed ingredients, then clears without touching balances", async () => {
    const f = await fixture(); const rice = await f.stock("Rice"); const oil = await f.stock("Oil", "L"); const salt = await f.stock("Salt", "g", 500);
    const original = await f.save([{ stockItemId: rice.id, qtyPerSale: 0.125 }, { stockItemId: oil.id, qtyPerSale: 0.025 }]);
    const edited = await f.save([{ stockItemId: rice.id, qtyPerSale: 0.2 }, { stockItemId: salt.id, qtyPerSale: 2 }], original.version);
    expect(edited.version).toBe(original.version + 1);
    expect(edited.links).toEqual([
      expect.objectContaining({ stockItemId: rice.id, qtyPerSale: 0.2 }), expect.objectContaining({ stockItemId: salt.id, qtyPerSale: 2 }),
    ]);
    expect(await f.recipe()).toEqual(edited);
    const cleared = await f.save([], edited.version);
    expect(cleared).toEqual({ links: [], version: edited.version + 1 });
    expect(await f.recipe()).toEqual(cleared);
    expect([f.balance(rice.id), f.balance(oil.id), f.balance(salt.id)]).toEqual([5, 5, 500]);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE reason = 'sale'").get()).toEqual({ n: 0 });
  });

  it("accepts identical lost-response retries and reordered ingredients without changing IDs, versions or events", async () => {
    const f = await fixture(); const rice = await f.stock("Rice"); const oil = await f.stock("Oil", "L");
    const ingredients = [{ stockItemId: rice.id, qtyPerSale: 0.125 }, { stockItemId: oil.id, qtyPerSale: 0.025 }];
    const broadcast = vi.spyOn(f.app, "broadcast");
    const saved = await f.save(ingredients, 0);
    expect(broadcast).toHaveBeenCalledWith("recipe.changed", { productId: f.productId });
    broadcast.mockClear();
    expect(await f.save(ingredients, 0)).toEqual(saved);
    expect(await f.save([...ingredients].reverse(), 0)).toEqual(saved);
    expect(broadcast).not.toHaveBeenCalled();
    const cleared = await f.save([], saved.version);
    broadcast.mockClear();
    expect(await f.save([], saved.version)).toEqual(cleared);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects invalid replacements without losing the saved recipe or publishing changes", async () => {
    const f = await fixture(); const rice = await f.stock("Rice"); const oil = await f.stock("Oil", "L"); const archived = await f.stock("Archived spice", "g");
    const archivedResponse = await f.request("PATCH", `/api/stock-items/${archived.id}`, { expectedVersion: archived.version, isActive: false });
    expect(archivedResponse.statusCode, archivedResponse.body).toBe(200);
    const saved = await f.save([{ stockItemId: rice.id, qtyPerSale: 0.125 }]);
    const invalid = [
      { label: "duplicate ingredients", ingredients: [{ stockItemId: oil.id, qtyPerSale: 0.1 }, { stockItemId: oil.id, qtyPerSale: 0.2 }] },
      { label: "zero quantity", ingredients: [{ stockItemId: oil.id, qtyPerSale: 0 }] },
      { label: "tiny positive quantity rounding to zero", ingredients: [{ stockItemId: oil.id, qtyPerSale: 1e-8 }] },
      { label: "positive quantity within rounding tolerance", ingredients: [{ stockItemId: oil.id, qtyPerSale: 9e-8 }] },
      { label: "negative quantity", ingredients: [{ stockItemId: oil.id, qtyPerSale: -0.1 }] },
      { label: "excess precision", ingredients: [{ stockItemId: oil.id, qtyPerSale: 0.0001 }] },
      { label: "excess quantity", ingredients: [{ stockItemId: oil.id, qtyPerSale: 1_000_001 }] },
      { label: "missing quantity", ingredients: [{ stockItemId: oil.id }] },
      { label: "blank selection", ingredients: [{ stockItemId: " ", qtyPerSale: 1 }] },
      { label: "missing stock", ingredients: [{ stockItemId: oil.id, qtyPerSale: 0.1 }, { stockItemId: uuidv7(), qtyPerSale: 1 }] },
      { label: "archived stock", ingredients: [{ stockItemId: oil.id, qtyPerSale: 0.1 }, { stockItemId: archived.id, qtyPerSale: 1 }] },
      { label: "more than 100 ingredients", ingredients: Array.from({ length: 101 }, () => ({ stockItemId: uuidv7(), qtyPerSale: 1 })) },
    ];
    const broadcast = vi.spyOn(f.app, "broadcast");
    for (const input of invalid) {
      const response = await f.request("PUT", `/api/products/${f.productId}/recipe`, { expectedVersion: saved.version, ingredients: input.ingredients });
      expect(response.statusCode, `${input.label}: ${response.body}`).toBe(400);
      expect(await f.recipe(), input.label).toEqual(saved);
    }
    for (const qtyPerSale of [1e-8, 9e-8]) {
      const response = await f.request("PUT", `/api/products/${f.productId}/stock-links`, {
        expectedVersion: saved.version, stockItemId: oil.id, qtyPerSale,
      });
      expect(response.statusCode, `simple stock link with ${qtyPerSale}: ${response.body}`).toBe(400);
      expect(await f.recipe()).toEqual(saved);
    }
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("returns not found for a missing product without creating orphan links", async () => {
    const f = await fixture(); const rice = await f.stock("Rice"); const missing = uuidv7();
    expect((await f.request("GET", `/api/products/${missing}/stock-links`)).statusCode).toBe(404);
    expect((await f.request("PUT", `/api/products/${missing}/recipe`, { expectedVersion: 0, ingredients: [{ stockItemId: rice.id, qtyPerSale: 1 }] })).statusCode).toBe(404);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM product_stock_links").get()).toEqual({ n: 0 });
  });

  it("rejects a stale changed recipe after another counter saves", async () => {
    const f = await fixture(); const rice = await f.stock("Rice"); const oil = await f.stock("Oil", "L");
    const opened = await f.save([{ stockItemId: rice.id, qtyPerSale: 0.125 }]);
    const otherCounter = await f.save([{ stockItemId: rice.id, qtyPerSale: 0.25 }, { stockItemId: oil.id, qtyPerSale: 0.025 }], opened.version);
    const broadcast = vi.spyOn(f.app, "broadcast");
    const stale = await f.request("PUT", `/api/products/${f.productId}/recipe`, { expectedVersion: opened.version, ingredients: [{ stockItemId: rice.id, qtyPerSale: 0.5 }] });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(await f.recipe()).toEqual(otherCounter);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("shares concurrency protection with the simple stock-link editor and prevents it replacing a multi-ingredient recipe", async () => {
    const f = await fixture(); const rice = await f.stock("Rice"); const oil = await f.stock("Oil", "L");
    const simple = await f.request("PUT", `/api/products/${f.productId}/stock-links`, { expectedVersion: 0, stockItemId: rice.id, qtyPerSale: 0.125 });
    expect(simple.statusCode, simple.body).toBe(200);
    const ingredients = [{ stockItemId: rice.id, qtyPerSale: 0.25 }, { stockItemId: oil.id, qtyPerSale: 0.025 }];
    expect((await f.request("PUT", `/api/products/${f.productId}/recipe`, { expectedVersion: 0, ingredients })).statusCode).toBe(409);
    expect(await f.recipe()).toEqual(simple.json());
    const multiple = await f.save(ingredients, simple.json().version);
    expect((await f.request("PUT", `/api/products/${f.productId}/stock-links`, { expectedVersion: multiple.version, stockItemId: null })).statusCode).toBe(409);
    expect(await f.recipe()).toEqual(multiple);
    const single = await f.save([{ stockItemId: oil.id, qtyPerSale: 0.1 }], multiple.version);
    expect((await f.request("PUT", `/api/products/${f.productId}/stock-links`, { expectedVersion: multiple.version, stockItemId: rice.id, qtyPerSale: 0.5 })).statusCode).toBe(409);
    expect(await f.recipe()).toEqual(single);
  });

  it("rolls back the whole replacement and version if inserting a later ingredient fails", async () => {
    const f = await fixture(); const rice = await f.stock("Rice"); const rejected = await f.stock("Rejected insert", "L");
    const saved = await f.save([{ stockItemId: rice.id, qtyPerSale: 0.125 }]);
    f.app.db.exec("CREATE TRIGGER fail_recipe BEFORE INSERT ON product_stock_links WHEN (SELECT name FROM stock_items WHERE id = NEW.stock_item_id) = 'Rejected insert' BEGIN SELECT RAISE(ABORT, 'test'); END");
    const broadcast = vi.spyOn(f.app, "broadcast");
    const failed = await f.request("PUT", `/api/products/${f.productId}/recipe`, { expectedVersion: saved.version,
      ingredients: [{ stockItemId: rice.id, qtyPerSale: 0.25 }, { stockItemId: rejected.id, qtyPerSale: 0.025 }] });
    expect(failed.statusCode, failed.body).toBe(500);
    expect(await f.recipe()).toEqual(saved);
    expect([f.balance(rice.id), f.balance(rejected.id)]).toEqual([5, 5]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("uses the product recipe for the base dish and every variant without converting ingredient units", async () => {
    const f = await fixture(); const rice = await f.stock("Rice", "kg"); const oil = await f.stock("Oil", "ml", 500);
    await f.save([{ stockItemId: rice.id, qtyPerSale: 0.125 }, { stockItemId: oil.id, qtyPerSale: 12.5 }]);
    const regular = f.variants.find((variant) => variant.name === "Regular")!;
    const large = f.variants.find((variant) => variant.name === "Large")!;
    const order = await f.order([{ qty: 1, variantId: null }, { qty: 2, variantId: regular.id }, { qty: 3, variantId: large.id }]);
    await f.issue(order.id);
    expect([f.balance(rice.id), f.balance(oil.id)]).toEqual([4.25, 425]);
    const sales = f.app.db.prepare("SELECT oi.variant_id, m.stock_item_id, m.delta FROM stock_moves m JOIN order_items oi ON oi.id = m.order_item_id WHERE m.reason = 'sale'").all();
    expect(sales).toHaveLength(6);
    expect(sales).toEqual(expect.arrayContaining([
      { variant_id: null, stock_item_id: rice.id, delta: -0.125 }, { variant_id: null, stock_item_id: oil.id, delta: -12.5 },
      { variant_id: regular.id, stock_item_id: rice.id, delta: -0.25 }, { variant_id: regular.id, stock_item_id: oil.id, delta: -25 },
      { variant_id: large.id, stock_item_id: rice.id, delta: -0.375 }, { variant_id: large.id, stock_item_id: oil.id, delta: -37.5 },
    ]));
  });

  it("deducts at kitchen send and reverses the recorded original recipe after editing and archiving a removed ingredient", async () => {
    const f = await fixture(); const rice = await f.stock("Rice"); const oil = await f.stock("Oil", "L"); const butter = await f.stock("Butter");
    await f.save([{ stockItemId: rice.id, qtyPerSale: 0.125 }, { stockItemId: oil.id, qtyPerSale: 0.05 }]);
    const order = await f.order([{ qty: 3, variantId: null }], true);
    expect([f.balance(rice.id), f.balance(oil.id)]).toEqual([5, 5]);
    const sent = await f.request("POST", `/api/orders/${order.id}/send`);
    expect(sent.statusCode, sent.body).toBe(200);
    expect([f.balance(rice.id), f.balance(oil.id)]).toEqual([4.625, 4.85]);
    await f.save([{ stockItemId: rice.id, qtyPerSale: 0.3 }, { stockItemId: butter.id, qtyPerSale: 0.2 }]);
    const oilVersion = (await f.request("GET", "/api/stock-items")).json().items.find((item: StockItem) => item.id === oil.id).version;
    expect((await f.request("PATCH", `/api/stock-items/${oil.id}`, { expectedVersion: oilVersion, isActive: false })).statusCode).toBe(200);
    const cancelled = await f.request("POST", `/api/order-items/${order.items[0]!.id}/cancel`, { reason: "Customer cancelled" });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect([f.balance(rice.id), f.balance(oil.id), f.balance(butter.id)]).toEqual([5, 5, 5]);
    expect(f.app.db.prepare("SELECT r.stock_item_id, r.delta, s.delta AS original_delta FROM stock_moves r JOIN stock_moves s ON s.id = r.reversal_of WHERE r.reason = 'cancel_reversal' ORDER BY r.id").all()).toEqual([
      { stock_item_id: rice.id, delta: 0.375, original_delta: -0.375 }, { stock_item_id: oil.id, delta: 0.15, original_delta: -0.15 },
    ]);
    expect((await f.request("POST", `/api/order-items/${order.items[0]!.id}/cancel`, { reason: "Retry" })).statusCode).toBe(409);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE reason = 'cancel_reversal'").get()).toEqual({ n: 2 });
  });

  it("deducts stationless ingredients only at bill issue and never deducts again on retry after a recipe edit", async () => {
    const f = await fixture(); const rice = await f.stock("Rice"); const oil = await f.stock("Oil", "L"); const butter = await f.stock("Butter");
    await f.save([{ stockItemId: rice.id, qtyPerSale: 0.125 }, { stockItemId: oil.id, qtyPerSale: 0.025 }]);
    const order = await f.order([{ qty: 3, variantId: null }]);
    const preview = await f.request("POST", `/api/orders/${order.id}/bill-preview`, {});
    expect(preview.statusCode, preview.body).toBe(200);
    expect([f.balance(rice.id), f.balance(oil.id)]).toEqual([5, 5]);
    const { bill, payload } = await f.issue(order.id);
    expect([f.balance(rice.id), f.balance(oil.id)]).toEqual([4.625, 4.925]);
    await f.save([{ stockItemId: butter.id, qtyPerSale: 2 }]);
    expect((await f.request("POST", `/api/orders/${order.id}/bill`, payload)).statusCode).toBe(200);
    expect((await f.request("POST", `/api/bills/${bill.id}/settle`, { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: bill.totalPaise }] })).statusCode).toBe(200);
    expect([f.balance(rice.id), f.balance(oil.id), f.balance(butter.id)]).toEqual([4.625, 4.925, 5]);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE reason = 'sale'").get()).toEqual({ n: 2 });
  });

  it("allows a Pro cashier to read recipes but denies writes without stock.manage", async () => {
    const f = await fixture(); const rice = await f.stock("Rice");
    const saved = await f.save([{ stockItemId: rice.id, qtyPerSale: 0.125 }]);
    const cashier = await f.cashier();
    expect(await f.recipe(cashier)).toEqual(saved);
    const response = await f.request("PUT", `/api/products/${f.productId}/recipe`, { expectedVersion: saved.version, ingredients: [] }, cashier);
    expect(response.statusCode, response.body).toBe(403);
    expect(await f.recipe()).toEqual(saved);
    expect((await f.app.inject({ method: "PUT", url: `/api/products/${f.productId}/recipe`, payload: { expectedVersion: saved.version, ingredients: [] } })).statusCode).toBe(401);
  });

  it("locks editing after a Basic downgrade while retaining readable recipes and existing deductions, then unlocks on upgrade", async () => {
    const f = await fixture(); const rice = await f.stock("Rice"); const oil = await f.stock("Oil", "L");
    const saved = await f.save([{ stockItemId: rice.id, qtyPerSale: 0.125 }, { stockItemId: oil.id, qtyPerSale: 0.05 }]);
    const cashier = await f.cashier();
    await f.activate("basic", 2);
    expect(await f.recipe()).toEqual(saved);
    expect(await f.recipe(cashier)).toEqual(saved);
    const locked = await f.request("PUT", `/api/products/${f.productId}/recipe`, { expectedVersion: saved.version, ingredients: [] });
    expect(locked.statusCode, locked.body).toBe(403);
    expect((await f.request("PUT", `/api/products/${f.productId}/stock-links`, { expectedVersion: saved.version, stockItemId: null })).statusCode).toBe(409);
    const stationless = await f.order([{ qty: 2, variantId: null }]); await f.issue(stationless.id);
    expect([f.balance(rice.id), f.balance(oil.id)]).toEqual([4.75, 4.9]);
    const kitchen = await f.order([{ qty: 1, variantId: null }], true);
    expect((await f.request("POST", `/api/orders/${kitchen.id}/send`)).statusCode).toBe(200);
    expect([f.balance(rice.id), f.balance(oil.id)]).toEqual([4.625, 4.85]);
    expect(await f.recipe()).toEqual(saved);
    await f.activate("pro", 3);
    expect(await f.save([], saved.version)).toEqual({ links: [], version: saved.version + 1 });
  });
});
