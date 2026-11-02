// Remote sessions: staff ask, the PC answers, the sharing window connects, someone ends it. Every step is a row update guarded by the
// state it expects, so a late or repeated message changes nothing; every step is in the activity log and, when there is one, the chat.
import { newToken } from "../secret.js";
import type { D1Like } from "../env.js";
import type { Env } from "../env.js";
import type { LiveHub } from "../live/types.js";
import { iceServersFor } from "../live/turn.js";
import type { RemoteMode, RemoteSession } from "../portal/api-types.js";
import { sha256Hex } from "../secret.js";
import { activityStatement } from "../store.js";
import { addSystemMessage, counterName, firstName } from "./chats.js";

/** The PC shows the request for 60 seconds; the service gives up a little later. */
export const REQUEST_TTL_MS = 75_000;
/** After it is allowed, the sharing window must connect within this. */
const START_TTL_MS = 2 * 60_000;
/** A session ends on its own after an hour. */
export const SESSION_MAX_MS = 60 * 60_000;
/** The path the sharing window connects to with its one-time token. */
export const AGENT_PATH = "/v1/remote/agent";

interface Row {
  origin: "in_app" | "connector"; elevated: number; adminPrompts: number; expiresAt: number | null;
  id: string; status: RemoteSession["status"]; reason: string; modeRequested: RemoteMode; mode: RemoteMode | null; installationId: string | null; outletName: string | null;
  customerId: string | null; customerName: string | null; chatId: string | null; requestedById: string; requestedByName: string | null; approvedByName: string | null;
  requestedAt: number; answeredAt: number | null; startedAt: number | null; endedAt: number | null; endReason: string | null;
}
const COLUMNS = `r.origin, r.elevated, r.admin_prompts AS adminPrompts, r.expires_at AS expiresAt, r.id, r.status, r.reason, r.mode_requested AS modeRequested, r.mode, r.installation_id AS installationId, i.outlet_name AS outletName,
  r.customer_id AS customerId, c.business_name AS customerName, r.chat_id AS chatId, r.requested_by AS requestedById, u.name AS requestedByName,
  r.approved_by_name AS approvedByName, r.requested_at AS requestedAt, r.answered_at AS answeredAt, r.started_at AS startedAt, r.ended_at AS endedAt, r.end_reason AS endReason`;
const FROM = `FROM remote_sessions r LEFT JOIN installations i ON i.installation_id = r.installation_id LEFT JOIN customers c ON c.id = r.customer_id
  LEFT JOIN staff_users u ON u.id = r.requested_by`;
const toSession = (r: Row): RemoteSession => ({
  origin: r.origin, elevated: !!r.elevated, adminPrompts: !!r.adminPrompts, expiresAt: r.expiresAt,
  id: r.id, status: r.status, reason: r.reason, modeRequested: r.modeRequested, mode: r.mode,
  installation: r.installationId ? { id: r.installationId, name: counterName(r.installationId, r.outletName) } : null,
  customer: r.customerId ? { id: r.customerId, name: r.customerName ?? "" } : null, chatId: r.chatId,
  requestedBy: { id: r.requestedById, name: r.requestedByName ?? "Former staff" }, approvedByName: r.approvedByName,
  requestedAt: r.requestedAt, answeredAt: r.answeredAt, startedAt: r.startedAt, endedAt: r.endedAt, endReason: r.endReason,
});

