// The restaurant's side of support chat. The counter's POS server (holding the installation secret) asks for a one-time link and opens it
// in the browser; the link turns into an mp_support cookie that speaks for that counter's chats, and nothing else, for a day.
import { overLimit } from "../limits.js";
import { newToken } from "../secret.js";
import { z } from "zod";
import type { Env } from "../env.js";
import type { Deps } from "../issue.js";
import { HttpError, json, readBody, SECURITY_HEADERS, serveSpa } from "../portal/http.js";
import { getInstallation } from "../store.js";
import { activityStatement } from "../store.js";
import { sha256Hex, verifyInstallationSecret } from "../secret.js";
import { insertMessageStatement, lastMessageId, MESSAGE_MAX, openChatId, publishChat, touchChatStatement, visitorChat } from "./chats.js";

const COOKIE = "mp_support";
const LINK_TTL_MS = 10 * 60_000;
const VISITOR_TTL_MS = 24 * 60 * 60_000;


const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const LinkRequest = z.object({ installationId: z.string().uuid() }).passthrough();

/** POST /v1/support/link, from a counter: a link to its support chat, good once for 10 minutes. */
export async function handleSupportLink(deps: Deps, request: Request, secret: string | null): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
  const parsed = LinkRequest.safeParse(body);
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  const found = await getInstallation(deps.db, parsed.data.installationId);
  const installation = found ? await verifyInstallationSecret(deps.db, found, secret) : null;
  if (!installation) return json({ error: "unknown_installation", message: "This counter isn't registered with MasalaPOS yet." }, 403);
  if (!installation.customerId) return json({ error: "not_enrolled", message: "Activate this counter with its Customer ID and Order ID first." }, 409);
  const token = newToken(), now = deps.now();
  await deps.db.batch([
    deps.db.prepare(`DELETE FROM support_links WHERE expires_at <= ?`).bind(now),
    deps.db.prepare(`INSERT INTO support_links (token_hash, installation_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(await sha256Hex(token), installation.installationId, now, now + LINK_TTL_MS),
  ]);
  return json({ url: `${new URL(request.url).origin}/support/start?t=${token}`, expiresAt: now + LINK_TTL_MS });
}

/** The visitor session behind a request's mp_support cookie, or null. */
export async function currentVisitor(deps: Pick<Deps, "db" | "now">, request: Request): Promise<{ installationId: string; sessionHash: string } | null> {
  const token = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`))?.[1];
  if (!token) return null;
  const sessionHash = await sha256Hex(token);
  const row = await deps.db.prepare(`SELECT v.installation_id AS installationId FROM support_visitors v JOIN installations i ON i.installation_id = v.installation_id
    WHERE v.session_hash = ? AND v.expires_at > ? AND i.customer_id IS NOT NULL`).bind(sessionHash, deps.now()).first<{ installationId: string }>();
  return row ? { installationId: row.installationId, sessionHash } : null;
}

const NewMessage = z.object({
  body: z.string().trim().min(1, "Write a message").max(MESSAGE_MAX),
  name: z.string().trim().min(1, "Tell us your name").max(80).optional(),
  phone: z.string().trim().max(20).regex(/^[0-9+ ()-]*$/, "Use digits only").optional(),
}).strict();

const limited = (env: Env, request: Request) => overLimit(env.LIMITER, request, "support");

/** Everything under /support: the link exchange, the chat page's API, and the page itself. */
export async function supportRoute(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/support/start") return await start(deps, url);
    if (url.pathname.startsWith("/support/api/")) return await api(request, env, deps, url);
    return await serveSpa(request, env, url, "/support", "support page");
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    throw error;
  }
}

