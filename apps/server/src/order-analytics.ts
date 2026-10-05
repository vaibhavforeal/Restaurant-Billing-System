import type { FastifyInstance } from "fastify";
import { localDateKey } from "@forkflow/domain";
import type { AnalyticsDay, AnalyticsHour, CategoryAnalytics, ItemAnalytics, OrderAnalyticsReport, OrderTypeAnalytics } from "@forkflow/domain/operational-reports";
import { z } from "zod";
import { reportRange } from "./sales-reports.js";

/**
 * Read stored bill totals and immutable reporting lines in one snapshot. Bills (void ones too) count on their issue
 * date; credit notes and their lines subtract on the credit-note date, attributed to the credited bill's order type.
 */
export function registerOrderAnalytics(app: FastifyInstance) {
  app.get("/api/reports/analytics", { preHandler: app.requirePermission("reports.read") }, async (req, reply) => {
    const { from, to, dates, bounds } = reportRange(req.query);
    const { type: orderType } = z.object({ type: z.enum(["all", "parcel", "dine_in"]).default("all") }).parse(req.query);
    const db = app.db;
    const report = db.transaction((): OrderAnalyticsReport => {
      // Credit rows carry no order id, so order counts come from issued bills only.
      const billEntries = `SELECT b.created_at AS at, o.id AS orderId, o.type, b.total_paise AS total
          FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.created_at >= ? AND b.created_at < ?
        UNION ALL
        SELECT c.created_at, NULL, o.type, -c.total_paise
          FROM credit_notes c JOIN bills b ON b.id = c.bill_id JOIN orders o ON o.id = b.order_id WHERE c.created_at >= ? AND c.created_at < ?`;
      const lineEntries = `SELECT l.product_id, l.variant_id, l.category_id, l.name, l.category_name, o.id AS orderId, o.type, l.qty, l.total_paise AS total
          FROM bill_report_lines l JOIN bills b ON b.id = l.bill_id JOIN orders o ON o.id = b.order_id WHERE b.created_at >= ? AND b.created_at < ?
        UNION ALL
        SELECT l.product_id, l.variant_id, l.category_id, l.name, l.category_name, NULL, o.type, -cl.qty, -cl.total_paise
          FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id
          JOIN bill_report_lines l ON l.bill_id = c.bill_id AND l.order_item_id = cl.order_item_id
          JOIN bills b ON b.id = c.bill_id JOIN orders o ON o.id = b.order_id WHERE c.created_at >= ? AND c.created_at < ?`;
      const filter = orderType === "all" ? "" : " WHERE type = ?";
      const both = [...bounds, ...bounds];
      const params = orderType === "all" ? both : [...both, orderType];
      const bills = `FROM (${billEntries})${filter}`;
      const lines = `FROM (${lineEntries})${filter}`;
      // Aggregate bills independently of their lines so multi-item orders count once.
      const counts = db.prepare(`SELECT type, COUNT(DISTINCT orderId) AS orderCount, SUM(total) AS totalPaise
        FROM (${billEntries}) GROUP BY type`).all(...both) as Omit<OrderTypeAnalytics, "qty">[];
      const quantities = db.prepare(`SELECT type, SUM(qty) AS qty FROM (${lineEntries}) GROUP BY type`).all(...both) as { type: string; qty: number }[];
      const comparison = (["parcel", "dine_in"] as const).map((type) => ({ type,
        orderCount: counts.find((row) => row.type === type)?.orderCount ?? 0,
        totalPaise: counts.find((row) => row.type === type)?.totalPaise ?? 0,
        qty: quantities.find((row) => row.type === type)?.qty ?? 0 }));
      const totals = comparison.filter((row) => orderType === "all" || row.type === orderType)
        .reduce((sum, row) => ({ orderCount: sum.orderCount + row.orderCount, totalPaise: sum.totalPaise + row.totalPaise, qty: sum.qty + row.qty }), { orderCount: 0, totalPaise: 0, qty: 0 });
      const aggregates = "SUM(qty) AS qty, COUNT(DISTINCT orderId) AS orderCount, SUM(total) AS totalPaise";
      const items = db.prepare(`SELECT product_id AS productId, variant_id AS variantId, category_id AS categoryId, name, category_name AS category,
        ${aggregates}, SUM(CASE WHEN type = 'parcel' THEN qty ELSE 0 END) AS takeawayQty,
        SUM(CASE WHEN type = 'dine_in' THEN qty ELSE 0 END) AS tableQty ${lines}
        GROUP BY product_id, variant_id, name, category_id, category_name
        ORDER BY qty DESC, totalPaise DESC, name, product_id, variant_id, category_id, category_name`).all(...params) as ItemAnalytics[];
      const categories = db.prepare(`SELECT category_id AS categoryId, category_name AS name, ${aggregates} ${lines}
        GROUP BY category_id, category_name ORDER BY totalPaise DESC, qty DESC, name, category_id`).all(...params) as CategoryAnalytics[];
      const dailyData = db.prepare(`SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') AS date,
        COUNT(DISTINCT CASE WHEN type = 'parcel' THEN orderId END) AS takeawayOrders,
        COUNT(DISTINCT CASE WHEN type = 'dine_in' THEN orderId END) AS tableOrders, SUM(total) AS totalPaise
        ${bills} GROUP BY date`).all(...params) as AnalyticsDay[];
      const dailyByDate = new Map(dailyData.map((row) => [row.date, row]));
      const daily = dates.map((date) => dailyByDate.get(date) ?? { date, takeawayOrders: 0, tableOrders: 0, totalPaise: 0 });
      const hours = db.prepare(`SELECT CAST(strftime('%H', at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
        COUNT(DISTINCT orderId) AS orderCount, SUM(total) AS totalPaise ${bills} GROUP BY hour`).all(...params) as AnalyticsHour[];
      const hourly = Array.from({ length: 24 }, (_, hour) => hours.find((row) => row.hour === hour) ?? { hour, orderCount: 0, totalPaise: 0 });
      const generatedAt = Date.now();
      return { from, to, today: localDateKey(generatedAt), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        generatedAt, orderType, totals, comparison, items, categories, daily, hourly };
    })();
    reply.header("Cache-Control", "no-store");
    return { report };
  });
}
