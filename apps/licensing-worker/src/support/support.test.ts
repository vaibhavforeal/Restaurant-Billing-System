import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";
import { authorizeLive, INSTALLATION_HEADER } from "../live/authorize.js";
import { SupportHub } from "../live/hub.js";
import type { LiveSocket, Peer } from "../live/types.js";
import type { ChatDetail, ChatSummary, RemoteSession, TicketDetail, VisitorChat } from "../portal/api-types.js";
import { seedCustomer, seedOrder } from "../testing/fixtures.js";
import { activation, keyPair, ORIGIN, send, testEnv, withSecret } from "../testing/harness.js";
import { as, type PortalClient } from "../testing/portal.js";
import { SECRET_HEADER } from "../secret.js";
import { TEST_SECRET } from "../testing/secret.js";
import { REQUEST_TTL_MS } from "./remote.js";

const T0 = Date.UTC(2026, 9, 31, 6, 0, 0);
const keys = keyPair();
let fingerprint: string;
let env: Env;
let hub: SupportHub;
let installationId: string;
let support: PortalClient & { staff: { id: string; name: string } };

beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); fingerprint = await keys.fingerprint(); });
beforeEach(async () => {
  vi.setSystemTime(T0);
  env = testEnv(keys.privatePem, { TURN_URLS: "turn:relay.test:3478?transport=udp,turns:relay.test:5349", TURN_SECRET: "turn-secret" });
  hub = new SupportHub(env, { db: env.DB, now: Date.now, uuid: () => crypto.randomUUID() }, () => {});
  env.LIVE = hub;
  const customer = await seedCustomer(env.DB, { name: "Spice Route" });
  const order = await seedOrder(env.DB, customer);
  installationId = crypto.randomUUID();
  const res = await send(env, "POST", "/v1/enroll", { activation: activation(installationId, fingerprint, { outletName: "Spice Route Baner" }), customerId: customer.code, orderId: order.code }, withSecret());
  expect(res.status).toBe(200);
  support = await as(env, "support", { name: "Neha Sharma" });
});

class FakeSocket implements LiveSocket {
  sent: Array<Record<string, unknown>> = [];
  closed: number | null = null;
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close(code = 1000) { this.closed = code; }
  of(type: string) { return this.sent.filter((e) => e.type === type); }
}
function open(peer: Peer) {
  const socket = new FakeSocket();
  const connection = hub.connect(peer, socket);
  return { socket, say: (message: unknown) => connection.onMessage(JSON.stringify(message)), close: () => connection.onClose() };
}
/** Lets the hub's fire-and-forget handlers finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function link(secret = TEST_SECRET): Promise<Response> {
  return send(env, "POST", "/v1/support/link", { installationId }, withSecret({}, secret));
}
/** A visitor's browser: follows the counter's link and keeps the cookie. */
async function visitor() {
  const { url } = await (await link()).json() as { url: string };
  const started = await send(env, "GET", new URL(url).pathname + new URL(url).search);
  expect(started.status).toBe(303);
  const cookie = started.headers.get("set-cookie")!.split(";")[0]!;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    send(env, method, `/support/api${path}`, body, { cookie, ...(method === "GET" ? {} : { origin: ORIGIN }), ...headers });
  return { cookie, call, url };
}

describe("support links", () => {
  it("are minted only with the counter's secret, work once, and lapse after 10 minutes", async () => {
    expect((await link("f".repeat(64))).status).toBe(403);
    expect((await send(env, "POST", "/v1/support/link", { installationId: crypto.randomUUID() }, withSecret())).status).toBe(403);
    const { url } = await (await link()).json() as { url: string };
    expect(url).toMatch(/^https:\/\/licensing\.test\/support\/start\?t=[A-Za-z0-9_-]{43}$/);
    const path = new URL(url).pathname + new URL(url).search;
    const first = await send(env, "GET", path);
    expect(first.headers.get("location")).toBe(`${ORIGIN}/support/`);
    expect(first.headers.get("set-cookie")).toMatch(/^mp_support=[A-Za-z0-9_-]{43}; Path=\/support; HttpOnly; Secure; SameSite=Strict/);
    expect((await send(env, "GET", path)).headers.get("location")).toBe(`${ORIGIN}/support/?link=expired`);

    const late = await (await link()).json() as { url: string };
    vi.setSystemTime(T0 + 10 * 60_000 + 1);
    expect((await send(env, "GET", new URL(late.url).pathname + new URL(late.url).search)).headers.get("location")).toContain("link=expired");
  });

  it("refuse a counter that was never enrolled with a customer", async () => {
    const stray = crypto.randomUUID();
    await send(env, "POST", "/v1/activate", activation(stray, fingerprint), withSecret());
    const res = await send(env, "POST", "/v1/support/link", { installationId: stray }, withSecret());
    expect([403, 409]).toContain(res.status);
  });
});

