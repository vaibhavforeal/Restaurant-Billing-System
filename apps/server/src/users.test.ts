import { afterEach, describe, expect, it } from "vitest";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

describe("users admin", () => {
  it("lists users without exposing pin hashes", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const res = await app.inject({ method: "GET", url: "/api/users", headers: auth(admin.token) });
    expect(res.statusCode).toBe(200);
    const { users } = res.json();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ name: "Asha", role: "admin", isActive: true });
    expect(JSON.stringify(users[0])).not.toContain("hash");
  });

  it("creates a user who can then log in", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const res = await app.inject({
      method: "POST", url: "/api/users",
      payload: { name: "Ravi", pin: "4321", role: "cashier" },
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ name: "Ravi", role: "cashier", isActive: true });

    const login = await app.inject({ method: "POST", url: "/api/login", payload: { pin: "4321" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.name).toBe("Ravi");
  });

  it("rejects a duplicate PIN at creation with 409 — even against an inactive user", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    // same PIN as the setup admin
    const dup = await app.inject({
      method: "POST", url: "/api/users",
      payload: { name: "Mallory", pin: "1234", role: "waiter" },
      headers: auth(admin.token),
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("PIN already in use");

    // deactivate a user, their PIN stays reserved
    const w = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });
    await app.inject({ method: "PATCH", url: `/api/users/${w.id}`, payload: { isActive: false }, headers: auth(admin.token) });
    const dup2 = await app.inject({
      method: "POST", url: "/api/users",
      payload: { name: "New", pin: "5678", role: "waiter" },
      headers: auth(admin.token),
    });
    expect(dup2.statusCode).toBe(409);
  });

  it("changes a PIN (uniqueness enforced, self excluded) and the new PIN logs in", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const w = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });

    // taking the admin's PIN is refused
    const clash = await app.inject({ method: "PATCH", url: `/api/users/${w.id}`, payload: { pin: "1234" }, headers: auth(admin.token) });
    expect(clash.statusCode).toBe(409);

    // re-submitting your own current PIN is fine (self excluded from the scan)
    const same = await app.inject({ method: "PATCH", url: `/api/users/${w.id}`, payload: { pin: "5678" }, headers: auth(admin.token) });
    expect(same.statusCode).toBe(200);

    const changed = await app.inject({ method: "PATCH", url: `/api/users/${w.id}`, payload: { pin: "9999" }, headers: auth(admin.token) });
    expect(changed.statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { pin: "9999" } });
    expect(login.statusCode).toBe(200);
  });

  it("refuses to deactivate or demote the last active admin", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const deact = await app.inject({ method: "PATCH", url: `/api/users/${admin.user.id}`, payload: { isActive: false }, headers: auth(admin.token) });
    expect(deact.statusCode).toBe(409);
    expect(deact.json().error).toBe("cannot remove the last admin");

    const demote = await app.inject({ method: "PATCH", url: `/api/users/${admin.user.id}`, payload: { role: "cashier" }, headers: auth(admin.token) });
    expect(demote.statusCode).toBe(409);

    // with a second admin present, demoting the first is allowed
    await createUser(app, admin.token, { name: "Beena", pin: "2468", role: "admin" });
    const now = await app.inject({ method: "PATCH", url: `/api/users/${admin.user.id}`, payload: { role: "cashier" }, headers: auth(admin.token) });
    expect(now.statusCode).toBe(200);
  });

  it("deactivating a user invalidates their existing session", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const w = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });

    const meBefore = await app.inject({ method: "GET", url: "/api/me", headers: auth(w.token) });
    expect(meBefore.statusCode).toBe(200);

    await app.inject({ method: "PATCH", url: `/api/users/${w.id}`, payload: { isActive: false }, headers: auth(admin.token) });
    const meAfter = await app.inject({ method: "GET", url: "/api/me", headers: auth(w.token) });
    expect(meAfter.statusCode).toBe(401);
  });

  it("404s on an unknown user and 403s non-admins", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const missing = await app.inject({ method: "PATCH", url: "/api/users/nope", payload: { name: "X" }, headers: auth(admin.token) });
    expect(missing.statusCode).toBe(404);

    const w = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });
    const list = await app.inject({ method: "GET", url: "/api/users", headers: auth(w.token) });
    expect(list.statusCode).toBe(403);
    const create = await app.inject({
      method: "POST", url: "/api/users",
      payload: { name: "X", pin: "1111", role: "waiter" },
      headers: auth(w.token),
    });
    expect(create.statusCode).toBe(403);
  });
});
