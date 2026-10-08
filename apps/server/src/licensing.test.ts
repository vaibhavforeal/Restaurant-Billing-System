import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { LicenseClaims, MIGRATIONS, PLANS, migrate, openDb } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import { SETUP, freshApp } from "./test-helpers.js";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const installationId = randomUUID();
const scope = { installationId, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID() };
const device = "a".repeat(64);
const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) { await app.close(); app.db.close(); } });

function signed(input: LicenseClaims, privateKey = keys.privateKey) {
  const message = `ff1.${Buffer.from(JSON.stringify(input)).toString("base64url")}`;
  return `${message}.${sign(null, Buffer.from(message), privateKey).toString("base64url")}`;
}
async function fixture() {
  let now = Date.now();
  const db = openDb(":memory:"); migrate(db, MIGRATIONS);
  const app = buildServer({ db, licensing: { publicKey, installationId, now: () => now } });
  // Exercise the same permission + entitlement guard that future paid routes use.
  app.get("/api/test-recipes", { preHandler: [app.requirePermission("stock.manage"), app.requireFeature("recipes")] }, async () => ({ allowed: true }));
  app.get("/api/test-kds", { preHandler: [app.requirePermission("kots.read"), app.requireFeature("kds")] }, async () => ({ allowed: true }));
  apps.push(app);
  const setup = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: { "x-forkflow-device": device } });
  expect(setup.statusCode).toBe(201);
  const headers = { authorization: `Bearer ${setup.json().token}`, "x-forkflow-device": device };
  const claims: LicenseClaims = { version: 1, ...scope, revision: 1, plan: "basic", features: PLANS.basic.features, maxDevices: PLANS.basic.maxDevices,
    issuedAt: now - 1000, expiresAt: now + 60_000, graceUntil: now + 120_000 };
  const clean = LicenseClaims.parse(claims);
  const activate = (c: LicenseClaims = clean) => app.inject({ method: "PUT", url: "/api/license", payload: { license: signed(c) }, headers });
  const register = (h = headers, name = "Main counter") => app.inject({ method: "POST", url: "/api/license/devices", payload: { name }, headers: h });
  const login = async (credential: string, pin = "1234") => {
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { pin }, headers: { "x-forkflow-device": credential } });
    expect(res.statusCode).toBe(200);
    return { authorization: `Bearer ${res.json().token}`, "x-forkflow-device": credential };
  };
  return { app, headers, claims: clean, activate, register, login, setNow: (value: number) => { now = value; } };
}

