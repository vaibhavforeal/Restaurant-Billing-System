import { buildStaffActivityReport, localDateKey, type ActivityEvent, type ActivityThresholds, type Database } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { reportRange } from "./sales-reports.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days before the chosen dates that set each person's usual rate. */
export const ACTIVITY_BASELINE_DAYS = 30;

const ThresholdsUpdate = z.object({
  cashShortPaise: z.number().int().min(0).max(100_000_000),
  discountPercent: z.number().gt(0).max(100),
  payOutPaise: z.number().int().min(0).max(100_000_000),
  multiplier: z.number().min(1).max(20),
  minEvents: z.number().int().min(1).max(1000),
});

export function activityThresholds(db: Database): ActivityThresholds {
  return db.prepare(`SELECT alert_cash_short_paise AS cashShortPaise, alert_discount_percent AS discountPercent, alert_pay_out_paise AS payOutPaise,
    alert_multiplier AS multiplier, alert_min_events AS minEvents FROM settings WHERE id = 1`).get() as ActivityThresholds;
}

const name = (s: string | null | undefined) => s ? `: ${s}` : "";

/**
 * Everything staff did between `start` and `end` that can lose money, with who did it. Items cancelled by a KOT edit
 * are counted as that edit's quantity cut, not again as a cancellation.
 */
export function activityEvents(db: Database, start: number, end: number): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const range = [start, end];
  for (const r of db.prepare(`SELECT oi.cancelled_at AS at, oi.cancelled_by AS staffId, u.name AS staffName, oi.qty, oi.price_paise_snapshot * oi.qty AS amount,
      oi.name_snapshot AS dish, oi.cancel_reason AS reason, k.kot_no AS kotNo
    FROM order_items oi JOIN users u ON u.id = oi.cancelled_by LEFT JOIN kots k ON k.id = oi.kot_id
    WHERE oi.status = 'cancelled' AND oi.kot_id IS NOT NULL AND oi.parent_item_id IS NULL AND oi.cancelled_at >= ? AND oi.cancelled_at < ?
      AND NOT EXISTS (SELECT 1 FROM kot_edits e WHERE e.cancelled_item_id = oi.id)`).all(...range) as Array<{ at: number; staffId: string; staffName: string; qty: number; amount: number; dish: string; reason: string | null; kotNo: number | null }>) {
    events.push({ kind: "cancelled_after_kot", at: r.at, staffId: r.staffId, staffName: r.staffName, count: r.qty, amountPaise: r.amount,
      detail: `${r.qty} × ${r.dish}${name(r.reason)}`, reference: r.kotNo === null ? null : `KOT #${r.kotNo}` });
  }
  for (const r of db.prepare(`SELECT e.created_at AS at, e.created_by AS staffId, u.name AS staffName, e.old_qty AS oldQty, e.new_qty AS newQty,
      oi.price_paise_snapshot AS price, oi.name_snapshot AS dish, e.reason, k.kot_no AS kotNo
    FROM kot_edits e JOIN users u ON u.id = e.created_by JOIN order_items oi ON oi.id = e.order_item_id LEFT JOIN kots k ON k.id = e.kot_id
    WHERE e.new_qty < e.old_qty AND e.created_at >= ? AND e.created_at < ?`).all(...range) as Array<{ at: number; staffId: string; staffName: string; oldQty: number; newQty: number; price: number; dish: string; reason: string | null; kotNo: number | null }>) {
    const cut = r.oldQty - r.newQty;
    events.push({ kind: "kot_cut", at: r.at, staffId: r.staffId, staffName: r.staffName, count: cut, amountPaise: cut * r.price,
      detail: `${r.dish}: ${r.oldQty} → ${r.newQty}${name(r.reason)}`, reference: r.kotNo === null ? null : `KOT #${r.kotNo}` });
  }
  for (const r of db.prepare(`SELECT c.created_at AS at, c.requested_by AS staffId, u.name AS staffName, c.total_paise AS amount, c.kind, c.reason,
      b.bill_no AS billNo, a.name AS approver, EXISTS (SELECT 1 FROM payments p WHERE p.bill_id = b.id) AS paid
    FROM credit_notes c JOIN bills b ON b.id = c.bill_id JOIN users u ON u.id = c.requested_by JOIN users a ON a.id = c.approved_by
    WHERE c.created_at >= ? AND c.created_at < ?`).all(...range) as Array<{ at: number; staffId: string; staffName: string; amount: number; kind: "void" | "refund"; reason: string; billNo: number; approver: string; paid: number }>) {
    events.push({ kind: "credit_note", at: r.at, staffId: r.staffId, staffName: r.staffName, count: 1, amountPaise: r.amount,
      detail: `${r.kind === "void" ? "Void" : "Refund"}${name(r.reason)}; asked by ${r.staffName}, approved by ${r.approver}`,
      reference: `Bill #${r.billNo}`, paidBillVoid: r.kind === "void" && r.paid === 1 });
  }
  // Offers are the owner's, not the staff member's choice, so they are left out of the discount given.
  for (const r of db.prepare(`SELECT b.created_at AS at, b.created_by AS staffId, u.name AS staffName, b.discount_paise - b.offer_discount_paise AS amount, b.subtotal_paise AS subtotal,
      b.discount_note AS note, b.bill_no AS billNo, a.name AS approver
    FROM bills b JOIN users u ON u.id = b.created_by LEFT JOIN users a ON a.id = b.discount_approved_by
    WHERE b.discount_paise - b.offer_discount_paise > 0 AND b.created_at >= ? AND b.created_at < ?`).all(...range) as Array<{ at: number; staffId: string; staffName: string; amount: number; subtotal: number; note: string | null; billNo: number; approver: string | null }>) {
    const percent = r.subtotal > 0 ? Math.round(r.amount * 1000 / r.subtotal) / 10 : 100;
    events.push({ kind: "discount", at: r.at, staffId: r.staffId, staffName: r.staffName, count: 1, amountPaise: r.amount,
      detail: `${percent}% off${name(r.note)}${r.approver ? `; approved by ${r.approver}` : ""}`, reference: `Bill #${r.billNo}`, discountPercent: percent });
  }
  for (const r of db.prepare(`SELECT s.closed_at AS at, s.cashier_id AS staffId, u.name AS staffName, -s.variance_paise AS amount, s.close_note AS note
    FROM shifts s JOIN users u ON u.id = s.cashier_id WHERE s.variance_paise < 0 AND s.closed_at >= ? AND s.closed_at < ?`).all(...range) as Array<{ at: number; staffId: string; staffName: string; amount: number; note: string | null }>) {
    events.push({ kind: "cash_short", at: r.at, staffId: r.staffId, staffName: r.staffName, count: 1, amountPaise: r.amount,
      detail: `Drawer short at shift close${name(r.note)}`, reference: null });
  }
  for (const r of db.prepare(`SELECT m.created_at AS at, m.created_by AS staffId, u.name AS staffName, m.amount_paise AS amount, m.reason
    FROM cash_movements m JOIN users u ON u.id = m.created_by WHERE m.kind = 'pay_out' AND m.created_at >= ? AND m.created_at < ?`).all(...range) as Array<{ at: number; staffId: string; staffName: string; amount: number; reason: string }>) {
    events.push({ kind: "pay_out", at: r.at, staffId: r.staffId, staffName: r.staffName, count: 1, amountPaise: r.amount, detail: r.reason, reference: null });
  }
  // Opening balances have no client reference; every manual count does.
  for (const r of db.prepare(`SELECT m.created_at AS at, m.created_by AS staffId, u.name AS staffName, m.delta, m.reason, m.note, m.cost_paise AS cost, s.name AS item, s.unit
    FROM stock_moves m JOIN users u ON u.id = m.created_by JOIN stock_items s ON s.id = m.stock_item_id
    WHERE (m.reason = 'wastage' OR (m.reason = 'adjustment' AND m.client_ref IS NOT NULL)) AND m.created_at >= ? AND m.created_at < ?`).all(...range) as Array<{ at: number; staffId: string; staffName: string; delta: number; reason: string; note: string | null; cost: number | null; item: string; unit: string }>) {
    events.push({ kind: "stock_correction", at: r.at, staffId: r.staffId, staffName: r.staffName, count: 1, amountPaise: r.cost === null ? null : Math.abs(r.cost),
      detail: `${r.reason === "wastage" ? "Wastage" : "Count correction"}: ${r.delta > 0 ? "+" : ""}${r.delta} ${r.unit} ${r.item}${r.note ? ` (${r.note})` : ""}`, reference: null });
  }
  return events;
}

