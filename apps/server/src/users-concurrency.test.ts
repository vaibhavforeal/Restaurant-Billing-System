import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "@forkflow/core";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

// Delay only the async password boundary; real salted hashes, verification,
// API handlers, sessions and SQLite writes still run in every scenario.
const passwordWork = vi.hoisted(() => ({ before: undefined as ((kind: "hash" | "verify", pin: string) => Promise<void>) | undefined }));
vi.mock("@forkflow/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@forkflow/core")>();
  return {
    ...actual,
    hashPassword: async (pin: string) => {
      await passwordWork.before?.("hash", pin);
      return actual.hashPassword(pin);
    },
    verifyPassword: async (pin: string, hash: string) => {
      await passwordWork.before?.("verify", pin);
      return actual.verifyPassword(pin, hash);
    },
  };
});

const releases: Array<() => void> = [];
function deferPassword(kind: "hash" | "verify", pin: string) {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let waiting = true;
  passwordWork.before = async (nextKind, nextPin) => {
    if (waiting && nextKind === kind && nextPin === pin) {
      waiting = false;
      entered();
      await released;
    }
  };
  releases.push(release);
  return { started, release };
}

// Let the second injected request pass its synchronous hooks/handler before
// releasing the first request. No wall-clock sleeps or hashing-speed guesses.
const requestTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function observeQueuedAuthorization() {
  let reached!: () => void;
  const authorized = new Promise<void>((resolve) => { reached = resolve; });
  const assertAccess = app.licensing.assertAccess.bind(app.licensing);
  vi.spyOn(app.licensing, "assertAccess").mockImplementation((req) => {
    assertAccess(req);
    if (req.headers["x-test-queued"]) reached();
  });
  return async () => { await authorized; await requestTurn(); };
}

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  passwordWork.before = undefined;
  vi.restoreAllMocks();
  await app?.close();
  app?.db.close();
});