export async function remoteSessionsWhere(db: D1Like, where: string, binds: unknown[], limit = 50): Promise<RemoteSession[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE ${where} ORDER BY r.requested_at DESC LIMIT ?`).bind(...binds, limit).all<Row>();
  return results.map(toSession);
}
export async function remoteSession(db: D1Like, id: string): Promise<RemoteSession | null> {
  return (await remoteSessionsWhere(db, "r.id = ?", [id], 1))[0] ?? null;
}

export interface RemoteDeps { db: D1Like; live: LiveHub | undefined; now: () => number; env: Pick<Env, "TURN_URLS" | "TURN_SECRET"> }

const MODE_WORDS: Record<RemoteMode, string> = { view: "view only", control: "view and control" };
const isOpen = (s: RemoteSession) => s.status === "requested" || s.status === "approved" || s.status === "active";

export async function changed(deps: RemoteDeps, session: RemoteSession, action: string, summary: string, chatLine: string | null): Promise<RemoteSession> {
  const { db, live } = deps, now = deps.now();
  await activityStatement(db, now, { actorId: null, action, entityType: "remote_session", entityId: session.id, customerId: session.customer?.id ?? null, summary }).run();
  const fresh = (await remoteSession(db, session.id))!;
  live?.toRemote(session.id, { type: "remote.updated", session: fresh });
  live?.toStaff({ type: "remote.updated", session: fresh });
  if (fresh.origin === "connector" && fresh.installation) live?.toCounter(fresh.installation.id, { type: "connector.updated", session: fresh });
  if (chatLine && session.chatId) await addSystemMessage(db, live, session.chatId, chatLine, now);
  return fresh;
}

/** The ask, after the route has checked the staff member and that the counter is connected. Pushes the request to the PC. */
export async function requestRemote(deps: RemoteDeps & { uuid: () => string }, staff: { id: string; name: string },
  ask: { installationId: string; customerId: string | null; chatId: string | null; reason: string; mode: RemoteMode }): Promise<RemoteSession> {
  const { db } = deps, now = deps.now(), id = deps.uuid();
  await db.batch([
    db.prepare(`INSERT INTO remote_sessions (id, installation_id, customer_id, chat_id, requested_by, reason, mode_requested, status, requested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?)`).bind(id, ask.installationId, ask.customerId, ask.chatId, staff.id, ask.reason, ask.mode, now),
    activityStatement(db, now, { actorId: staff.id, action: "remote.requested", entityType: "remote_session", entityId: id, customerId: ask.customerId,
      summary: `Asked for remote access (${MODE_WORDS[ask.mode]}): ${ask.reason}` }),
  ]);
  const session = (await remoteSession(db, id))!;
  deps.live?.toCounter(ask.installationId, { type: "remote.request", sessionId: id, agentName: staff.name, reason: ask.reason, mode: ask.mode, expiresInMs: 60_000 });
  deps.live?.toStaff({ type: "remote.updated", session });
  if (ask.chatId) await addSystemMessage(db, deps.live, ask.chatId, `${firstName(staff.name)} asked to ${ask.mode === "control" ? "see and control" : "see"} this PC: ${ask.reason}`, now);
  return session;
}

/**
 * The PC's answer, from the counter's live connection. Only a pending request of this counter, still within its time, can be answered.
 * Allowing never grants more than was asked: a request to view stays view only. On yes the counter gets a one-time token for its sharing window.
 */
export async function answerRemote(deps: RemoteDeps, installationId: string, answer: { sessionId: string; decision: "deny" | RemoteMode; approvedBy: string }): Promise<void> {
  const { db, live } = deps, now = deps.now();
  const session = await remoteSession(db, answer.sessionId);
  if (!session || session.installation?.id !== installationId || session.origin !== "in_app" || session.status !== "requested") return;
  if (answer.decision === "deny") {
    const { meta } = await db.prepare(`UPDATE remote_sessions SET status = 'denied', answered_at = ?, approved_by_name = ? WHERE id = ? AND status = 'requested'`)
      .bind(now, answer.approvedBy, session.id).run();
    if (meta.changes === 1) await changed(deps, session, "remote.denied", `Remote access refused at the PC by ${answer.approvedBy}`, "Remote access was refused at the PC.");
    return;
  }
  const mode: RemoteMode = answer.decision === "control" && session.modeRequested === "control" ? "control" : "view";
  const token = newToken();
  const { meta } = await db.prepare(`UPDATE remote_sessions SET status = 'approved', mode = ?, answered_at = ?, approved_by_name = ?, agent_token_hash = ?
    WHERE id = ? AND status = 'requested' AND requested_at > ?`).bind(mode, now, answer.approvedBy, await sha256Hex(token), session.id, now - REQUEST_TTL_MS).run();
  if (meta.changes !== 1) return;
  live?.toCounter(installationId, {
    type: "remote.start", sessionId: session.id, token, mode, agentPath: AGENT_PATH, agentName: session.requestedBy.name,
    iceServers: await iceServersFor(deps.env, `counter-${session.id.slice(0, 8)}`, now), maxMs: SESSION_MAX_MS,
  });
  await changed(deps, session, "remote.allowed", `Remote access allowed (${MODE_WORDS[mode]}) at the PC by ${answer.approvedBy}`, `${answer.approvedBy} allowed remote access (${MODE_WORDS[mode]}).`);
}

/** The sharing window's token, swapped (once) for its session. Null when unknown, used, or too late. */
export async function claimAgentToken(deps: RemoteDeps, token: string, origin: "in_app" | "connector" = "in_app"): Promise<{ sessionId: string; installationId: string | null; chatId: string | null } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { db } = deps, now = deps.now(), hash = await sha256Hex(token);
  const row = await db.prepare(`SELECT id, installation_id AS installationId, chat_id AS chatId FROM remote_sessions WHERE origin = ? AND agent_token_hash = ? AND status = 'approved' AND answered_at > ?`)
    .bind(origin, hash, now - START_TTL_MS).first<{ id: string; installationId: string | null; chatId: string | null }>();
  if (!row) return null;
  const { meta } = await db.prepare(`UPDATE remote_sessions SET agent_token_hash = NULL WHERE id = ? AND agent_token_hash = ?`).bind(row.id, hash).run();
  return meta.changes === 1 ? { sessionId: row.id, installationId: row.installationId, chatId: row.chatId } : null;
}

/** The sharing window is connected: the session is live. */
export async function startRemote(deps: RemoteDeps, sessionId: string): Promise<void> {
  const { meta } = await deps.db.prepare(`UPDATE remote_sessions SET status = 'active', started_at = ? WHERE id = ? AND status = 'approved'`).bind(deps.now(), sessionId).run();
  const session = await remoteSession(deps.db, sessionId);
  if (meta.changes === 1 && session) await changed(deps, session, "remote.started", "Remote session started", null);
}

/** Ends a session that is still pending or running, whoever ends it. Tells the PC, the viewer and the sharing window. */
export async function endRemote(deps: RemoteDeps, sessionId: string, reason: string, status: "ended" | "expired" = "ended"): Promise<void> {
  const { db, live } = deps, now = deps.now();
  const session = await remoteSession(db, sessionId);
  if (!session || !isOpen(session)) return;
  const { meta } = await db.prepare(`UPDATE remote_sessions SET status = ?, ended_at = ?, end_reason = ?, agent_token_hash = NULL
    WHERE id = ? AND status IN ('requested', 'approved', 'active')`).bind(status, now, reason, sessionId).run();
  if (meta.changes !== 1) return;
  session.installation && live?.toCounter(session.installation.id, { type: "remote.ended", sessionId, reason });
  live?.dropAgent(sessionId);
  const chatLine = status === "expired" ? "No one answered the remote access request." : session.status === "requested" ? "The remote access request was withdrawn." : `Remote session ended: ${reason}.`;
  await changed(deps, session, status === "expired" ? "remote.expired" : "remote.ended", status === "expired" ? "Remote access request expired" : `Remote session ended: ${reason}`, chatLine);
}

/** Runs every few seconds on hosts with a hub: lapses unanswered requests, windows that never connected, and sessions past the hour. */
export async function sweepRemote(deps: RemoteDeps): Promise<void> {
  const now = deps.now();
  const { results } = await deps.db.prepare(`SELECT id, status FROM remote_sessions WHERE
      (status = 'requested' AND ((origin = 'in_app' AND requested_at <= ?) OR (origin = 'connector' AND expires_at <= ?))) OR (status = 'approved' AND answered_at <= ?) OR (status = 'active' AND started_at <= ?)`)
    .bind(now - REQUEST_TTL_MS, now, now - START_TTL_MS, now - SESSION_MAX_MS).all<{ origin: "in_app" | "connector"; elevated: number; adminPrompts: number; expiresAt: number | null;
  id: string; status: string }>();
  for (const row of results) {
    if (row.status === "requested") await endRemote(deps, row.id, "No answer at the PC", "expired");
    else if (row.status === "approved") await endRemote(deps, row.id, "Screen sharing didn't start");
    else await endRemote(deps, row.id, "Time limit reached");
  }
}

/** At start-up nothing is connected, so nothing pending or running can go on. */
export async function endAllOpen(deps: RemoteDeps, reason: string): Promise<void> {
  const { results } = await deps.db.prepare(`SELECT id FROM remote_sessions WHERE status IN ('requested', 'approved', 'active')`).all<{ id: string }>();
  for (const row of results) await endRemote(deps, row.id, reason);
}
