// Live support end to end over real sockets: the Node host with its hub on a port, a real counter (POS server) pointed at it, the
// restaurant's chat over HTTP, support staff and the sharing window over WebSockets. Only Electron's screen capture is left out:
// the desktop shell is a recorder of what the server asks it to do.
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import worker from "../../licensing-worker/src/index.js";
import { authorizeLive, LIVE_PATHS } from "../../licensing-worker/src/live/authorize.js";
import { SupportHub } from "../../licensing-worker/src/live/hub.js";
import type { ChatDetail, ChatSummary, RemoteSession, VisitorChat } from "../../licensing-worker/src/portal/api-types.js";
import { seedCustomer, seedOrder } from "../../licensing-worker/src/testing/fixtures.js";
import { keyPair, testEnv } from "../../licensing-worker/src/testing/harness.js";
import { client, PASSWORD, seedStaff } from "../../licensing-worker/src/testing/portal.js";
import { TEST_SECRET } from "../../licensing-worker/src/testing/secret.js";
import { MIGRATIONS, migrate, openDb, type RemoteToDesktop } from "../../../packages/domain/src/index.js";
import { buildServer } from "../../server/src/server.js";
import { createApp } from "./app.js";

const keys = keyPair();
const COUNTER = "88888888-8888-4888-8888-888888888888";
const DEVICE = "e".repeat(64);
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function waitFor<T>(check: () => T | Promise<T>, what: string, ms = 5_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A socket that keeps every message it receives. */
async function socket(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const got: Array<Record<string, unknown>> = [];
  ws.on("message", (data) => got.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("unexpected-response", (_q, res) => reject(new Error(`refused ${res.statusCode}`))); });
  cleanups.push(() => ws.terminate());
  return { ws, got, of: (type: string) => got.filter((m) => m["type"] === type), send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe("live support between a real counter and the portal host", () => {
  it("opens a chat from Get support, and runs a remote session from request to the sharing window's end", async () => {
    const env = testEnv(keys.privatePem);
    const liveDeps = { db: env.DB, now: Date.now, uuid: () => crypto.randomUUID() };
    const hub = new SupportHub(env, liveDeps, () => {});
    env.LIVE = hub;
    await hub.start(60_000);
    cleanups.push(() => hub.stop());
    const host = createApp(worker, env, { live: { hub, paths: LIVE_PATHS, authorize: (request) => authorizeLive(request, env, liveDeps) } }).listen(0, "127.0.0.1");
    await new Promise((resolve) => host.once("listening", resolve));
    cleanups.push(() => new Promise((resolve) => host.close(resolve)));
    const origin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;

    // MasalaPOS's side: a customer with a paid order, and a support person signed in over real HTTP.
    const customer = await seedCustomer(env.DB, { name: "Spice Route" });
    const order = await seedOrder(env.DB, customer);
    const neha = await seedStaff(env, "support", { name: "Neha Sharma" });
    const login = await fetch(`${origin}/portal/api/login`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email: neha.email, password: PASSWORD }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const support = client(env, cookie);

    // The restaurant's counter, activated with its setup card, talking to the host for real.
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    const toDesktop: RemoteToDesktop[] = [];
    const fromDesktop: Array<(m: unknown) => void> = [];
    const counter = buildServer({ db, appVersion: "0.7.0", licensing: { publicKey: keys.publicPem, installationId: COUNTER, installationSecret: TEST_SECRET, serviceUrl: origin },
      updateBridge: { send: (m) => { if (m.type.startsWith("remote-")) toDesktop.push(m as RemoteToDesktop); }, onMessage: (l) => { fromDesktop.push(l); } } });
    cleanups.push(async () => { await counter.close(); db.close(); });
    const activated = await counter.inject({ method: "POST", url: "/api/setup/activate", headers: { "x-masalapos-device": DEVICE }, payload: { customerId: customer.code, orderId: order.code } });
    expect(activated.statusCode, activated.body).toBe(200);
    const setup = await counter.inject({ method: "POST", url: "/api/setup", headers: { "x-masalapos-device": DEVICE }, payload: { restaurantName: "Spice Route", address: "12 MG Road", city: "Bengaluru", stateCode: "29", pincode: "560001", phone: "9845012345", adminName: "Meera", pin: "1234" } });
    const pos = { authorization: `Bearer ${setup.json().token}`, "x-masalapos-device": DEVICE };
    await counter.ready();
    await waitFor(() => hub.counterOnline(COUNTER), "the counter's live connection");

    // Get support: a one-time link, opened in the browser, becomes the restaurant's chat.
    const { url } = (await counter.inject({ method: "POST", url: "/api/support/link", headers: pos })).json() as { url: string };
    expect(url.startsWith(`${origin}/support/start?t=`)).toBe(true);
    const opened = await fetch(url, { redirect: "manual" });
    expect(opened.status).toBe(303);
    const visitorCookie = opened.headers.get("set-cookie")!.split(";")[0]!;
    const page = await socket(`${origin.replace("http", "ws")}/support/live`, { cookie: visitorCookie, origin });
    const staff = await socket(`${origin.replace("http", "ws")}/portal/api/live`, { cookie, origin });
    await waitFor(() => staff.of("hello")[0], "hello");
    expect(staff.of("hello")[0]!["counters"]).toEqual([COUNTER]);

    const sent = await fetch(`${origin}/support/api/messages`, { method: "POST", headers: { "content-type": "application/json", cookie: visitorCookie, origin },
      body: JSON.stringify({ body: "The KOT printer stopped", name: "Meera" }) });
    expect(sent.status).toBe(201);
    const pushed = await waitFor(() => staff.of("chat.updated")[0], "the chat reaching support") as { chat: ChatSummary };
    expect(pushed.chat).toMatchObject({ status: "waiting", customer: { name: "Spice Route" }, installation: { id: COUNTER } });
    await support.ok("POST", `/chats/${pushed.chat.id}/messages`, { body: "Hi Meera, let me take a look." });
    await waitFor(() => page.of("visitor.updated").find((e) => (e["messages"] as Array<{ name: string }>).some((m) => m.name === "Neha")), "the reply reaching the restaurant");
    const { chat } = await support.ok<{ chat: ChatDetail }>("GET", `/chats/${pushed.chat.id}`);
    expect(chat.counterOnline).toBe(true);

    // Remote access: support asks, the PC's admin allows view and control, the desktop is told to share.
    const { session } = await support.ok<{ session: RemoteSession }>("POST", "/remote-sessions", { installationId: COUNTER, chatId: chat.id, reason: "Check the KOT printer settings", mode: "control" });
    const status = await waitFor(async () => { const s = (await counter.inject({ url: "/api/support/status", headers: pos })).json(); return s.pending ? s : null; }, "the request reaching the PC");
    expect(status.pending).toMatchObject({ sessionId: session.id, agentName: "Neha Sharma", mode: "control" });
    const allowed = await counter.inject({ method: "POST", url: "/api/support/remote/answer", headers: pos, payload: { sessionId: session.id, decision: "control" } });
    expect(allowed.statusCode, allowed.body).toBe(200);
    const start = await waitFor(() => toDesktop.find((m) => m.type === "remote-start"), "the desktop being told to share") as Extract<RemoteToDesktop, { type: "remote-start" }>;
    expect(start.agentUrl.startsWith(`${origin.replace("http", "ws")}/v1/remote/agent?t=`)).toBe(true);
    expect(start.mode).toBe("control");

    // The sharing window connects with its one-time address; the viewer watches; signalling flows both ways.
    staff.send({ type: "remote.watch", sessionId: session.id });
    const agent = await socket(start.agentUrl, {});
    for (const l of fromDesktop) l({ type: "remote-state", sessionId: session.id, state: "sharing" });
    await waitFor(() => agent.of("remote.peer")[0], "the agent hearing of its viewer");
    agent.send({ type: "remote.signal", data: { kind: "offer", sdp: "v=0 offer" } });
    await waitFor(() => staff.of("remote.signal")[0], "the offer reaching the viewer");
    staff.send({ type: "remote.signal", sessionId: session.id, data: { kind: "answer", sdp: "v=0 answer" } });
    await waitFor(() => agent.of("remote.signal")[0], "the answer reaching the agent");
    expect((await support.ok<{ session: RemoteSession }>("GET", `/remote-sessions/${session.id}`)).session).toMatchObject({ status: "active", mode: "control", approvedByName: "Meera" });
    await expect(socket(start.agentUrl, {})).rejects.toThrow("refused 403");

    // Closing the sharing window ends the session everywhere: the portal, the counter's log, the desktop.
    agent.ws.close();
    await waitFor(async () => (await support.ok<{ session: RemoteSession }>("GET", `/remote-sessions/${session.id}`)).session.status === "ended", "the session ending");
    await waitFor(() => toDesktop.some((m) => m.type === "remote-stop"), "the desktop being told to stop");
    const log = (await counter.inject({ url: "/api/support/remote-log", headers: pos })).json().entries as Array<{ event: string }>;
    expect(log.map((e) => e.event).reverse()).toEqual(["requested", "allowed", "started", "ended"]);
    const trail = (await support.ok<{ chat: ChatDetail }>("GET", `/chats/${chat.id}`)).chat.messages.filter((m) => m.author === "system").map((m) => m.body);
    expect(trail).toEqual(["Neha asked to see and control this PC: Check the KOT printer settings", "Meera allowed remote access (view and control).", "Remote session ended: Screen sharing stopped."]);
    void visitorCookie; void ({} as VisitorChat);
  }, 20_000);
});