/** Reports → Staff activity (admins only) and its alert limits in Settings. */
export function registerStaffActivity(app: FastifyInstance): void {
  const db = app.db;
  app.get("/api/reports/staff-activity", { preHandler: app.requirePermission("users.manage") }, async (req, reply) => {
    const { from, to, dates, bounds } = reportRange(req.query);
    const { events, baseline } = db.transaction(() => ({
      events: activityEvents(db, bounds[0], bounds[1]),
      baseline: activityEvents(db, bounds[0] - ACTIVITY_BASELINE_DAYS * DAY_MS, bounds[0]),
    }))();
    reply.header("Cache-Control", "no-store");
    return { report: buildStaffActivityReport({ from, to, today: localDateKey(Date.now()), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, generatedAt: Date.now(),
      days: dates.length, baselineDays: ACTIVITY_BASELINE_DAYS, events, baseline, thresholds: activityThresholds(db) }) };
  });
  const manage = app.requirePermission("settings.manage");
  app.get("/api/settings/activity-alerts", { preHandler: manage }, async () => ({ thresholds: activityThresholds(db) }));
  app.put("/api/settings/activity-alerts", { preHandler: manage }, async (req) => {
    const body = ThresholdsUpdate.parse(req.body);
    db.prepare(`UPDATE settings SET alert_cash_short_paise = ?, alert_discount_percent = ?, alert_pay_out_paise = ?, alert_multiplier = ?, alert_min_events = ? WHERE id = 1`)
      .run(body.cashShortPaise, body.discountPercent, body.payOutPaise, body.multiplier, body.minEvents);
    return { thresholds: activityThresholds(db) };
  });
}
