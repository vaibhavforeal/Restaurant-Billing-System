import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MIGRATIONS, migrate, openDb, type Database } from "@masalapos/domain";
import { Devices, deviceHash } from "./devices.js";
import { ADMIN_LOGIN, SETUP, auth, commercialApp, createUser, freshApp, setupAdmin, testLogin } from "./test-helpers.js";

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);

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
    expect(() => devices.add({ credentialHash: deviceHash(A)!, name: "Again", kind: "counter" }, "Asha")).toThrow(/already joined/);
    expect(devices.active()).toHaveLength(1);
  });

  it("a removed browser that joins again is a new device of the kind asked for", () => {
    const first = add(A, "One");
    devices.remove(first.id, "Asha");
    now = 300;
    const again = add(A, "Back", "kitchen");
    expect(again.id).not.toBe(first.id);
    expect(again).toMatchObject({ name: "Back", kind: "kitchen", createdAt: 300, removedAt: null, version: 1, settings: {} });
    expect(devices.active().map((d) => d.id)).toEqual([again.id]);
    expect(db.prepare("SELECT credential_hash AS h, removed_at IS NOT NULL AS removed FROM devices WHERE id = ?").get(first.id)).toEqual({ h: `retired:${first.id}`, removed: 1 });
  });

  it("moves a device to another browser and keeps everything else", () => {
    now = 100; add(A, "Main", "counter", true);
    now = 200; const pass = add(B, "Pass", "kitchen");
    db.prepare("UPDATE devices SET settings = '{\"x\":1}', last_seen_at = 150 WHERE id = ?").run(pass.id);
    session(deviceHash(B)!); session(deviceHash(A)!);
    now = 900;
    const moved = devices.replaceCredential(pass.id, deviceHash(C)!, "Asha", "Replaced the browser of Pass.");
    expect(moved).toMatchObject({ id: pass.id, name: "Pass", kind: "kitchen", settings: { x: 1 }, createdAt: 200, lastSeenAt: null, version: 2, credentialHash: deviceHash(C) });
    expect(devices.active().map((d) => d.name)).toEqual(["Main", "Pass"]);
    expect(devices.findByCredential(B)).toBeNull();
    expect(sessions(deviceHash(B)!)).toEqual({ n: 0 });
    expect(sessions(deviceHash(A)!)).toEqual({ n: 1 });
    expect(devices.events().events[0]).toMatchObject({ kind: "replaced", summary: "Replaced the browser of Pass.", actorName: "Asha", deviceId: pass.id });
  });

  it("keeps the main counter the main counter when it is replaced", () => {
    const main = add(A, "Main", "counter", true);
    expect(devices.replaceCredential(main.id, deviceHash(B)!, "Asha", "x").isMain).toBe(true);
    expect(devices.main()?.id).toBe(main.id);
  });

  it("refuses to replace with a browser that is already a device, or a device that is gone", () => {
    const one = add(A, "One"), two = add(B, "Two");
    expect(() => devices.replaceCredential(one.id, deviceHash(B)!, "Asha", "x")).toThrow(/already joined/);
    expect(() => devices.replaceCredential(one.id, deviceHash(A)!, "Asha", "x")).toThrow(/already joined/);
    devices.remove(two.id, "Asha");
    expect(() => devices.replaceCredential(two.id, deviceHash(C)!, "Asha", "x")).toThrow(/Device not found/);
    // The removed device's old browser can take over another device.
    expect(devices.replaceCredential(one.id, deviceHash(B)!, "Asha", "x").credentialHash).toBe(deviceHash(B));
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

  it("adds a main counter only while the device limit has room, but always promotes a device already in the list", () => {
    add(A, "One"); now = 200; add(B, "Two");
    const C = "c".repeat(64);
    expect(devices.ensureMain(C, "Asha", 2)).toBeNull();
    expect(devices.active().map((d) => [d.name, d.isMain])).toEqual([["One", false], ["Two", false]]);
    expect(devices.ensureMain(B, "Asha", 2)).toMatchObject({ name: "Two", isMain: true });
    expect(devices.active()).toHaveLength(2);
  });

  it("keeps the credential hash out of anything serialised from a device", () => {
    const d = add(A, "One");
    expect(d.credentialHash).toBe(deviceHash(A));
    expect(JSON.stringify([d, devices.active(), devices.findByCredential(A), { ...d }])).not.toContain(deviceHash(A)!);
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

  it("never sends the credential hash when a route returns the calling device", async () => {
    const app = dev();
    app.get("/api/test-device-whole", { preHandler: app.requireAuth }, async (req) => ({ device: req.device }));
    const setup = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: withDevice(A) });
    const res = await app.inject({ url: "/api/test-device-whole", headers: { ...auth(setup.json().token), ...withDevice(A) } });
    expect(res.json().device).toMatchObject({ name: "Main counter", isMain: true });
    expect(res.body).not.toContain(deviceHash(A)!);
    expect(res.body).not.toContain("credentialHash");
  });

  describe("in a licensed build with no main counter", () => {
    const D = "d".repeat(64), C = "c".repeat(64);
    /** Basic plan (2 devices) whose one device, "Counter", is not marked main: what a database from before the main counter looks like. */
    const licensed = async () => {
      const f = await commercialApp("basic"); apps.push(f.app);
      f.app.db.prepare("UPDATE devices SET is_main = 0").run();
      return f;
    };

    it("an admin signing in on the main PC with the removed counter's browser gets it back as the main counter", async () => {
      const { app } = await licensed();
      app.db.prepare("UPDATE devices SET removed_at = 1").run();
      app.db.prepare("DELETE FROM sessions").run();
      const signedIn = await signIn(app, ADMIN_LOGIN, D);
      expect(signedIn.statusCode).toBe(200);
      expect(app.devices.active()).toMatchObject([{ name: "Main counter", isMain: true, credentialHash: deviceHash(D) }]);
      expect(app.db.prepare("SELECT count(*) AS n FROM devices").get()).toEqual({ n: 2 });
      expect((await app.inject({ url: "/api/products", headers: { ...auth(signedIn.json().token), ...withDevice(D) } })).statusCode).toBe(200);
    });

    it("signing in on the main PC adds no device once the plan's devices are all in use", async () => {
      const { app, headers } = await licensed();
      const second = await signIn(app, ADMIN_LOGIN, B, "192.168.1.20");
      const registered = await app.inject({ method: "POST", url: "/api/license/devices", payload: { name: "Kitchen" }, headers: { ...auth(second.json().token), ...withDevice(B) } });
      expect(registered.statusCode).toBe(200);
      expect((await signIn(app, ADMIN_LOGIN, C)).statusCode).toBe(200);
      expect(app.devices.active().map((d) => [d.name, d.isMain])).toEqual([["Counter", false], ["Kitchen", false]]);
      // A device that already holds a slot can still become the main counter.
      expect((await signIn(app, ADMIN_LOGIN, D)).statusCode).toBe(200);
      expect(app.devices.active().map((d) => [d.name, d.isMain])).toEqual([["Counter", true], ["Kitchen", false]]);
      expect((await app.inject({ url: "/api/products", headers })).statusCode).toBe(200);
    });
  });
});
