import type { FastifyInstance } from "fastify";
import { localDateKey } from "@forkflow/domain";
import type { AnalyticsDay, AnalyticsHour, CategoryAnalytics, ItemAnalytics, OrderAnalyticsReport, OrderTypeAnalytics } from "@forkflow/domain/operational-reports";
import { z } from "zod";
import { reportRange } from "./sales-reports.js";

/** Read stored bill totals and immutable reporting lines in one snapshot. */
export function registerOrderAnalytics(app: FastifyInstance) {
  app.get("/api/reports/analytics", { preHandler: app.requirePermission("reports.read") }, async (req, reply) => {
    const { from, to, dates, bounds } = reportRange(req.query);
    const { type: orderType } = z.object({ type: z.enum(["all", "parcel", "dine_in"]).default("all") }).parse(req.query);
    const db = app.db;
    const report = db.transaction((): OrderAnalyticsReport => {
      const where = "b.created_at >= ? AND b.created_at < ? AND b.status != 'void'";
      const filter = orderType === "all" ? "" : " AND o.type = ?";
      const params = orderType === "all" ? [...bounds] : [...bounds, orderType];
      const bills = `FROM bills b JOIN orders o ON o.id = b.order_id WHERE ${where}${filter}`;
      const lines = `FROM bill_report_lines l JOIN bills b ON b.id = l.bill_id JOIN orders o ON o.id = b.order_id WHERE ${where}${filter}`;
      // Aggregate bills independently of their lines so multi-item orders count once.
      const counts = db.prepare(`SELECT o.type, COUNT(DISTINCT o.id) AS orderCount, SUM(b.total_paise) AS totalPaise
        FROM bills b JOIN orders o ON o.id = b.order_id WHERE ${where} GROUP BY o.type`).all(...bounds) as Omit<OrderTypeAnalytics, "qty">[];
      const quantities = db.prepare(`SELECT o.type, SUM(l.qty) AS qty FROM bill_report_lines l
        JOIN bills b ON b.id = l.bill_id JOIN orders o ON o.id = b.order_id WHERE ${where} GROUP BY o.type`).all(...bounds) as { type: string; qty: number }[];
      const comparison = (["parcel", "dine_in"] as const).map((type) => ({ type,
        orderCount: counts.find((row) => row.type === type)?.orderCount ?? 0,
        totalPaise: counts.find((row) => row.type === type)?.totalPaise ?? 0,
        qty: quantities.find((row) => row.type === type)?.qty ?? 0 }));
      const totals = comparison.filter((row) => orderType === "all" || row.type === orderType)
        .reduce((sum, row) => ({ orderCount: sum.orderCount + row.orderCount, totalPaise: sum.totalPaise + row.totalPaise, qty: sum.qty + row.qty }), { orderCount: 0, totalPaise: 0, qty: 0 });
      const aggregates = "SUM(l.qty) AS qty, COUNT(DISTINCT o.id) AS orderCount, SUM(l.total_paise) AS totalPaise";
      const items = db.prepare(`SELECT l.product_id AS productId, l.variant_id AS variantId, l.category_id AS categoryId, l.name, l.category_name AS category,
        ${aggregates}, SUM(CASE WHEN o.type = 'parcel' THEN l.qty ELSE 0 END) AS takeawayQty,
        SUM(CASE WHEN o.type = 'dine_in' THEN l.qty ELSE 0 END) AS tableQty ${lines}
        GROUP BY l.product_id, l.variant_id, l.name, l.category_id, l.category_name
        ORDER BY qty DESC, totalPaise DESC, l.name, l.product_id, l.variant_id, l.category_id, l.category_name`).all(...params) as ItemAnalytics[];
      const categories = db.prepare(`SELECT l.category_id AS categoryId, l.category_name AS name, ${aggregates} ${lines}
        GROUP BY l.category_id, l.category_name ORDER BY totalPaise DESC, qty DESC, name, l.category_id`).all(...params) as CategoryAnalytics[];
      const dailyData = db.prepare(`SELECT strftime('%Y-%m-%d', b.created_at / 1000, 'unixepoch', 'localtime') AS date,
        COUNT(DISTINCT CASE WHEN o.type = 'parcel' THEN o.id END) AS takeawayOrders,
        COUNT(DISTINCT CASE WHEN o.type = 'dine_in' THEN o.id END) AS tableOrders, SUM(b.total_paise) AS totalPaise
        ${bills} GROUP BY date`).all(...params) as AnalyticsDay[];
      const dailyByDate = new Map(dailyData.map((row) => [row.date, row]));
      const daily = dates.map((date) => dailyByDate.get(date) ?? { date, takeawayOrders: 0, tableOrders: 0, totalPaise: 0 });
      const hours = db.prepare(`SELECT CAST(strftime('%H', b.created_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
        COUNT(DISTINCT o.id) AS orderCount, SUM(b.total_paise) AS totalPaise ${bills} GROUP BY hour`).all(...params) as AnalyticsHour[];
      const hourly = Array.from({ length: 24 }, (_, hour) => hours.find((row) => row.hour === hour) ?? { hour, orderCount: 0, totalPaise: 0 });
      const generatedAt = Date.now();
      return { from, to, today: localDateKey(generatedAt), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        generatedAt, orderType, totals, comparison, items, categories, daily, hourly };
    })();
    reply.header("Cache-Control", "no-store");
    return { report };
  });
}