describe("live chat", () => {
  it("starts from the restaurant with a name, is answered and closed by support, and a new message opens a new chat", async () => {
    const v = await visitor();
    expect((await v.call("POST", "/messages", { body: "Printer not printing KOTs" })).status).toBe(400);
    expect((await v.call("POST", "/messages", { body: "hi", name: "Ravi" }, { origin: "https://evil.test" })).status).toBe(403);
    const opened = await (await v.call("POST", "/messages", { body: "Printer not printing KOTs", name: "Ravi", phone: "98220 12345" })).json() as VisitorChat;
    expect(opened.chat).toMatchObject({ number: 1001, status: "waiting", visitorName: "Ravi", agentName: null });
    expect(opened.outletName).toBe("Spice Route Baner");

    const inbox = await support.ok<{ chats: ChatSummary[]; counts: Record<string, number> }>("GET", "/chats");
    expect(inbox.counts).toMatchObject({ waiting: 1, active: 0 });
    const chatId = inbox.chats[0]!.id;
    expect(inbox.chats[0]).toMatchObject({ customer: { name: "Spice Route" }, installation: { id: installationId, name: "Spice Route Baner" }, lastMessage: { author: "customer" } });

    const replied = await support.ok<{ chat: ChatDetail }>("POST", `/chats/${chatId}/messages`, { body: "Hi Ravi, let me check." });
    expect(replied.chat).toMatchObject({ status: "active", assignee: { id: support.staff.id } });

    const seen = await (await v.call("GET", "/chat")).json() as VisitorChat;
    expect(seen.chat!.agentName).toBe("Neha");
    expect(seen.chat!.messages.map((m) => [m.author, m.name])).toEqual([["customer", null], ["staff", "Neha"]]);
    const after = seen.chat!.messages[0]!.id;
    expect(((await (await v.call("GET", `/chat?after=${after}`)).json()) as VisitorChat).chat!.messages).toHaveLength(1);

    await support.ok("PATCH", `/chats/${chatId}`, { status: "closed" });
    const closed = await (await v.call("GET", "/chat")).json() as VisitorChat;
    expect(closed.chat).toMatchObject({ status: "closed" });
    expect(closed.chat!.messages.at(-1)).toMatchObject({ author: "system" });
    expect((await support.call("POST", `/chats/${chatId}/messages`, { body: "one more" })).status).toBe(409);

    expect((await v.call("POST", "/messages", { body: "Another thing" })).status).toBe(400);
    const second = await (await v.call("POST", "/messages", { body: "Another thing", name: "Ravi" })).json() as VisitorChat;
    expect(second.chat).toMatchObject({ number: 1002, status: "waiting" });
  });

  it("is for support and admins only, and the restaurant needs its cookie", async () => {
    const sales = await as(env, "sales");
    expect((await sales.call("GET", "/chats")).status).toBe(403);
    const accounts = await as(env, "accounts");
    expect((await accounts.call("GET", "/chats")).status).toBe(403);
    expect((await send(env, "GET", "/support/api/chat")).status).toBe(401);
  });

  it("turns into a ticket carrying the transcript", async () => {
    const v = await visitor();
    await v.call("POST", "/messages", { body: "Day close shows wrong total", name: "Ravi" });
    const chatId = (await support.ok<{ chats: ChatSummary[] }>("GET", "/chats")).chats[0]!.id;
    await support.ok("POST", `/chats/${chatId}/messages`, { body: "Looking into it" });
    const made = await support.ok<{ chat: ChatDetail; ticketId: string }>("POST", `/chats/${chatId}/ticket`, { subject: "Day close total", category: "bug", priority: "high" });
    expect(made.chat.ticket).toMatchObject({ number: 1001 });
    const { ticket } = await support.ok<{ ticket: TicketDetail }>("GET", `/tickets/${made.ticketId}`);
    expect(ticket.description).toContain("Ravi: Day close shows wrong total");
    expect(ticket.description).toContain("Neha Sharma: Looking into it");
    expect(ticket.installation?.id).toBe(installationId);
    expect((await support.call("POST", `/chats/${chatId}/ticket`, { subject: "again", category: "bug", priority: "low" })).status).toBe(409);
  });

  it("pushes new messages to support and to the restaurant's page", async () => {
    const staffSocket = open({ kind: "staff", user: { ...support.staff, email: "", role: "support", mustChangePassword: false }, tokenHash: "x" });
    const page = open({ kind: "visitor", installationId, sessionHash: "y" });
    const v = await visitor();
    await v.call("POST", "/messages", { body: "Hello?", name: "Ravi" });
    const update = staffSocket.socket.of("chat.updated")[0] as { chat: ChatSummary; messages: unknown[] };
    expect(update.chat).toMatchObject({ status: "waiting", visitorName: "Ravi" });
    expect(update.messages).toHaveLength(1);

    page.say({ type: "typing" });
    await settle();
    expect(staffSocket.socket.of("chat.typing")[0]).toMatchObject({ installationId });

    await support.ok("POST", `/chats/${update.chat.id}/messages`, { body: "Hi!" });
    const pushed = page.socket.of("visitor.updated").at(-1) as { status: string; agentName: string; messages: Array<{ name: string; body: string }> };
    expect(pushed).toMatchObject({ status: "active", agentName: "Neha" });
    expect(pushed.messages).toEqual([expect.objectContaining({ name: "Neha", body: "Hi!" })]);
    expect(JSON.stringify(page.socket.sent)).not.toContain("Sharma");
  });
});

