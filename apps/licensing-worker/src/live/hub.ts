// The in-memory hub of live sockets on one host: staff in the portal, restaurants' chat pages, counters' POS servers, and remote
// sessions' sharing windows. It keeps no state that matters across a restart: messages and sessions live in the database, and
// every client reconnects and reloads over HTTP.
import { z } from "zod";
import type { D1Like, Env } from "../env.js";
import { roleCan } from "../portal/shared.js";
import { firstName } from "../support/chats.js";
import { answerRemote, endAllOpen, endRemote, remoteSession, startRemote, sweepRemote, type RemoteDeps } from "../support/remote.js";
import type { Connection, LiveEvent, LiveHub, LiveSocket, Peer } from "./types.js";

export interface HubDeps { db: D1Like; now: () => number; uuid: () => string }
type StaffPeer = Extract<Peer, { kind: "staff" }>;

/** Per socket: more than this many messages in the window closes it (signalling bursts stay far below). */
const BURST = { messages: 200, windowMs: 10_000 };

const StaffMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("typing"), chatId: z.string().uuid() }),
  z.object({ type: z.literal("remote.watch"), sessionId: z.string().uuid() }),
  z.object({ type: z.literal("remote.signal"), sessionId: z.string().uuid(), data: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("remote.end"), sessionId: z.string().uuid() }),
]);
const VisitorMessage = z.object({ type: z.literal("typing") });
const CounterMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("remote.answer"), sessionId: z.string().uuid(), decision: z.enum(["deny", "view", "control"]), approvedBy: z.string().trim().min(1).max(80) }),
  z.object({ type: z.literal("remote.end"), sessionId: z.string().uuid(), reason: z.string().trim().min(1).max(120).optional() }),
]);
const AgentMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("remote.signal"), data: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("remote.end"), reason: z.string().trim().min(1).max(120).optional() }),
]);

function parse<S extends z.ZodType>(schema: S, text: string): z.infer<S> | null {
  try { const parsed = schema.safeParse(JSON.parse(text)); return parsed.success ? parsed.data : null; } catch { return null; }
}

export class SupportHub implements LiveHub {
  private readonly staff = new Map<LiveSocket, StaffPeer>();
  private readonly visitors = new Map<string, Set<LiveSocket>>();
  private readonly counters = new Map<string, LiveSocket>();
  private readonly agents = new Map<string, LiveSocket>();
  private readonly viewers = new Map<string, Set<LiveSocket>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeps = 0;

  constructor(private readonly env: Pick<Env, "TURN_URLS" | "TURN_SECRET">, private readonly deps: HubDeps, private readonly log: (message: string) => void = console.error) {}

  private get remote(): RemoteDeps { return { db: this.deps.db, live: this, now: this.deps.now, env: this.env }; }

