import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type ModuleInfo } from "@masalapos/domain";
import { auth, commercialApp, createUser, freshApp, setupAdmin } from "./test-helpers.js";

describe("module controls", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { if (app) { await app.close(); app.db.close(); app = undefined; } });

  async function dev() {
    app = freshApp();
    const { token } = await setupAdmin(app);
    const headers = auth(token);
    const request = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object, h: Record<string, string> = headers) =>
      app!.inject({ method, url, headers: h, ...(payload ? { payload } : {}) });
    return { app, token, headers, request };
  }
  const states = async (request: (m: "GET", u: string) => Promise<{ json(): { modules: ModuleInfo[] } }>) =>
    Object.fromEntries((await request("GET", "/api/modules")).json().modules.map((m) => [m.id, m])) as Record<string, ModuleInfo>;

  it("allows everything in development builds, with add-ons waiting to be switched on", async () => {
    const { request } = await dev();
    const m = await states(request);
    expect(Object.values(m).every((s) => s.allowed)).toBe(true);
    expect(m["takeaway"]).toMatchObject({ enabled: true, active: true, reason: null });
    expect(m["crm"]).toMatchObject({ enabled: false, active: false, reason: "Turned off" });
    expect(m["kds"]!.active).toBe(false);
  });

  it("lets an admin switch a module off and on again, and any signed-in role read the states", async () => {
    const { request, token } = await dev();
    const off = await request("PATCH", "/api/modules/reservations", { enabled: false });
    expect(off.statusCode).toBe(200);
    expect((await states(request))["reservations"]).toMatchObject({ enabled: false, active: false, reason: "Turned off" });
    expect((await request("PATCH", "/api/modules/reservations", { enabled: true })).statusCode).toBe(200);
    expect((await states(request))["reservations"]!.active).toBe(true);
    const waiter = await createUser(app!, token, { name: "Arun", pin: "5555", role: "waiter" });
    expect((await request("GET", "/api/modules", undefined, auth(waiter.token))).statusCode).toBe(200);
    expect((await request("PATCH", "/api/modules/reservations", { enabled: false }, auth(waiter.token))).statusCode).toBe(403);
    expect((await request("PATCH", "/api/modules/payroll", { enabled: false })).statusCode).toBe(404);
  });

  it("makes a module inactive when one it depends on is off", async () => {
    const { request } = await dev();
    await request("PATCH", "/api/modules/inventory", { enabled: false });
    const m = await states(request);
    expect(m["recipes"]).toMatchObject({ enabled: true, active: false, reason: "Needs Inventory" });
    expect(m["costing"]).toMatchObject({ active: false, reason: "Needs Recipes" });
  });

  it("follows the licence: the owner's choices decide what may be switched on", async () => {
    const c = await commercialApp("basic", { kds: true, reservations: false });
    app = c.app;
    const request = (method: "GET" | "PATCH" | "POST", url: string, payload?: object) => c.app.inject({ method, url, headers: c.headers, ...(payload ? { payload } : {}) });
    const m = await states(request);
    expect(m["kds"]).toMatchObject({ allowed: true, enabled: false });
    expect(m["recipes"]).toMatchObject({ allowed: false, active: false, reason: "Not included for this restaurant" });
    expect(m["reservations"]).toMatchObject({ allowed: false, active: false });
    // Allowed by the owner: the restaurant can switch it on.
    expect((await request("PATCH", "/api/modules/kds", { enabled: true })).statusCode).toBe(200);
    expect((await states(request))["kds"]!.active).toBe(true);
    // Not allowed: switching on is refused, switching off is fine.
    const refused = await request("PATCH", "/api/modules/reservations", { enabled: true });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("Reservations is not included for this restaurant. Contact MasalaPOS to add it.");
    expect((await request("PATCH", "/api/modules/reservations", { enabled: false })).statusCode).toBe(200);
    const blocked = await request("POST", "/api/reservations", { customerName: "Asha", phone: "9876543210", partySize: 2, startsAt: Date.now() + 86_400_000 });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("module_off");
  });

  it("stops new takeaway orders but lets an open one be finished", async () => {
    const { request } = await dev();
    const category = (await request("POST", "/api/categories", { name: "Food" })).json().category.id as string;
    const product = (await request("POST", "/api/products", { name: "Thali", categoryId: category, pricePaise: 50000, gstRate: 5, kotStationId: null })).json().product.id as string;
    const open = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order.id as string;
    await request("PATCH", "/api/modules/takeaway", { enabled: false });
    const refused = await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "module_off", error: "Takeaway is not available: Turned off." });
    // The open takeaway order still takes items and can be billed.
    expect((await request("POST", `/api/orders/${open}/items`, { items: [{ productId: product, qty: 1, clientRef: uuidv7() }] })).statusCode).toBe(200);
    const preview = await request("POST", `/api/orders/${open}/bill-preview`, {});
    expect(preview.statusCode).toBe(200);
    expect((await request("POST", `/api/orders/${open}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey })).statusCode).toBe(201);
  });

  it("keeps bills and the day-end GST summary when reports are off", async () => {
    const { request } = await dev();
    await request("PATCH", "/api/modules/reports", { enabled: false });
    for (const url of ["/api/reports/sales", "/api/reports/analytics", "/api/reports/operations/items", "/api/custom-reports"]) {
      expect((await request("GET", url)).statusCode, url).toBe(409);
    }
    expect((await request("GET", "/api/reports/day-end")).statusCode).toBe(200);
    expect((await states(request))["dashboard"]).toMatchObject({ active: false, reason: "Needs Reports & analytics" });
  });

  it("stops stock edits while inventory is off but keeps stock readable", async () => {
    const { request } = await dev();
    const created = await request("POST", "/api/stock-items", { clientRef: uuidv7(), name: "Rice", unit: "kg" });
    expect(created.statusCode, created.body).toBe(201);
    await request("PATCH", "/api/modules/inventory", { enabled: false });
    expect((await request("POST", "/api/stock-items", { clientRef: uuidv7(), name: "Oil", unit: "L" })).statusCode).toBe(409);
    const list = await request("GET", "/api/stock-items");
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
  });
});
