import { z } from "zod";
import type { Env } from "../env.js";
import type { Deps } from "../issue.js";
import { path, type Route } from "../portal/context.js";
import { conflict, HttpError, json, notFound, readBody } from "../portal/http.js";
import { addSystemMessage, chatSummary } from "../support/chats.js";
import { changed, newToken, remoteSession, SESSION_MAX_MS } from "../support/remote.js";
import { sha256Hex } from "../secret.js";
import { iceServersFor } from "../live/turn.js";
import { activityStatement } from "../store.js";

const INVITATION_MS = 30 * 60_000;
export const CONSENT_MS = 15 * 60_000;
export interface ConnectorManifest { version: string; size: number; sha256: string; url: string; signature: string; }
export interface ConnectorDistribution {
  enabled: boolean;
  manifest(): Promise<ConnectorManifest>;
  stubUrl(version: string, filename: string, expiresAt: number): Promise<string>;
}
const credential = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Ask = z.object({ chatId: z.string().uuid().optional(), customerId: z.string().uuid().optional(),
  reason: z.string().trim().min(1).max(200), mode: z.enum(["view", "control"]) }).strict()
  .refine((a) => !!a.chatId !== !!a.customerId, "Choose a chat or customer");
const Redeem = z.union([z.object({ token: credential }).strict(), z.object({ code: z.string().trim().regex(/^[A-Za-z0-9-]{12,19}$/) }).strict()]);
const Consent = z.object({ token: credential, mode: z.enum(["deny", "view", "control"]), approvedBy: z.string().trim().min(1).max(80),
  elevated: z.boolean(), adminPrompts: z.boolean().default(false) }).strict();
type TokenRow = { sessionId: string; chatId: string };
const remoteDeps = (deps: Deps, env: Env) => ({ db: deps.db, now: deps.now, live: env.LIVE, env });
function available(env: Env): ConnectorDistribution {
  if (!env.CONNECTOR?.enabled || !env.LIVE) throw new HttpError(503, "Support Connector is not available yet", "connector_unavailable");
  return env.CONNECTOR;
}
const invalid = () => new HttpError(403, "This invitation has expired or has already been used. Ask support for a new link.", "invalid_invitation");
const normalizeCode = (code: string) => code.replace(/-/g, "").toUpperCase();

