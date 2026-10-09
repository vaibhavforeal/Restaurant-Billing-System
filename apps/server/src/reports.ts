import type { FastifyInstance } from "fastify";
import { localDateKey } from "@forkflow/domain";
import { z } from "zod";
import { httpError } from "./http-error.js";

interface ModeAmount { mode: string; amountPaise: number }

export function registerReports(app: FastifyInstance) {
  app.get("/api/reports/day-end", { preHandler: app.requirePermission("reports.read") }, async (req) => {
    const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(localDateKey(Date.now())) }).parse(req.query);
    const start = new Date(`${date}T00:00:00`);
    if (!Number.isFinite(start.getTime()) || localDateKey(start.getTime()) !== date) throw httpError(400, "Invalid report date");
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const bounds = [start.getTime(), end.getTime()];
    const db = app.db;
    // Gross figures are every bill issued this day (void ones too) and every payment received; voids and refunds
    // are credit notes subtracted on their own date, so a closed day never changes. One read transaction keeps
    // every section on the same snapshot.
    return db.transaction(() => {
      const sales = db.prepare(`SELECT COUNT(*) AS billCount, COALESCE(SUM(subtotal_paise),0) AS subtotalPaise,
        COALESCE(SUM(discount_paise),0) AS discountPaise, COALESCE(SUM(cgst_paise),0) AS cgstPaise,
        COALESCE(SUM(sgst_paise),0) AS sgstPaise, COALESCE(SUM(rounding_paise),0) AS roundingPaise,
        COALESCE(SUM(total_paise),0) AS totalPaise,
        COALESCE(SUM(CASE WHEN status = 'unpaid' THEN total_paise ELSE 0 END),0) AS outstandingPaise
        FROM bills WHERE created_at >= ? AND created_at < ?`).get(...bounds) as { cgstPaise: number; sgstPaise: number; totalPaise: number };
      const taxes = db.prepare(`SELECT t.gst_rate AS gstRate, SUM(t.taxable_paise) AS taxablePaise,
        SUM(t.cgst_paise) AS cgstPaise, SUM(t.sgst_paise) AS sgstPaise FROM bill_taxes t JOIN bills b ON b.id = t.bill_id
        WHERE b.created_at >= ? AND b.created_at < ? GROUP BY t.gst_rate ORDER BY t.gst_rate`).all(...bounds) as Array<{ taxablePaise: number }>;
      // A `zomato` payment is a receivable from Zomato, not money in the drawer: it is reported on its own line and
      // kept out of every cash, UPI and card figure.
      const payments = db.prepare(`SELECT mode, SUM(amount_paise) AS amountPaise FROM payments
        WHERE created_at >= ? AND created_at < ? AND mode <> 'zomato' GROUP BY mode ORDER BY mode`).all(...bounds) as ModeAmount[];
      const zomatoReceivablePaise = (db.prepare("SELECT COALESCE(SUM(amount_paise),0) AS amountPaise FROM payments WHERE mode = 'zomato' AND created_at >= ? AND created_at < ?")
        .get(...bounds) as { amountPaise: number }).amountPaise;
      const credit = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(taxable_paise),0) AS taxablePaise, COALESCE(SUM(cgst_paise),0) AS cgstPaise,
        COALESCE(SUM(sgst_paise),0) AS sgstPaise, COALESCE(SUM(total_paise),0) AS totalPaise
        FROM credit_notes WHERE created_at >= ? AND created_at < ?`).get(...bounds) as { count: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; totalPaise: number };
      const creditTaxes = db.prepare(`SELECT t.gst_rate AS gstRate, SUM(t.taxable_paise) AS taxablePaise,
        SUM(t.cgst_paise) AS cgstPaise, SUM(t.sgst_paise) AS sgstPaise FROM credit_note_taxes t JOIN credit_notes c ON c.id = t.credit_note_id
        WHERE c.created_at >= ? AND c.created_at < ? GROUP BY t.gst_rate ORDER BY t.gst_rate`).all(...bounds);
      const refunds = db.prepare(`SELECT mode, SUM(amount_paise) AS amountPaise FROM refund_payments
        WHERE created_at >= ? AND created_at < ? GROUP BY mode ORDER BY mode`).all(...bounds) as ModeAmount[];
      const cancellations = db.prepare("SELECT COUNT(*) AS orderCount FROM orders WHERE status = 'cancelled' AND merged_into IS NULL AND closed_at >= ? AND closed_at < ?").get(...bounds);
      const grossTaxable = taxes.reduce((sum, t) => sum + t.taxablePaise, 0);
      const net = { totalPaise: sales.totalPaise - credit.totalPaise, taxablePaise: grossTaxable - credit.taxablePaise,
        cgstPaise: sales.cgstPaise - credit.cgstPaise, sgstPaise: sales.sgstPaise - credit.sgstPaise };
      const netByMode = new Map<string, number>();
      for (const p of payments) netByMode.set(p.mode, (netByMode.get(p.mode) ?? 0) + p.amountPaise);
      for (const r of refunds) netByMode.set(r.mode, (netByMode.get(r.mode) ?? 0) - r.amountPaise);
      const netPayments = [...netByMode].sort(([a], [b]) => a.localeCompare(b)).map(([mode, amountPaise]) => ({ mode, amountPaise }));
      return { report: { date, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, sales, taxes, payments, cancellations,
        creditNotes: { ...credit, taxes: creditTaxes }, refunds, net, netPayments, zomatoReceivablePaise } };
    })();
  });
}
