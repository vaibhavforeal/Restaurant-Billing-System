import { MIGRATIONS, migrate, openDb } from "@forkflow/domain";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

function freshApp() {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  return buildServer({ db });
}

const SETUP = { restaurantName: "Cafe Test", adminName: "Asha", pin: "1234" };

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
    expect((await app.inject({ method: "GET", url: "/api/needs-setup" })).json()).toEqual({ needsSetup: true });

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
});

describe("login / me / logout", () => {
  it("full round trip", async () => {
    app = freshApp();
    await setup(app);

    const bad = await app.inject({ method: "POST", url: "/api/login", payload: { pin: "9999" } });
    expect(bad.statusCode).toBe(401);

    const good = await app.inject({ method: "POST", url: "/api/login", payload: { pin: "1234" } });
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
    const { hashPassword } = await import("@forkflow/core");
    const { uuidv7 } = await import("@forkflow/domain");
    app.db
      .prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Wren', ?, 'waiter', ?)")
      .run(uuidv7(), await hashPassword("5678"), Date.now());
    const waiter = (await app.inject({ method: "POST", url: "/api/login", payload: { pin: "5678" } })).json();

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
      const res = await app.inject({ method: "POST", url: "/api/login", payload: { pin: "9999" } });
      expect(res.statusCode).toBe(401);
    }

    // 6th attempt (even with correct PIN) → 429
    const throttled = await app.inject({ method: "POST", url: "/api/login", payload: { pin: "1234" } });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().error).toBe("too many attempts");

    // different IP is unaffected
    const otherIp = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { pin: "1234" },
      remoteAddress: "192.168.1.99",
    });
    expect(otherIp.statusCode).toBe(200);

    // a fresh app instance is unaffected (throttle state is plugin-scoped, not module-scoped)
    const app2 = freshApp();
    try {
      await setup(app2);
      const fresh = await app2.inject({ method: "POST", url: "/api/login", payload: { pin: "1234" } });
      expect(fresh.statusCode).toBe(200);
    } finally {
      await app2.close();
    }
  });
});