export const connectorRoutes: Route[] = [
  { method: "GET", path: path("/connector"), permission: "support.remote", handler: async (ctx) => json({ available: !!ctx.env.CONNECTOR?.enabled }) },
  { method: "POST", path: path("/connector"), permission: "support.remote", handler: async (ctx) => {
    available(ctx.env);
    const ask = await readBody(ctx.request, Ask), { db, uuid, now } = ctx.deps, at = now();
    let chat = ask.chatId ? await chatSummary(db, ask.chatId) : null;
    if (ask.chatId && !chat) throw notFound("That chat");
    if (!chat) {
      if (!await db.prepare("SELECT id FROM customers WHERE id = ?").bind(ask.customerId).first()) throw notFound("That customer");
      const id = uuid();
      await db.prepare(`INSERT INTO support_chats (id, number, customer_id, installation_id, status, assignee_id, created_at, last_message_at)
        VALUES (?, (SELECT COALESCE(MAX(number),1000)+1 FROM support_chats), ?, NULL, 'active', ?, ?, ?)`)
        .bind(id, ask.customerId, ctx.user.id, at, at).run();
      chat = (await chatSummary(db, id))!;
    }
    if (chat.status === "closed") throw conflict("Reopen this chat before sending a connector");
    if (await db.prepare(`SELECT id FROM remote_sessions WHERE (chat_id = ? OR (installation_id IS NOT NULL AND installation_id = ?))
      AND status IN ('requested','approved','active')`).bind(chat.id, chat.installation?.id ?? null).first()) throw conflict("A remote session is already open for this chat or counter");
    const sessionId = uuid(), token = newToken();
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const raw = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => alphabet[n % alphabet.length]).join("");
    const code = raw.match(/.{4}/g)!.join("-");
    try {
      await db.batch([
        db.prepare(`INSERT INTO remote_sessions (id, installation_id, customer_id, chat_id, requested_by, reason, mode_requested, requested_at, origin, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connector', ?)`)
          .bind(sessionId, chat.installation?.id ?? null, chat.customer.id, chat.id, ctx.user.id, ask.reason, ask.mode, at, at + INVITATION_MS),
        db.prepare(`INSERT INTO connector_tokens (token_hash, code_hash, session_id, chat_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, 'download', ?, ?)`)
          .bind(await sha256Hex(token), await sha256Hex(raw), sessionId, chat.id, at, at + INVITATION_MS),
        activityStatement(db, at, { actorId: ctx.user.id, action: "connector.requested", entityType: "remote_session", entityId: sessionId, customerId: chat.customer.id, summary: `Sent Support Connector: ${ask.reason}` }),
      ]);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw conflict("A connector session is already open");
      throw error;
    }
    const url = `${ctx.url.origin}/support/connector?t=${token}`;
    await addSystemMessage(db, ctx.env.LIVE, chat.id, `${ctx.user.name} sent Support Connector. The invitation expires in 30 minutes; ask support for the link or fallback code.`, at, `${ctx.user.name} sent Support Connector. Download: ${url}\nIf the file was renamed, enter code ${code}. Expires in 30 minutes.`);
    const session = (await remoteSession(db, sessionId))!;
    ctx.env.LIVE?.toStaff({ type: "remote.updated", session });
    if (chat.installation) ctx.env.LIVE?.toCounter(chat.installation.id, { type: "connector.request", session, url });
    return json({ url, code, sessionId, chatId: chat.id, session, expiresAt: at + INVITATION_MS }, 201);
  } },
];

