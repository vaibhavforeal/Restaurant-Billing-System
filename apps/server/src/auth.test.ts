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
