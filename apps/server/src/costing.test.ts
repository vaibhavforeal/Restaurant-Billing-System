import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type StockItem, type StockMove, type StockCostChange } from "@forkflow/domain";
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
  const request = (method: "GET" | "POST" | "PATCH", url: string, payload?: object, as = token) =>
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
      ({ ...real(credential), canOperate: true, features: { recipes: false, qrOrdering: false } }));
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
      const insert = app.db.prepare("INSERT INTO stock_cost_changes (id, stock_item_id, old_cost_milli_paise, new_cost_milli_paise, note, created_at) VALUES (?, ?, NULL, ?, 'n', ?)");
      insert.run("c-a", item.id, 1, 1_000);
      insert.run("c-b", item.id, 2, 2_000);
      insert.run("c-c", item.id, 3, 3_000);
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
});
