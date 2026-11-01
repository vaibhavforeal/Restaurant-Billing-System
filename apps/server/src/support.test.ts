import { generateKeyPairSync, randomUUID } from "node:crypto";
import { MIGRATIONS, migrate, openDb, type RemoteToDesktop } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import type { LiveLink } from "./support.js";
import { hashPassword } from "@masalapos/core";
import { createHash } from "node:crypto";
import { SETUP } from "./test-helpers.js";

const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const installationId = randomUUID();
const installationSecret = "0123456789abcdef".repeat(4);
const serviceUrl = "https://portal.example";
const device = "a".repeat(64);
const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) { await app.close(); app.db.close(); } });

/** The counter's live connection as the test drives it: `sent` is what the counter said, `say` is the service talking. */
class FakeLink implements LiveLink {
  sent: Array<Record<string, unknown>> = [];
  private listeners: Record<string, Array<(...args: never[]) => void>> = {};
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.emit("close", false); }
  on(event: string, listener: (...args: never[]) => void) { (this.listeners[event] ??= []).push(listener); }
  emit(event: string, ...args: unknown[]) { for (const l of this.listeners[event] ?? []) (l as (...a: unknown[]) => void)(...args); }
  say(message: Record<string, unknown>) { this.emit("message", JSON.stringify(message)); }
  of(type: string) { return this.sent.filter((m) => m["type"] === type); }
}

async function fixture(options: { online?: boolean; desktop?: boolean; fetch?: typeof fetch } = {}) {
  const db = openDb(":memory:"); migrate(db, MIGRATIONS);
  const links: FakeLink[] = [];
  const toDesktop: RemoteToDesktop[] = [];
  const fromDesktop: Array<(message: unknown) => void> = [];
  const online = options.online ?? true;
  const app = buildServer({
    db,
    licensing: { publicKey, installationId, ...(online ? { serviceUrl, installationSecret } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) },
    ...(options.desktop === false ? {} : { updateBridge: { send: (m) => { if (m.type.startsWith("remote-")) toDesktop.push(m as RemoteToDesktop); }, onMessage: (l) => { fromDesktop.push(l); } } }),
    support: { connect: (url, headers) => { const link = new FakeLink(url, headers); links.push(link); return link; }, log: () => {} },
  });
  apps.push(app);
  const setup = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: { "x-masalapos-device": device } });
  expect(setup.statusCode, setup.body).toBe(201);
  const admin = { authorization: `Bearer ${setup.json().token}`, "x-masalapos-device": device };
  await app.ready();
  const link = links[0];
  link?.emit("open");
  return { app, admin, link, toDesktop, desktop: (m: unknown) => { for (const l of fromDesktop) l(m); } };
}

const request = (over: Record<string, unknown> = {}) => ({ type: "remote.request", sessionId: randomUUID(), agentName: "Neha Sharma", reason: "Check the printer", mode: "control", ...over });

describe("Get support", () => {
  it("asks the service for a one-time chat link with the installation secret", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = await fixture({ fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init });
      return new Response(JSON.stringify({ url: `${serviceUrl}/support/start?t=${"x".repeat(43)}` }), { status: 200 }); }) as typeof fetch });
    const res = await f.app.inject({ method: "POST", url: "/api/support/link", headers: f.admin });
    expect(res.json()).toEqual({ url: `${serviceUrl}/support/start?t=${"x".repeat(43)}`, message: null });
    expect(calls[0]!.url).toBe(`${serviceUrl}/v1/support/link`);
    expect((calls[0]!.init.headers as Record<string, string>)["x-masalapos-installation-secret"]).toBe(installationSecret);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ installationId });
  });

  it("explains itself instead of opening a link when the service refuses or isn't configured", async () => {
    const refused = await fixture({ fetch: (async () => new Response(JSON.stringify({ error: "not_enrolled", message: "Activate this counter first." }), { status: 409 })) as typeof fetch });
    expect((await refused.app.inject({ method: "POST", url: "/api/support/link", headers: refused.admin })).json()).toEqual({ url: null, message: "Activate this counter first." });
    const elsewhere = await fixture({ fetch: (async () => new Response(JSON.stringify({ url: "https://evil.example/support/x" }), { status: 200 })) as typeof fetch });
    expect((await elsewhere.app.inject({ method: "POST", url: "/api/support/link", headers: elsewhere.admin })).json().url).toBeNull();
    const offline = await fixture({ online: false });
    expect((await offline.app.inject({ method: "POST", url: "/api/support/link", headers: offline.admin })).json()).toMatchObject({ url: null });
    expect(offline.link).toBeUndefined();
  });
});

