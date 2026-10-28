import type { FastifyInstance } from "fastify";
import { requireIntegration } from "./integrations.js";
import { loyaltySettings, loyaltyTiers } from "./loyalty.js";
import { reportRange } from "./sales-reports.js";
import { segmentCustomers } from "./customer-segments.js";
import { requireModule } from "./modules.js";

/**
 * CRM insights for a date range. Customer counts use non-void bills in the range: a customer is "new" when their first
 * ever bill falls in the range and "returning" when they had a bill before it. Points figures are ledger movements in the
 * range; the liability is today's unspent points at today's point value.
 */
export function registerCrmReports(app: FastifyInstance): void {
  const db = app.db;
  app.get("/api/reports/crm", { preHandler: [app.requirePermission("reports.read"), requireModule(app, "reports"), requireIntegration(app, "crm")] }, async (req) => {
    const { from, to, bounds: [start, end] } = reportRange(req.query);
    const bills = db.prepare(`SELECT COUNT(*) AS bills, COUNT(customer_id) AS withCustomer FROM bills WHERE status <> 'void' AND created_at >= ? AND created_at < ?`)
      .get(start, end) as { bills: number; withCustomer: number };
    const visitors = db.prepare(`SELECT b.customer_id AS id, COUNT(*) AS visits, SUM(b.total_paise) AS spend,
        (SELECT MIN(x.created_at) FROM bills x WHERE x.customer_id = b.customer_id AND x.status <> 'void') AS first
      FROM bills b WHERE b.customer_id IS NOT NULL AND b.status <> 'void' AND b.created_at >= ? AND b.created_at < ? GROUP BY b.customer_id`)
      .all(start, end) as Array<{ id: string; visits: number; spend: number; first: number }>;
    const newCustomers = visitors.filter((v) => v.first >= start).length;
    const points = Object.fromEntries((db.prepare(`SELECT kind, COALESCE(SUM(points), 0) AS n FROM loyalty_ledger WHERE created_at >= ? AND created_at < ? GROUP BY kind`)
      .all(start, end) as Array<{ kind: string; n: number }>).map((r) => [r.kind, r.n]));
    const settings = loyaltySettings(db);
    const everyone = segmentCustomers(db);
    const outstanding = everyone.reduce((sum, c) => sum + Math.max(0, c.points), 0);
    const tierCounts = new Map<string, number>();
    for (const c of everyone) if (c.isActive) tierCounts.set(c.tierName ?? "", (tierCounts.get(c.tierName ?? "") ?? 0) + 1);
    const tiers = settings.tiersEnabled
      ? [...loyaltyTiers(db).filter((t) => t.isActive).map((t) => ({ name: t.name, customers: tierCounts.get(t.name) ?? 0 })), { name: "No tier", customers: tierCounts.get("") ?? 0 }]
      : [];
    const ratings = db.prepare(`SELECT COUNT(*) AS count, AVG(overall) AS average, SUM(overall <= 2) AS low FROM customer_feedback WHERE created_at >= ? AND created_at < ?`)
      .get(start, end) as { count: number; average: number | null; low: number | null };
    const spread = db.prepare(`SELECT overall AS rating, COUNT(*) AS count FROM customer_feedback WHERE created_at >= ? AND created_at < ? GROUP BY overall ORDER BY overall`)
      .all(start, end) as Array<{ rating: number; count: number }>;
    const byId = new Map(everyone.map((c) => [c.id, c]));
    const top = [...visitors].sort((a, b) => b.spend - a.spend || b.visits - a.visits).slice(0, 10)
      .map((v) => ({ id: v.id, name: byId.get(v.id)?.name ?? "", phone: byId.get(v.id)?.phone ?? "", visits: v.visits, spendPaise: v.spend, tierName: byId.get(v.id)?.tierName ?? null }));
    return {
      from, to,
      customers: {
        total: everyone.filter((c) => c.isActive).length, active: visitors.length, new: newCustomers, returning: visitors.length - newCustomers,
        repeatRate: visitors.length ? visitors.filter((v) => v.visits > 1 || v.first < start).length / visitors.length : 0,
        optedIn: everyone.filter((c) => c.isActive && c.marketingOptIn).length,
      },
      bills: { ...bills, attachRate: bills.bills ? bills.withCustomer / bills.bills : 0 },
      points: {
        enabled: settings.enabled, issued: (points["earn"] ?? 0) + Math.max(0, points["adjust"] ?? 0), redeemed: -(points["redeem"] ?? 0),
        expired: -(points["expire"] ?? 0), reversed: points["reverse"] ?? 0,
        outstanding, liabilityPaise: outstanding * settings.pointValuePaise,
      },
      tiers,
      feedback: { count: ratings.count, average: ratings.average, low: ratings.low ?? 0, spread },
      topCustomers: top,
    };
  });
}
