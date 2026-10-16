import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { migrate, MIGRATIONS, openDb, PLANS } from "@forkflow/domain";
import { buildServer } from "./server.js";
import { SETUP } from "./test-helpers.js";
import { setupAdmin, auth } from "./test-helpers.js";
import type { FastifyInstance } from "fastify";
const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) { await app.close(); app.db.close(); } });
async function fixture() {
  const keys = generateKeyPairSync("ed25519"), installationId = randomUUID(), organizationId = randomUUID(), outletId = randomUUID();
  const encode = (body: unknown) => { const message = `ff1.${Buffer.from(JSON.stringify(body)).toString("base64url")}`; return `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString("base64url")}`; };
  const db = openDb(":memory:"); migrate(db, MIGRATIONS);
  let envelope = ""; let offline = false;
  const options = { publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), installationId, installationSecret: "a".repeat(64), serviceUrl: "https://licensing.test", fetch: (async () => { if (offline) throw Error("offline"); return Response.json({ policy: envelope }); }) as typeof fetch };
  const app = buildServer({ db, licensing: options }); apps.push(app);
  const device = "d".repeat(64);
  const setup = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: { "x-forkflow-device": device } });
  const headers = { authorization: `Bearer ${setup.json().token}`, "x-forkflow-device": device };
  const now = Date.now();
  app.licensing.activate(encode({ version: 1, installationId, organizationId, outletId, licenseId: randomUUID(), revision: 1, plan: "pro", maxDevices: 5, features: PLANS.pro.features, issuedAt: now - 1000, expiresAt: now + 86400_000, graceUntil: now + 86400_000 }), "Test");
  await app.inject({ method: "POST", url: "/api/license/devices", headers, payload: { name: "Counter" } });
  const policy = (revision: number, enabled: Record<string, boolean>, extra = {}) => encode({ kind: "restaurant-features", version: 1, installationId, organizationId, outletId, revision, enabled, ...extra });
  return { app, db, options, headers, policy, set: (value: string) => envelope = value, offline: () => offline = true };
}
describe("owner policy synchronization", () => {
  it("denies feature and integration changes even in an unconfigured runtime", async () => {
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    const app = buildServer({ db }); apps.push(app);
    const admin = await setupAdmin(app);
    for (const path of ["/api/features/inventory", "/api/integrations/zomato"]) expect((await app.inject({ method: "PATCH", url: path, headers: auth(admin.token), payload: { enabled: true } })).statusCode).toBe(403);
  });
  it("enforces signed owner settings and denies both staff override APIs", async () => {
    const f = await fixture(); f.set(f.policy(1, { takeaway: false, inventory: false, zomato: true }));
    expect(await f.app.licensing.refreshFeaturePolicy()).toBe(true);
    const catalog = (await f.app.inject({ url: "/api/features", headers: f.headers })).json();
    expect(catalog.features.find((v: { id: string }) => v.id === "inventory").active).toBe(false);
    expect((await f.app.inject({ url: "/api/integrations", headers: f.headers })).json().integrations.find((v: { id: string }) => v.id === "zomato").enabled).toBe(true);
    expect((await f.app.inject({ method: "POST", url: "/api/orders", headers: f.headers, payload: { type: "parcel", clientRef: randomUUID() } })).statusCode).toBe(403);
    for (const path of ["/api/features/inventory", "/api/integrations/zomato"]) expect((await f.app.inject({ method: "PATCH", url: path, headers: f.headers, payload: { enabled: true } })).statusCode).toBe(403);
  });
  it("keeps the verified cache offline and rejects rollback, tampering and wrong-outlet settings", async () => {
    const f = await fixture(); f.set(f.policy(2, { inventory: false })); await f.app.licensing.refreshFeaturePolicy();
    for (const invalid of [f.policy(1, { inventory: true }), f.policy(2, { inventory: true }), f.policy(3, { inventory: true }, { outletId: randomUUID() }), f.policy(3, { inventory: true }).slice(0, -4) + "abcd"]) {
      f.set(invalid); expect(await f.app.licensing.refreshFeaturePolicy()).toBe(false);
      expect(f.app.licensing.featurePolicy()?.enabled.inventory).toBe(false);
    }
    f.offline(); expect(await f.app.licensing.refreshFeaturePolicy()).toBe(false);
    await f.app.close(); apps.splice(apps.indexOf(f.app), 1);
    const restarted = buildServer({ db: f.db, licensing: f.options }); apps.push(restarted);
    expect(restarted.licensing.featurePolicy()?.enabled.inventory).toBe(false);
  });
  it("grants individual CRUD actions and independently denies archive actions", async () => {
    const f = await fixture();
    const userId = (await f.app.inject({ url: "/api/me", headers: f.headers })).json().user.id;
    f.set(f.policy(1, {}, { staffPermissions: { [userId]: { "categories.create": false, "categories.update": true, "categories.delete": false } } }));
    await f.app.licensing.refreshFeaturePolicy();
    expect((await f.app.inject({ method: "POST", url: "/api/categories", headers: f.headers, payload: { name: "Denied" } })).statusCode).toBe(403);
    const category = f.db.prepare("SELECT id FROM categories LIMIT 1").get() as { id: string } | undefined;
    const id = category?.id ?? randomUUID();
    if (!category) f.db.prepare("INSERT INTO categories(id,name,sort_order,is_active) VALUES (?,'Food',0,1)").run(id);
    expect((await f.app.inject({ method: "PATCH", url: `/api/categories/${id}`, headers: f.headers, payload: { name: "Allowed edit" } })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "PATCH", url: `/api/categories/${id}`, headers: f.headers, payload: { isActive: false } })).statusCode).toBe(403);
    f.set(f.policy(2, {}, { staffPermissions: { [userId]: { "categories.create": true, "categories.read": false } } }));
    await f.app.licensing.refreshFeaturePolicy();
    expect((await f.app.inject({ method: "POST", url: "/api/categories", headers: f.headers, payload: { name: "Allowed" } })).statusCode).toBe(201);
    expect((await f.app.inject({ url: "/api/categories", headers: f.headers })).statusCode).toBe(403);
    f.set(f.policy(3, {}, { staffPermissions: { [userId]: { "categories.delete": true, "categories.update": false } } }));
    await f.app.licensing.refreshFeaturePolicy();
    expect((await f.app.inject({ method: "PATCH", url: `/api/categories/${id}`, headers: f.headers, payload: { isActive: false, name: "Unauthorized rename" } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "PATCH", url: `/api/categories/${id}`, headers: f.headers, payload: { isActive: false } })).statusCode).toBe(200);
  });
  it("grants cashier actions outside the role and prevents catalog import from bypassing denials", async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: "POST", url: "/api/users", headers: f.headers, payload: { name: "Ravi", pin: "2222", role: "cashier" } })).statusCode).toBe(201);
    const login = await f.app.inject({ method: "POST", url: "/api/login", payload: { pin: "2222" }, headers: { "x-forkflow-device": f.headers["x-forkflow-device"] } });
    const headers = { ...f.headers, authorization: `Bearer ${login.json().token}` };
    const id = login.json().user.id;
    f.set(f.policy(1, {}, { staffPermissions: { [id]: { "categories.create": true, "categories.update": false } } }));
    await f.app.licensing.refreshFeaturePolicy();
    expect((await f.app.inject({ method: "POST", url: "/api/categories", headers, payload: { name: "Cashier-created" } })).statusCode).toBe(201);
    expect((await f.app.inject({ method: "POST", url: "/api/catalog/import", headers, payload: {} })).statusCode).toBe(403);
    expect((await f.app.inject({ url: "/api/me/permissions", headers })).json().permissions["categories.create"]).toBe(true);
  });
});
