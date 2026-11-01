import { z } from "zod";
import type { Database, RoleName } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";

const ROLES: RoleName[] = ["admin", "cashier", "waiter", "kitchen"];

/**
 * The largest discount, as a percent of the bill subtotal, this user may give without approval; null means no limit.
 * A per-user override wins over the role's limit. A role with no row is capped at 0, so a missing setting never opens the limit.
 */
export function effectiveDiscountCap(db: Database, user: { id: string; role: RoleName }): number | null {
  if (user.role === "admin") return null;
  const own = db.prepare("SELECT max_discount_percent AS v FROM users WHERE id = ?").get(user.id) as { v: number | null } | undefined;
  if (own?.v !== null && own?.v !== undefined) return own.v;
  const row = db.prepare("SELECT max_percent AS v FROM discount_caps WHERE role = ?").get(user.role) as { v: number | null } | undefined;
  return row ? row.v : 0;
}

export const DiscountCapsUpdate = z.object({
  // Admin is always unlimited, so only the other roles are editable.
  caps: z.array(z.object({ role: z.enum(["cashier", "waiter", "kitchen"]), maxPercent: z.number().min(0).max(100).nullable() })).min(1).max(3),
});

export function registerDiscountCaps(app: FastifyInstance): void {
  const manage = app.requirePermission("settings.manage");
  const read = () => ({ caps: (app.db.prepare("SELECT role, max_percent AS maxPercent FROM discount_caps").all() as Array<{ role: RoleName; maxPercent: number | null }>)
    .sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role)) });

  app.get("/api/discount-caps", { preHandler: manage }, async () => read());
  app.put("/api/discount-caps", { preHandler: manage }, async (req) => {
    const body = DiscountCapsUpdate.parse(req.body);
    if (new Set(body.caps.map((c) => c.role)).size !== body.caps.length) throw httpError(400, "Each role can appear once");
    app.db.transaction(() => {
      for (const c of body.caps) app.db.prepare("UPDATE discount_caps SET max_percent = ? WHERE role = ?").run(c.maxPercent, c.role);
    })();
    return read();
  });
  /** What the signed-in user may discount, so the billing screen can say so before a PIN is needed. */
  app.get("/api/discount-caps/mine", { preHandler: app.requirePermission("bills.create") }, async (req) => ({
    maxPercent: effectiveDiscountCap(app.db, req.user),
  }));
}
