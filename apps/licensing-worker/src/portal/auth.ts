import { z } from "zod";
import type { Env } from "../env.js";
import type { Deps } from "../issue.js";
import { sha256Hex } from "../secret.js";
import { HttpError, json, readBody } from "./http.js";
import { dummyHash, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "./passwords.js";
import type { StaffUser } from "./api-types.js";

export type { StaffUser } from "./api-types.js";

const COOKIE = "ff_portal";
/** A session ends 12 hours after sign-in, or after 2 hours without a request, whichever comes first. */
export const SESSION_MS = 12 * 60 * 60 * 1000;
export const IDLE_MS = 2 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60_000;
/** Five wrong passwords lock the account for 15 minutes, whatever address they come from. */
export const LOCK_AFTER = 5;
export const LOCK_MS = 15 * 60 * 1000;

const USER_COLUMNS = `u.id, u.email, u.name, u.role, u.must_change_password AS mustChangePassword`;
type UserRecord = Omit<StaffUser, "mustChangePassword"> & { mustChangePassword: number };
/** Only these fields ever leave the Worker; the row also carries the password hash and lock state. */
const toUser = (r: UserRecord): StaffUser => ({ id: r.id, email: r.email, name: r.name, role: r.role, mustChangePassword: r.mustChangePassword === 1 });

const cookie = (value: string, maxAgeSeconds: number) => `${COOKIE}=${value}; Path=/portal; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
export const sessionToken = (request: Request): string | null =>
  request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`))?.[1] ?? null;
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const Credentials = z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(512) }).strict();
export const NewPassword = z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`).max(200);

async function limited(env: Env, request: Request): Promise<boolean> {
  const limiter = env.LOGIN_LIMITER ?? env.LIMITER;
  // Fails open like the licensing routes; the per-account lock below does not depend on it.
  try { return !(await limiter.limit({ key: `portal:${request.headers.get("cf-connecting-ip") ?? "unknown"}` })).success; } catch { return false; }
}

export async function signIn(deps: Deps, env: Env, request: Request): Promise<Response> {
  if (await limited(env, request)) throw new HttpError(429, "Too many sign-in attempts. Try again in a minute.");
  const { email, password } = await readBody(request, Credentials);
  const { db } = deps, now = deps.now();
  const row = await db.prepare(`SELECT ${USER_COLUMNS}, u.password_hash AS passwordHash, u.active, u.failed_attempts AS failedAttempts, u.locked_until AS lockedUntil
    FROM staff_users u WHERE u.email = ?`).bind(email).first<UserRecord & { passwordHash: string; active: number; failedAttempts: number; lockedUntil: number | null }>();
  if (!row || row.active !== 1) {
    await verifyPassword(password, await dummyHash());
    throw new HttpError(401, "Wrong email or password");
  }
  if (row.lockedUntil !== null && row.lockedUntil > now) {
    throw new HttpError(429, `Too many wrong passwords for this account. Try again in ${Math.ceil((row.lockedUntil - now) / 60_000)} minutes.`);
  }
  if (!(await verifyPassword(password, row.passwordHash))) {
    const failed = row.failedAttempts + 1, lock = failed >= LOCK_AFTER;
    await db.prepare(`UPDATE staff_users SET failed_attempts = ?, locked_until = ? WHERE id = ?`).bind(lock ? 0 : failed, lock ? now + LOCK_MS : null, row.id).run();
    throw new HttpError(401, "Wrong email or password");
  }
  const token = newToken();
  await db.batch([
    db.prepare(`UPDATE staff_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?`).bind(now, row.id),
    db.prepare(`DELETE FROM staff_sessions WHERE expires_at <= ? OR last_used_at <= ?`).bind(now, now - IDLE_MS),
    db.prepare(`INSERT INTO staff_sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(await sha256Hex(token), row.id, now, now, now + SESSION_MS),
  ]);
  return json({ user: toUser(row) }, 200, { "set-cookie": cookie(token, SESSION_MS / 1000) });
}

/** The signed-in staff member, or null when there is no live session (expired, idle too long, or the account was deactivated). */
export async function currentUser(deps: Deps, request: Request): Promise<{ user: StaffUser; tokenHash: string } | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token), now = deps.now();
  const row = await deps.db.prepare(`SELECT ${USER_COLUMNS}, s.last_used_at AS lastUsedAt FROM staff_sessions s JOIN staff_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND s.last_used_at > ? AND u.active = 1`).bind(tokenHash, now, now - IDLE_MS).first<UserRecord & { lastUsedAt: number }>();
  if (!row) return null;
  if (now - row.lastUsedAt >= TOUCH_EVERY_MS) await deps.db.prepare(`UPDATE staff_sessions SET last_used_at = ? WHERE token_hash = ?`).bind(now, tokenHash).run();
  return { user: toUser(row), tokenHash };
}

export async function signOut(deps: Deps, tokenHash: string): Promise<Response> {
  await deps.db.prepare(`DELETE FROM staff_sessions WHERE token_hash = ?`).bind(tokenHash).run();
  return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
}

/** A staff member changes their own password; their other sessions end. Required before anything else after a temporary password. */
export async function changePassword(deps: Deps, request: Request, user: StaffUser, tokenHash: string): Promise<Response> {
  const { current, next } = await readBody(request, z.object({ current: z.string().min(1).max(512), next: NewPassword }).strict());
  const { db } = deps;
  const row = await db.prepare(`SELECT password_hash AS passwordHash FROM staff_users WHERE id = ?`).bind(user.id).first<{ passwordHash: string }>();
  if (!row || !(await verifyPassword(current, row.passwordHash))) throw new HttpError(400, "Your current password is wrong");
  if (current === next) throw new HttpError(400, "Choose a password different from the current one");
  const now = deps.now();
  await db.batch([
    db.prepare(`UPDATE staff_users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?`).bind(await hashPassword(next), now, user.id),
    db.prepare(`DELETE FROM staff_sessions WHERE user_id = ? AND token_hash <> ?`).bind(user.id, tokenHash),
  ]);
  return json({ user: { ...user, mustChangePassword: false } });
}

/** Ends every session of a staff member: after a role change, deactivation or a password reset. */
export const revokeSessionsStatement = (deps: Deps, userId: string) => deps.db.prepare(`DELETE FROM staff_sessions WHERE user_id = ?`).bind(userId);