describe("concurrent staff mutations", () => {
  it("creates only one user for concurrent requests with the same unused PIN", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const results = await Promise.all([
      app.inject({ method: "POST", url: "/api/users", headers: auth(admin.token), payload: { name: "Cashier", pin: "8765", role: "cashier" } }),
      app.inject({ method: "POST", url: "/api/users", headers: auth(admin.token), payload: { name: "Waiter", pin: "8765", role: "waiter" } }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 2 });
    const winner = results.find((r) => r.statusCode === 201)!.json().user;
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { pin: "8765" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.id).toBe(winner.id);
  });

  it("keeps one active admin when both admins concurrently demote themselves and change PINs", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const second = await createUser(app, admin.token, { name: "Second", pin: "2468", role: "admin" });
    const results = await Promise.all([
      app.inject({ method: "PATCH", url: `/api/users/${admin.user.id}`, headers: auth(admin.token), payload: { role: "cashier", pin: "9876" } }),
      app.inject({ method: "PATCH", url: `/api/users/${second.id}`, headers: auth(second.token), payload: { role: "cashier", pin: "6789" } }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").get()).toEqual({ n: 1 });
  });

  it.each([
    ["POST", "POST"], ["PATCH", "PATCH"], ["POST", "PATCH"], ["PATCH", "POST"],
  ] as const)("reserves a PIN across overlapping %s/%s mutations", async (firstMethod, secondMethod) => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const firstUser = await createUser(app, admin.token, { name: "First", pin: "2468", role: "waiter" });
    const secondUser = await createUser(app, admin.token, { name: "Second", pin: "5678", role: "waiter" });
    const gate = deferPassword("hash", "8765");
    const first = app.inject({ method: firstMethod, url: firstMethod === "POST" ? "/api/users" : `/api/users/${firstUser.id}`,
      headers: auth(admin.token), payload: { name: "First changed", pin: "8765", role: "cashier" } }).then((r) => r);
    await gate.started;
    expect(app.db.inTransaction).toBe(false);
    const queuedAuthorized = observeQueuedAuthorization();
    const second = app.inject({ method: secondMethod, url: secondMethod === "POST" ? "/api/users" : `/api/users/${secondUser.id}`,
      headers: { ...auth(admin.token), "x-test-queued": "1" }, payload: { name: "Second changed", pin: "8765", role: "cashier" } }).then((r) => r);
    await queuedAuthorized();
    gate.release();
    const [accepted, rejected] = await Promise.all([first, second]);
    expect(accepted.statusCode).toBe(firstMethod === "POST" ? 201 : 200);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toEqual({ error: "PIN already in use" });
    const rows = app.db.prepare("SELECT pin_hash FROM users").all() as Array<{ pin_hash: string }>;
    const matches = await Promise.all(rows.map((row) => verifyPassword("8765", row.pin_hash)));
    expect(matches.filter(Boolean)).toHaveLength(1);
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { pin: "8765" } });
    expect(login.json().user.id).toBe(accepted.json().user.id);
  });

  it("keeps an active admin during overlapping deactivations with PIN edits", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const second = await createUser(app, admin.token, { name: "Second", pin: "2468", role: "admin" });
    const gate = deferPassword("verify", "9876");
    const first = app.inject({ method: "PATCH", url: `/api/users/${admin.user.id}`, headers: auth(admin.token),
      payload: { isActive: false, pin: "9876" } }).then((r) => r);
    await gate.started;
    expect(app.db.inTransaction).toBe(false);
    const queuedAuthorized = observeQueuedAuthorization();
    const queued = app.inject({ method: "PATCH", url: `/api/users/${second.id}`, headers: { ...auth(second.token), "x-test-queued": "1" },
      payload: { isActive: false, pin: "6789" } }).then((r) => r);
    await queuedAuthorized();
    gate.release();
    const results = await Promise.all([first, queued]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 409]);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").get()).toEqual({ n: 1 });
  });

  it("preserves a queued name edit and the preceding role/PIN edit", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const target = await createUser(app, admin.token, { name: "Original", pin: "2468", role: "waiter" });
    const gate = deferPassword("hash", "8765");
    const first = app.inject({ method: "PATCH", url: `/api/users/${target.id}`, headers: auth(admin.token),
      payload: { role: "cashier", pin: "8765" } }).then((r) => r);
    await gate.started;
    const queuedAuthorized = observeQueuedAuthorization();
    const queued = app.inject({ method: "PATCH", url: `/api/users/${target.id}`, headers: { ...auth(admin.token), "x-test-queued": "1" },
      payload: { name: "Current name" } }).then((r) => r);
    await queuedAuthorized();
    gate.release();
    const results = await Promise.all([first, queued]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const row = app.db.prepare("SELECT * FROM users WHERE id = ?").get(target.id) as { name: string; role: string; pin_hash: string };
    expect(row).toMatchObject({ name: "Current name", role: "cashier" });
    expect(await verifyPassword("8765", row.pin_hash)).toBe(true);
  });

  it.each([
    [{ role: "cashier" }, 403, { error: "forbidden", permission: "users.manage" }],
    [{ isActive: false }, 401, { error: "unauthenticated" }],
  ])("rechecks a queued writer after their authority changes: %j", async (change, status, body) => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const actor = await createUser(app, admin.token, { name: "Second admin", pin: "2468", role: "admin" });
    const gate = deferPassword("hash", "8765");
    const first = app.inject({ method: "PATCH", url: `/api/users/${actor.id}`, headers: auth(admin.token),
      payload: { ...change, pin: "8765" } }).then((r) => r);
    await gate.started;
    const queuedAuthorized = observeQueuedAuthorization();
    const queued = app.inject({ method: "POST", url: "/api/users", headers: { ...auth(actor.token), "x-test-queued": "1" },
      payload: { name: "Unauthorized", pin: "9876", role: "waiter" } }).then((r) => r);
    await queuedAuthorized();
    gate.release();
    expect((await first).statusCode).toBe(200);
    const rejected = await queued;
    expect(rejected.statusCode).toBe(status);
    expect(rejected.json()).toEqual(body);
    expect(app.db.prepare("SELECT id FROM users WHERE name = 'Unauthorized'").get()).toBeUndefined();
  });

  it("rechecks a queued writer after logout while allowing other routes to run", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const actor = await createUser(app, admin.token, { name: "Second admin", pin: "2468", role: "admin" });
    const gate = deferPassword("verify", "8765");
    const first = app.inject({ method: "POST", url: "/api/users", headers: auth(admin.token),
      payload: { name: "Allowed", pin: "8765", role: "waiter" } }).then((r) => r);
    await gate.started;
    const queuedAuthorized = observeQueuedAuthorization();
    const queued = app.inject({ method: "PATCH", url: `/api/users/${admin.user.id}`, headers: { ...auth(actor.token), "x-test-queued": "1" },
      payload: { name: "Unauthorized" } }).then((r) => r);
    await queuedAuthorized();
    expect((await app.inject({ method: "POST", url: "/api/logout", headers: auth(actor.token) })).statusCode).toBe(204);
    gate.release();
    expect((await first).statusCode).toBe(201);
    const rejected = await queued;
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: "unauthenticated" });
    expect(app.db.prepare("SELECT name FROM users WHERE id = ?").get(admin.user.id)).toEqual({ name: "Asha" });
  });

  it.each(["POST", "PATCH"] as const)("rechecks %s authority immediately after hashing", async (method) => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const target = await createUser(app, admin.token, { name: "Original", pin: "2468", role: "waiter" });
    const gate = deferPassword("hash", "8765");
    const pending = app.inject({ method, url: method === "POST" ? "/api/users" : `/api/users/${target.id}`, headers: auth(admin.token),
      payload: { name: "Unauthorized", role: "cashier", pin: "8765" } }).then((r) => r);
    await gate.started;
    expect(app.db.inTransaction).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/logout", headers: auth(admin.token) })).statusCode).toBe(204);
    gate.release();
    const rejected = await pending;
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: "unauthenticated" });
    expect(app.db.prepare("SELECT id FROM users WHERE name = 'Unauthorized'").get()).toBeUndefined();
  });

  it("reads omitted target fields again after asynchronous PIN work", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const target = await createUser(app, admin.token, { name: "Original", pin: "2468", role: "waiter" });
    const gate = deferPassword("hash", "8765");
    const pending = app.inject({ method: "PATCH", url: `/api/users/${target.id}`, headers: auth(admin.token), payload: { pin: "8765" } }).then((r) => r);
    await gate.started;
    app.db.prepare("UPDATE users SET name = 'Fresh', role = 'cashier', is_active = 0 WHERE id = ?").run(target.id);
    gate.release();
    const updated = await pending;
    expect(updated.statusCode).toBe(200);
    expect(updated.json().user).toMatchObject({ name: "Fresh", role: "cashier", isActive: false });
  });

  it("rechecks the active-admin invariant after asynchronous PIN work", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const second = await createUser(app, admin.token, { name: "Second", pin: "2468", role: "admin" });
    const gate = deferPassword("hash", "8765");
    const pending = app.inject({ method: "PATCH", url: `/api/users/${admin.user.id}`, headers: auth(admin.token),
      payload: { role: "cashier", pin: "8765" } }).then((r) => r);
    await gate.started;
    app.db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(second.id);
    gate.release();
    const rejected = await pending;
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toEqual({ error: "cannot remove the last admin" });
  });

  it("continues queued work after a rejected mutation", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const gate = deferPassword("verify", "1234");
    const duplicate = app.inject({ method: "POST", url: "/api/users", headers: auth(admin.token),
      payload: { name: "Duplicate", pin: "1234", role: "waiter" } }).then((r) => r);
    await gate.started;
    const queuedAuthorized = observeQueuedAuthorization();
    const queued = app.inject({ method: "POST", url: "/api/users", headers: { ...auth(admin.token), "x-test-queued": "1" },
      payload: { name: "Allowed", pin: "8765", role: "cashier" } }).then((r) => r);
    await queuedAuthorized();
    gate.release();
    expect((await duplicate).statusCode).toBe(409);
    expect((await queued).statusCode).toBe(201);
    expect(app.db.prepare("SELECT name FROM users WHERE name != 'Asha'").all()).toEqual([{ name: "Allowed" }]);
  });

  it("does not block another app instance behind password work", async () => {
    app = freshApp();
    const other = freshApp();
    try {
      const admin = await setupAdmin(app);
      const otherAdmin = await setupAdmin(other);
      const gate = deferPassword("hash", "8765");
      const pending = app.inject({ method: "POST", url: "/api/users", headers: auth(admin.token),
        payload: { name: "First app", pin: "8765", role: "waiter" } }).then((r) => r);
      await gate.started;
      const independent = await other.inject({ method: "POST", url: "/api/users", headers: auth(otherAdmin.token),
        payload: { name: "Other app", pin: "8765", role: "waiter" } });
      expect(independent.statusCode).toBe(201);
      gate.release();
      expect((await pending).statusCode).toBe(201);
    } finally {
      await other.close();
      other.db.close();
    }
  });
});

describe("setup concurrency", () => {
  it("keeps setup's first-user protection across overlapping hashes", async () => {
    app = freshApp();
    const gate = deferPassword("hash", "1234");
    const first = app.inject({ method: "POST", url: "/api/setup", payload: { restaurantName: "Cafe", adminName: "First", pin: "1234" } }).then((r) => r);
    await gate.started;
    const second = await app.inject({ method: "POST", url: "/api/setup", payload: { restaurantName: "Cafe", adminName: "Second", pin: "2468" } });
    gate.release();
    expect(second.statusCode).toBe(201);
    expect((await first).statusCode).toBe(409);
    expect(app.db.prepare("SELECT name, role FROM users").all()).toEqual([{ name: "Second", role: "admin" }]);
  });
});