describe("commercial licensing", () => {
  it("previews signed changes without writing license state, devices or history", async () => {
    const f = await fixture();
    const state = f.app.db.prepare("SELECT * FROM license_state").get();
    const preview = await f.app.inject({ method: "POST", url: "/api/license/preview", headers: f.headers, payload: { license: signed(f.claims) } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ currentPlan: null, plan: "basic", revision: 1, maxDevices: 2, blockedDevices: [], alreadyInstalled: false });
    expect(preview.json().previewKey).toMatch(/^[a-f0-9]{64}$/);
    expect(f.app.db.prepare("SELECT * FROM license_state").get()).toEqual(state);
    expect(f.app.licensing.history().events).toEqual([]);
    expect(f.app.db.prepare("SELECT count(*) AS n FROM licensed_devices").get()).toEqual({ n: 0 });
    const bad = signed({ ...f.claims, installationId: randomUUID() });
    expect((await f.app.inject({ method: "POST", url: "/api/license/preview", headers: f.headers, payload: { license: bad } })).statusCode).toBe(400);
  });

  it("shows downgrade impact and rejects previews made before device or license changes", async () => {
    const f = await fixture(); await f.activate({ ...f.claims, plan: "pro", maxDevices: 5, features: PLANS.pro.features }); await f.register();
    const second = await f.login("b".repeat(64)); await f.register(second, "Kitchen");
    const third = await f.login("c".repeat(64)); await f.register(third, "Waiter");
    const license = signed({ ...f.claims, revision: 3 });
    const before = f.app.licensing.preview(license);
    expect(before.blockedDevices).toEqual(f.app.licensing.devices().slice(2).map(({ id, name }) => ({ id, name })));
    const target = f.app.licensing.devices()[0]!;
    f.app.licensing.rename(target.id, "New name", target.version, "Asha");
    const apply = (previewKey: string) => f.app.inject({ method: "PUT", url: "/api/license", headers: f.headers, payload: { license, previewKey } });
    expect((await apply(before.previewKey)).statusCode).toBe(409);
    const next = f.app.licensing.preview(license);
    await f.activate({ ...f.claims, revision: 2, plan: "pro", maxDevices: 5, features: PLANS.pro.features });
    expect((await apply(next.previewKey)).statusCode).toBe(409);
    const fresh = f.app.licensing.preview(license);
    expect((await apply(fresh.previewKey)).statusCode).toBe(200);
    expect((await apply(fresh.previewKey)).statusCode).toBe(200);
    expect(f.app.licensing.preview(license).alreadyInstalled).toBe(true);
    expect(f.app.licensing.history().events.filter((e) => e.revision === 3)).toHaveLength(1);
  });

  it("rejects activation when a registration changes after preview", async () => {
    const f = await fixture(); await f.activate(); await f.register();
    const license = signed({ ...f.claims, revision: 2 });
    const preview = f.app.licensing.preview(license);
    const second = await f.login("b".repeat(64)); await f.register(second, "Kitchen");
    const result = await f.app.inject({ method: "PUT", url: "/api/license", headers: f.headers, payload: { license, previewKey: preview.previewKey } });
    expect(result.statusCode).toBe(409);
    expect(f.app.licensing.status(device).revision).toBe(1);
  });

  it("exports activation identity without a grant or device secrets and supports renewal after expiry", async () => {
    const f = await fixture();
    const initial = await f.app.inject({ url: "/api/license/activation-request", headers: f.headers });
    expect(initial.json()).toMatchObject({ format: "forkflow-activation-request", installationId, currentRevision: 0, licenseId: null });
    expect(initial.headers["cache-control"]).toBe("no-store");
    expect(initial.json().verificationKeyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    await f.activate(); await f.register(); f.setNow(f.claims.graceUntil);
    const request = (await f.app.inject({ url: "/api/license/activation-request", headers: f.headers })).json();
    expect(request).toMatchObject({ ...scope, currentRevision: 1 });
    expect(JSON.stringify(request)).not.toContain("ff1."); expect(JSON.stringify(request)).not.toContain(device);
    const renewal = signed({ ...f.claims, revision: 2, issuedAt: f.claims.graceUntil, expiresAt: f.claims.graceUntil + 60_000, graceUntil: f.claims.graceUntil + 120_000 });
    const preview = (await f.app.inject({ method: "POST", url: "/api/license/preview", headers: f.headers, payload: { license: renewal } })).json();
    expect((await f.app.inject({ method: "PUT", url: "/api/license", headers: f.headers, payload: { license: renewal, previewKey: preview.previewKey } })).statusCode).toBe(200);
    expect(f.app.licensing.status(device).canOperate).toBe(true);
  });

  it("renames any device with stale-write checks while preserving slot priority", async () => {
    const f = await fixture(); await f.activate(); await f.register();
    const second = await f.login("b".repeat(64)); await f.register(second, "Kitchen");
    const target = f.app.licensing.devices().find((d) => d.name === "Kitchen")!;
    const rename = (name: string, version: number) => f.app.inject({ method: "PATCH", url: `/api/license/devices/${target.id}`, headers: f.headers, payload: { name, version } });
    expect((await rename("  Kitchen screen  ", target.version)).statusCode).toBe(200);
    const updated = f.app.licensing.devices().find((d) => d.id === target.id)!;
    expect(updated).toMatchObject({ name: "Kitchen screen", version: 2, createdAt: target.createdAt });
    expect((await rename("Old name", target.version)).statusCode).toBe(409);
    expect((await f.app.inject({ method: "DELETE", url: `/api/license/devices/${target.id}`, headers: f.headers, payload: { version: target.version } })).statusCode).toBe(409);
    expect((await rename(" ", updated.version)).statusCode).toBe(400);
    expect((await rename("x".repeat(81), updated.version)).statusCode).toBe(400);
    expect((await f.app.inject({ url: "/api/products", headers: second })).statusCode).toBe(200);
  });

  it("removal retries are idempotent and cannot remove a later re-registration", async () => {
    const f = await fixture(); await f.activate(); await f.register();
    const second = await f.login("b".repeat(64)); await f.register(second, "Kitchen");
    const target = f.app.licensing.devices().find((d) => d.name === "Kitchen")!;
    const remove = () => f.app.inject({ method: "DELETE", url: `/api/license/devices/${target.id}`, headers: f.headers, payload: { version: target.version } });
    expect((await remove()).statusCode).toBe(204); expect((await remove()).statusCode).toBe(204);
    expect((await f.app.inject({ url: "/api/me", headers: second })).statusCode).toBe(401);
    const reconnected = await f.login("b".repeat(64)); await f.register(reconnected, "Kitchen again");
    expect((await remove()).statusCode).toBe(409);
    expect((await f.app.inject({ url: "/api/products", headers: reconnected })).statusCode).toBe(200);
    expect(f.app.licensing.history().events.filter((e) => e.kind === "device_removed")).toHaveLength(1);
  });

  it("records successful changes once and pages history without leaking credentials", async () => {
    const f = await fixture(); await f.activate(); await f.activate(); await f.register(); await f.register();
    expect(f.app.licensing.history().events.map((e) => e.kind)).toEqual(["device_registered", "license_activated"]);
    expect(f.app.licensing.history().events[0]!.actorName).toBe(SETUP.adminName);
    for (let i = 0; i < 25; i++) await f.register(f.headers, `Counter ${i}`);
    const first = (await f.app.inject({ url: "/api/license/history", headers: f.headers })).json();
    expect(first.events).toHaveLength(20);
    const second = (await f.app.inject({ url: `/api/license/history?before=${first.nextBefore}`, headers: f.headers })).json();
    expect(second.events).toHaveLength(7); expect(second.nextBefore).toBeNull();
    expect(new Set([...first.events, ...second.events].map((e) => e.id)).size).toBe(27);
    expect(JSON.stringify(first)).not.toContain(device); expect(JSON.stringify(first)).not.toContain("ff1.");
    expect((await f.app.inject({ url: "/api/license/history?before=nope", headers: f.headers })).statusCode).toBe(400);
  });

  it("keeps device and history APIs available after expiry and denies staff management", async () => {
    const f = await fixture(); await f.activate(); await f.register();
    await f.app.inject({ method: "POST", url: "/api/users", headers: f.headers, payload: { name: "Cashier", role: "cashier", pin: "2345" } });
    const cashier = await f.login(device, "2345"), target = f.app.licensing.devices()[0]!;
    for (const [method, url, payload] of [
      ["GET", "/api/license/history", undefined], ["GET", "/api/license/activation-request", undefined],
      ["POST", "/api/license/preview", { license: signed(f.claims) }],
      ["PATCH", `/api/license/devices/${target.id}`, { name: "Changed", version: target.version }],
    ] as const) expect((await f.app.inject({ method, url, headers: cashier, ...(payload ? { payload } : {}) })).statusCode).toBe(403);
    f.setNow(f.claims.graceUntil);
    for (const url of ["/api/license", "/api/license/devices", "/api/license/history", "/api/license/activation-request"]) expect((await f.app.inject({ url, headers: f.headers })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "PATCH", url: `/api/license/devices/${target.id}`, headers: f.headers, payload: { name: "Main PC", version: target.version } })).statusCode).toBe(200);
    expect((await f.app.inject({ url: "/api/products", headers: f.headers })).statusCode).toBe(403);
  });

  it("reports server time and throttles last-active writes without changing device versions", async () => {
    const f = await fixture(); await f.activate(); await f.register();
    const before = f.app.licensing.devices(device)[0]!;
    expect(before.lastSeenAt).not.toBeNull();
    f.setNow(before.lastSeenAt! + 30_000);
    expect(f.app.licensing.devices(device)[0]).toMatchObject({ lastSeenAt: before.lastSeenAt, version: before.version });
    f.setNow(before.lastSeenAt! + 60_000);
    expect(f.app.licensing.devices(device)[0]).toMatchObject({ lastSeenAt: before.lastSeenAt! + 60_000, version: before.version });
    expect(f.app.licensing.status(device)).toMatchObject({ serverTime: before.lastSeenAt! + 60_000, registeredDevices: 1, revision: 1, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });

  it("migrates existing licenses and devices without changing grants or priority", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter((m) => m.version < 13));
      db.prepare("UPDATE license_state SET envelope='existing', revision=7, last_seen_at=123 WHERE id=1").run();
      db.prepare("INSERT INTO licensed_devices (id, credential_hash, name, created_at) VALUES ('old','hash','Main',42)").run();
      migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT * FROM licensed_devices WHERE id='old'").get()).toMatchObject({ name: "Main", created_at: 42, last_seen_at: null, version: 1 });
      expect(db.prepare("SELECT * FROM license_state WHERE id=1").get()).toMatchObject({ envelope: "existing", revision: 7, last_seen_at: 123 });
      expect(db.prepare("SELECT count(*) AS n FROM license_events").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it("rejects unrenderable signed dates and alternate base64 signature encodings", async () => {
    const f = await fixture();
    expect((await f.activate({ ...f.claims, expiresAt: Number.MAX_SAFE_INTEGER - 1, graceUntil: Number.MAX_SAFE_INTEGER })).statusCode).toBe(400);
    const valid = signed(f.claims), alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const altered = valid.slice(0, -1) + alphabet[alphabet.indexOf(valid.at(-1)!) + 1];
    expect(Buffer.from(altered.split(".")[2]!, "base64url")).toEqual(Buffer.from(valid.split(".")[2]!, "base64url"));
    expect((await f.app.inject({ method: "PUT", url: "/api/license", headers: f.headers, payload: { license: altered } })).statusCode).toBe(400);
  });

  it("requires activation and device approval, then enforces Basic and Pro on the API", async () => {
    const f = await fixture();
    expect((await f.app.inject({ url: "/api/products", headers: f.headers })).statusCode).toBe(403);
    expect((await f.activate()).statusCode).toBe(200);
    expect((await f.app.inject({ url: "/api/products", headers: f.headers })).statusCode).toBe(403);
    expect((await f.register()).statusCode).toBe(200);
    expect((await f.app.inject({ url: "/api/products", headers: f.headers })).statusCode).toBe(200);
    expect((await f.app.inject({ url: "/api/test-recipes", headers: f.headers })).statusCode).toBe(403);
    const pro = { ...f.claims, revision: 2, plan: "pro" as const, features: PLANS.pro.features, maxDevices: 5 };
    expect((await f.activate(pro)).statusCode).toBe(200);
    expect((await f.app.inject({ url: "/api/test-recipes", headers: f.headers })).statusCode).toBe(200);
    // Plan entitlement never substitutes for the staff permission.
    await f.app.inject({ method: "POST", url: "/api/users", headers: f.headers, payload: { name: "Cashier", pin: "2345", role: "cashier" } });
    const cashier = await f.login(device, "2345");
    expect((await f.app.inject({ url: "/api/test-recipes", headers: cashier })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "PUT", url: "/api/license", headers: cashier, payload: { license: signed({ ...pro, revision: 3 }) } })).statusCode).toBe(403);
  });

  it("includes kds in Pro only", () => {
    expect(PLANS.pro.features.kds).toBe(true);
    expect(PLANS.basic.features.kds).toBe(false);
  });

  it("reports kds in development builds", async () => {
    const app = freshApp(); apps.push(app);
    expect(app.licensing.status().features).toEqual({ recipes: true, qrOrdering: true, kds: true });
  });

  it("reads grants issued before kds as not licensed for the kitchen display", async () => {
    const f = await fixture();
    const old = { ...f.claims, plan: "pro" as const, maxDevices: 5, features: { recipes: true, qrOrdering: true } };
    expect(LicenseClaims.parse(old).features.kds).toBe(false);
    expect((await f.activate(old as unknown as LicenseClaims)).statusCode).toBe(200);
    expect(f.app.licensing.status().features.kds).toBe(false);
  });

  it("names the kitchen display in the missing-feature error", async () => {
    const f = await fixture(); await f.activate(); await f.register();
    const res = await f.app.inject({ url: "/api/test-kds", headers: f.headers });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("This feature requires a plan with the Kitchen Display");
  });

  it("rejects forged, altered, wrong-installation, stale, future and cross-outlet licenses", async () => {
    const f = await fixture();
    const put = (license: string) => f.app.inject({ method: "PUT", url: "/api/license", headers: f.headers, payload: { license } });
    const foreign = generateKeyPairSync("ed25519");
    expect((await put(signed(f.claims, foreign.privateKey))).statusCode).toBe(400);
    const parts = signed(f.claims).split(".");
    parts[1] = Buffer.from(JSON.stringify({ ...f.claims, maxDevices: 100 })).toString("base64url");
    expect((await put(parts.join("."))).statusCode).toBe(400);
    expect((await f.activate({ ...f.claims, installationId: randomUUID() })).statusCode).toBe(400);
    expect((await f.activate({ ...f.claims, issuedAt: f.claims.graceUntil + 1000 })).statusCode).toBe(400);
    expect((await f.activate()).statusCode).toBe(200);
    expect((await f.activate()).statusCode).toBe(200); // retry of the exact same grant
    expect((await f.activate({ ...f.claims, revision: 2, organizationId: randomUUID() })).statusCode).toBe(409);
    expect((await f.activate({ ...f.claims, revision: 2, maxDevices: 3 })).statusCode).toBe(200);
    expect((await f.activate()).statusCode).toBe(409);
    expect((await f.activate({ ...f.claims, revision: 2, maxDevices: 4 })).statusCode).toBe(409);
  });

  it("counts persistent registrations, shares a browser slot, and prevents bearer-only bypass", async () => {
    const f = await fixture(); await f.activate(); await f.register();
    const same = await f.login(device);
    expect((await f.register(same)).statusCode).toBe(200);
    const second = await f.login("b".repeat(64));
    expect((await f.register(second, "Kitchen")).statusCode).toBe(200);
    const third = await f.login("c".repeat(64));
    expect((await f.register(third, "Phone")).statusCode).toBe(409);
    expect((await f.app.inject({ url: "/api/products", headers: { authorization: f.headers.authorization } })).statusCode).toBe(401);
    expect((await f.app.inject({ url: "/api/products", headers: { ...f.headers, "x-forkflow-device": third["x-forkflow-device"] } })).statusCode).toBe(401);
    const listed = (await f.app.inject({ url: "/api/license/devices", headers: f.headers })).json();
    expect(listed.devices).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain("credential");
    const target = listed.devices.find((d: { name: string }) => d.name === "Kitchen");
    expect((await f.app.inject({ method: "DELETE", url: `/api/license/devices/${target.id}`, headers: f.headers })).statusCode).toBe(204);
    expect((await f.app.inject({ url: "/api/me", headers: second })).statusCode).toBe(401);
    expect((await f.register(third, "Phone")).statusCode).toBe(200);
  });

  it("honors the offline grace period and fails closed after expiry or clock rollback", async () => {
    const f = await fixture(); await f.activate(); await f.register();
    f.setNow(f.claims.expiresAt);
    expect(f.app.licensing.status(device)).toMatchObject({ state: "grace", canOperate: true });
    expect((await f.app.inject({ url: "/api/products", headers: f.headers })).statusCode).toBe(200);
    f.setNow(f.claims.graceUntil);
    expect(f.app.licensing.status(device)).toMatchObject({ state: "expired", canOperate: false });
    expect((await f.app.inject({ url: "/api/products", headers: f.headers })).statusCode).toBe(403);
    expect((await f.app.inject({ url: "/api/license", headers: f.headers })).statusCode).toBe(200);
    f.setNow(f.claims.issuedAt - 600_000);
    expect(f.app.licensing.status(device).state).toBe("clock_error");
    expect((await f.activate({ ...f.claims, revision: 2 })).statusCode).toBe(409);
  });

  it("applies a reduced device allowance without deleting devices or restaurant data", async () => {
    const f = await fixture();
    await f.activate({ ...f.claims, plan: "pro", maxDevices: 5, features: PLANS.pro.features });
    await f.register();
    for (const letter of ["b", "c"]) { const headers = await f.login(letter.repeat(64)); await f.register(headers, letter); }
    expect((await f.activate({ ...f.claims, revision: 2 })).statusCode).toBe(200);
    const devices = f.app.licensing.devices(device);
    expect(devices).toHaveLength(3);
    expect(devices.filter((d) => d.allowed)).toHaveLength(2);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
    expect((await f.activate({ ...f.claims, revision: 3, plan: "pro", maxDevices: 5, features: PLANS.pro.features })).statusCode).toBe(200);
    expect(f.app.licensing.devices(device).every((d) => d.allowed)).toBe(true);
  });

  it("checks device and license authorization on WebSockets and closes revoked connections", async () => {
    const f = await fixture(); await f.activate(); await f.register();
    const denied = await f.app.injectWS("/api/ws");
    const deniedClosed = new Promise<number>((resolve) => denied.once("close", resolve));
    denied.send(JSON.stringify({ type: "auth", token: f.headers.authorization.slice(7), device: "b".repeat(64) }));
    expect(await deniedClosed).toBe(4403);
    const ws = await f.app.injectWS("/api/ws");
    const authed = new Promise<string>((resolve) => ws.once("message", (raw: Buffer) => resolve(raw.toString())));
    ws.send(JSON.stringify({ type: "auth", token: f.headers.authorization.slice(7), device }));
    expect(JSON.parse(await authed).event).toBe("auth.ok");
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    const id = f.app.licensing.devices(device)[0]!.id;
    await f.app.inject({ method: "DELETE", url: `/api/license/devices/${id}`, headers: f.headers });
    expect(await closed).toBe(4401);
  });

  it("retains licensing and device enforcement after the server restarts", async () => {
    const f = await fixture(); await f.activate(); await f.register();
    const db = f.app.db;
    await f.app.close(); apps.splice(apps.indexOf(f.app), 1);
    const restarted = buildServer({ db, licensing: { publicKey, installationId } }); apps.push(restarted);
    expect((await restarted.inject({ url: "/api/products", headers: f.headers })).statusCode).toBe(200);
    expect(restarted.licensing.devices(device)).toHaveLength(1);
    const altered = signed(f.claims).replace("ff1.", "ff2.");
    db.prepare("UPDATE license_state SET envelope = ? WHERE id = 1").run(altered);
    expect((await restarted.inject({ url: "/api/products", headers: f.headers })).statusCode).toBe(403);
    const renewed = signed({ ...f.claims, revision: 2 });
    expect((await restarted.inject({ method: "PUT", url: "/api/license", headers: f.headers, payload: { license: renewed } })).statusCode).toBe(200);
    expect((await restarted.inject({ url: "/api/products", headers: f.headers })).statusCode).toBe(200);
  });

  it("allocates the final device slot atomically across simultaneous requests", async () => {
    const f = await fixture(); await f.activate(); await f.register();
    const second = await f.login("b".repeat(64)), third = await f.login("c".repeat(64));
    const responses = await Promise.all([f.register(second, "Counter"), f.register(third, "Phone")]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(f.app.licensing.devices(device)).toHaveLength(2);
  });
});
