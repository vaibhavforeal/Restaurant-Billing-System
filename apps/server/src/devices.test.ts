import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MIGRATIONS, migrate, openDb, type Database } from "@masalapos/domain";
import { Devices, deviceHash } from "./devices.js";
import { ADMIN_LOGIN, SETUP, auth, createUser, freshApp, setupAdmin, testLogin } from "./test-helpers.js";

const A = "a".repeat(64), B = "b".repeat(64);

describe("device registry", () => {
  let db: Database, devices: Devices, now: number;
  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    now = 100;
    devices = new Devices(db, () => now);
  });
  const add = (credential: string, name: string, kind: "counter" | "kitchen" | "captain" = "counter", isMain = false) =>
    devices.add({ credentialHash: deviceHash(credential)!, name, kind, isMain }, "Asha");
  /** Signs someone in on the device, the way a login leaves a session row behind. */
  const session = (credentialHash: string) => {
    db.prepare("INSERT OR IGNORE INTO users (id, name, pin_hash, role, created_at) VALUES ('u1', 'Asha', 'x', 'admin', 1)").run();
    db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at, device) VALUES (?, 'u1', 1, 9999999, ?)").run(`t-${credentialHash}`, credentialHash);
  };
  const sessions = (credentialHash: string) => db.prepare("SELECT count(*) AS n FROM sessions WHERE device = ?").get(credentialHash);

  it("hashes only well-formed credentials", () => {
    expect(deviceHash(A)).toMatch(/^[a-f0-9]{64}$/);
    expect(deviceHash(A)).not.toBe(A);
    expect(deviceHash("nope")).toBeNull();
    expect(deviceHash(undefined)).toBeNull();
  });

  it("adds devices and lists them oldest first", () => {
    add(A, "One");
    now = 200;
    add(B, "Two", "kitchen");
    expect(devices.active().map((d) => [d.name, d.kind, d.isMain, d.version])).toEqual([["One", "counter", false, 1], ["Two", "kitchen", false, 1]]);
    expect(devices.active()[0]).toMatchObject({ credentialHash: deviceHash(A), settings: {}, createdAt: 100, removedAt: null, lastSeenAt: null });
    expect(devices.findByCredential(A)?.name).toBe("One");
    expect(devices.findByCredential("nope")).toBeNull();
    expect(devices.events().events.map((e) => [e.kind, e.summary])).toEqual([["joined", "Registered Two."], ["joined", "Registered One."]]);
    expect(devices.events().events[0]).toMatchObject({ actorName: "Asha", occurredAt: 200, deviceId: devices.active()[1]!.id });
  });

  it("refuses a credential an active device already holds", () => {
    add(A, "One");
    expect(() => devices.add({ credentialHash: deviceHash(A)!, name: "Again", kind: "counter" }, "Asha")).toThrow(/already registered/);
    expect(devices.active()).toHaveLength(1);
  });

  it("revives a removed device that registers again", () => {
    const first = add(A, "One");
    devices.remove(first.id, "Asha");
    expect(devices.active()).toEqual([]);
    expect(devices.findByCredential(A)).toBeNull();
    now = 300;
    const revived = add(A, "Back", "kitchen");
    expect(revived).toMatchObject({ id: first.id, name: "Back", kind: "counter", createdAt: 300, removedAt: null, version: 3 });
    expect(devices.active()).toHaveLength(1);
  });

  it("renames with a stale-write check", () => {
    const d = add(A, "Old");
    expect(() => devices.rename(d.id, "New", 99, "Asha")).toThrow(/This device changed/);
    now = 200;
    devices.rename(d.id, "New", d.version, "Asha");
    expect(devices.active()[0]).toMatchObject({ name: "New", version: 2, createdAt: d.createdAt });
    devices.rename(d.id, "New", 2, "Asha");
    expect(devices.active()[0]!.version).toBe(2);
    expect(devices.events().events.map((e) => [e.kind, e.summary])).toEqual([["renamed", "Renamed Old to New."], ["joined", "Registered Old."]]);
    expect(() => devices.rename("missing", "X", 1, "Asha")).toThrow(/Device not found/);
  });

  it("removes a device, ends its sessions, and is idempotent", () => {
    const d = add(A, "One");
    const other = add(B, "Two");
    session(d.credentialHash); session(other.credentialHash);
    expect(() => devices.remove(d.id, "Asha", 99)).toThrow(/This device changed/);
    expect(() => devices.remove("missing", "Asha")).toThrow(/Device not found/);
    now = 400;
    devices.remove(d.id, "Asha", d.version);
    devices.remove(d.id, "Asha", d.version);
    expect(devices.active().map((x) => x.name)).toEqual(["Two"]);
    expect(sessions(d.credentialHash)).toEqual({ n: 0 });
    expect(sessions(other.credentialHash)).toEqual({ n: 1 });
    expect(devices.events().events.filter((e) => e.kind === "removed").map((e) => e.summary)).toEqual(["Removed One."]);
    expect(db.prepare("SELECT removed_at, version FROM devices WHERE id = ?").get(d.id)).toEqual({ removed_at: 400, version: 2 });
  });

  it("never removes the main counter", () => {
    const main = add(A, "Main counter", "counter", true);
    session(main.credentialHash);
    expect(() => devices.remove(main.id, "Asha")).toThrow(/main counter can't be removed/);
    expect(devices.active()).toHaveLength(1);
    expect(devices.active()[0]).toMatchObject({ isMain: true, version: 1 });
    expect(sessions(main.credentialHash)).toEqual({ n: 1 });
    expect(devices.events().events.filter((e) => e.kind === "removed")).toEqual([]);
  });

  it("makes one main counter", () => {
    expect(devices.ensureMain("nope", "Asha")).toBeNull();
    expect(devices.ensureMain(A, "Asha")).toMatchObject({ name: "Main counter", kind: "counter", isMain: true });
    expect(devices.ensureMain(B, "Asha")).toBeNull();
    expect(devices.ensureMain(A, "Asha")).toBeNull();
    expect(devices.active().filter((d) => d.isMain)).toHaveLength(1);
    expect(devices.active()).toHaveLength(1);
  });

  it("promotes an existing device to main instead of adding a second row", () => {
    add(A, "Old counter");
    expect(devices.ensureMain(A, "Asha")).toMatchObject({ name: "Old counter", isMain: true });
    expect(devices.active()).toMatchObject([{ name: "Old counter", isMain: true }]);
  });

  it("touch updates last seen without changing the version", () => {
    const d = add(A, "One");
    devices.touch(d.id, 777);
    expect(devices.active()[0]).toMatchObject({ lastSeenAt: 777, version: 1 });
  });

  it("pages history 20 at a time and never exposes a credential", () => {
    const d = add(A, "Name 0");
    for (let i = 1; i <= 25; i++) devices.rename(d.id, `Name ${i}`, i, "Asha");
    const first = devices.events();
    expect(first.events).toHaveLength(20);
    expect(first.nextBefore).not.toBeNull();
    const second = devices.events(first.nextBefore!);
    expect(second.events).toHaveLength(6);
    expect(second.nextBefore).toBeNull();
    expect(new Set([...first.events, ...second.events].map((e) => e.id)).size).toBe(26);
    expect(JSON.stringify(first)).not.toContain(deviceHash(A)!);
    expect(JSON.stringify(second)).not.toContain(A);
  });
});