describe("live socket sign-in", () => {
  const upgrade = (path: string, headers: Record<string, string> = {}) => authorizeLive(new Request(`${ORIGIN}${path}`, { headers }), env, { db: env.DB, now: Date.now, uuid: () => crypto.randomUUID() });

  it("lets support staff in from the portal's own pages only", async () => {
    expect(await upgrade("/portal/api/live", { cookie: support.cookie, origin: ORIGIN })).toMatchObject({ kind: "staff", user: { id: support.staff.id } });
    expect(await upgrade("/portal/api/live", { cookie: support.cookie })).toBeNull();
    expect(await upgrade("/portal/api/live", { cookie: support.cookie, origin: "https://evil.test" })).toBeNull();
    const sales = await as(env, "sales");
    expect(await upgrade("/portal/api/live", { cookie: sales.cookie, origin: ORIGIN })).toBeNull();
  });

  it("lets the restaurant's page and the counter in with their own credentials", async () => {
    const v = await visitor();
    expect(await upgrade("/support/live", { cookie: v.cookie, origin: ORIGIN })).toMatchObject({ kind: "visitor", installationId });
    expect(await upgrade("/support/live", { cookie: v.cookie, origin: "https://evil.test" })).toBeNull();
    expect(await upgrade("/v1/counter/live", { [INSTALLATION_HEADER]: installationId, [SECRET_HEADER]: TEST_SECRET })).toMatchObject({ kind: "counter", installationId });
    expect(await upgrade("/v1/counter/live", { [INSTALLATION_HEADER]: installationId, [SECRET_HEADER]: "0".repeat(64) })).toBeNull();
    expect(await upgrade("/v1/remote/agent?t=nope")).toBeNull();
    expect(await upgrade("/somewhere")).toBeNull();
  });
});

