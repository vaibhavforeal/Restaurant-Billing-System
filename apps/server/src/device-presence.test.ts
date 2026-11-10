import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { WebSocket as Client } from "ws";
import { DevicePresence } from "./device-presence.js";
import { ADMIN_LOGIN, SETUP, auth, freshApp, wsAuth } from "./test-helpers.js";

const A = "a".repeat(64);

describe("device presence", () => {
  it("is online from the first socket to the last", () => {
    const seen: Array<[string, boolean]> = [];
    const p = new DevicePresence((id, online) => seen.push([id, online]));
    expect(p.online("a")).toBe(false);
    p.open("a"); p.open("a"); p.open("b");
    expect(p.online("a")).toBe(true);
    p.close("a");
    expect(p.online("a")).toBe(true);
    p.close("a"); p.close("a");
    expect(p.online("a")).toBe(false);
    expect(seen).toEqual([["a", true], ["b", true], ["a", false]]);
  });
});

describe("device presence on the hub", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => { for (const app of apps.splice(0)) { await app.close(); app.db.close(); } });
  /** A dev build set up from browser A, which is its main counter. */
  const dev = async () => {
    const app = freshApp(); apps.push(app);
    const setup = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: { "x-masalapos-device": A } });
    const token = setup.json().token as string;
    return { app, token, headers: { ...auth(token), "x-masalapos-device": A } };
  };
  const events = (ws: WebSocket, name: string) => {
    const seen: Array<{ deviceId: string; online: boolean }> = [];
    ws.on("message", (raw: Buffer) => { const frame = JSON.parse(raw.toString()) as { event: string; data: { deviceId: string; online: boolean } }; if (frame.event === name) seen.push(frame.data); });
    return seen;
  };
  const closed = (ws: WebSocket) => new Promise<void>((resolve) => { if (ws.readyState === ws.CLOSED) resolve(); else ws.on("close", () => resolve()); });
  /**
   * A signed-in socket over the network, as a browser opens one. The in-process sockets of `wsAuth` never tell the hub
   * that the browser closed them, so closing from the browser's side is tested over a real connection.
   */
  const browserSocket = async (app: FastifyInstance, token: string, device: string) => {
    if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    return new Promise<Client>((resolve, reject) => {
      const ws = new Client(`ws://127.0.0.1:${port}/api/ws`);
      ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token, device })));
      ws.on("message", (raw: Buffer) => { if ((JSON.parse(raw.toString()) as { event: string }).event === "auth.ok") resolve(ws); });
      ws.on("error", reject);
    });
  };
  const hungUp = async (ws: Client) => { await new Promise<void>((resolve) => { ws.on("close", () => resolve()); ws.close(); }); await settle(); };
  /** Lets frames already sent reach the sockets listening for them. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  it("a device is online while it has a socket", async () => {
    const { app, token } = await dev();
    const main = app.devices.main()!;
    const seen = events(await wsAuth(app, token), "devices.presence");   // no device: counts for nobody
    expect(app.deviceOnline(main.id)).toBe(false);
    const one = await browserSocket(app, token, A), two = await browserSocket(app, token, A);
    expect(app.deviceOnline(main.id)).toBe(true);
    await hungUp(one);
    expect(app.deviceOnline(main.id)).toBe(true);
    await hungUp(two);
    expect(app.deviceOnline(main.id)).toBe(false);
    expect(seen).toEqual([{ deviceId: main.id, online: true }, { deviceId: main.id, online: false }]);
    expect(app.devices.main()!.lastSeenAt).not.toBeNull();
  });
  it("signing out takes the device offline once", async () => {
    const { app, token, headers } = await dev();
    const main = app.devices.main()!;
    const watcherToken = (await app.inject({ method: "POST", url: "/api/login", payload: ADMIN_LOGIN })).json().token as string;
    const seen = events(await wsAuth(app, watcherToken), "devices.presence");
    const ws = await wsAuth(app, token, A);
    expect(app.deviceOnline(main.id)).toBe(true);
    await app.inject({ method: "POST", url: "/api/logout", headers });
    await closed(ws); await settle();
    expect(app.deviceOnline(main.id)).toBe(false);
    expect(seen.filter((e) => !e.online)).toEqual([{ deviceId: main.id, online: false }]);
  });
});
