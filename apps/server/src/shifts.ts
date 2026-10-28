import { CashMovementCreate, DayClose, ShiftClose, ShiftOpen, localDateKey, uuidv7, type Database } from "@forkflow/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";
import { dayBounds, dayEndReport } from "./reports.js";
import { reportRange } from "./sales-reports.js";
import { userCan } from "./auth.js";

interface ShiftRow {
  id: string; cashier_id: string; opened_at: number; opening_float_paise: number; open_client_ref: string;
  closed_at: number | null; closed_by: string | null; counted_cash_paise: number | null; expected_cash_paise: number | null;
  variance_paise: number | null; close_note: string | null; close_client_ref: string | null;
}

/**
 * The cash a shift's drawer should hold at `until`: the opening float, plus cash payments on bills the cashier settled,
 * less cash refunds the cashier requested, plus pay-ins and less pay-outs. Settlement and refund attribution follow the
 * Cashier collections report.
 */
function shiftCash(db: Database, shift: ShiftRow, until: number) {
  const window = [shift.opened_at, until] as const;
  const one = (sql: string, ...params: (string | number)[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  const cashSalesPaise = one(`SELECT COALESCE(SUM(p.amount_paise), 0) AS n FROM payments p JOIN bill_settlements s ON s.bill_id = p.bill_id
    WHERE p.mode = 'cash' AND s.created_by = ? AND p.created_at >= ? AND p.created_at <= ?`, shift.cashier_id, ...window);
  const cashRefundsPaise = one(`SELECT COALESCE(SUM(r.amount_paise), 0) AS n FROM refund_payments r JOIN credit_notes c ON c.id = r.credit_note_id
    WHERE r.mode = 'cash' AND c.requested_by = ? AND r.created_at >= ? AND r.created_at <= ?`, shift.cashier_id, ...window);
  const payInPaise = one("SELECT COALESCE(SUM(amount_paise), 0) AS n FROM cash_movements WHERE shift_id = ? AND kind = 'pay_in'", shift.id);
  const payOutPaise = one("SELECT COALESCE(SUM(amount_paise), 0) AS n FROM cash_movements WHERE shift_id = ? AND kind = 'pay_out'", shift.id);
  return { cashSalesPaise, cashRefundsPaise, payInPaise, payOutPaise,
    expectedCashPaise: shift.opening_float_paise + cashSalesPaise - cashRefundsPaise + payInPaise - payOutPaise };
}

function shiftJson(db: Database, row: ShiftRow) {
  const name = (id: string | null) => id ? (db.prepare("SELECT name FROM users WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "Unknown" : null;
  const cash = shiftCash(db, row, row.closed_at ?? Date.now());
  return {
    id: row.id, cashierId: row.cashier_id, cashierName: name(row.cashier_id), openedAt: row.opened_at, openingFloatPaise: row.opening_float_paise,
    ...cash,
    // A closed shift reports what was expected when it was counted.
    expectedCashPaise: row.expected_cash_paise ?? cash.expectedCashPaise,
    closedAt: row.closed_at, closedByName: name(row.closed_by), countedCashPaise: row.counted_cash_paise, variancePaise: row.variance_paise, note: row.close_note,
    movements: db.prepare(`SELECT m.id, m.kind, m.amount_paise AS amountPaise, m.reason, m.created_at AS createdAt, u.name AS createdByName
      FROM cash_movements m JOIN users u ON u.id = m.created_by WHERE m.shift_id = ? ORDER BY m.created_at, m.id`).all(row.id),
  };
}

/** What stops a business date from closing: open drawers, and orders opened that day that are still open or unpaid. */
function dayBlockers(db: Database, date: string) {
  const [, end] = dayBounds(date);
  const openShifts = (db.prepare(`SELECT u.name FROM shifts s JOIN users u ON u.id = s.cashier_id WHERE s.closed_at IS NULL AND s.opened_at < ? ORDER BY u.name`)
    .all(end) as Array<{ name: string }>).map((r) => r.name);
  const count = (status: string) => (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = ? AND opened_at < ?").get(status, end) as { n: number }).n;
  return { openShifts, openOrders: count("open"), unpaidBills: count("billed") };
}

export function registerShifts(app: FastifyInstance): void {
  const db = app.db;
  const cashier = app.requirePermission("bills.settle");
  const getShift = (id: string) => db.prepare("SELECT * FROM shifts WHERE id = ?").get(id) as ShiftRow | undefined;
  /** Staff work their own drawer; whoever may close the day may act on anyone's (for example to close a shift left open). */
  function ownShift(req: FastifyRequest, id: string): ShiftRow {
    const shift = getShift(id);
    if (!shift || (shift.cashier_id !== req.user.id && !userCan(req.user, "reports.close_day"))) throw httpError(404, "shift not found");
    return shift;
  }

  app.get("/api/shifts/current", { preHandler: cashier }, async (req) => {
    const row = db.prepare("SELECT * FROM shifts WHERE cashier_id = ? AND closed_at IS NULL").get(req.user.id) as ShiftRow | undefined;
    return { shift: row ? shiftJson(db, row) : null };
  });

  app.post("/api/shifts", { preHandler: cashier }, async (req, reply) => {
    const body = ShiftOpen.parse(req.body);
    const result = db.transaction(() => {
      const replay = db.prepare("SELECT * FROM shifts WHERE open_client_ref = ?").get(body.clientRef) as ShiftRow | undefined;
      if (replay) {
        if (replay.cashier_id !== req.user.id || replay.opening_float_paise !== body.openingFloatPaise) throw httpError(409, "Shift reference already used for a different request");
        return { id: replay.id, created: false };
      }
      if (db.prepare("SELECT 1 FROM shifts WHERE cashier_id = ? AND closed_at IS NULL").get(req.user.id)) throw httpError(409, "You already have an open shift");
      const id = uuidv7();
      db.prepare("INSERT INTO shifts (id, cashier_id, opened_at, opening_float_paise, open_client_ref) VALUES (?, ?, ?, ?, ?)")
        .run(id, req.user.id, Date.now(), body.openingFloatPaise, body.clientRef);
      return { id, created: true };
    })();
    return reply.status(result.created ? 201 : 200).send({ shift: shiftJson(db, getShift(result.id)!) });
  });

  app.post("/api/shifts/:id/cash-movements", { preHandler: cashier }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CashMovementCreate.parse(req.body);
    const requestJson = JSON.stringify({ shiftId: id, ...body });
    const created = db.transaction(() => {
      const replay = db.prepare("SELECT request_json FROM cash_movements WHERE client_ref = ?").get(body.clientRef) as { request_json: string } | undefined;
      if (replay) {
        if (replay.request_json !== requestJson) throw httpError(409, "Cash movement reference already used for a different request");
        return false;
      }
      const shift = ownShift(req, id);
      if (shift.closed_at !== null) throw httpError(409, "This shift is closed");
      db.prepare("INSERT INTO cash_movements (id, shift_id, kind, amount_paise, reason, created_at, created_by, client_ref, request_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(uuidv7(), id, body.kind, body.amountPaise, body.reason, Date.now(), req.user.id, body.clientRef, requestJson);
      return true;
    })();
    return reply.status(created ? 201 : 200).send({ shift: shiftJson(db, getShift(id)!) });
  });

  app.post("/api/shifts/:id/close", { preHandler: cashier }, async (req) => {
    const { id } = req.params as { id: string };
    const body = ShiftClose.parse(req.body);
    db.transaction(() => {
      const shift = ownShift(req, id);
      if (shift.close_client_ref === body.clientRef) {
        if (shift.counted_cash_paise !== body.countedCashPaise) throw httpError(409, "Close reference already used for a different request");
        return;
      }
      if (shift.closed_at !== null) throw httpError(409, "This shift is already closed");
      const now = Date.now();
      const { expectedCashPaise } = shiftCash(db, shift, now);
      db.prepare(`UPDATE shifts SET closed_at = ?, closed_by = ?, counted_cash_paise = ?, expected_cash_paise = ?, variance_paise = ?, close_note = ?, close_client_ref = ?
        WHERE id = ?`).run(now, req.user.id, body.countedCashPaise, expectedCashPaise, body.countedCashPaise - expectedCashPaise, body.note || null, body.clientRef, id);
    })();
    return { shift: shiftJson(db, getShift(id)!) };
  });

  app.get("/api/shifts", { preHandler: app.requirePermission("reports.read") }, async (req) => {
    const { from, to, bounds } = reportRange(req.query);
    const rows = db.prepare("SELECT * FROM shifts WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at DESC").all(...bounds) as ShiftRow[];
    return { from, to, shifts: rows.map((row) => shiftJson(db, row)) };
  });

  app.get("/api/day-close", { preHandler: app.requirePermission("reports.read") }, async (req) => {
    const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(localDateKey(Date.now())) }).parse(req.query);
    return dayCloseState(date);
  });

  app.post("/api/day-close", { preHandler: app.requirePermission("reports.close_day") }, async (req, reply) => {
    const body = DayClose.parse(req.body);
    const created = db.transaction(() => {
      const replay = db.prepare("SELECT business_date FROM day_closes WHERE client_ref = ?").get(body.clientRef) as { business_date: string } | undefined;
      if (replay) {
        if (replay.business_date !== body.date) throw httpError(409, "Day close reference already used for a different date");
        return false;
      }
      if (body.date > localDateKey(Date.now())) throw httpError(400, "A future date cannot be closed");
      if (db.prepare("SELECT 1 FROM day_closes WHERE business_date = ?").get(body.date)) throw httpError(409, `${body.date} is already closed`);
      const blockers = dayBlockers(db, body.date);
      const problems = [
        ...(blockers.openShifts.length ? [`close the open shift${blockers.openShifts.length > 1 ? "s" : ""} for ${blockers.openShifts.join(", ")}`] : []),
        ...(blockers.openOrders ? [`bill or cancel ${blockers.openOrders} open order${blockers.openOrders > 1 ? "s" : ""}`] : []),
        ...(blockers.unpaidBills ? [`settle ${blockers.unpaidBills} unpaid bill${blockers.unpaidBills > 1 ? "s" : ""}`] : []),
      ];
      if (problems.length) throw httpError(409, `Before closing ${body.date}: ${problems.join("; ")}.`, "day_open");
      const [start, end] = dayBounds(body.date);
      const shifts = (db.prepare("SELECT * FROM shifts WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at").all(start, end) as ShiftRow[]).map((row) => shiftJson(db, row));
      db.prepare("INSERT INTO day_closes (business_date, closed_at, closed_by, note, report_json, client_ref) VALUES (?, ?, ?, ?, ?, ?)")
        .run(body.date, Date.now(), req.user.id, body.note || null, JSON.stringify({ dayEnd: dayEndReport(db, body.date), shifts }), body.clientRef);
      return true;
    })();
    return reply.status(created ? 201 : 200).send(dayCloseState(body.date));
  });

  /** A date's close record (with the saved report), or what still blocks closing it. */
  function dayCloseState(date: string) {
    const row = db.prepare(`SELECT d.business_date AS date, d.closed_at AS closedAt, u.name AS closedByName, d.note, d.report_json
      FROM day_closes d JOIN users u ON u.id = d.closed_by WHERE d.business_date = ?`).get(date) as
      { date: string; closedAt: number; closedByName: string; note: string | null; report_json: string } | undefined;
    if (!row) return { date, close: null, blockers: dayBlockers(db, date) };
    const { report_json, ...close } = row;
    return { date, close: { ...close, report: JSON.parse(report_json) }, blockers: null };
  }
}