describe("remote access", () => {
  it("connects to the service with the counter's identity", async () => {
    const f = await fixture();
    expect(f.link!.url).toBe("wss://portal.example/v1/counter/live");
    expect(f.link!.headers).toEqual({ "x-masalapos-installation-secret": installationSecret, "x-masalapos-installation-id": installationId });
    expect((await f.app.inject({ method: "GET", url: "/api/support/status", headers: f.admin })).json()).toMatchObject({ online: true, canShare: true, remoteEnabled: true, pending: null });
  });

  it("asks this PC, needs an admin to allow, starts the desktop's sharing and ends it from the banner", async () => {
    const f = await fixture();
    // Written straight in: an unactivated counter can't add staff through the API.
    const cashierId = randomUUID(), token = randomUUID();
    f.app.db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Ravi', ?, 'cashier', ?)").run(cashierId, await hashPassword("4321"), Date.now());
    f.app.db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at, device) VALUES (?, ?, ?, ?, ?)")
      .run(token, cashierId, Date.now(), Date.now() + 60_000, createHash("sha256").update(device).digest("hex"));
    const cashierHeaders = { authorization: `Bearer ${token}`, "x-masalapos-device": device };
    const ask = request();
    f.link!.say(ask);
    const status = (await f.app.inject({ method: "GET", url: "/api/support/status", headers: f.admin })).json();
    expect(status.pending).toMatchObject({ sessionId: ask.sessionId, agentName: "Neha Sharma", reason: "Check the printer", mode: "control" });

    const answer = (headers: Record<string, string>, payload: Record<string, unknown>, remoteAddress = "127.0.0.1") =>
      f.app.inject({ method: "POST", url: "/api/support/remote/answer", headers, payload: { sessionId: ask.sessionId, ...payload }, remoteAddress });
    expect((await answer(f.admin, { decision: "control" }, "192.168.1.20")).statusCode).toBe(403);
    expect((await answer(cashierHeaders, { decision: "control" })).statusCode).toBe(403);
    expect((await answer(cashierHeaders, { decision: "control", approverPin: "9999" })).statusCode).toBe(401);
    const allowed = await answer(cashierHeaders, { decision: "control", approverPin: SETUP.pin });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(f.link!.of("remote.answer")).toEqual([{ type: "remote.answer", sessionId: ask.sessionId, decision: "control", approvedBy: SETUP.adminName }]);

    // A start for a session nobody here allowed does nothing.
    f.link!.say({ type: "remote.start", sessionId: randomUUID(), token: "t".repeat(43), mode: "control", agentPath: "/v1/remote/agent", agentName: "X", maxMs: 1000, iceServers: [] });
    expect(f.toDesktop).toEqual([]);
    f.link!.say({ type: "remote.start", sessionId: ask.sessionId, token: "t".repeat(43), mode: "control", agentPath: "/v1/remote/agent", agentName: "Neha Sharma", maxMs: 3_600_000,
      iceServers: [{ urls: ["turn:relay.example:3478"], username: "u", credential: "c" }] });
    expect(f.toDesktop[0]).toMatchObject({ type: "remote-start", sessionId: ask.sessionId, agentUrl: `wss://portal.example/v1/remote/agent?t=${"t".repeat(43)}`, mode: "control" });

    f.desktop({ type: "remote-state", sessionId: ask.sessionId, state: "sharing" });
    f.desktop({ type: "remote-stop-request", sessionId: ask.sessionId });
    expect(f.link!.of("remote.end")).toEqual([{ type: "remote.end", sessionId: ask.sessionId, reason: "Stopped at the PC" }]);
    expect(f.toDesktop.at(-1)).toMatchObject({ type: "remote-stop", sessionId: ask.sessionId });
    f.link!.say({ type: "remote.ended", sessionId: ask.sessionId, reason: "Stopped at the PC" });

    const log = (await f.app.inject({ method: "GET", url: "/api/support/remote-log", headers: f.admin })).json().entries as Array<{ event: string; actorName: string | null }>;
    expect(log.map((e) => e.event).reverse()).toEqual(["requested", "allowed", "started", "ended"]);
    expect(log.find((e) => e.event === "allowed")?.actorName).toBe(SETUP.adminName);
    expect((await f.app.inject({ method: "GET", url: "/api/support/status", headers: f.admin })).json()).toMatchObject({ pending: null, active: null });
  });

  it("refuses by itself when an admin turned it off, when another session runs, or when this server can't share a screen", async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: "PUT", url: "/api/support/remote-settings", headers: f.admin, payload: { enabled: false } })).statusCode).toBe(200);
    f.link!.say(request());
    expect(f.link!.of("remote.answer")[0]).toMatchObject({ decision: "deny", approvedBy: "Remote access is turned off on this PC" });
    await f.app.inject({ method: "PUT", url: "/api/support/remote-settings", headers: f.admin, payload: { enabled: true } });
    f.link!.say(request());
    f.link!.say(request());
    expect(f.link!.of("remote.answer").at(-1)).toMatchObject({ decision: "deny", approvedBy: "Another remote session is in progress" });

    const headless = await fixture({ desktop: false });
    headless.link!.say(request());
    expect(headless.link!.of("remote.answer")[0]).toMatchObject({ decision: "deny", approvedBy: "This PC can't share its screen" });
  });

  it("a refusal needs no admin, and works while the licence is not active", async () => {
    const f = await fixture();
    const ask = request();
    f.link!.say(ask);
    const res = await f.app.inject({ method: "POST", url: "/api/support/remote/answer", headers: f.admin, payload: { sessionId: ask.sessionId, decision: "deny" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(f.link!.of("remote.answer")[0]).toMatchObject({ decision: "deny", approvedBy: SETUP.adminName });
    expect((await f.app.inject({ method: "POST", url: "/api/support/remote/answer", headers: f.admin, payload: { sessionId: ask.sessionId, decision: "deny" } })).statusCode).toBe(409);
  });
});


describe("connector audit recovery", () => {
  it("replays missed history once, with original times, and rejects another installation", async () => {
    const f = await fixture();
    const session = { id:randomUUID(),origin:"connector",installation:{id:installationId},requestedBy:{name:"Neha"},reason:"Printer",modeRequested:"control",mode:"view",approvedByName:"Meera",status:"ended",expiresAt:5000,requestedAt:1000,answeredAt:2000,startedAt:3000,endedAt:4000,endReason:"Stopped" };
    f.link!.say({type:"connector.history",session:{...session,installation:{id:randomUUID()}}});
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM remote_support_log").get()).toEqual({n:0});
    f.link!.say({type:"connector.history",session});
    f.link!.say({type:"connector.history",session});
    expect(f.app.db.prepare("SELECT event, at FROM remote_support_log ORDER BY at").all()).toEqual([{event:"requested",at:1000},{event:"allowed",at:2000},{event:"started",at:3000},{event:"ended",at:4000}]);
    expect(f.toDesktop).toEqual([]);
  });
});
