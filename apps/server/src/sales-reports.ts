import type { FastifyInstance } from "fastify";
import { localDateKey } from "@forkflow/domain";
import { z } from "zod";
import { httpError } from "./http-error.js";

interface Sales {
  billCount: number; subtotalPaise: number; discountPaise: number; cgstPaise: number;
  sgstPaise: number; roundingPaise: number; totalPaise: number; outstandingPaise: number;
}
/** Money received by payment date, net of refunds paid out that date (`refundPaise`, already subtracted per method). */
interface Collections { billCount: number; cashPaise: number; upiPaise: number; cardPaise: number; refundPaise: number; totalPaise: number }
const emptySales = (): Sales => ({ billCount: 0, subtotalPaise: 0, discountPaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, totalPaise: 0, outstandingPaise: 0 });
const emptyCollections = (): Collections => ({ billCount: 0, cashPaise: 0, upiPaise: 0, cardPaise: 0, refundPaise: 0, totalPaise: 0 });

export function reportRange(query: unknown) {
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const input = z.object({ from: date.optional(), to: date.optional() }).parse(query);
  const to = input.to ?? localDateKey(Date.now());
  const end = new Date(`${to}T00:00:00`);
  if (!Number.isFinite(end.getTime()) || localDateKey(end.getTime()) !== to) throw httpError(400, "Invalid end date");
  const defaultStart = new Date(end); defaultStart.setDate(defaultStart.getDate() - 6);
  const from = input.from ?? localDateKey(defaultStart.getTime());
  const start = new Date(`${from}T00:00:00`);
  if (!Number.isFinite(start.getTime()) || localDateKey(start.getTime()) !== from) throw httpError(400, "Invalid start date");
  if (start > end) throw httpError(400, "Start date must be on or before end date");
  const dates: string[] = [];
  for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
    dates.push(localDateKey(day.getTime()));
    if (dates.length > 366) throw httpError(400, "Choose a date range of 366 days or less");
  }
  end.setDate(end.getDate() + 1);
  return { from, to, dates, bounds: [start.getTime(), end.getTime()] as const };
}

/**
 * Read-only aggregation of stored bills/payments. Does not recalculate bills. Sales are every bill issued that day
 * (void ones too); credit notes subtract on their own date, and refunds subtract from collections on their date by method.
 */
export function registerSalesReports(app: FastifyInstance) {
  app.get("/api/reports/sales", { preHandler: app.requirePermission("reports.read") }, async (req) => {
    const { from, to, dates, bounds } = reportRange(req.query);
    const db = app.db;
    const localDate = (column: string) => `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch', 'localtime')`;
    const { sales, credits, collections, refunds, collectedBills } = db.transaction(() => ({
      sales: db.prepare(`SELECT ${localDate("created_at")} AS date,
        COUNT(*) AS billCount, SUM(subtotal_paise) AS subtotalPaise, SUM(discount_paise) AS discountPaise,
        SUM(cgst_paise) AS cgstPaise, SUM(sgst_paise) AS sgstPaise, SUM(rounding_paise) AS roundingPaise,
        SUM(total_paise) AS totalPaise, SUM(CASE WHEN status = 'unpaid' THEN total_paise ELSE 0 END) AS outstandingPaise
        FROM bills WHERE created_at >= ? AND created_at < ? GROUP BY date`).all(...bounds) as Array<Sales & { date: string }>,
      credits: db.prepare(`SELECT ${localDate("created_at")} AS date, SUM(total_paise) AS totalPaise
        FROM credit_notes WHERE created_at >= ? AND created_at < ? GROUP BY date`).all(...bounds) as Array<{ date: string; totalPaise: number }>,
      collections: db.prepare(`SELECT ${localDate("created_at")} AS date, COUNT(DISTINCT bill_id) AS billCount,
        SUM(CASE WHEN mode = 'cash' THEN amount_paise ELSE 0 END) AS cashPaise,
        SUM(CASE WHEN mode = 'upi' THEN amount_paise ELSE 0 END) AS upiPaise,
        SUM(CASE WHEN mode = 'card' THEN amount_paise ELSE 0 END) AS cardPaise, SUM(amount_paise) AS totalPaise
        FROM payments WHERE created_at >= ? AND created_at < ? AND mode <> 'zomato' GROUP BY date`).all(...bounds) as Array<Omit<Collections, "refundPaise"> & { date: string }>,
      refunds: db.prepare(`SELECT ${localDate("created_at")} AS date,
        SUM(CASE WHEN mode = 'cash' THEN amount_paise ELSE 0 END) AS cashPaise,
        SUM(CASE WHEN mode = 'upi' THEN amount_paise ELSE 0 END) AS upiPaise,
        SUM(CASE WHEN mode = 'card' THEN amount_paise ELSE 0 END) AS cardPaise, SUM(amount_paise) AS totalPaise
        FROM refund_payments WHERE created_at >= ? AND created_at < ? GROUP BY date`).all(...bounds) as Array<{ date: string; cashPaise: number; upiPaise: number; cardPaise: number; totalPaise: number }>,
      // A bill appearing on multiple collection dates must count only once in the range.
      collectedBills: (db.prepare("SELECT COUNT(DISTINCT bill_id) AS count FROM payments WHERE created_at >= ? AND created_at < ? AND mode <> 'zomato'").get(...bounds) as { count: number }).count,
    }))();
    const salesByDate = new Map(sales.map(({ date, ...values }) => [date, values]));
    const creditByDate = new Map(credits.map((row) => [row.date, row.totalPaise]));
    const collectionsByDate = new Map(collections.map(({ date, ...values }) => [date, values]));
    const refundsByDate = new Map(refunds.map(({ date, ...values }) => [date, values]));
    const daily = dates.map((date) => {
      const daySales = salesByDate.get(date) ?? emptySales();
      const creditNotePaise = creditByDate.get(date) ?? 0;
      const paid = collectionsByDate.get(date), refunded = refundsByDate.get(date);
      const collections: Collections = paid ? { ...paid, refundPaise: 0 } : emptyCollections();
      if (refunded) {
        collections.cashPaise -= refunded.cashPaise; collections.upiPaise -= refunded.upiPaise; collections.cardPaise -= refunded.cardPaise;
        collections.totalPaise -= refunded.totalPaise; collections.refundPaise = refunded.totalPaise;
      }
      return { date, sales: daySales, creditNotePaise, netTotalPaise: daySales.totalPaise - creditNotePaise, collections };
    });
    const salesTotal = emptySales(), collectionTotal = emptyCollections();
    let creditNotePaise = 0;
    for (const day of daily) {
      for (const key of Object.keys(salesTotal) as Array<keyof Sales>) salesTotal[key] += day.sales[key];
      for (const key of Object.keys(collectionTotal) as Array<keyof Collections>) collectionTotal[key] += day.collections[key];
      creditNotePaise += day.creditNotePaise;
    }
    collectionTotal.billCount = collectedBills;
    return { report: { from, to, today: localDateKey(Date.now()), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, generatedAt: Date.now(),
      sales: salesTotal, creditNotePaise, netTotalPaise: salesTotal.totalPaise - creditNotePaise, collections: collectionTotal, daily } };
  });
}
