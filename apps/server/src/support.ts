// MasalaPOS support from the counter: the Get support chat link, and remote access to this PC.
// The counter keeps one live connection to the MasalaPOS service (authenticated with its installation secret). Remote-access requests
// arrive on it; the POS screen on this PC asks for consent; only then does the desktop shell start sharing the screen. Every request,
// answer and session end is written to remote_support_log, the restaurant's own record.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isRemoteToServer, type IceServer, type RemoteMode, type RemoteToDesktop } from "@masalapos/domain/remote-support";
import { WebSocket } from "ws";
import { z } from "zod";
import { resolveApprover } from "./credit-notes.js";
import { httpError } from "./http-error.js";

const SECRET_HEADER = "x-masalapos-installation-secret";
const INSTALLATION_HEADER = "x-masalapos-installation-id";
/** The PC shows a request this long; the service gives up a little after. */
export const CONSENT_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface SupportOptions {
  /** Base URL of the MasalaPOS service (no trailing slash). Without it, Get support explains that this build isn't connected. */
  serviceUrl?: string;
  installationId?: string;
  installationSecret?: string;
  /** The desktop shell's message port; without it this PC cannot share its screen, so every request is refused. */
  desktop?: { send(message: RemoteToDesktop): void; onMessage(listener: (message: unknown) => void): void };
  fetch?: typeof fetch;
  /** Tests replace the live connection. */
  connect?: (url: string, headers: Record<string, string>) => LiveLink;
  log?: (message: string) => void;
}

/** The counter's end of the live connection, as the channel uses it. */
export interface LiveLink {
  send(text: string): void;
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (text: string) => void): void;
  on(event: "close", listener: (refused: boolean) => void): void;
}

export interface PendingRequest { sessionId: string; agentName: string; reason: string; mode: RemoteMode; expiresAt: number }
export interface ActiveSession { sessionId: string; agentName: string; mode: RemoteMode; startedAt: number | null }

const ServiceEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("remote.request"), sessionId: z.string().uuid(), agentName: z.string().max(120), reason: z.string().max(200), mode: z.enum(["view", "control"]) }),
  z.object({ type: z.literal("remote.start"), sessionId: z.string().uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), mode: z.enum(["view", "control"]),
    agentPath: z.string().regex(/^\/[a-z0-9/_-]+$/), agentName: z.string().max(120), maxMs: z.number().int().positive(),
    iceServers: z.array(z.object({ urls: z.array(z.string().max(200)).max(8), username: z.string().max(200).optional(), credential: z.string().max(200).optional() })).max(8) }),
  z.object({ type: z.literal("remote.ended"), sessionId: z.string().uuid(), reason: z.string().max(200) }),
]);

function nodeLink(url: string, headers: Record<string, string>): LiveLink {
  const ws = new WebSocket(url, { headers, handshakeTimeout: 15_000, maxPayload: 64 * 1024 });
  let refused = false;
  ws.on("unexpected-response", (_req, res) => { refused = res.statusCode === 403; ws.terminate(); });
  ws.on("error", () => { /* a close follows */ });
  return {
    send: (text) => { if (ws.readyState === ws.OPEN) ws.send(text); },
    close: () => ws.close(1000),
    on: ((event: string, listener: (...args: never[]) => void) => {
      if (event === "open") ws.on("open", listener as () => void);
      else if (event === "message") ws.on("message", (data) => (listener as (text: string) => void)(data.toString()));
      else ws.on("close", () => (listener as (refused: boolean) => void)(refused));
    }) as LiveLink["on"],
  };
}

/**
 * The live connection to the MasalaPOS service: reconnects on its own (2 s doubling to 5 min), and backs off for 10 minutes when the
 * service refuses it (this counter isn't activated yet). A ping every 25 s; silence for 70 s means it died.
 */
export class SupportChannel {
  private link: LiveLink | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;
  private stopped = true;
  connected = false;

