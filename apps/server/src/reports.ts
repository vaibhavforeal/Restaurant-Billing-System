import type { FastifyInstance } from "fastify";
import { localDateKey } from "@forkflow/domain";
import { z } from "zod";
import { httpError } from "./http-error.js";

export function registerReports(app: FastifyInstance) {
  app.get("/api/reports/day-end", { preHandler: app.requirePermission("reports.read") }, async (req) => {
    const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(localDateKey(Date.now())) }).parse(req.query);
    const start = new Date(`${date}T00:00:00`);
    if (!Number.isFinite(start.getTime()) || localDateKey(start.getTime()) !== date) throw httpError(400, "Invalid report date");
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const bounds = [start.getTime(), end.getTime()];
    const sales = app.db.prepare(`SELECT COUNT(*) AS billCount, COALESCE(SUM(subtotal_paise),0) AS subtotalPaise,
      COALESCE(SUM(discount_paise),0) AS discountPaise, COALESCE(SUM(cgst_paise),0) AS cgstPaise,
      COALESCE(SUM(sgst_paise),0) AS sgstPaise, COALESCE(SUM(rounding_paise),0) AS roundingPaise,
      COALESCE(SUM(total_paise),0) AS totalPaise,
      COALESCE(SUM(CASE WHEN status = 'unpaid' THEN total_paise ELSE 0 END),0) AS outstandingPaise
      FROM bills WHERE created_at >= ? AND created_at < ? AND status != 'void'`).get(...bounds);
    const taxes = app.db.prepare(`SELECT t.gst_rate AS gstRate, SUM(t.taxable_paise) AS taxablePaise,
      SUM(t.cgst_paise) AS cgstPaise, SUM(t.sgst_paise) AS sgstPaise FROM bill_taxes t JOIN bills b ON b.id = t.bill_id
      WHERE b.created_at >= ? AND b.created_at < ? AND b.status != 'void' GROUP BY t.gst_rate ORDER BY t.gst_rate`).all(...bounds);
    const payments = app.db.prepare(`SELECT p.mode, SUM(p.amount_paise) AS amountPaise FROM payments p
      JOIN bills b ON b.id = p.bill_id WHERE p.created_at >= ? AND p.created_at < ? AND b.status != 'void' GROUP BY p.mode`).all(...bounds);
    const cancellations = app.db.prepare("SELECT COUNT(*) AS orderCount FROM orders WHERE status = 'cancelled' AND closed_at >= ? AND closed_at < ?").get(...bounds);
    return { report: { date, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, sales, taxes, payments, cancellations } };
  });
}
