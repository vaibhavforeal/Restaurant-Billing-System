import { MIGRATIONS, migrate, openDb } from "@masalapos/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";
import { ADMIN_LOGIN, SETUP } from "./test-helpers.js";

const WRONG = { ...ADMIN_LOGIN, password: "wrong-password" };

function freshApp() {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  return buildServer({ db });
}

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

async function setup(a: typeof app) {
  const res = await a.inject({ method: "POST", url: "/api/setup", payload: SETUP });
  return res.json() as { token: string; user: { id: string; name: string; role: string } };
}

describe("first-run setup", () => {
  it("needs-setup flips after setup creates the admin", async () => {
    app = freshApp();
    expect((await app.inject({ method: "GET", url: "/api/needs-setup" })).json()).toEqual({ needsSetup: true, activation: "none", licensed: true });

    const res = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.role).toBe("admin");

    expect((await app.inject({ method: "GET", url: "/api/needs-setup" })).json()).toEqual({ needsSetup: false });
  });

  it("rejects a second setup", async () => {
    app = freshApp();
    await setup(app);
    const again = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP });
    expect(again.statusCode).toBe(409);
  });

  it("rejects a malformed PIN", async () => {
    app = freshApp();
    const res = await app.inject({ method: "POST", url: "/api/setup", payload: { ...SETUP, pin: "12" } });
    expect(res.statusCode).toBe(400);
  });

  it("stores the restaurant's details with the cleaned phone and uppercased GSTIN", async () => {
    app = freshApp();
    const res = await app.inject({ method: "POST", url: "/api/setup", payload: { ...SETUP, phone: "+91 98450-12345", gstin: "29abcde1234f1z5", fssai: "12345678901234" } });
    expect(res.statusCode).toBe(201);
    expect(app.db.prepare("SELECT restaurant_name, address, city, state_code, pincode, phone, gstin, fssai, setup_complete FROM settings WHERE id = 1").get()).toEqual({
      restaurant_name: "Cafe Test", address: "12 MG Road", city: "Bengaluru", state_code: "29", pincode: "560001",
      phone: "9845012345", gstin: "29ABCDE1234F1Z5", fssai: "12345678901234", setup_complete: 1,
    });
  });

  it.each([
    ["no address", { address: "" }], ["no city", { city: "" }], ["no phone", { phone: "" }], ["a bad PIN code", { pincode: "12" }],
    ["an unknown state", { stateCode: "99" }], ["a malformed GSTIN", { gstin: "29ABC" }], ["a GSTIN from another state", { gstin: "27ABCDE1234F1Z5" }],
  ])("refuses setup with %s and creates no admin", async (_, change) => {
    app = freshApp();
    const res = await app.inject({ method: "POST", url: "/api/setup", payload: { ...SETUP, ...change } });
    expect(res.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/needs-setup" })).json().needsSetup).toBe(true);
  });
});

