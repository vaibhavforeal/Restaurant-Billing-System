import { DAY_MS } from "../dates.js";
import type { RenewalRow } from "./api-types.js";
import { path, type Ctx, type Route } from "./context.js";
import { json } from "./http.js";
import { installationsWhere } from "./installations.js";
import { ownedBy } from "./scope.js";

type Window = "7" | "30" | "60" | "expired" | "trials";
const WINDOWS: Window[] = ["7", "30", "60", "expired", "trials"];

/** Which counters a renewal window holds: paid licences ending within N days, those already past their end, or trials. */
function windowSql(window: Window, now: number): { sql: string; binds: unknown[] } {
  if (window === "expired") return { sql: "l.expires_at < ? AND l.expires_at >= ? AND lo.kind IS NOT 'trial'", binds: [now, now - 90 * DAY_MS] };
  // Every trial still running (they last days, not months) and those that ended in the last fortnight: the ones to convert.
  if (window === "trials") return { sql: "lo.kind = 'trial' AND l.expires_at < ? AND l.expires_at >= ?", binds: [now + 31 * DAY_MS, now - 14 * DAY_MS] };
  return { sql: "l.expires_at >= ? AND l.expires_at < ? AND lo.kind IS NOT 'trial'", binds: [now, now + Number(window) * DAY_MS] };
}

/** Counters due for renewal within what the staff member may see, soonest first, with any renewal order already drafted for them. */
export async function renewalRows(ctx: Ctx, window: Window, limit = 200): Promise<RenewalRow[]> {
  const now = ctx.deps.now(), scope = ownedBy(ctx.user, "c.owner_id"), w = windowSql(window, now);
  const counters = await installationsWhere(ctx, `i.order_id IS NOT NULL AND ${scope.sql} AND ${w.sql}`, [...scope.binds, ...w.binds], "l.expires_at", limit);
  if (!counters.length) return [];
  const ids = counters.map((c) => c.id), marks = ids.map(() => "?").join(", ");
  const [customers, open] = await Promise.all([
    ctx.deps.db.prepare(`SELECT i.installation_id AS installationId, c.id, c.business_name AS name, c.code, c.owner_id AS ownerId, u.name AS ownerName,
        (SELECT MIN(f.due_at) FROM follow_ups f WHERE f.customer_id = c.id AND f.status = 'open') AS nextFollowUpAt
      FROM installations i JOIN customers c ON c.id = i.customer_id LEFT JOIN staff_users u ON u.id = c.owner_id WHERE i.installation_id IN (${marks})`).bind(...ids)
      .all<{ installationId: string; id: string; name: string; code: string; ownerId: string | null; ownerName: string | null; nextFollowUpAt: number | null }>(),
    ctx.deps.db.prepare(`SELECT t.installation_id AS installationId, o.id, o.code, o.status FROM order_installations t JOIN orders o ON o.id = t.order_id
      WHERE t.installation_id IN (${marks}) AND o.status IN ('draft', 'confirmed') ORDER BY o.created_at DESC`).bind(...ids)
      .all<{ installationId: string; id: string; code: string; status: "draft" | "confirmed" }>(),
  ]);
  return counters.map((installation) => {
    const c = customers.results.find((r) => r.installationId === installation.id)!;
    const o = open.results.find((r) => r.installationId === installation.id);
    return {
      installation, customer: { id: c.id, name: c.name, code: c.code, owner: c.ownerId ? { id: c.ownerId, name: c.ownerName ?? "" } : null },
      openRenewal: o ? { id: o.id, code: o.code, status: o.status } : null, nextFollowUpAt: c.nextFollowUpAt,
    };
  });
}

export async function renewalCounts(ctx: Ctx): Promise<Record<Window, number>> {
  const now = ctx.deps.now(), scope = ownedBy(ctx.user, "c.owner_id");
  const entries = await Promise.all(WINDOWS.map(async (window) => {
    const w = windowSql(window, now);
    const row = await ctx.deps.db.prepare(`SELECT COUNT(*) AS n FROM installations i JOIN customers c ON c.id = i.customer_id
      JOIN licenses l ON l.installation_id = i.installation_id AND l.revision = (SELECT MAX(revision) FROM licenses WHERE installation_id = i.installation_id)
      LEFT JOIN orders lo ON lo.id = l.order_id WHERE i.order_id IS NOT NULL AND ${scope.sql} AND ${w.sql}`).bind(...scope.binds, ...w.binds).first<{ n: number }>();
    return [window, row!.n] as const;
  }));
  return Object.fromEntries(entries) as Record<Window, number>;
}

export const renewalRoutes: Route[] = [
  { method: "GET", path: path("/renewals"), permission: "customers.read", handler: async (ctx) => {
    const requested = ctx.url.searchParams.get("window") as Window | null;
    const window = requested && WINDOWS.includes(requested) ? requested : "30";
    const [rows, counts] = await Promise.all([renewalRows(ctx, window), renewalCounts(ctx)]);
    return json({ window, renewals: rows, counts });
  } },
];