async function start(deps: Deps, url: URL): Promise<Response> {
  const token = url.searchParams.get("t") ?? "", now = deps.now();
  const back = (query: string) => new Response(null, { status: 303, headers: { location: `${url.origin}/support/${query}`, "cache-control": "no-store", ...SECURITY_HEADERS } });
  if (!TOKEN.test(token)) return back("?link=expired");
  const hash = await sha256Hex(token);
  const link = await deps.db.prepare(`SELECT installation_id AS installationId FROM support_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`)
    .bind(hash, now).first<{ installationId: string }>();
  if (!link) return back("?link=expired");
  const { meta } = await deps.db.prepare(`UPDATE support_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`).bind(now, hash).run();
  if (meta.changes !== 1) return back("?link=expired");
  const session = newToken();
  await deps.db.batch([
    deps.db.prepare(`DELETE FROM support_visitors WHERE expires_at <= ?`).bind(now),
    deps.db.prepare(`INSERT INTO support_visitors (session_hash, installation_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(await sha256Hex(session), link.installationId, now, now + VISITOR_TTL_MS),
  ]);
  const response = back("");
  response.headers.append("set-cookie", `${COOKIE}=${session}; Path=/support; HttpOnly; Secure; SameSite=Strict; Max-Age=${VISITOR_TTL_MS / 1000}`);
  return response;
}

async function api(request: Request, env: Env, deps: Deps, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.headers.get("origin") !== url.origin) throw new HttpError(403, "Send messages from the chat page itself", "bad_origin");
  const visitor = await currentVisitor(deps, request);
  if (!visitor) throw new HttpError(401, "This chat link has expired. Click Get support in MasalaPOS again.", "signed_out");
  const p = url.pathname.slice("/support/api".length);
  if (request.method === "GET" && p === "/chat") {
    const after = Number(url.searchParams.get("after") ?? 0);
    return json({ ...(await visitorChat(deps.db, visitor.installationId, Number.isSafeInteger(after) && after > 0 ? after : 0)), live: env.LIVE !== undefined });
  }
  if (request.method === "POST" && p === "/messages") {
    if (await limited(env, request)) throw new HttpError(429, "That's a lot of messages at once. Wait a moment and send again.");
    const body = await readBody(request, NewMessage);
    const { db } = deps, now = deps.now();
    let chatId = await openChatId(db, visitor.installationId);
    let after = 0;
    if (chatId) {
      after = await lastMessageId(db, chatId);
      await db.batch([insertMessageStatement(db, chatId, "customer", null, body.body, now), touchChatStatement(db, chatId, now),
        ...(body.name ? [db.prepare(`UPDATE support_chats SET visitor_name = ?, visitor_phone = COALESCE(?, visitor_phone) WHERE id = ?`).bind(body.name, body.phone || null, chatId)] : [])]);
    } else {
      if (!body.name) throw new HttpError(400, "Tell us your name so support knows who they're talking to", "name_required");
      const installation = await getInstallation(db, visitor.installationId);
      if (!installation?.customerId) throw new HttpError(409, "This counter is no longer activated");
      chatId = deps.uuid();
      await db.batch([
        db.prepare(`INSERT INTO support_chats (id, number, customer_id, installation_id, visitor_name, visitor_phone, status, created_at, last_message_at)
          SELECT ?, COALESCE(MAX(number), 1000) + 1, ?, ?, ?, ?, 'waiting', ?, ? FROM support_chats`)
          .bind(chatId, installation.customerId, installation.installationId, body.name, body.phone || null, now, now),
        insertMessageStatement(db, chatId, "customer", null, body.body, now),
        activityStatement(db, now, { actorId: null, action: "chat.opened", entityType: "support_chat", entityId: chatId, customerId: installation.customerId,
          summary: `${body.name} started a support chat from ${installation.outletName ?? "a counter"}` }),
      ]);
    }
    await publishChat(db, env.LIVE, chatId, after);
    return json({ ...(await visitorChat(db, visitor.installationId)), live: env.LIVE !== undefined }, 201);
  }
  throw new HttpError(404, "Not found", "not_found");
}

/** The chat page (apps/portal's support entry, built into dist/support). */