describe("devices on the server", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => { for (const app of apps.splice(0)) { await app.close(); app.db.close(); } });
  const dev = () => { const app = freshApp(); apps.push(app); return app; };
  const withDevice = (credential: string) => ({ "x-masalapos-device": credential });
  const signIn = (app: FastifyInstance, payload: object, credential: string, remoteAddress?: string) =>
    app.inject({ method: "POST", url: "/api/login", payload, headers: withDevice(credential), ...(remoteAddress ? { remoteAddress } : {}) });

  it("setup makes the setup browser the main counter in a dev build", async () => {
    const app = dev();
    await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: withDevice(A) });
    expect(app.devices.active()).toMatchObject([{ name: "Main counter", kind: "counter", isMain: true }]);
    expect(app.devices.events().events).toMatchObject([{ kind: "joined", actorName: SETUP.adminName }]);
  });

  it("setup without a device credential in a dev build makes no device", async () => {
    const app = dev(); await setupAdmin(app);
    expect(app.devices.active()).toEqual([]);
  });

  it("an admin signing in on the main PC becomes the main counter when there is none", async () => {
    const app = dev(); await setupAdmin(app);
    const lan = await signIn(app, ADMIN_LOGIN, B, "192.168.1.20");
    expect(lan.statusCode).toBe(200);
    expect(app.devices.active()).toEqual([]);
    expect((await signIn(app, { ...ADMIN_LOGIN, password: "wrong-password" }, A)).statusCode).toBe(401);
    expect(app.devices.active()).toEqual([]);
    expect((await signIn(app, ADMIN_LOGIN, A)).statusCode).toBe(200);
    expect(app.devices.active()).toMatchObject([{ name: "Main counter", isMain: true, credentialHash: deviceHash(A) }]);
    await signIn(app, ADMIN_LOGIN, B);
    expect(app.devices.active()).toHaveLength(1);
  });

  it("a cashier signing in on the main PC does not become the main counter", async () => {
    const app = dev(); const admin = await setupAdmin(app);
    const cashier = { name: "Ravi", pin: "2345", role: "cashier" as const };
    await createUser(app, admin.token, cashier);
    expect((await signIn(app, testLogin(cashier), A)).statusCode).toBe(200);
    expect(app.devices.active()).toEqual([]);
  });

  it("puts the calling device on the request", async () => {
    const app = dev();
    app.get("/api/test-device", { preHandler: app.requireAuth }, async (req) => ({ name: req.device?.name ?? null }));
    app.get("/api/test-device-permission", { preHandler: app.requirePermission("settings.manage") }, async (req) => ({ name: req.device?.name ?? null }));
    const setup = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: withDevice(A) });
    const token = auth(setup.json().token);
    const ask = async (url: string, headers: Record<string, string>) => {
      const res = await app.inject({ url, headers });
      return [res.statusCode, res.json()];
    };
    expect(await ask("/api/test-device", token)).toEqual([200, { name: null }]);
    expect(await ask("/api/test-device", { ...token, ...withDevice(B) })).toEqual([200, { name: null }]);
    expect(await ask("/api/test-device", { ...token, ...withDevice(A) })).toEqual([200, { name: "Main counter" }]);
    expect(await ask("/api/test-device-permission", { ...token, ...withDevice(A) })).toEqual([200, { name: "Main counter" }]);
    expect(await ask("/api/test-device-permission", token)).toEqual([200, { name: null }]);
  });
});
