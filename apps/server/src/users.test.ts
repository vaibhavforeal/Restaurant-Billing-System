import { afterEach, describe, expect, it } from "vitest";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

describe("users admin", () => {
  it("lists users with their usernames, without exposing PIN or password hashes", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const res = await app.inject({ method: "GET", url: "/api/users", headers: auth(admin.token) });
    expect(res.statusCode).toBe(200);
    const { users } = res.json();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ name: "Asha", username: "admin", role: "admin", isActive: true });
    expect(JSON.stringify(users[0])).not.toContain("hash");
  });

  it("creates a user who can then sign in with their username and password", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const res = await app.inject({
      method: "POST", url: "/api/users",
      payload: { name: "Ravi", username: "Ravi.K", password: "ravi-password", role: "cashier" },
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ name: "Ravi", username: "ravi.k", role: "cashier", isActive: true });

    const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "ravi.k", password: "ravi-password" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.name).toBe("Ravi");
  });

  it("refuses a username already taken, whatever its case, and a short password", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const post = (payload: object) => app.inject({ method: "POST", url: "/api/users", payload, headers: auth(admin.token) });
    const dup = await post({ name: "Other Admin", username: "ADMIN", password: "another-password", role: "waiter" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("Username already in use");
    expect((await post({ name: "Short", username: "short", password: "1234", role: "waiter" })).statusCode).toBe(400);

    const w = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });
    const rename = await app.inject({ method: "PATCH", url: `/api/users/${w.id}`, payload: { username: "admin" }, headers: auth(admin.token) });
    expect(rename.statusCode).toBe(409);
  });

  it("gives only admins an approval PIN, unique among admins", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const post = (payload: object) => app.inject({ method: "POST", url: "/api/users", payload, headers: auth(admin.token) });
    const patch = (id: string, payload: object) => app.inject({ method: "PATCH", url: `/api/users/${id}`, payload, headers: auth(admin.token) });
    // An admin must have one, and not the PIN another admin already uses.
    expect((await post({ name: "Beena", username: "beena", password: "beena-password", role: "admin" })).statusCode).toBe(400);
    const clash = await post({ name: "Beena", username: "beena", password: "beena-password", role: "admin", pin: "1234" });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toBe("Another admin uses this approval PIN");
    // Staff have none, so the same digits are free for them.
    const w = await createUser(app, admin.token, { name: "Wren", pin: "1234", role: "waiter" });
    expect((await patch(w.id, { pin: "4321" })).statusCode).toBe(400);
    // Making someone an admin needs their PIN in the same change.
    expect((await patch(w.id, { role: "admin" })).statusCode).toBe(400);
    expect((await patch(w.id, { role: "admin", pin: "1234" })).statusCode).toBe(409);
    expect((await patch(w.id, { role: "admin", pin: "4321" })).statusCode).toBe(200);
    // An admin re-saving their own PIN is fine.
    expect((await patch(w.id, { pin: "4321" })).statusCode).toBe(200);
  });

  it("keeps a deactivated admin's approval PIN reserved", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const beena = await createUser(app, admin.token, { name: "Beena", pin: "2468", role: "admin" });
    await app.inject({ method: "PATCH", url: `/api/users/${beena.id}`, payload: { isActive: false }, headers: auth(admin.token) });
    const again = await app.inject({ method: "POST", url: "/api/users", payload: { name: "Chitra", username: "chitra", password: "chitra-password", role: "admin", pin: "2468" }, headers: auth(admin.token) });
    expect(again.statusCode).toBe(409);
  });

  it("clears the approval PIN of someone who is no longer an admin", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const beena = await createUser(app, admin.token, { name: "Beena", pin: "2468", role: "admin" });
    expect((await app.inject({ method: "PATCH", url: `/api/users/${beena.id}`, payload: { role: "cashier" }, headers: auth(admin.token) })).statusCode).toBe(200);
    expect(app.db.prepare("SELECT pin_hash FROM users WHERE id = ?").get(beena.id)).toEqual({ pin_hash: "" });
  });

  it("resets a password, signing the person out everywhere while an admin resetting their own stays in", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const w = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });
    const reset = await app.inject({ method: "PATCH", url: `/api/users/${w.id}`, payload: { password: "a-new-password" }, headers: auth(admin.token) });
    expect(reset.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: auth(w.token) })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { username: "wren", password: "password-5678" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { username: "wren", password: "a-new-password" } })).statusCode).toBe(200);

    const own = await app.inject({ method: "PATCH", url: `/api/users/${admin.user.id}`, payload: { password: "admin-password-2" }, headers: auth(admin.token) });
    expect(own.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: auth(admin.token) })).statusCode).toBe(200);
  });

  it("lets only one of several simultaneous requests claim the same new approval PIN", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const beena = await createUser(app, admin.token, { name: "Beena", pin: "2468", role: "admin" });
    const results = await Promise.all([
      app.inject({ method: "POST", url: "/api/users", payload: { name: "Ravi", username: "ravi", password: "ravi-password", pin: "4321", role: "admin" }, headers: auth(admin.token) }),
      app.inject({ method: "POST", url: "/api/users", payload: { name: "Meena", username: "meena", password: "meena-password", pin: "4321", role: "admin" }, headers: auth(admin.token) }),
      app.inject({ method: "PATCH", url: `/api/users/${beena.id}`, payload: { pin: "4321" }, headers: auth(admin.token) }),
    ]);
    expect(results.filter((r) => r.statusCode !== 409)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409).map((r) => r.json().error)).toEqual(["Another admin uses this approval PIN", "Another admin uses this approval PIN"]);
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

  it("keeps one admin when the last two are demoted at the same moment, even when one change also sets a password", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const beena = await createUser(app, admin.token, { name: "Beena", pin: "2468", role: "admin" });
    // The password change makes one request wait on hashing, which is when the other used to slip past the check.
    const results = await Promise.all([
      app.inject({ method: "PATCH", url: `/api/users/${admin.user.id}`, payload: { role: "cashier", password: "a-new-password" }, headers: auth(admin.token) }),
      app.inject({ method: "PATCH", url: `/api/users/${beena.id}`, payload: { role: "cashier" }, headers: auth(admin.token) }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const admins = app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").get() as { n: number };
    expect(admins.n).toBe(1);
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
      payload: { name: "X", username: "xavier", password: "xavier-password", role: "waiter" },
      headers: auth(w.token),
    });
    expect(create.statusCode).toBe(403);
  });
});