  constructor(private readonly url: string, private readonly headers: Record<string, string>, private readonly onEvent: (event: unknown) => void,
    private readonly connect: (url: string, headers: Record<string, string>) => LiveLink, private readonly onStatus: (connected: boolean) => void = () => {}) {}

  start(): void { if (this.stopped) { this.stopped = false; this.open(); } }
  /** Tries again now instead of waiting out the back-off (the counter was just activated, so the service will now accept it). */
  retryNow(): void {
    if (this.stopped || this.link) return;
    if (this.timer) clearTimeout(this.timer);
    this.attempts = 0;
    this.open();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pinger) clearInterval(this.pinger);
    this.link?.close();
    this.link = null;
    this.setConnected(false);
  }
  send(message: Record<string, unknown>): boolean {
    if (!this.link || !this.connected) return false;
    this.link.send(JSON.stringify(message));
    return true;
  }

  private setConnected(value: boolean) { if (this.connected !== value) { this.connected = value; this.onStatus(value); } }

  private open() {
    if (this.stopped) return;
    const link = this.connect(this.url, this.headers);
    this.link = link;
    link.on("open", () => {
      if (this.link !== link) return;
      this.attempts = 0;
      this.lastHeard = Date.now();
      this.setConnected(true);
      this.pinger = setInterval(() => {
        if (Date.now() - this.lastHeard > 70_000) { link.close(); return; }
        link.send(JSON.stringify({ type: "ping" }));
      }, 25_000);
      this.pinger.unref?.();
    });
    link.on("message", (text) => {
      if (this.link !== link) return;
      this.lastHeard = Date.now();
      let event: unknown;
      try { event = JSON.parse(text); } catch { return; }
      this.onEvent(event);
    });
    link.on("close", (refused) => {
      if (this.link !== link) return;
      this.link = null;
      if (this.pinger) clearInterval(this.pinger);
      this.setConnected(false);
      if (this.stopped) return;
      const delay = refused ? 10 * 60_000 : Math.min(5 * 60_000, 2_000 * 2 ** this.attempts++);
      this.timer = setTimeout(() => this.open(), delay + Math.random() * 1_000);
      this.timer.unref?.();
    });
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** Consent and Stop come from the screen of this PC only, never from another device on the network. */
function assertThisPc(req: FastifyRequest) {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) throw httpError(403, "Remote access can only be answered on the PC being shared");
}

const AnswerBody = z.object({ sessionId: z.string().uuid(), decision: z.enum(["deny", "view", "control"]), approverPin: z.string().min(4).max(12).optional() });
const StopBody = z.object({ sessionId: z.string().uuid() });
const SettingsBody = z.object({ enabled: z.boolean() });

