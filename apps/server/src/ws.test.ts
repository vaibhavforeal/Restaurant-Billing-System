import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, MIGRATIONS, migrate } from "@masalapos/domain";
import { buildServer } from "./server.js";
import { auth, setupAdmin, wsAuth, createUser } from "./test-helpers.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("WebSocket auth handshake", () => {
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

describe("WebSocket broadcasts respect the recipient's permissions", () => {
  const order = { id: "o1", status: "open", customer: { id: "c1", name: "Priya", phone: "9876543210", email: "priya@example.com", birthDate: "1990-04-01" } };

  async function collect(ws: import("@fastify/websocket").WebSocket) {
    const messages: Array<{ event: string; data: { order?: { customer: unknown } } }> = [];
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event !== "auth.ok") messages.push(msg);
    });
    return messages;
  }

  it("leaves customer contact details out of orders sent to people who cannot view customers", async () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    app = buildServer({ db });
    await app.ready();
    const admin = await setupAdmin(app);
    const kitchen = await createUser(app, admin.token, { name: "Kiran", pin: "5678", role: "kitchen" });

    const adminWs = await wsAuth(app, admin.token);
    const kitchenWs = await wsAuth(app, kitchen.token);
    const toAdmin = await collect(adminWs);
    const toKitchen = await collect(kitchenWs);

    app.broadcast("order.updated", { order });
    app.broadcast("table.changed", { tableId: "t1" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(toAdmin).toEqual([{ event: "order.updated", data: { order } }, { event: "table.changed", data: { tableId: "t1" } }]);
    expect(toKitchen).toEqual([{ event: "order.updated", data: { order: { ...order, customer: null } } }, { event: "table.changed", data: { tableId: "t1" } }]);
    expect(JSON.stringify(toKitchen)).not.toContain("9876543210");
    adminWs.terminate();
    kitchenWs.terminate();
  });

  it("follows a person's permission changes on an open socket", async () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    app = buildServer({ db });
    await app.ready();
    const admin = await setupAdmin(app);
    const waiter = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });

    const ws = await wsAuth(app, waiter.token);
    const messages = await collect(ws);
    const revoke = await app.inject({ method: "PUT", url: `/api/users/${waiter.id}/permissions`, payload: { overrides: { "customers.read": false } }, headers: auth(admin.token) });
    expect(revoke.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    messages.length = 0;

    app.broadcast("order.updated", { order });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages).toEqual([{ event: "order.updated", data: { order: { ...order, customer: null } } }]);
    ws.terminate();
  });
});
