import { z } from "zod";
import { NewPassword, revokeSessionsStatement } from "./auth.js";
import { logBy, path, type Ctx, type Route } from "./context.js";
import { conflict, HttpError, json, notFound, readBody } from "./http.js";
import { hashPassword } from "./passwords.js";
import type { StaffRecord } from "./api-types.js";
import { ROLE_NAMES, ROLES, type Role } from "./shared.js";

const COLUMNS = `id, email, name, role, active, must_change_password AS mustChangePassword, locked_until AS lockedUntil, last_login_at AS lastLoginAt, created_at AS createdAt`;
type Row = Omit<StaffRecord, "active" | "mustChangePassword" | "locked"> & { active: number; mustChangePassword: number; lockedUntil: number | null };
const toRecord = (r: Row, now: number): StaffRecord => {
  const { lockedUntil, ...rest } = r;
  return { ...rest, active: r.active === 1, mustChangePassword: r.mustChangePassword === 1, locked: lockedUntil !== null && lockedUntil > now };
};

const Email = z.string().trim().toLowerCase().email("Enter a valid email").max(254);
const Name = z.string().trim().min(1, "Enter a name").max(80);
const NewUser = z.object({ email: Email, name: Name, role: z.enum(ROLES), password: NewPassword }).strict();
const UserChange = z.object({ name: Name.optional(), role: z.enum(ROLES).optional(), active: z.boolean().optional() }).strict();

async function staffRow(ctx: Ctx, id: string): Promise<Row> {
  const row = await ctx.deps.db.prepare(`SELECT ${COLUMNS} FROM staff_users WHERE id = ?`).bind(id).first<Row>();
  if (!row) throw notFound("That staff member");
  return row;
}

async function activeAdmins(ctx: Ctx): Promise<number> {
  return (await ctx.deps.db.prepare(`SELECT COUNT(*) AS n FROM staff_users WHERE role = 'admin' AND active = 1`).first<{ n: number }>())!.n;
}

export const usersRoutes: Route[] = [
  // Everyone signed in may list active colleagues, to assign leads, tickets and follow-ups.
  { method: "GET", path: path("/staff"), handler: async (ctx) => {
    const { results } = await ctx.deps.db.prepare(`SELECT id, name, role FROM staff_users WHERE active = 1 ORDER BY name`).all<{ id: string; name: string; role: Role }>();
    return json({ staff: results });
  } },
  { method: "GET", path: path("/users"), permission: "users.manage", handler: async (ctx) => {
    const { results } = await ctx.deps.db.prepare(`SELECT ${COLUMNS} FROM staff_users ORDER BY active DESC, name`).all<Row>();
    return json({ users: results.map((r) => toRecord(r, ctx.deps.now())) });
  } },
  { method: "POST", path: path("/users"), permission: "users.manage", handler: async (ctx) => {
    const body = await readBody(ctx.request, NewUser);
    const { db } = ctx.deps, now = ctx.deps.now(), id = ctx.deps.uuid();
    if (await db.prepare(`SELECT 1 AS hit FROM staff_users WHERE email = ?`).bind(body.email).first()) throw conflict("Someone already uses that email", "email_taken");
    await db.batch([
      db.prepare(`INSERT INTO staff_users (id, email, name, role, password_hash, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(id, body.email, body.name, body.role, await hashPassword(body.password), now, now),
      logBy(ctx, { action: "user.created", entityType: "user", entityId: id, customerId: null, summary: `Added ${body.name} (${ROLE_NAMES[body.role]})` }),
    ]);
    return json({ user: toRecord(await staffRow(ctx, id), now) }, 201);
  } },
  { method: "PATCH", path: path("/users/:id"), permission: "users.manage", handler: async (ctx) => {
    const change = await readBody(ctx.request, UserChange);
    const before = await staffRow(ctx, ctx.params[0]!);
    const demoted = before.role === "admin" && before.active === 1 && ((change.role !== undefined && change.role !== "admin") || change.active === false);
    // The portal can never be left without an admin who can sign in.
    if (demoted && await activeAdmins(ctx) <= 1) throw conflict("Keep at least one active admin. Make someone else an admin first.", "last_admin");
    const name = change.name ?? before.name, role = change.role ?? before.role, active = change.active ?? before.active === 1;
    const access = role !== before.role || active !== (before.active === 1);
    const { db } = ctx.deps, now = ctx.deps.now();
    const what = [name !== before.name && `renamed to ${name}`, role !== before.role && `role ${ROLE_NAMES[before.role]} → ${ROLE_NAMES[role]}`,
      active !== (before.active === 1) && (active ? "reactivated" : "deactivated")].filter(Boolean).join(", ");
    if (!what) return json({ user: toRecord(before, now) });
    await db.batch([
      db.prepare(`UPDATE staff_users SET name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?`).bind(name, role, active ? 1 : 0, now, before.id),
      // A new role or a deactivation takes effect at once: their sessions end and they sign in again.
      ...(access ? [revokeSessionsStatement(ctx.deps, before.id)] : []),
      logBy(ctx, { action: "user.changed", entityType: "user", entityId: before.id, customerId: null, summary: `${before.name}: ${what}` }),
    ]);
    return json({ user: toRecord(await staffRow(ctx, before.id), now) });
  } },
  { method: "POST", path: path("/users/:id/password"), permission: "users.manage", handler: async (ctx) => {
    const { password } = await readBody(ctx.request, z.object({ password: NewPassword }).strict());
    const before = await staffRow(ctx, ctx.params[0]!);
    if (before.id === ctx.user.id) throw new HttpError(400, "Change your own password from your account menu instead");
    const { db } = ctx.deps, now = ctx.deps.now();
    await db.batch([
      db.prepare(`UPDATE staff_users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`)
        .bind(await hashPassword(password), now, before.id),
      revokeSessionsStatement(ctx.deps, before.id),
      logBy(ctx, { action: "user.password_reset", entityType: "user", entityId: before.id, customerId: null, summary: `Reset the password of ${before.name}` }),
    ]);
    return json({ user: toRecord(await staffRow(ctx, before.id), now) });
  } },
];