export function registerSupport(app: FastifyInstance, options: SupportOptions = {}): void {
  const log = options.log ?? ((message: string) => app.log.warn(message));
  const db = app.db;
  const { serviceUrl, installationId, installationSecret, desktop } = options;
  const online = !!(serviceUrl && installationId && installationSecret);
  const headers = online ? { [SECRET_HEADER]: installationSecret!, [INSTALLATION_HEADER]: installationId! } : {};
  let pending: PendingRequest | null = null;
  let active: ActiveSession | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const record = (sessionId: string, event: "requested" | "allowed" | "refused" | "started" | "ended", detail: { agentName?: string | null; actorName?: string | null; detail?: string | null } = {}) =>
    db.prepare("INSERT INTO remote_support_log (session_id, at, event, agent_name, actor_name, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sessionId, Date.now(), event, detail.agentName ?? null, detail.actorName ?? null, detail.detail ?? null);
  const enabled = () => ((db.prepare("SELECT remote_support_enabled AS on_ FROM settings WHERE id = 1").get() as { on_?: number } | undefined)?.on_ ?? 1) === 1;
  const state = () => ({ pending, active });
  const announce = () => app.broadcast("support.remote", state());
  const clearPending = () => { if (pendingTimer) clearTimeout(pendingTimer); pendingTimer = null; pending = null; };

  const channel = online ? new SupportChannel(`${serviceUrl!.replace(/^http/, "ws")}/v1/counter/live`, headers, (raw) => onServiceEvent(raw), options.connect ?? nodeLink,
    () => app.broadcast("support.status", { online: channel?.connected ?? false })) : null;

  function onServiceEvent(raw: unknown) {
    const parsed = ServiceEvent.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.type === "pong") return;
    if (event.type === "remote.request") {
      // Refused without asking anyone: the admin turned it off, or there is no screen here to share (a server without the desktop app).
      const refusal = !enabled() ? "Remote access is turned off on this PC" : !desktop ? "This PC can't share its screen" : active || pending ? "Another remote session is in progress" : null;
      record(event.sessionId, "requested", { agentName: event.agentName, detail: event.reason });
      if (refusal) {
        channel?.send({ type: "remote.answer", sessionId: event.sessionId, decision: "deny", approvedBy: refusal.slice(0, 80) });
        record(event.sessionId, "refused", { agentName: event.agentName, detail: refusal });
        return;
      }
      clearPending();
      pending = { sessionId: event.sessionId, agentName: event.agentName, reason: event.reason, mode: event.mode, expiresAt: Date.now() + CONSENT_MS };
      pendingTimer = setTimeout(() => {
        if (pending?.sessionId !== event.sessionId) return;
        record(event.sessionId, "refused", { agentName: event.agentName, detail: "No one answered" });
        clearPending();
        announce();
      }, CONSENT_MS);
      pendingTimer.unref?.();
      announce();
      return;
    }
    if (event.type === "remote.start") {
      // Only a session this PC just allowed may start.
      if (active?.sessionId !== event.sessionId || active.startedAt !== null || !desktop) return;
      active = { ...active, mode: event.mode };
      const agentUrl = `${serviceUrl!.replace(/^http/, "ws")}${event.agentPath}?t=${event.token}`;
      desktop.send({ type: "remote-start", sessionId: event.sessionId, agentUrl, mode: event.mode, iceServers: event.iceServers as IceServer[], agentName: event.agentName, maxMs: event.maxMs });
      announce();
      return;
    }
    // remote.ended
    if (pending?.sessionId === event.sessionId) { clearPending(); announce(); }
    if (active?.sessionId === event.sessionId) {
      desktop?.send({ type: "remote-stop", sessionId: event.sessionId, reason: event.reason });
      record(event.sessionId, "ended", { agentName: active.agentName, detail: event.reason });
      active = null;
      announce();
    }
  }

  /** Stop pressed on this PC: ends it here at once, whether or not the service hears about it. */
  function stopHere(sessionId: string, reason: string, actorName: string | null = null) {
    if (active?.sessionId !== sessionId) return;
    channel?.send({ type: "remote.end", sessionId, reason });
    desktop?.send({ type: "remote-stop", sessionId, reason });
    record(sessionId, "ended", { agentName: active.agentName, actorName, detail: reason });
    active = null;
    announce();
  }

  desktop?.onMessage((message) => {
    if (!isRemoteToServer(message) || active?.sessionId !== message.sessionId) return;
    if (message.type === "remote-stop-request") { stopHere(message.sessionId, "Stopped at the PC"); return; }
    if (message.state === "sharing" && active.startedAt === null) {
      active = { ...active, startedAt: Date.now() };
      record(message.sessionId, "started", { agentName: active.agentName });
      announce();
    } else if (message.state === "stopped") {
      record(message.sessionId, "ended", { agentName: active.agentName, detail: message.reason ?? "Screen sharing stopped" });
      channel?.send({ type: "remote.end", sessionId: message.sessionId, reason: message.reason ?? "Screen sharing stopped" });
      active = null;
      announce();
    }
  });

  if (channel) {
    app.licensing.onChange(() => channel.retryNow());
    app.addHook("onReady", async () => channel.start());
    app.addHook("preClose", async () => {
      if (active) desktop?.send({ type: "remote-stop", sessionId: active.sessionId, reason: "MasalaPOS is closing" });
      clearPending();
      channel.stop();
    });
  }

  app.post("/api/support/link", { preHandler: app.requireAuth }, async () => {
    if (!online) return { url: null, message: "This copy of MasalaPOS isn't connected to MasalaPOS support online. Call your MasalaPOS representative." };
    try {
      const response = await (options.fetch ?? fetch)(`${serviceUrl}/v1/support/link`, {
        method: "POST", headers: { "content-type": "application/json", [SECRET_HEADER]: installationSecret! }, body: JSON.stringify({ installationId }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => null) as { url?: unknown; message?: unknown } | null;
      if (response.ok && typeof body?.url === "string" && body.url.startsWith(`${serviceUrl}/support/`)) return { url: body.url, message: null };
      if (response.status === 429) return { url: null, message: "MasalaPOS support is busy. Try again in a minute." };
      return { url: null, message: typeof body?.message === "string" ? body.message.slice(0, 200) : "MasalaPOS support couldn't open a chat for this counter. Call your MasalaPOS representative." };
    } catch {
      log("Get support: couldn't reach the MasalaPOS service");
      return { url: null, message: "Couldn't reach MasalaPOS support. Check the internet connection and try again." };
    }
  });

  app.get("/api/support/status", { preHandler: app.requireAuth }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { online: channel?.connected ?? false, available: online, canShare: !!desktop, remoteEnabled: enabled(), ...state() };
  });

  app.post("/api/support/remote/answer", { preHandler: app.requireAuth }, async (req) => {
    assertThisPc(req);
    const body = AnswerBody.parse(req.body);
    if (pending?.sessionId !== body.sessionId) throw httpError(409, "That request has already been answered or has expired");
    const request = pending;
    if (body.decision === "deny") {
      clearPending();
      channel?.send({ type: "remote.answer", sessionId: request.sessionId, decision: "deny", approvedBy: req.user.name.slice(0, 80) });
      record(request.sessionId, "refused", { agentName: request.agentName, actorName: req.user.name });
      announce();
      return state();
    }
    // Allowing needs an admin: the signed-in one, or an admin's PIN typed on this screen.
    const approver = await resolveApprover(app, req, body.approverPin);
    if (pending?.sessionId !== body.sessionId) throw httpError(409, "That request has expired");
    if (!channel?.send({ type: "remote.answer", sessionId: request.sessionId, decision: body.decision, approvedBy: approver.name.slice(0, 80) })) {
      throw httpError(503, "Lost the connection to MasalaPOS support. Ask them to send the request again.");
    }
    clearPending();
    const mode: RemoteMode = body.decision === "control" && request.mode === "control" ? "control" : "view";
    active = { sessionId: request.sessionId, agentName: request.agentName, mode, startedAt: null };
    record(request.sessionId, "allowed", { agentName: request.agentName, actorName: approver.name, detail: mode === "control" ? "View and control" : "View only" });
    announce();
    return state();
  });

  app.post("/api/support/remote/stop", { preHandler: app.requireAuth }, async (req) => {
    assertThisPc(req);
    const { sessionId } = StopBody.parse(req.body);
    stopHere(sessionId, "Stopped at the PC", req.user.name);
    return state();
  });

  const manage = app.requirePermission("settings.manage");
  app.get("/api/support/remote-log", { preHandler: manage }, async () => ({
    entries: db.prepare("SELECT id, session_id AS sessionId, at, event, agent_name AS agentName, actor_name AS actorName, detail FROM remote_support_log ORDER BY id DESC LIMIT 100").all(),
  }));
  app.put("/api/support/remote-settings", { preHandler: manage }, async (req) => {
    const { enabled: on } = SettingsBody.parse(req.body);
    db.prepare("UPDATE settings SET remote_support_enabled = ? WHERE id = 1").run(on ? 1 : 0);
    return { remoteEnabled: on };
  });
}
