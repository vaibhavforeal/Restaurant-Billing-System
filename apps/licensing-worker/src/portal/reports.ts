import { LEAD_STAGES, type ReportData } from "./api-types.js";
import { path, queryInt, type Route } from "./context.js";
import { HttpError, json } from "./http.js";
import { ownedBy } from "./scope.js";
import { roleCan } from "./shared.js";

const IST_MONTH = (column: string) => `strftime('%Y-%m', (${column} + 19800000) / 1000, 'unixepoch')`;

/**
 * The numbers behind the business, for a period (this financial year unless chosen), within what the person may see: a sales rep's
 * figures are their own customers' and leads'. Money is cleared payments; revenue by plan is what paid orders were worth.
 */
export const reportRoutes: Route[] = [
  { method: "GET", path: path("/reports"), permission: "reports.read", handler: async (ctx) => {
    const now = ctx.deps.now(), { db } = ctx.deps;
    const local = new Date(now + 330 * 60_000);
    const fyStart = Date.UTC(local.getUTCMonth() >= 3 ? local.getUTCFullYear() : local.getUTCFullYear() - 1, 3, 1) - 330 * 60_000;
    const from = queryInt(ctx.url, "from", fyStart)!, to = queryInt(ctx.url, "to", now + 1)!;
    if (to <= from || to - from > 3 * 366 * 86_400_000) throw new HttpError(400, "Choose a period of up to three years");
    const c = ownedBy(ctx.user, "c.owner_id"), l = ownedBy(ctx.user, "l.owner_id");
    // Twelve whole months to the end of the period, so the chart always has the same shape.
    const end = new Date(to - 1 + 330 * 60_000), monthsFrom = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1) - 330 * 60_000;
    const [byMonth, byPlan, funnel, sources, reps, renewals, trials, tickets, openTickets, resolution] = await Promise.all([
      db.prepare(`SELECT ${IST_MONTH("p.received_at")} AS month, SUM(p.amount_paise) AS paise FROM payments p JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = o.customer_id
        WHERE p.status = 'cleared' AND p.received_at >= ? AND p.received_at < ? AND ${c.sql} GROUP BY month`).bind(monthsFrom, to, ...c.binds).all<{ month: string; paise: number }>(),
      db.prepare(`SELECT o.plan, SUM(o.total_paise) AS paise, COUNT(*) AS orders FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.status = 'paid' AND o.paid_at >= ? AND o.paid_at < ? AND o.total_paise > 0 AND ${c.sql} GROUP BY o.plan`).bind(from, to, ...c.binds).all<{ plan: "basic" | "pro"; paise: number; orders: number }>(),
      db.prepare(`SELECT l.stage, COUNT(*) AS count FROM leads l WHERE l.created_at >= ? AND l.created_at < ? AND ${l.sql} GROUP BY l.stage`).bind(from, to, ...l.binds).all<{ stage: string; count: number }>(),
      db.prepare(`SELECT l.source, COUNT(*) AS leads, SUM(l.stage = 'won') AS won FROM leads l WHERE l.created_at >= ? AND l.created_at < ? AND ${l.sql} GROUP BY l.source ORDER BY leads DESC`)
        .bind(from, to, ...l.binds).all<ReportData["sources"][number]>(),
      roleCan(ctx.user.role, "users.manage") || ctx.user.role === "accounts" || ctx.user.role === "sales"
        ? db.prepare(`SELECT u.id, u.name,
            (SELECT COUNT(*) FROM leads l WHERE l.owner_id = u.id AND l.stage = 'won' AND l.closed_at >= ? AND l.closed_at < ?) AS leadsWon,
            (SELECT COUNT(*) FROM orders o WHERE o.owner_id = u.id AND o.status = 'paid' AND o.total_paise > 0 AND o.paid_at >= ? AND o.paid_at < ?) AS ordersPaid,
            (SELECT COALESCE(SUM(o.total_paise), 0) FROM orders o WHERE o.owner_id = u.id AND o.status = 'paid' AND o.paid_at >= ? AND o.paid_at < ?) AS revenuePaise
          FROM staff_users u WHERE u.role IN ('admin', 'sales') AND ${ctx.user.role === "sales" ? "u.id = ?" : "1 = 1"} ORDER BY revenuePaise DESC, u.name`)
          .bind(from, to, from, to, from, to, ...(ctx.user.role === "sales" ? [ctx.user.id] : [])).all<{ id: string; name: string; leadsWon: number; ordersPaid: number; revenuePaise: number }>()
        : Promise.resolve({ results: [] }),
      // Counters whose paid licence came due in the period, and how many of them now run past it (renewed).
      db.prepare(`SELECT COUNT(DISTINCT i.installation_id) AS due,
          COUNT(DISTINCT CASE WHEN (SELECT MAX(l2.expires_at) FROM licenses l2 WHERE l2.installation_id = i.installation_id) > ? THEN i.installation_id END) AS renewed
        FROM installations i JOIN customers c ON c.id = i.customer_id JOIN licenses l ON l.installation_id = i.installation_id LEFT JOIN orders lo ON lo.id = l.order_id
        WHERE l.expires_at >= ? AND l.expires_at < ? AND lo.kind IS NOT 'trial' AND ${c.sql}`).bind(Math.min(to, now), from, Math.min(to, now), ...c.binds).first<{ due: number; renewed: number }>(),
      db.prepare(`SELECT COUNT(*) AS started, SUM(EXISTS (SELECT 1 FROM orders p WHERE p.customer_id = o.customer_id AND p.kind = 'new' AND p.status = 'paid' AND p.created_at >= o.created_at)) AS converted
        FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.kind = 'trial' AND o.created_at >= ? AND o.created_at < ? AND ${c.sql}`).bind(from, to, ...c.binds).first<{ started: number; converted: number | null }>(),
      db.prepare(`SELECT SUM(t.created_at >= ? AND t.created_at < ?) AS opened, SUM(t.resolved_at >= ? AND t.resolved_at < ?) AS resolved FROM tickets t JOIN customers c ON c.id = t.customer_id
        WHERE ${c.sql}`).bind(from, to, from, to, ...c.binds).first<{ opened: number | null; resolved: number | null }>(),
      db.prepare(`SELECT t.priority, COUNT(*) AS n FROM tickets t JOIN customers c ON c.id = t.customer_id WHERE t.status IN ('open', 'in_progress', 'waiting') AND ${c.sql} GROUP BY t.priority`)
        .bind(...c.binds).all<{ priority: string; n: number }>(),
      db.prepare(`SELECT t.resolved_at - t.created_at AS ms FROM tickets t JOIN customers c ON c.id = t.customer_id WHERE t.resolved_at >= ? AND t.resolved_at < ? AND ${c.sql} ORDER BY ms`)
        .bind(from, to, ...c.binds).all<{ ms: number }>(),
    ]);
    const months: ReportData["revenueByMonth"] = [];
    for (let i = 0; i < 12; i++) {
      const at = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11 + i, 1));
      const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
      months.push({ month, paise: byMonth.results.find((m) => m.month === month)?.paise ?? 0 });
    }
    const durations = resolution.results.map((r) => r.ms);
    const median = durations.length ? durations[Math.floor((durations.length - 1) / 2)]! : null;
    const data: ReportData = {
      from, to, revenueByMonth: months,
      revenueByPlan: (["pro", "basic"] as const).map((plan) => ({ plan, paise: byPlan.results.find((r) => r.plan === plan)?.paise ?? 0, orders: byPlan.results.find((r) => r.plan === plan)?.orders ?? 0 })),
      funnel: LEAD_STAGES.map((stage) => ({ stage, count: funnel.results.find((f) => f.stage === stage)?.count ?? 0 })),
      sources: sources.results.map((s) => ({ ...s, won: s.won ?? 0 })),
      reps: reps.results.map((r) => ({ rep: { id: r.id, name: r.name }, leadsWon: r.leadsWon, ordersPaid: r.ordersPaid, revenuePaise: r.revenuePaise })),
      renewals: { due: renewals!.due, renewed: renewals!.renewed },
      trials: { started: trials!.started, converted: trials!.converted ?? 0 },
      tickets: { opened: tickets!.opened ?? 0, resolved: tickets!.resolved ?? 0, medianHoursToResolve: median === null ? null : Math.round(median / 360_000) / 10,
        openByPriority: Object.fromEntries(openTickets.results.map((t) => [t.priority, t.n])) },
    };
    return json(data);
  } },
];
