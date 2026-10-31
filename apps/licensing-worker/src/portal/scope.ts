import type { StaffUser } from "./auth.js";
import { notFound } from "./http.js";
import type { Ctx } from "./context.js";
import { seesOnlyOwn } from "./shared.js";

/**
 * The one place that limits rows to what a staff member may see. Sales reps see only the customers assigned to them, and with them
 * those customers' orders, counters, invoices and tickets; everyone else sees every customer. `column` is the owner column to test
 * (a customer's, or a lead's). Every list and detail query takes its WHERE from here.
 */
export function ownedBy(user: StaffUser, column: string): { sql: string; binds: unknown[] } {
  return seesOnlyOwn(user.role) ? { sql: `${column} = ?`, binds: [user.id] } : { sql: "1 = 1", binds: [] };
}

/** The customer's id when the staff member may see it; otherwise the same 404 as a customer that does not exist. */
export async function visibleCustomer(ctx: Ctx, customerId: string): Promise<{ id: string; ownerId: string | null; name: string; code: string; stateCode: string | null }> {
  const scope = ownedBy(ctx.user, "owner_id");
  const row = await ctx.deps.db.prepare(`SELECT id, owner_id AS ownerId, business_name AS name, code, state_code AS stateCode FROM customers WHERE id = ? AND ${scope.sql}`)
    .bind(customerId, ...scope.binds).first<{ id: string; ownerId: string | null; name: string; code: string; stateCode: string | null }>();
  if (!row) throw notFound("That customer");
  return row;
}
