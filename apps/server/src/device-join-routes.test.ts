import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MIGRATIONS, migrate, openDb } from "@masalapos/domain";
import { deviceHash } from "./devices.js";
import { buildServer } from "./server.js";
import { ADMIN_LOGIN, SETUP, auth, commercialApp, createUser, freshApp, joinDevice, setupAdmin, testLogin } from "./test-helpers.js";

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64), D = "d".repeat(64);
const LAN = "192.168.1.20";
const BAD = { error: "That code is not valid or has expired" };

describe("joining over the API", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => { for (const app of apps.splice(0)) { await app.close(); app.db.close(); } });
  const withDevice = (credential: string) => ({ "x-masalapos-device": credential });
  /** Basic plan (2 devices); the setup browser D is the main counter. */
  const licensed = async () => { const f = await commercialApp("basic"); apps.push(f.app); return f; };
  /** A dev build set up from browser A, which is its main counter. */
  const dev = async (app = freshApp()) => {
    apps.push(app);
    const setup = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: withDevice(A) });
    const token = setup.json().token as string;
    return { app, token, headers: { ...auth(token), ...withDevice(A) } };
  };
  const makeCode = async (app: FastifyInstance, headers: Record<string, string>, payload: object = { kind: "counter", name: "Two" }) =>
    (await app.inject({ method: "POST", url: "/api/devices/join-codes", headers, payload })).json().code as string;
  const join = (app: FastifyInstance, code: string, credential: string | null, remoteAddress?: string) =>
    app.inject({ method: "POST", url: "/api/devices/join", payload: { code }, ...(credential ? { headers: withDevice(credential) } : {}), ...(remoteAddress ? { remoteAddress } : {}) });
  const signIn = async (app: FastifyInstance, payload: object, credential: string) => {
    const res = await app.inject({ method: "POST", url: "/api/login", payload, headers: withDevice(credential) });
    return { ...auth(res.json().token), ...withDevice(credential) };
  };
  const rejoin = (app: FastifyInstance, headers: Record<string, string>, remoteAddress?: string) =>
    app.inject({ method: "POST", url: "/api/devices/rejoin-main", headers, ...(remoteAddress ? { remoteAddress } : {}) });

  it("an admin makes a code and another browser joins with it", async () => {
    const { app, headers } = await licensed();
    const made = await app.inject({ method: "POST", url: "/api/devices/join-codes", headers, payload: { kind: "kitchen", name: "Pass" } });
    expect(made.statusCode).toBe(201);
    expect(made.headers["cache-control"]).toBe("no-store");
    const issued = made.json();
    expect(issued).toMatchObject({ kind: "kitchen", name: "Pass", replacesDeviceId: null });
    expect(issued.expiresAt).toBeGreaterThan(Date.now() + 590_000);
    expect(issued.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
    expect(Array.isArray(issued.links)).toBe(true);
    for (const link of issued.links) {
      expect(link.url).toMatch(new RegExp(`^http://[\\d.]+:\\d+/join#${issued.code}$`));
      expect(link.qr).toMatch(/^data:image\/png/);
    }
    expect((await app.inject({ url: "/api/devices/me", headers: withDevice(B), remoteAddress: LAN })).json()).toEqual({ joined: false, kind: null, mainPc: false });
    expect((await app.inject({ url: "/api/devices/me" })).json()).toEqual({ joined: false, kind: null, mainPc: true });
    const joined = await join(app, issued.code.toLowerCase(), B, LAN);
    expect([joined.statusCode, joined.json()]).toEqual([200, { kind: "kitchen", name: "Pass" }]);
    expect(joined.headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ url: "/api/devices/me", headers: withDevice(B) })).json()).toEqual({ joined: true, kind: "kitchen", mainPc: true });
    // The joined device can sign in and work.
    expect((await app.inject({ url: "/api/products", headers: await signIn(app, ADMIN_LOGIN, B) })).statusCode).toBe(200);
    expect(joined.body + made.body).not.toContain(deviceHash(B)!);
  });

  it("captain links use the HTTPS addresses when the secure listener is on", async () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const { app, headers } = await dev(buildServer({ db, port: 4100, captainHttps: { enabled: true, port: 4443, addresses: ["192.168.1.5"] } }));
    const captain = (await app.inject({ method: "POST", url: "/api/devices/join-codes", headers, payload: { kind: "captain", name: "Tablet" } })).json();
    expect(captain.links.map((l: { url: string }) => l.url)).toEqual([`https://192.168.1.5:4443/join#${captain.code}`]);
    const kitchen = (await app.inject({ method: "POST", url: "/api/devices/join-codes", headers, payload: { kind: "kitchen", name: "Pass" } })).json();
    for (const link of kitchen.links) expect(link.url).toMatch(/^http:\/\//);
  });

  it("only someone who manages settings can make a code", async () => {
    const { app, token } = await dev();
    const cashier = await createUser(app, token, { name: "Ravi", pin: "2345", role: "cashier" });
    const payload = { kind: "counter", name: "Two" };
    expect((await app.inject({ method: "POST", url: "/api/devices/join-codes", headers: auth(cashier.token), payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/devices/join-codes", payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/devices/join-codes", headers: auth(token), payload: { kind: "display", name: "X" } })).statusCode).toBe(400);
  });

  it("refuses a new-device code at the plan's limit and allows a replace code", async () => {
    const { app, headers } = await licensed();
    await joinDevice(app, headers, B);
    const full = await app.inject({ method: "POST", url: "/api/devices/join-codes", headers, payload: { kind: "counter", name: "Three" } });
    expect([full.statusCode, full.json().error]).toEqual([409, "Device limit reached. Remove an old device or upgrade your plan."]);
    const second = app.devices.findByCredential(B)!;
    expect(second).toMatchObject({ name: "Counter 2", kind: "counter" });
    expect((await app.inject({ method: "POST", url: "/api/devices/join-codes", headers, payload: { replacesDeviceId: second.id } })).statusCode).toBe(201);
  });

  it("lets no new device in while the licence cannot be read, since the limit is unknown", async () => {
    const { app, headers } = await licensed();
    const fresh = await makeCode(app, headers);
    await joinDevice(app, headers, B, { kind: "counter", name: "Second" });
    const replace = await makeCode(app, headers, { replacesDeviceId: app.devices.findByCredential(B)!.id });
    const envelope = app.db.prepare("SELECT envelope FROM license_state WHERE id = 1").get() as { envelope: string };
    app.db.prepare("UPDATE devices SET removed_at = 1 WHERE name = 'Second'").run();
    app.db.prepare("UPDATE license_state SET envelope = NULL WHERE id = 1").run();
    expect(app.licensing.status().maxDevices).toBeNull();
    const refused = await join(app, fresh, C);
    expect([refused.statusCode, refused.json().error]).toEqual([409, "Device limit reached. Remove an old device or upgrade your plan."]);
    expect(app.devices.active()).toHaveLength(1);
    // The code is still good once the licence reads again.
    app.db.prepare("UPDATE license_state SET envelope = ? WHERE id = 1").run(envelope.envelope);
    expect((await join(app, fresh, C)).statusCode).toBe(200);
    expect(replace).toMatch(/^[A-Z2-9]{6}$/);
  });

  it("a dev build has no limit", async () => {
    const { app, headers } = await dev();
    await joinDevice(app, headers, B, { kind: "counter", name: "Two" });
    await joinDevice(app, headers, C, { kind: "kitchen", name: "Pass" });
    await joinDevice(app, headers, D, { kind: "captain", name: "Tablet" });
    expect(app.devices.active().map((d) => d.name).sort()).toEqual(["Main counter", "Pass", "Tablet", "Two"]);
  });

  it("answers every bad code alike", async () => {
    const { app, headers } = await dev();
    const code = await makeCode(app, headers);
    expect((await join(app, code, B)).statusCode).toBe(200);
    for (const bad of ["ZZZZZZ", "x", code]) {
      const res = await join(app, bad, C);
      expect([res.statusCode, res.json()]).toEqual([400, BAD]);
    }
  });

  it("refuses a joined browser, a missing credential and a malformed body", async () => {
    const { app, headers } = await dev();
    const code = await makeCode(app, headers);
    const again = await join(app, code, A);
    expect([again.statusCode, again.json().error]).toEqual([409, "This device has already joined."]);
    const bare = await join(app, code, null);
    expect([bare.statusCode, bare.json().error]).toEqual([400, "A device credential is required"]);
    expect((await app.inject({ method: "POST", url: "/api/devices/join", payload: {}, headers: withDevice(B) })).statusCode).toBe(400);
    expect((await join(app, code, B)).statusCode).toBe(200);
  });

  it("limits join attempts per address", async () => {
    const { app } = await dev();
    for (let i = 0; i < 10; i++) expect((await join(app, "ZZZZZZ", B, LAN)).statusCode).toBe(400);
    const eleventh = await join(app, "ZZZZZZ", B, LAN);
    expect([eleventh.statusCode, eleventh.json().error]).toEqual([429, "Please wait a minute and try again"]);
    expect((await join(app, "ZZZZZZ", B, "192.168.1.21")).statusCode).toBe(400);
  });

  it("replacing a device signs its old browser out", async () => {
    const { app, headers } = await licensed();
    await joinDevice(app, headers, B, { kind: "counter", name: "Second" });
    const oldHeaders = await signIn(app, ADMIN_LOGIN, B);
    expect((await app.inject({ url: "/api/products", headers: oldHeaders })).statusCode).toBe(200);
    const code = await makeCode(app, headers, { replacesDeviceId: app.devices.findByCredential(B)!.id });
    expect((await join(app, code, C)).json()).toEqual({ kind: "counter", name: "Second" });
    expect((await app.inject({ url: "/api/products", headers: oldHeaders })).statusCode).toBe(401);
    expect(app.devices.active()).toHaveLength(2);
    expect(app.devices.findByCredential(C)).toMatchObject({ name: "Second" });
    expect((await app.inject({ url: "/api/products", headers: await signIn(app, ADMIN_LOGIN, C) })).statusCode).toBe(200);
  });

  it("an admin on the main PC re-joins as the main counter without a code", async () => {
    const { app, headers } = await licensed();
    const mainName = app.devices.main()!.name;
    const fresh = await signIn(app, ADMIN_LOGIN, B);
    expect((await app.inject({ url: "/api/products", headers: fresh })).statusCode).toBe(403);
    const rejoined = await rejoin(app, fresh);
    expect([rejoined.statusCode, rejoined.json()]).toEqual([200, { kind: "counter", name: mainName }]);
    expect((await app.inject({ url: "/api/products", headers: fresh })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/products", headers })).statusCode).toBe(401);
    expect(app.devices.active()).toHaveLength(1);
    expect(app.devices.main()).toMatchObject({ credentialHash: deviceHash(B), isMain: true });
    expect(app.devices.events().events[0]).toMatchObject({ kind: "replaced", summary: `Re-joined ${mainName} from the main PC.`, actorName: SETUP.adminName });
  });

  it("refuses the re-join from another address and from a browser that is already a device", async () => {
    const { app, headers } = await licensed();
    const fresh = await signIn(app, ADMIN_LOGIN, B);
    const lan = await rejoin(app, fresh, LAN);
    expect([lan.statusCode, lan.json().error]).toEqual([403, "Re-join the main counter from the main POS PC."]);
    const own = await rejoin(app, headers);
    expect([own.statusCode, own.json().error]).toEqual([409, "This device has already joined."]);
    expect((await rejoin(app, withDevice(B))).statusCode).toBe(401);
    expect(app.devices.main()).toMatchObject({ credentialHash: deviceHash(D) });
    expect((await app.inject({ url: "/api/products", headers })).statusCode).toBe(200);
  });

  it("refuses the re-join for anyone but an administrator", async () => {
    const { app, token } = await dev();
    const cashier = { name: "Ravi", pin: "2345", role: "cashier" as const };
    await createUser(app, token, cashier);
    const res = await rejoin(app, await signIn(app, testLogin(cashier), B));
    expect([res.statusCode, res.json().error]).toEqual([403, "Only an administrator can re-join the main counter."]);
    expect(app.devices.main()).toMatchObject({ credentialHash: deviceHash(A) });
  });

  it("has nothing to re-join when there is no main counter", async () => {
    const app = freshApp(); apps.push(app);
    const admin = await setupAdmin(app);
    const res = await rejoin(app, { ...auth(admin.token), ...withDevice(A) });
    expect([res.statusCode, res.json().error]).toEqual([409, "There is no main counter to re-join."]);
    const bare = await rejoin(app, auth(admin.token));
    expect([bare.statusCode, bare.json().error]).toEqual([400, "A device credential is required"]);
  });
});
