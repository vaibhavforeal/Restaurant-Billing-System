import type { HomeData, OrderSummary } from "./api-types.js";
import { path, type Route } from "./context.js";
import { followUpsWhere } from "./followups.js";
import { json } from "./http.js";
import { renewalCounts, renewalRows } from "./renewals.js";
import { ownedBy } from "./scope.js";
import { roleCan } from "./shared.js";
import { ticketsWhere } from "./tickets.js";

const IST_OFFSET_MS = 330 * 60_000;
/** Midnight in India at the start of the day `at` falls in, and at the start of its month. */
export function istStarts(at: number): { day: number; month: number } {
  const local = new Date(at + IST_OFFSET_MS);
  return {
    day: Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - IST_OFFSET_MS,
    month: Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - IST_OFFSET_MS,
  };
}

/** The first screen after sign-in: what this person has to do today, and what is waiting on money, renewals and support. */
export const homeRoutes: Route[] = [
  { method: "GET", path: path("/home"), handler: async (ctx) => {
    const { db } = ctx.deps, now = ctx.deps.now(), { day, month } = istStarts(now), role = ctx.user.role;
    const scope = ownedBy(ctx.user, "c.owner_id");
    const canFollow = roleCan(role, "followups.write");
    const [followUps, followCounts, renewals, counts, waiting, waitingItems, money] = await Promise.all([
      canFollow ? followUpsWhere(ctx, "f.owner_id = ? AND f.status = 'open' AND f.due_at < ?", [ctx.user.id, day + 86_400_000], "f.due_at", 6) : [],
      // Overdue is past its time; due today is still to come before midnight in India.
      db.prepare(`SELECT SUM(due_at < ?) AS overdue, SUM(due_at >= ? AND due_at < ?) AS today FROM follow_ups WHERE owner_id = ? AND status = 'open'`)
        .bind(now, now, day + 86_400_000, ctx.user.id).first<{ overdue: number | null; today: number | null }>(),
      renewalRows(ctx, "30", 5),
      renewalCounts(ctx),
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(MAX(0, o.total_paise - (SELECT COALESCE(SUM(p.amount_paise), 0) FROM payments p WHERE p.order_id = o.id AND p.status = 'cleared'))), 0) AS owed
        FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'confirmed' AND o.kind <> 'trial' AND ${scope.sql}`).bind(...scope.binds).first<{ n: number; owed: number }>(),
      db.prepare(`SELECT o.id, o.code, o.kind, o.status, o.plan, o.term_months AS termMonths, o.term_days AS termDays, o.outlets, o.seats_used AS seatsUsed, o.total_paise AS totalPaise,
          (SELECT COALESCE(SUM(p.amount_paise), 0) FROM payments p WHERE p.order_id = o.id AND p.status = 'cleared') AS paidPaise, c.id AS customerId, c.business_name AS customerName,
          c.code AS customerCode, o.created_at AS createdAt, o.credit_until AS creditUntil
        FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'confirmed' AND o.kind <> 'trial' AND ${scope.sql} ORDER BY o.confirmed_at LIMIT 5`).bind(...scope.binds)
        .all<Omit<OrderSummary, "customer" | "owner"> & { customerId: string; customerName: string; customerCode: string }>(),
      db.prepare(`SELECT (SELECT COALESCE(SUM(p.amount_paise), 0) FROM payments p JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = o.customer_id
            WHERE p.status = 'cleared' AND p.received_at >= ? AND ${scope.sql}) AS received,
          (SELECT COUNT(*) FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.issued_at >= ? AND i.cancelled_at IS NULL AND ${scope.sql}) AS invoices,
          (SELECT COUNT(*) FROM customers c WHERE c.created_at >= ? AND ${scope.sql}) AS customers`)
        .bind(month, ...scope.binds, month, ...scope.binds, month, ...scope.binds).first<{ received: number; invoices: number; customers: number }>(),
    ]);
    let tickets: HomeData["tickets"] = null;
    if (roleCan(role, "tickets.read")) {
      const mine = role === "support";
      const [items, open] = await Promise.all([
        ticketsWhere(ctx, ["t.status IN ('open', 'in_progress', 'waiting')", ...(mine ? ["(t.assignee_id = ? OR t.assignee_id IS NULL)"] : [])], mine ? [ctx.user.id] : [],
          "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at", 5),
        db.prepare(`SELECT COUNT(*) AS n, SUM(t.priority = 'urgent') AS urgent FROM tickets t JOIN customers c ON c.id = t.customer_id
          WHERE t.status IN ('open', 'in_progress', 'waiting') AND ${scope.sql}`).bind(...scope.binds).first<{ n: number; urgent: number | null }>(),
      ]);
      tickets = { open: open!.n, urgent: open!.urgent ?? 0, items };
    }
    let leads: HomeData["leads"] = null;
    if (roleCan(role, "leads.read")) {
      const leadScope = ownedBy(ctx.user, "l.owner_id");
      const { results } = await db.prepare(`SELECT l.stage, COUNT(*) AS n FROM leads l WHERE l.stage NOT IN ('won', 'lost') AND ${leadScope.sql} GROUP BY l.stage`).bind(...leadScope.binds).all<{ stage: string; n: number }>();
      leads = { open: results.reduce((sum, r) => sum + r.n, 0), byStage: Object.fromEntries(results.map((r) => [r.stage, r.n])) };
    }
    const data: HomeData = {
      followUps: { overdue: followCounts?.overdue ?? 0, dueToday: followCounts?.today ?? 0, items: followUps },
      renewals: { due30: counts["30"], expired: counts.expired, items: renewals },
      orders: { waiting: waiting!.n, owedPaise: waiting!.owed, items: waitingItems.results.map(({ customerId, customerName, customerCode, ...o }) => ({ ...o, customer: { id: customerId, name: customerName, code: customerCode }, owner: null })) },
      tickets, leads,
      month: { receivedPaise: money!.received, invoices: money!.invoices, newCustomers: money!.customers },
    };
    return json(data);
  } },
];