  /** Ends whatever a previous run left open, then sweeps every `everyMs`. */
  async start(everyMs = 5_000): Promise<void> {
    await endAllOpen(this.remote, "The support service restarted");
    this.timer = setInterval(() => void this.sweep().catch((e) => this.log(`live: sweep failed: ${e instanceof Error ? e.message : "unknown"}`)), everyMs);
    (this.timer as { unref?: () => void }).unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async sweep(): Promise<void> {
    await sweepRemote(this.remote);
    // About once a minute, staff whose session ended (signed out, deactivated, timed out) lose their socket too.
    if (++this.sweeps % 12 === 0) await this.recheckStaff();
  }

  private async recheckStaff(): Promise<void> {
    const now = this.deps.now();
    for (const [socket, peer] of this.staff) {
      const live = await this.deps.db.prepare(`SELECT 1 AS hit FROM staff_sessions s JOIN staff_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`)
        .bind(peer.tokenHash, now).first();
      if (!live) socket.close(4001, "Signed out");
    }
  }

  connect(peer: Peer, socket: LiveSocket): Connection {
    let count = 0, windowStart = this.deps.now();
    const guard = (handle: (text: string) => Promise<void>) => (text: string) => {
      const now = this.deps.now();
      if (now - windowStart > BURST.windowMs) { windowStart = now; count = 0; }
      if (++count > BURST.messages) { socket.close(4008, "Too many messages"); return; }
      handle(text).catch((e) => this.log(`live: ${peer.kind} message failed: ${e instanceof Error ? e.message : "unknown"}`));
    };
    switch (peer.kind) {
      case "staff": return this.connectStaff(peer, socket, guard);
      case "visitor": return this.connectVisitor(peer, socket, guard);
      case "counter": return this.connectCounter(peer, socket, guard);
      case "agent": return this.connectAgent(peer, socket, guard);
    }
  }

  private connectStaff(peer: StaffPeer, socket: LiveSocket, guard: (h: (t: string) => Promise<void>) => (t: string) => void): Connection {
    this.staff.set(socket, peer);
    send(socket, { type: "hello", counters: [...this.counters.keys()] });
    return {
      onMessage: guard(async (text) => {
        const message = parse(StaffMessage, text);
        if (!message) return;
        if (message.type === "typing") {
          if (!roleCan(peer.user.role, "support.chat")) return;
          const chat = await this.deps.db.prepare(`SELECT installation_id AS installationId FROM support_chats WHERE id = ? AND status <> 'closed'`).bind(message.chatId)
            .first<{ installationId: string }>();
          if (chat) this.toVisitors(chat.installationId, { type: "typing", name: firstName(peer.user.name) });
          return;
        }
        if (message.type === "remote.watch") {
          if (!roleCan(peer.user.role, "support.remote")) return;
          const session = await remoteSession(this.deps.db, message.sessionId);
          // The viewer is whoever asked; an admin may take over.
          if (!session || (session.requestedBy.id !== peer.user.id && peer.user.role !== "admin")) { send(socket, { type: "remote.refused", sessionId: message.sessionId }); return; }
          setOf(this.viewers, message.sessionId).add(socket);
          send(socket, { type: "remote.updated", session });
          const agent = this.agents.get(message.sessionId);
          if (agent) send(agent, { type: "remote.peer" });
          return;
        }
        // Signals and ends only from a socket that is watching that session.
        if (!this.viewers.get(message.sessionId)?.has(socket)) return;
        if (message.type === "remote.signal") { const agent = this.agents.get(message.sessionId); if (agent) send(agent, { type: "remote.signal", data: message.data }); }
        else await endRemote(this.remote, message.sessionId, `Ended by ${firstName(peer.user.name) ?? "support"}`);
      }),
      onClose: () => {
        this.staff.delete(socket);
        for (const [sessionId, set] of this.viewers) {
          if (!set.delete(socket)) continue;
          if (!set.size) { this.viewers.delete(sessionId); const agent = this.agents.get(sessionId); if (agent) send(agent, { type: "remote.peer-left" }); }
        }
      },
    };
  }

  private connectVisitor(peer: Extract<Peer, { kind: "visitor" }>, socket: LiveSocket, guard: (h: (t: string) => Promise<void>) => (t: string) => void): Connection {
    setOf(this.visitors, peer.installationId).add(socket);
    return {
      onMessage: guard(async (text) => {
        if (parse(VisitorMessage, text)) this.toStaff({ type: "chat.typing", installationId: peer.installationId });
      }),
      onClose: () => removeFrom(this.visitors, peer.installationId, socket),
    };
  }

  private connectCounter(peer: Extract<Peer, { kind: "counter" }>, socket: LiveSocket, guard: (h: (t: string) => Promise<void>) => (t: string) => void): Connection {
    // One connection per counter: a newer one (after a network change) replaces the old.
    const previous = this.counters.get(peer.installationId);
    this.counters.set(peer.installationId, socket);
    if (previous) previous.close(4000, "Replaced by a newer connection");
    this.toStaff({ type: "counter.online", installationId: peer.installationId, online: true });
    return {
      onMessage: guard(async (text) => {
        const message = parse(CounterMessage, text);
        if (!message) return;
        if (message.type === "ping") { send(socket, { type: "pong" }); return; }
        if (message.type === "remote.answer") { await answerRemote(this.remote, peer.installationId, message); return; }
        const session = await remoteSession(this.deps.db, message.sessionId);
        if (session?.installation.id === peer.installationId) await endRemote(this.remote, message.sessionId, message.reason ?? "Stopped at the PC");
      }),
      onClose: () => {
        if (this.counters.get(peer.installationId) !== socket) return;
        this.counters.delete(peer.installationId);
        this.toStaff({ type: "counter.online", installationId: peer.installationId, online: false });
      },
    };
  }

  private connectAgent(peer: Extract<Peer, { kind: "agent" }>, socket: LiveSocket, guard: (h: (t: string) => Promise<void>) => (t: string) => void): Connection {
    this.agents.get(peer.sessionId)?.close(4000, "Replaced");
    this.agents.set(peer.sessionId, socket);
    void startRemote(this.remote, peer.sessionId).then(() => {
      if (this.viewers.get(peer.sessionId)?.size) send(socket, { type: "remote.peer" });
    }).catch((e) => this.log(`live: start failed: ${e instanceof Error ? e.message : "unknown"}`));
    return {
      onMessage: guard(async (text) => {
        const message = parse(AgentMessage, text);
        if (!message) return;
        if (message.type === "remote.signal") { for (const viewer of this.viewers.get(peer.sessionId) ?? []) send(viewer, { type: "remote.signal", sessionId: peer.sessionId, data: message.data }); }
        else await endRemote(this.remote, peer.sessionId, message.reason ?? "Stopped at the PC");
      }),
      onClose: () => {
        if (this.agents.get(peer.sessionId) !== socket) return;
        this.agents.delete(peer.sessionId);
        // No signalling channel means no way to stop it remotely: the session ends with the window's connection.
        void endRemote(this.remote, peer.sessionId, "Screen sharing stopped").catch((e) => this.log(`live: end failed: ${e instanceof Error ? e.message : "unknown"}`));
      },
    };
  }

  toVisitors(installationId: string, event: LiveEvent): void { for (const socket of this.visitors.get(installationId) ?? []) send(socket, event); }
  toStaff(event: LiveEvent): void {
    for (const [socket, peer] of this.staff) if (roleCan(peer.user.role, "support.chat") || roleCan(peer.user.role, "support.remote")) send(socket, event);
  }
  toCounter(installationId: string, event: LiveEvent): boolean {
    const socket = this.counters.get(installationId);
    if (socket) send(socket, event);
    return socket !== undefined;
  }
  counterOnline(installationId: string): boolean { return this.counters.has(installationId); }
  toRemote(sessionId: string, event: LiveEvent): void {
    for (const viewer of this.viewers.get(sessionId) ?? []) send(viewer, event);
    const agent = this.agents.get(sessionId);
    if (agent) send(agent, event);
  }
  dropAgent(sessionId: string): void {
    const agent = this.agents.get(sessionId);
    if (!agent) return;
    this.agents.delete(sessionId);
    agent.close(4002, "Session ended");
  }
}

function send(socket: LiveSocket, event: LiveEvent): void {
  try { socket.send(JSON.stringify(event)); } catch { /* a closing socket; its onClose cleans up */ }
}
function setOf<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  return set;
}
function removeFrom<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set?.delete(value) && !set.size) map.delete(key);
}
