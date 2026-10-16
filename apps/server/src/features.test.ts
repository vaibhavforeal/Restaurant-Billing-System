import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import { auth, commercialApp, createUser, freshApp, setupAdmin } from "./test-helpers.js";
import { wsAuth } from "./test-helpers.js";

let app: FastifyInstance;
afterEach(async () => { if (app) { await app.close(); app.db.close(); } });
type Info = { id: string; enabled: boolean; active: boolean; configurable: boolean; licensed: boolean; reason: string | null };
const list = (token: string) => app.inject({ url: "/api/features", headers: auth(token) });
const toggle = async (_token: string, id: string, enabled: boolean) => { app.db.prepare("INSERT INTO feature_state(id,enabled,updated_at,updated_by) VALUES (?,?,0,'owner-fixture') ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled").run(id, Number(enabled)); return list(_token); };
const feature = (res: { json(): { features: Info[] } }, id: string) => res.json().features.find(item => item.id === id)!;

describe("installation feature controls", () => {
  it("retains stock reads and normal order completion while management is disabled", async () => {
    app = freshApp(); const admin = await setupAdmin(app);
    await toggle(admin.token, "inventory", false);
    expect((await app.inject({ url: "/api/stock-items", headers: auth(admin.token) })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/bills", headers: auth(admin.token) })).statusCode).toBe(200);
  });

  it("disabling reports blocks profit reports even when costing is still enabled", async () => {
    app = freshApp(); const admin = await setupAdmin(app);
    await toggle(admin.token, "reports", false);
    const res = await app.inject({ url: "/api/reports/profit?from=2026-01-01&to=2026-01-01", headers: auth(admin.token) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "feature_disabled", feature: "reports" });
  });

  it("recovers stock creation and movement responses after inventory is disabled", async () => {
    app = freshApp(); const admin = await setupAdmin(app);
    const stock = { clientRef: crypto.randomUUID(), name: "Rice", unit: "kg", openingQty: 1 };
    const created = await app.inject({ method: "POST", url: "/api/stock-items", headers: auth(admin.token), payload: stock });
    expect(created.statusCode).toBe(201);
    const movement = { clientRef: crypto.randomUUID(), expectedVersion: created.json().item.version, reason: "purchase", quantity: 1, note: "Delivery" };
    const url = `/api/stock-items/${created.json().item.id}/movements`;
    expect((await app.inject({ method: "POST", url, headers: auth(admin.token), payload: movement })).statusCode).toBe(201);
    await toggle(admin.token, "inventory", false);
    expect((await app.inject({ method: "POST", url: "/api/stock-items", headers: auth(admin.token), payload: stock })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url, headers: auth(admin.token), payload: movement })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url, headers: auth(admin.token), payload: { ...movement, clientRef: crypto.randomUUID() } })).statusCode).toBe(403);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves").get()).toEqual({ n: 2 });
  });

  it.each(["recipe", "stock-links"])("recovers unchanged %s saves while blocking new edits after disabling inventory", async route => {
    app = freshApp(); const admin = await setupAdmin(app);
    const headers = auth(admin.token);
    const category = (await app.inject({ method: "POST", url: "/api/categories", headers, payload: { name: "Food" } })).json().category;
    const product = (await app.inject({ method: "POST", url: "/api/products", headers, payload: { name: "Meal", categoryId: category.id, pricePaise: 10000, gstRate: 5, kotStationId: null } })).json().product;
    const stock = (await app.inject({ method: "POST", url: "/api/stock-items", headers, payload: { clientRef: crypto.randomUUID(), name: "Rice", unit: "kg", openingQty: 1 } })).json().item;
    const payload = route === "recipe" ? { expectedVersion: 0, ingredients: [{ stockItemId: stock.id, qtyPerSale: 1 }] }
      : { expectedVersion: 0, stockItemId: stock.id, qtyPerSale: 1 };
    const url = `/api/products/${product.id}/${route}`;
    const saved = await app.inject({ method: "PUT", url, headers, payload });
    expect(saved.statusCode).toBe(200);
    await toggle(admin.token, "inventory", false);
    const recovered = await app.inject({ method: "PUT", url, headers, payload });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual(saved.json());
    const changed = route === "recipe" ? { expectedVersion: saved.json().version, ingredients: [{ stockItemId: stock.id, qtyPerSale: 2 }] }
      : { expectedVersion: saved.json().version, stockItemId: stock.id, qtyPerSale: 2 };
    const denied = await app.inject({ method: "PUT", url, headers, payload: changed });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "feature_disabled", feature: "recipes" });
  });

  it("keeps menu browsing and recovers guest submissions after disabling guest features", async () => {
    app = freshApp(); const admin = await setupAdmin(app);
    const table = (await app.inject({ method: "POST", url: "/api/tables", headers: auth(admin.token), payload: { name: "Table 1" } })).json().table.id;
    const qr = await app.inject({ method: "PUT", url: `/api/qr/tables/${table}`, headers: auth(admin.token), payload: { enabled: true } });
    const token = qr.json().table.path.split("#")[1];
    const guestHeaders = { "x-qr-token": token };
    const service = { clientRef: crypto.randomUUID(), receiptToken: "a".repeat(64), kind: "waiter" };
    const created = await app.inject({ method: "POST", url: "/api/guest/service-requests", headers: guestHeaders, payload: service });
    expect(created.statusCode).toBe(201);
    await toggle(admin.token, "qrOrdering", false);
    const menu = await app.inject({ url: "/api/guest/menu", headers: guestHeaders });
    expect(menu.statusCode).toBe(200);
    expect(menu.json()).toMatchObject({ orderingAvailable: false, servicesAvailable: false });
    expect((await app.inject({ method: "POST", url: "/api/guest/service-requests", headers: guestHeaders, payload: service })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/guest/service-requests", headers: guestHeaders, payload: { ...service, clientRef: crypto.randomUUID() } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/guest/service-requests/${created.json().request.id}`, headers: { "x-guest-receipt": service.receiptToken } })).statusCode).toBe(200);
  });

  it("blocks new takeaways while allowing replay and completion of an existing one", async () => {
    app = freshApp(); const admin = await setupAdmin(app);
    const payload = { clientRef: crypto.randomUUID(), type: "parcel" };
    const created = await app.inject({ method: "POST", url: "/api/orders", headers: auth(admin.token), payload });
    expect(created.statusCode).toBe(201);
    await toggle(admin.token, "takeaway", false);
    expect((await app.inject({ method: "POST", url: "/api/orders", headers: auth(admin.token), payload })).statusCode).toBe(200);
    const denied = await app.inject({ method: "POST", url: "/api/orders", headers: auth(admin.token), payload: { ...payload, clientRef: crypto.randomUUID() } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "feature_disabled", feature: "takeaway" });
    expect((await app.inject({ url: `/api/orders/${created.json().order.id}`, headers: auth(admin.token) })).statusCode).toBe(200);
  });
});