describe("remote sessions", () => {
  const staffPeer = (who: { id: string; name: string }, role: "support" | "admin" = "support"): Peer =>
    ({ kind: "staff", user: { id: who.id, name: who.name, email: "", role, mustChangePassword: false }, tokenHash: "x" });
  const ask = (mode: "view" | "control" = "control", chatId: string | null = null) =>
    support.call("POST", "/remote-sessions", { installationId, chatId, reason: "Check the printer settings", mode });

  it("need the counter connected, wait for the PC to allow, and never grant more than was asked", async () => {
    expect((await ask()).status).toBe(409);
    const counter = open({ kind: "counter", installationId, customerId: "c" });
    const { session } = await (await ask("view")).json() as { session: RemoteSession };
    expect(session).toMatchObject({ status: "requested", modeRequested: "view", requestedBy: { name: "Neha Sharma" } });
    expect(counter.socket.of("remote.request")[0]).toMatchObject({ sessionId: session.id, agentName: "Neha Sharma", mode: "view" });
    expect((await ask()).status).toBe(409);

    counter.say({ type: "remote.answer", sessionId: session.id, decision: "control", approvedBy: "Owner" });
    await settle();
    const start = counter.socket.of("remote.start")[0] as { token: string; mode: string; iceServers: Array<{ urls: string[]; username?: string }> };
    expect(start.mode).toBe("view");
    expect(start.iceServers.find((s) => s.username)?.urls).toEqual(["turn:relay.test:3478?transport=udp", "turns:relay.test:5349"]);
    const { session: allowed } = await support.ok<{ session: RemoteSession }>("GET", `/remote-sessions/${session.id}`);
    expect(allowed).toMatchObject({ status: "approved", mode: "view", approvedByName: "Owner" });
  });

  it("relay signalling between the viewer who asked and the PC's sharing window, and end with the window", async () => {
    const counter = open({ kind: "counter", installationId, customerId: "c" });
    const { session } = await (await ask()).json() as { session: RemoteSession };
    counter.say({ type: "remote.answer", sessionId: session.id, decision: "control", approvedBy: "Owner" });
    await settle();
    const { token } = counter.socket.of("remote.start")[0] as { token: string };

    const authorize = (t: string) => authorizeLive(new Request(`${ORIGIN}/v1/remote/agent?t=${t}`), env, { db: env.DB, now: Date.now, uuid: () => crypto.randomUUID() });
    const peer = await authorize(token);
    expect(peer).toEqual({ kind: "agent", sessionId: session.id, installationId });
    expect(await authorize(token)).toBeNull();

    const viewer = open(staffPeer(support.staff));
    viewer.say({ type: "remote.watch", sessionId: session.id });
    const stranger = open(staffPeer({ id: crypto.randomUUID(), name: "Other" }));
    stranger.say({ type: "remote.watch", sessionId: session.id });
    await settle();
    expect(stranger.socket.of("remote.refused")).toHaveLength(1);

    const agent = open(peer!);
    await settle();
    expect(agent.socket.of("remote.peer")).toHaveLength(1);
    expect((await support.ok<{ session: RemoteSession }>("GET", `/remote-sessions/${session.id}`)).session.status).toBe("active");

    agent.say({ type: "remote.signal", data: { sdp: "offer" } });
    viewer.say({ type: "remote.signal", sessionId: session.id, data: { sdp: "answer" } });
    stranger.say({ type: "remote.signal", sessionId: session.id, data: { sdp: "sneaky" } });
    await settle();
    expect(viewer.socket.of("remote.signal")[0]).toMatchObject({ data: { sdp: "offer" } });
    expect(agent.socket.of("remote.signal").map((e) => e.data)).toEqual([{ sdp: "answer" }]);

    agent.close();
    await settle();
    const ended = (await support.ok<{ session: RemoteSession }>("GET", `/remote-sessions/${session.id}`)).session;
    expect(ended).toMatchObject({ status: "ended", endReason: "Screen sharing stopped" });
    expect(counter.socket.of("remote.ended")[0]).toMatchObject({ sessionId: session.id });
  });

  it("are refused, lapse unanswered, and leave a trail in the chat", async () => {
    const counter = open({ kind: "counter", installationId, customerId: "c" });
    const v = await visitor();
    await v.call("POST", "/messages", { body: "Can you look at my screen?", name: "Ravi" });
    const chatId = (await support.ok<{ chats: ChatSummary[] }>("GET", "/chats")).chats[0]!.id;

    const first = (await (await ask("control", chatId)).json() as { session: RemoteSession }).session;
    counter.say({ type: "remote.answer", sessionId: first.id, decision: "deny", approvedBy: "Ravi" });
    await settle();
    expect((await support.ok<{ session: RemoteSession }>("GET", `/remote-sessions/${first.id}`)).session.status).toBe("denied");

    const second = (await (await ask("control", chatId)).json() as { session: RemoteSession }).session;
    vi.setSystemTime(T0 + REQUEST_TTL_MS + 1);
    await hub.sweep();
    expect((await support.ok<{ session: RemoteSession }>("GET", `/remote-sessions/${second.id}`)).session.status).toBe("expired");
    // A late yes changes nothing.
    counter.say({ type: "remote.answer", sessionId: second.id, decision: "control", approvedBy: "Ravi" });
    await settle();
    expect(counter.socket.of("remote.start")).toHaveLength(0);

    const { chat } = await support.ok<{ chat: ChatDetail }>("GET", `/chats/${chatId}`);
    expect(chat.messages.filter((m) => m.author === "system").map((m) => m.body)).toEqual([
      "Neha asked to see and control this PC: Check the printer settings",
      "Remote access was refused at the PC.",
      "Neha asked to see and control this PC: Check the printer settings",
      "No one answered the remote access request.",
    ]);
    expect(chat.counterOnline).toBe(true);
  });

  it("are for support and admins only", async () => {
    open({ kind: "counter", installationId, customerId: "c" });
    const sales = await as(env, "sales");
    expect((await sales.call("POST", "/remote-sessions", { installationId, reason: "x", mode: "view" })).status).toBe(403);
  });
});