/** Public bootstrap endpoints are routed before the support SPA. Fail closed when rate limiting is unavailable. */
export async function connectorRoute(request: Request, env: Env, deps: Deps): Promise<Response> {
  try {
    const distribution = available(env), url = new URL(request.url), { db } = deps, at = deps.now();
    const limiter = env.CONNECTOR_LIMITER ?? env.LOGIN_LIMITER ?? env.LIMITER;
    let limited = true;
    try { limited = !(await limiter.limit({ key: `connector:${request.headers.get("cf-connecting-ip") ?? "unknown"}` })).success; } catch { /* fail closed */ }
    if (limited) return json({ error: "Too many attempts. Try again shortly." }, 429);
    if (request.method === "GET" && url.pathname === "/support/connector-runtime/latest.json") return json(await distribution.manifest());
    if (request.method === "GET" && url.pathname === "/support/connector") {
      const token = credential.safeParse(url.searchParams.get("t"));
      if (!token.success) throw invalid();
      const row = await db.prepare(`SELECT c.number FROM connector_tokens t JOIN remote_sessions r ON r.id = t.session_id JOIN support_chats c ON c.id = t.chat_id
        WHERE t.token_hash = ? AND t.kind = 'download' AND t.used_at IS NULL AND t.expires_at > ? AND r.status = 'requested' AND r.expires_at > ?`)
        .bind(await sha256Hex(token.data), at, at).first<{ number: number }>();
      if (!row) throw invalid();
      const manifest = await distribution.manifest();
      return new Response(null, { status: 302, headers: { location: await distribution.stubUrl(manifest.version, `MasalaPOS-Support-C-${row.number}-${token.data}.exe`, at + 120_000),
        "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }
    if (request.method === "POST" && url.pathname === "/v1/connector/redeem") {
      const body = await readBody(request, Redeem);
      const hash = await sha256Hex("token" in body ? body.token : normalizeCode(body.code));
      const where = "token" in body ? "t.token_hash" : "t.code_hash";
      const next = newToken(), nextHash = await sha256Hex(next);
      const result = await db.batch([
        db.prepare(`INSERT INTO connector_tokens (token_hash, session_id, chat_id, kind, created_at, expires_at)
          SELECT ?, t.session_id, t.chat_id, 'consent', ?, ? FROM connector_tokens t JOIN remote_sessions r ON r.id = t.session_id
          WHERE ${where} = ? AND t.kind = 'download' AND t.used_at IS NULL AND t.expires_at > ? AND r.status = 'requested' AND r.expires_at > ?`)
          .bind(nextHash, at, at + CONSENT_MS, hash, at, at),
        db.prepare(`UPDATE connector_tokens SET used_at = ? WHERE kind = 'download' AND session_id = (SELECT session_id FROM connector_tokens WHERE token_hash = ?)`)
          .bind(at, nextHash),
        db.prepare(`UPDATE remote_sessions SET expires_at = ? WHERE id = (SELECT session_id FROM connector_tokens WHERE token_hash = ?)`)
          .bind(at + CONSENT_MS, nextHash),
      ]) as Array<{ meta: { changes: number } }>;
      if (result[0]?.meta.changes !== 1) throw invalid();
      const row = (await db.prepare("SELECT session_id AS sessionId, chat_id AS chatId FROM connector_tokens WHERE token_hash = ?").bind(nextHash).first<TokenRow>())!;
      return json({ token: next, session: await remoteSession(db, row.sessionId), expiresAt: at + CONSENT_MS });
    }
    if (request.method === "POST" && url.pathname === "/v1/connector/consent") {
      const body = await readBody(request, Consent), hash = await sha256Hex(body.token);
      const row = await db.prepare("SELECT session_id AS sessionId, chat_id AS chatId FROM connector_tokens WHERE token_hash = ? AND kind = 'consent' AND used_at IS NULL AND expires_at > ?")
        .bind(hash, at).first<TokenRow>();
      if (!row) throw invalid();
      const session = await remoteSession(db, row.sessionId);
      if (!session || session.origin !== "connector" || session.status !== "requested") throw invalid();
      if (body.mode === "control" && session.modeRequested !== "control") throw new HttpError(400, "Only view access was requested");
      if (body.adminPrompts && (!body.elevated || body.mode === "deny")) throw new HttpError(400, "Admin prompt access requires elevation and consent");
      const signal = newToken(), allowed = body.mode !== "deny";
      const result = await db.batch([
        db.prepare(`UPDATE remote_sessions SET status = ?, mode = ?, answered_at = ?, approved_by_name = ?, elevated = ?, admin_prompts = ?, agent_token_hash = ?
          WHERE id = ? AND status = 'requested' AND expires_at > ? AND EXISTS (SELECT 1 FROM connector_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?)`)
          .bind(allowed ? "approved" : "denied", allowed ? body.mode : null, at, body.approvedBy, +body.elevated, +body.adminPrompts,
            allowed ? await sha256Hex(signal) : null, row.sessionId, at, hash, at),
        db.prepare("UPDATE connector_tokens SET used_at = ? WHERE token_hash = ? AND changes() = 1").bind(at, hash),
      ]) as Array<{ meta: { changes: number } }>;
      if (result[0]?.meta.changes !== 1) throw invalid();
      const fresh = await changed(remoteDeps(deps, env), session, allowed ? "remote.allowed" : "remote.denied",
        `${body.approvedBy} ${allowed ? `allowed ${body.mode}${body.adminPrompts ? ' with admin prompts' : ''}` : 'declined'} Support Connector`,
        `${body.approvedBy} ${allowed ? `allowed remote access (${body.mode})` : 'declined remote access'}.`);
      return json({ session: fresh, ...(allowed ? { token: signal, agentPath: "/v1/connector/live", maxMs: SESSION_MAX_MS,
        iceServers: await iceServersFor(env, `connector-${session.id.slice(0,8)}`, at) } : {}) });
    }
    throw notFound("That endpoint");
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
}