describe("login / me / logout", () => {
  it("full round trip", async () => {
    app = freshApp();
    await setup(app);

    const bad = await app.inject({ method: "POST", url: "/api/login", payload: WRONG });
    expect(bad.statusCode).toBe(401);

    const good = await app.inject({ method: "POST", url: "/api/login", payload: ADMIN_LOGIN });
    expect(good.statusCode).toBe(200);
    const { token, user } = good.json();
    expect(user.name).toBe("Asha");

    const me = await app.inject({
      method: "GET", url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(user.id);

    const out = await app.inject({
      method: "POST", url: "/api/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.statusCode).toBe(204);

    const meAfter = await app.inject({
      method: "GET", url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meAfter.statusCode).toBe(401);
  });

  it("rejects missing/garbage tokens", async () => {
    app = freshApp();
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/me", headers: { authorization: "Bearer nope" } })).statusCode,
    ).toBe(401);
  });

  it("rejects expired session", async () => {
    app = freshApp();
    const { token, user } = await setup(app);

    // backdoor: expire the session
    app.db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(Date.now() - 1000, token);

    const me = await app.inject({
      method: "GET", url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it("rejects inactive user", async () => {
    app = freshApp();
    const { token, user } = await setup(app);

    // backdoor: deactivate the user
    app.db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(user.id);

    const me = await app.inject({
      method: "GET", url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it("logout works with empty body and application/json content-type", async () => {
    app = freshApp();
    const { token } = await setup(app);

    // browsers may send content-type: application/json on bodyless POSTs
    // (no payload at all — vanilla Fastify 400s this with FST_ERR_CTP_EMPTY_JSON_BODY)
    const out = await app.inject({
      method: "POST", url: "/api/logout",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    expect(out.statusCode).toBe(204);

    // session must actually be deleted
    const meAfter = await app.inject({
      method: "GET", url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meAfter.statusCode).toBe(401);
  });
});

describe("requirePermission", () => {
  it("admin passes, waiter is 403", async () => {
    app = freshApp();
    // a scratch admin-gated route, registered before ready()
    app.get("/api/_test-admin", { preHandler: app.requirePermission("users.manage") }, async () => ({ ok: true }));

    const admin = await setup(app);

    // create a waiter directly in the DB (user CRUD endpoints arrive in Milestone 2)
    const { hashPassword } = await import("@masalapos/core");
    const { uuidv7 } = await import("@masalapos/domain");
    app.db
      .prepare("INSERT INTO users (id, name, username, password_hash, pin_hash, role, created_at) VALUES (?, 'Wren', 'wren', ?, '', 'waiter', ?)")
      .run(uuidv7(), await hashPassword("wren-password"), Date.now());
    const waiter = (await app.inject({ method: "POST", url: "/api/login", payload: { username: "wren", password: "wren-password" } })).json();

    const okRes = await app.inject({
      method: "GET", url: "/api/_test-admin",
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(okRes.statusCode).toBe(200);

    const forbidden = await app.inject({
      method: "GET", url: "/api/_test-admin",
      headers: { authorization: `Bearer ${waiter.token}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe("username and password sign-in", () => {
  it("matches the username whatever its case and refuses the approval PIN as a password", async () => {
    app = freshApp();
    await setup(app);
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { username: " ADMIN ", password: SETUP.password } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { ...ADMIN_LOGIN, password: SETUP.pin } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { pin: SETUP.pin } })).statusCode).toBe(400);
  });

  it("answers an unknown username exactly like a wrong password", async () => {
    app = freshApp();
    await setup(app);
    const unknown = await app.inject({ method: "POST", url: "/api/login", payload: { username: "nobody", password: SETUP.password } });
    const wrong = await app.inject({ method: "POST", url: "/api/login", payload: WRONG });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it("does not sign in someone without a password, or someone deactivated", async () => {
    app = freshApp();
    await setup(app);
    const { hashPassword } = await import("@masalapos/core");
    const insert = app.db.prepare("INSERT INTO users (id, name, username, password_hash, pin_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, '', 'cashier', ?, ?)");
    insert.run("u1", "No password", "nopass", "", 1, Date.now());
    insert.run("u2", "Gone", "gone", await hashPassword("gone-password"), 0, Date.now());
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { username: "nopass", password: "anything-at-all" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { username: "gone", password: "gone-password" } })).statusCode).toBe(401);
  });

  it("refuses setup with a short password or a bad username", async () => {
    app = freshApp();
    expect((await app.inject({ method: "POST", url: "/api/setup", payload: { ...SETUP, password: "short" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/setup", payload: { ...SETUP, username: "a b" } })).statusCode).toBe(400);
  });
});

describe("error handling", () => {
  it("hides 500 error messages from clients", async () => {
    app = freshApp();
    // register a scratch route that throws
    app.get("/api/_test-error", async () => {
      throw new Error("sensitive internal details");
    });

    const res = await app.inject({ method: "GET", url: "/api/_test-error" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal error" });
  });
});

describe("login throttling", () => {
  it("throttles after 5 consecutive failures", async () => {
    app = freshApp();
    await setup(app);

    // 5 wrong PINs from same IP
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "POST", url: "/api/login", payload: WRONG });
      expect(res.statusCode).toBe(401);
    }

    // 6th attempt (even with correct PIN) → 429
    const throttled = await app.inject({ method: "POST", url: "/api/login", payload: ADMIN_LOGIN });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().error).toMatch(/Too many attempts/);

    // different IP is unaffected
    const otherIp = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: ADMIN_LOGIN,
      remoteAddress: "192.168.1.99",
    });
    expect(otherIp.statusCode).toBe(200);

    // a fresh app instance is unaffected (throttle state is plugin-scoped, not module-scoped)
    const app2 = freshApp();
    try {
      await setup(app2);
      const fresh = await app2.inject({ method: "POST", url: "/api/login", payload: ADMIN_LOGIN });
      expect(fresh.statusCode).toBe(200);
    } finally {
      await app2.close();
    }
  });

  it("counts wrong PINs sent in parallel before they are verified, so a burst cannot slip past the cooldown", async () => {
    app = freshApp();
    await setup(app);
    const login = (password: string) => app.inject({ method: "POST", url: "/api/login", payload: { ...ADMIN_LOGIN, password } });

    const burst = await Promise.all(Array.from({ length: 6 }, () => login("wrong-password")));
    const codes = burst.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(5);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
    expect((await login(SETUP.password)).statusCode).toBe(429);

    // once the cooldown is over the right PIN signs in again
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      const ok = await login(SETUP.password);
      expect(ok.statusCode, ok.body).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
