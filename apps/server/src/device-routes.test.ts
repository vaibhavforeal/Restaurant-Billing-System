import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { DeviceInfo } from "@masalapos/domain";
import { SETUP, auth, commercialApp, createUser, freshApp, joinDevice, wsAuth } from "./test-helpers.js";

const A = "a".repeat(64), B = "b".repeat(64);

describe("device list and settings over the API", () => {
  let app: FastifyInstance, adminToken: string, cashierToken: string, printerId: string;
  let admin: Record<string, string>, cashier: Record<string, string>;
  /** A dev build set up from browser A (the main counter), with browser B joined as "Two" and a cashier signed in on it. */
  beforeEach(async () => {
    app = freshApp();
    adminToken = (await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: { "x-masalapos-device": A } })).json().token;
    admin = { ...auth(adminToken), "x-masalapos-device": A };
    await joinDevice(app, admin, B, { kind: "counter", name: "Two" });
    cashierToken = (await createUser(app, adminToken, { name: "Ravi", pin: "4321", role: "cashier" })).token;
    cashier = { ...auth(cashierToken), "x-masalapos-device": B };
    const printer = await app.inject({ method: "POST", url: "/api/printers", headers: admin, payload: { name: "Front", kind: "network", connection: "127.0.0.1:9100", paperWidth: 80 } });
    printerId = printer.json().printer.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });
  const list = async (headers = admin) => (await app.inject({ method: "GET", url: "/api/devices", headers })).json() as { devices: DeviceInfo[]; maxDevices: number | null };
  const two = async () => (await list()).devices.find((d) => d.name === "Two")!;
  const patch = (id: string, payload: object, headers = admin) => app.inject({ method: "PATCH", url: `/api/devices/${id}/settings`, headers, payload });
  const mine = async (headers: Record<string, string>) => (await app.inject({ method: "GET", url: "/api/devices/me/settings", headers })).json();
  const events = (ws: WebSocket, name: string) => {
    const seen: unknown[] = [];
    ws.on("message", (raw: Buffer) => { const frame = JSON.parse(raw.toString()) as { event: string; data: unknown }; if (frame.event === name) seen.push(frame.data); });
    return seen;
  };
  /** Lets frames already sent reach the sockets listening for them. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  it("lists devices with their settings and who is online", async () => {
    const res = await app.inject({ method: "GET", url: "/api/devices", headers: admin });
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.maxDevices).toBeNull();
    expect(body.devices).toMatchObject([
      { name: "Main counter", kind: "counter", isMain: true, current: true, allowed: true, online: false, printerInactive: false, settings: { billPrinterId: null, paymentStart: "last" } },
      { name: "Two", isMain: false, current: false, allowed: true, online: false },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/credential/i);
    await wsAuth(app, cashierToken, B);
    expect((await two()).online).toBe(true);
  });
  it("only an administrator sees the list or changes settings", async () => {
    expect((await app.inject({ method: "GET", url: "/api/devices", headers: cashier })).statusCode).toBe(403);
    const d = await two();
    expect((await patch(d.id, { version: d.version, paymentStart: "cash" }, cashier)).statusCode).toBe(403);
  });
  it("an administrator sets a device's printer and the device reads it", async () => {
    const d = await two();
    const seen = events(await wsAuth(app, cashierToken, B), "devices.changed");
    const res = await patch(d.id, { version: d.version, billPrinterId: printerId, paymentStart: "upi" });
    expect(res.statusCode).toBe(200);
    expect(res.json().device).toMatchObject({ id: d.id, version: d.version + 1, online: true, settings: { billPrinterId: printerId, paymentStart: "upi" } });
    await settle();
    expect(seen).toEqual([{ deviceId: d.id }]);
    expect(await mine(cashier)).toEqual({ deviceId: d.id, version: d.version + 1, settings: { billPrinterId: printerId, paymentStart: "upi" } });
    expect((await mine(admin)).settings.billPrinterId).toBeNull();
    // The old device routes stay until the Devices area replaces them.
    expect((await app.inject({ method: "GET", url: "/api/license/devices", headers: admin })).statusCode).toBe(200);
  });
  it("saving what a device already has tells nobody", async () => {
    const d = await two();
    const seen = events(await wsAuth(app, cashierToken, B), "devices.changed");
    expect((await patch(d.id, { version: d.version, paymentStart: "last" })).json().device.version).toBe(d.version);
    await settle();
    expect(seen).toEqual([]);
  });
  it("refuses a stale version, an unknown printer and unknown keys", async () => {
    const d = await two();
    expect((await patch(d.id, { version: d.version + 5, paymentStart: "cash" })).statusCode).toBe(409);
    const unknown = await patch(d.id, { version: d.version, billPrinterId: "nope" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: "Choose an active printer" });
    expect((await patch(d.id, { version: d.version, theme: "dark" })).statusCode).toBe(400);
    expect((await patch(d.id, { paymentStart: "cash" })).statusCode).toBe(400);
    expect((await patch("not-a-device", { version: 1, paymentStart: "cash" })).statusCode).toBe(400);
    expect((await patch(crypto.randomUUID(), { version: 1, paymentStart: "cash" })).statusCode).toBe(404);
  });
  it("a printer switched off falls back to Browser / A4 and is marked", async () => {
    const d = await two();
    await patch(d.id, { version: d.version, billPrinterId: printerId });
    const seen = events(await wsAuth(app, cashierToken, B), "devices.changed");
    expect((await app.inject({ method: "PATCH", url: `/api/printers/${printerId}`, headers: admin, payload: { isActive: false } })).statusCode).toBe(200);
    await settle();
    expect(seen).toEqual([{}]);
    expect(await two()).toMatchObject({ printerInactive: true, settings: { billPrinterId: printerId } });
    expect((await mine(cashier)).settings.billPrinterId).toBeNull();
    await app.inject({ method: "PATCH", url: `/api/printers/${printerId}`, headers: admin, payload: { name: "Renamed" } });
    await settle();
    expect(seen).toEqual([{}]);   // a rename is not a device change
  });
  it("a browser that is not a device gets the defaults", async () => {
    expect(await mine(auth(adminToken))).toEqual({ deviceId: null, version: null, settings: { billPrinterId: null, paymentStart: "last" } });
    expect((await app.inject({ method: "GET", url: "/api/devices/me/settings" })).statusCode).toBe(401);
  });
  it("a licensed build reports the limit", async () => {
    const { app: licensed, headers } = await commercialApp("basic");   // 2 devices
    try {
      await joinDevice(licensed, headers, B);
      const body = (await licensed.inject({ method: "GET", url: "/api/devices", headers })).json();
      expect(body.maxDevices).toBe(2);
      expect(body.devices.map((d: DeviceInfo) => d.allowed)).toEqual([true, true]);
    } finally { await licensed.close(); licensed.db.close(); }
  });
});
