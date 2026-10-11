import { z } from "zod";
import type { D1Like } from "./env.js";
import type { Deps } from "./issue.js";
import { isWellFormedSecret, sha256Hex, verifyInstallationSecret } from "./secret.js";
import { deleteExpiredSessionsStatement, getInstallation, insertSessionStatement, sessionInstallation } from "./store.js";

export const SESSION_TTL_MS = 30 * 60_000;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const CreateSessionRequest = z.object({ installationId: z.string().uuid() });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 32 random bytes as 43 base64url characters (no padding). */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mints a checkout session for an installation that proves it holds the secret. Only the token's hash is stored; the token itself is returned once. */
export async function handleCreateSession(deps: Deps, body: unknown, secret: string | null): Promise<Response> {
  const parsed = CreateSessionRequest.safeParse(body);
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  if (!isWellFormedSecret(secret)) return json({ error: "unauthorized" }, 401);
  const { db } = deps;
  const found = await getInstallation(db, parsed.data.installationId);
  if (!found) return json({ error: "unknown_installation" }, 404);
  const installation = await verifyInstallationSecret(db, found, secret);
  if (!installation) return json({ error: "unauthorized" }, 401);

  const session = newToken(), now = deps.now(), expiresAt = now + SESSION_TTL_MS;
  // Only this installation's own expired sessions are swept, so the cost of cleaning up stays with the caller that made them.
  await db.batch([
    deleteExpiredSessionsStatement(db, installation.installationId, now),
    insertSessionStatement(db, { tokenHash: await sha256Hex(session), installationId: installation.installationId, expiresAt, createdAt: now }),
  ]);
  return json({ session, expiresAt });
}

/** The installation a checkout session belongs to, or null when the token is malformed, unknown or expired. */
export async function resolveSession(db: D1Like, token: string | null, now: number): Promise<string | null> {
  if (token === null || !TOKEN_FORMAT.test(token)) return null;
  return sessionInstallation(db, await sha256Hex(token), now);
}
