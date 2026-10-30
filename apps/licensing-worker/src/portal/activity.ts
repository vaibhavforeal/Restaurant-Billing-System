import type { D1Like } from "../env.js";
import { path, queryInt, type Route } from "./context.js";
import type { ActivityItem, ActivityPage } from "./api-types.js";
import { json } from "./http.js";

interface Row { id: number; at: number; actorId: string | null; actorName: string | null; action: string; entityType: string; entityId: string; customerId: string | null; customerName: string | null; summary: string }

const PAGE = 50;

/**
 * Newest first, `PAGE` at a time: pass the last page's `nextBefore` as `before` for the next one. `filters` are ANDed column
 * conditions, already safe SQL with their values in `binds`.
 */
export async function activityPage(db: D1Like, filters: string[], binds: unknown[], before: number | null): Promise<ActivityPage> {
  const where = [...filters, ...(before !== null ? ["a.id < ?"] : [])];
  const { results } = await db.prepare(`SELECT a.id, a.at, a.actor_id AS actorId, u.name AS actorName, a.action, a.entity_type AS entityType, a.entity_id AS entityId,
      a.customer_id AS customerId, c.business_name AS customerName, a.summary
    FROM activity_log a LEFT JOIN staff_users u ON u.id = a.actor_id LEFT JOIN customers c ON c.id = a.customer_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.id DESC LIMIT ?`)
    .bind(...binds, ...(before !== null ? [before] : []), PAGE + 1).all<Row>();
  const entries = results.slice(0, PAGE).map((r) => ({
    id: r.id, at: r.at, action: r.action, entityType: r.entityType, entityId: r.entityId, summary: r.summary,
    actor: r.actorId ? { id: r.actorId, name: r.actorName ?? "Former staff" } : null,
    customer: r.customerId ? { id: r.customerId, name: r.customerName ?? "" } : null,
  }));
  return { entries, nextBefore: results.length > PAGE ? entries[entries.length - 1]!.id : null };
}

export const activityRoutes: Route[] = [
  // Everything, for admins. Customer, order and ticket pages show their own history through their own routes and scope.
  { method: "GET", path: path("/activity"), permission: "activity.read", handler: async (ctx) => {
    const q = ctx.url.searchParams, filters: string[] = [], binds: unknown[] = [];
    const add = (sql: string, value: unknown) => { filters.push(sql); binds.push(value); };
    if (q.get("actorId")) add("a.actor_id = ?", q.get("actorId"));
    if (q.get("system") === "1") filters.push("a.actor_id IS NULL");
    if (q.get("entityType")) add("a.entity_type = ?", q.get("entityType"));
    if (q.get("customerId")) add("a.customer_id = ?", q.get("customerId"));
    const from = queryInt(ctx.url, "from"), to = queryInt(ctx.url, "to");
    if (from !== null) add("a.at >= ?", from);
    if (to !== null) add("a.at < ?", to);
    return json(await activityPage(ctx.deps.db, filters, binds, queryInt(ctx.url, "before")));
  } },
];
