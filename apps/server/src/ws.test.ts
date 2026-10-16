import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, MIGRATIONS, migrate } from "@forkflow/domain";
import { buildServer } from "./server.js";
import { auth, setupAdmin, wsAuth, createUser } from "./test-helpers.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("WebSocket auth handshake", () => {
  it.each([
    { outletIdentity: "another-outlet", generation: "generation-1" },
    { outletIdentity: "outlet-a", generation: "old-generation" },
    {},
  ])("rejects a stale or absent outlet identity before acknowledging auth or exposing events: %j", async (identity) => {
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    app = buildServer({ db, outletIdentity: "outlet-a", generation: "generation-1" });
    await app.ready(); const admin = await setupAdmin(app);
    const ws = await app.injectWS("/api/ws"), messages: string[] = [];
    const result = new Promise<unknown>(resolve => {
      ws.on("message", (raw: Buffer) => { messages.push(raw.toString()); resolve(JSON.parse(raw.toString())); });
      ws.once("close", (code: number) => resolve({ closed: true, code }));
    });
    ws.send(JSON.stringify({ type: "auth", token: admin.token, ...identity }));
    expect(await result).toEqual({ closed: true, code: 4409 });
    app.broadcast("order.updated", { privateOrder: "must-not-leak" });
    expect(messages).toEqual([]);
    ws.terminate();
  });

  it("authenticates the matching outlet and recovery generation", async () => {
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    app = buildServer({ db, outletIdentity: "outlet-a", generation: "generation-1" });
    await app.ready(); const admin = await setupAdmin(app);
    const ws = await app.injectWS("/api/ws");
    const response = new Promise<string>(resolve => ws.once("message", (raw: Buffer) => resolve(raw.toString())));
    ws.send(JSON.stringify({ type: "auth", token: admin.token, outletIdentity: "outlet-a", generation: "generation-1" }));
    expect(JSON.parse(await response)).toEqual({ event: "auth.ok", data: {} });
    const event = new Promise<string>(resolve => ws.once("message", (raw: Buffer) => resolve(raw.toString())));
    app.broadcast("order.updated", { id: "allowed" });
    expect(JSON.parse(await event)).toEqual({ event: "order.updated", data: { id: "allowed" } });
    ws.terminate();
  });
  it("closes with 4401 when no auth frame is sent within timeout", async () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    app = buildServer({ db, authTimeoutMs: 100 });
    await app.ready();
    await setupAdmin(app);

    const ws = await app.injectWS("/api/ws");

    const result = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("close", (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    expect(result.code).toBe(4401);
    expect(result.reason).toBe("unauthenticated");
  });

  it("closes with 4401 when the first frame is malformed", async () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    app = buildServer({ db });
    await app.ready();
    await setupAdmin(app);

    const ws = await app.injectWS("/api/ws");
    ws.send(JSON.stringify({ type: "wrong", foo: "bar" }));

    const result = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("close", (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    expect(result.code).toBe(4401);
    expect(result.reason).toBe("unauthenticated");
  });

  it("closes with 4401 when the token is invalid", async () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    app = buildServer({ db });
    await app.ready();
    await setupAdmin(app);

    const ws = await app.injectWS("/api/ws");
    ws.send(JSON.stringify({ type: "auth", token: "garbage" }));

    const result = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("close", (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    expect(result.code).toBe(4401);
    expect(result.reason).toBe("unauthenticated");
  });

  it("sends auth.ok and receives broadcasts with a valid token", async () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    app = buildServer({ db });
    await app.ready();
    const admin = await setupAdmin(app);

    const messages: unknown[] = [];
    const ws = await wsAuth(app, admin.token);
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if ((msg as { event?: string }).event !== "auth.ok") {
        messages.push(msg);
      }
    });

    app.broadcast("test.event", { x: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ event: "test.event", data: { x: 1 } });
    ws.terminate();
  });

  it("closes the socket when the user logs out", async () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    app = buildServer({ db });
    await app.ready();
    const admin = await setupAdmin(app);

    const ws = await wsAuth(app, admin.token);
    const closePromise = new Promise<number>((resolve) => {
      ws.on("close", (code: number) => resolve(code));
    });

    await app.inject({ method: "POST", url: "/api/logout", headers: auth(admin.token) });

    const code = await closePromise;
    expect(code).toBe(4401);
  });

  it("closes the socket when the user is deactivated", async () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    app = buildServer({ db });
    await app.ready();
    const admin = await setupAdmin(app);
    const waiter = await createUser(app, admin.token, { name: "Bob", pin: "5678", role: "waiter" });

    const ws = await wsAuth(app, waiter.token);
    const closePromise = new Promise<number>((resolve) => {
      ws.on("close", (code: number) => resolve(code));
    });

    await app.inject({
      method: "PATCH",
      url: `/api/users/${waiter.id}`,
      payload: { isActive: false },
      headers: auth(admin.token),
    });

    const code = await closePromise;
    expect(code).toBe(4401);
  });

  it("leaves valid sockets open when wsRevalidate is called", async () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    app = buildServer({ db });
    await app.ready();
    const admin = await setupAdmin(app);

    const ws = await wsAuth(app, admin.token);
    let closed = false;
    ws.on("close", () => { closed = true; });

    app.wsRevalidate();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(closed).toBe(false);
    ws.terminate();
  });

  it("delivers a broadcast without re-verifying every client's session and license", async () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    app = buildServer({ db });
    await app.ready();
    const admin = await setupAdmin(app);

    const ws = await wsAuth(app, admin.token);
    const message = new Promise<string>((resolve) => ws.once("message", (raw: Buffer) => resolve(raw.toString())));
    const status = vi.spyOn(app.licensing, "status");
    app.broadcast("table.changed", { tableId: "t1" });

    expect(JSON.parse(await message)).toEqual({ event: "table.changed", data: { tableId: "t1" } });
    expect(status).not.toHaveBeenCalled();
    ws.terminate();
  });
});
