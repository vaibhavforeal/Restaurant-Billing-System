import type { FastifyInstance } from "fastify";
import { localDateKey } from "@forkflow/domain";
import { z } from "zod";
import { httpError } from "./http-error.js";

interface Sales {
  billCount: number; subtotalPaise: number; discountPaise: number; cgstPaise: number;
  sgstPaise: number; roundingPaise: number; totalPaise: number; outstandingPaise: number;
}
interface Collections { billCount: number; cashPaise: number; upiPaise: number; cardPaise: number; totalPaise: number }
const emptySales = (): Sales => ({ billCount: 0, subtotalPaise: 0, discountPaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, totalPaise: 0, outstandingPaise: 0 });
const emptyCollections = (): Collections => ({ billCount: 0, cashPaise: 0, upiPaise: 0, cardPaise: 0, totalPaise: 0 });

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

/** Read-only aggregation of stored bills/payments. Does not recalculate bills. */
export function registerSalesReports(app: FastifyInstance) {
  app.get("/api/reports/sales", { preHandler: app.requirePermission("reports.read") }, async (req) => {
    const { from, to, dates, bounds } = reportRange(req.query);
    const sales = app.db.prepare(`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS date,
      COUNT(*) AS billCount, SUM(subtotal_paise) AS subtotalPaise, SUM(discount_paise) AS discountPaise,
      SUM(cgst_paise) AS cgstPaise, SUM(sgst_paise) AS sgstPaise, SUM(rounding_paise) AS roundingPaise,
      SUM(total_paise) AS totalPaise, SUM(CASE WHEN status = 'unpaid' THEN total_paise ELSE 0 END) AS outstandingPaise
      FROM bills WHERE created_at >= ? AND created_at < ? AND status != 'void' GROUP BY date`).all(...bounds) as Array<Sales & { date: string }>;
    const collections = app.db.prepare(`SELECT strftime('%Y-%m-%d', p.created_at / 1000, 'unixepoch', 'localtime') AS date,
      COUNT(DISTINCT p.bill_id) AS billCount,
      SUM(CASE WHEN p.mode = 'cash' THEN p.amount_paise ELSE 0 END) AS cashPaise,
      SUM(CASE WHEN p.mode = 'upi' THEN p.amount_paise ELSE 0 END) AS upiPaise,
      SUM(CASE WHEN p.mode = 'card' THEN p.amount_paise ELSE 0 END) AS cardPaise, SUM(p.amount_paise) AS totalPaise
      FROM payments p JOIN bills b ON b.id = p.bill_id
      WHERE p.created_at >= ? AND p.created_at < ? AND b.status != 'void' GROUP BY date`).all(...bounds) as Array<Collections & { date: string }>;
    const salesByDate = new Map(sales.map(({ date, ...values }) => [date, values]));
    const collectionsByDate = new Map(collections.map(({ date, ...values }) => [date, values]));
    const daily = dates.map((date) => ({ date, sales: salesByDate.get(date) ?? emptySales(), collections: collectionsByDate.get(date) ?? emptyCollections() }));
    const salesTotal = emptySales(), collectionTotal = emptyCollections();
    for (const day of daily) {
      for (const key of Object.keys(salesTotal) as Array<keyof Sales>) salesTotal[key] += day.sales[key];
      for (const key of Object.keys(collectionTotal) as Array<keyof Collections>) collectionTotal[key] += day.collections[key];
    }
    // A bill appearing on multiple collection dates must count only once in the range.
    collectionTotal.billCount = (app.db.prepare(`SELECT COUNT(DISTINCT p.bill_id) AS count FROM payments p
      JOIN bills b ON b.id = p.bill_id WHERE p.created_at >= ? AND p.created_at < ? AND b.status != 'void'`).get(...bounds) as { count: number }).count;
    return { report: { from, to, today: localDateKey(Date.now()), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, generatedAt: Date.now(),
      sales: salesTotal, collections: collectionTotal, daily } };
  });
}
