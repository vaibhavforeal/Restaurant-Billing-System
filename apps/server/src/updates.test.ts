import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MIGRATIONS, migrate, openDb, uuidv7, type ToDesktop, type UpdateStatus } from "@masalapos/domain";
import { buildServer } from "./server.js";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

/** Stands in for the Electron shell's message port. */
function fakeShell() {
  const sent: ToDesktop[] = [];
  let listener: (message: unknown) => void = () => {};
  return {
    sent,
    bridge: { send: (message: ToDesktop) => sent.push(message), onMessage: (fn: (message: unknown) => void) => { listener = fn; } },
    report: (status: Partial<UpdateStatus>) => listener({ type: "update-status", status: { currentVersion: "0.7.0", availableVersion: null, percent: null, checkedAt: null, message: null, ...status } }),
  };
}

describe("desktop updates", () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); app.db.close(); });
  async function withShell() {
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    const shell = fakeShell();
    app = buildServer({ db, updateBridge: shell.bridge, appVersion: "0.7.0" });
    await app.ready();
    const { token } = await setupAdmin(app);
    return { shell, token };
  }
  const call = (method: "GET" | "PUT" | "POST", url: string, token: string, payload?: object) =>
    app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });

  it("tells the shell the saved channel at start and when the admin changes it", async () => {
    const { shell, token } = await withShell();
    expect(shell.sent).toEqual([{ type: "update-config", channel: "stable" }]);
    const changed = await call("PUT", "/api/system/updates", token, { channel: "patch" });
    expect(changed.json().channel).toBe("patch");
    expect(shell.sent.at(-1)).toEqual({ type: "update-config", channel: "patch" });
    expect((await call("PUT", "/api/system/updates", token, { channel: "beta" })).statusCode).toBe(400);
  });

  it("shows the shell's status and asks it to check", async () => {
    const { shell, token } = await withShell();
    shell.report({ state: "downloading", availableVersion: "0.7.1", percent: 42 });
    expect((await call("GET", "/api/system/updates", token)).json().status).toMatchObject({ state: "downloading", availableVersion: "0.7.1", percent: 42 });
    expect((await call("POST", "/api/system/updates/check", token)).statusCode).toBe(202);
    expect(shell.sent.at(-1)).toEqual({ type: "update-check" });
    shell.report({ state: "nonsense" as UpdateStatus["state"] });
    shell.report({} as UpdateStatus); // ignored: not an update-status message shape
  });

  it("installs only a downloaded update, and never while orders are open or unpaid", async () => {
    const { shell, token } = await withShell();
    expect((await call("POST", "/api/system/updates/install", token)).statusCode).toBe(409);
    shell.report({ state: "ready", availableVersion: "0.7.1" });
    const order = (await call("POST", "/api/orders", token, { clientRef: uuidv7(), type: "parcel" })).json().order;
    const blocked = await call("POST", "/api/system/updates/install", token);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "orders_open" });
    expect(shell.sent.some((m) => m.type === "update-install")).toBe(false);
    await call("POST", `/api/orders/${order.id}/cancel`, token, {});
    expect((await call("POST", "/api/system/updates/install", token)).statusCode).toBe(202);
    expect(shell.sent.at(-1)).toEqual({ type: "update-install" });
  });

  it("is admin only, and reports unsupported without the desktop app", async () => {
    app = freshApp();
    const { token } = await setupAdmin(app);
    const state = (await call("GET", "/api/system/updates", token)).json();
    expect(state.status).toMatchObject({ state: "unsupported", currentVersion: "development" });
    expect((await call("POST", "/api/system/updates/check", token)).statusCode).toBe(409);
    const cashier = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
    expect((await call("GET", "/api/system/updates", cashier.token)).statusCode).toBe(403);
  });
});
