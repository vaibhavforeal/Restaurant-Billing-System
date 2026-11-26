import { CashMovementCreate, DayClose, ShiftOpen, localDateKey, uuidv7, type Database } from "@masalapos/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { priorRequest } from "./client-ref.js";
import { httpError } from "./http-error.js";
import { dayBounds, dayEndReport } from "./reports.js";
import { reportRange } from "./sales-reports.js";
import { businessToday, dayStartHour } from "./business-day.js";
import { tradingShift } from "./cash-custody.js";
import { authedUser, userCan } from "./auth.js";

type Recipient = Parameters<typeof authedUser>[1];
interface Handover {
  seq: number; recipient: string; recipientName: string; final: number; state: string;
  counted: number; expected: number; note: string; received: number | null;
}
function latest(db: Database, id: string) {
  return db.prepare(`SELECT e.seq,e.recipient,e.final,e.state,e.counted,e.expected,e.note,e.received,u.name AS recipientName FROM handover_events e JOIN users u ON u.id=e.recipient
    WHERE shift_id=? ORDER BY seq DESC LIMIT 1`).get(id) as Handover | undefined;
}
const amount = z.number().int().min(0).max(1_000_000_000);
const actionSchema = z.discriminatedUnion("action", [
  z.object({action:z.literal("submit"), recipient:z.string(), final:z.boolean(), counted:amount, note:z.string().trim().max(200)}),
  z.object({action:z.literal("approve")}),
  z.object({action:z.literal("recount")}),
  z.object({action:z.literal("receive"), received:amount}),
]);
const handoverBody = z.object({clientRef:z.string().min(8).max(64), revision:z.number().int().nonnegative(), change:actionSchema});

interface ShiftRow {
  drawer_id: string; id: string; cashier_id: string; opened_at: number; opening_float_paise: number; open_client_ref: string;
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
    WHERE p.mode = 'cash' AND (p.shift_id = ? OR (p.shift_id IS NULL AND s.created_by = ? AND p.created_at >= ? AND p.created_at <= ?))`, shift.id, shift.cashier_id, ...window);
  const cashRefundsPaise = one(`SELECT COALESCE(SUM(r.amount_paise), 0) AS n FROM refund_payments r JOIN credit_notes c ON c.id = r.credit_note_id
    WHERE r.mode = 'cash' AND (r.shift_id = ? OR (r.shift_id IS NULL AND c.requested_by = ? AND r.created_at >= ? AND r.created_at <= ?))`, shift.id, shift.cashier_id, ...window);
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
    drawerName: (db.prepare("SELECT name FROM drawers WHERE id=?").get(row.drawer_id) as {name:string} | undefined)?.name,
    handover: latest(db, row.id),
    history: db.prepare(`SELECT e.seq,e.state,e.counted,e.received,e.at,e.note,u.name AS actorName FROM handover_events e
      JOIN users u ON u.id=e.actor WHERE shift_id=? ORDER BY seq`).all(row.id),
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
  const [, end] = dayBounds(db, date);
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
        if (replay.cashier_id !== req.user.id || replay.drawer_id !== body.drawerId || replay.opening_float_paise !== body.openingFloatPaise) throw httpError(409, "Shift reference already used for a different request");
        return { id: replay.id, created: false };
      }
      if (db.prepare("SELECT 1 FROM shifts WHERE cashier_id = ? AND closed_at IS NULL").get(req.user.id)) throw httpError(409, "You already have an open shift");
      if (!db.prepare("SELECT 1 FROM drawers WHERE id=?").get(body.drawerId)) throw httpError(404,"Drawer not found");
      if (db.prepare("SELECT 1 FROM shifts WHERE drawer_id=? AND closed_at IS NULL").get(body.drawerId)) throw httpError(409,"Drawer is already in use");
      const id = uuidv7();
      db.prepare("INSERT INTO shifts (id, cashier_id, opened_at, opening_float_paise, open_client_ref, drawer_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, req.user.id, Date.now(), body.openingFloatPaise, body.clientRef, body.drawerId);
      return { id, created: true };
    })();
    return reply.status(result.created ? 201 : 200).send({ shift: shiftJson(db, getShift(result.id)!) });
  });

  app.post("/api/shifts/:id/cash-movements", { preHandler: cashier }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CashMovementCreate.parse(req.body);
    const requestJson = JSON.stringify({ shiftId: id, ...body });
    const created = db.transaction(() => {
      const shift = ownShift(req, id);
      if (shift.cashier_id !== req.user.id) throw httpError(403, "Use your own drawer");
      if (priorRequest(db, "cash_movements", body.clientRef, requestJson, "Cash movement reference already used for a different request")) return false;
      if (shift.closed_at !== null) throw httpError(409, "This shift is closed");
      tradingShift(db, req.user.id);
      db.prepare("INSERT INTO cash_movements (id, shift_id, kind, amount_paise, reason, created_at, created_by, client_ref, request_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(uuidv7(), id, body.kind, body.amountPaise, body.reason, Date.now(), req.user.id, body.clientRef, requestJson);
      return true;
    })();
    return reply.status(created ? 201 : 200).send({ shift: shiftJson(db, getShift(id)!) });
  });

  app.get("/api/drawers", {preHandler: cashier}, async (req) => {
    const users = db.prepare("SELECT id,name,role FROM users WHERE is_active=1 ORDER BY name").all() as Recipient[];
    const pending = (db.prepare("SELECT * FROM shifts WHERE closed_at IS NULL").all() as ShiftRow[])
      .map(row => shiftJson(db,row)).filter(s => s.handover && (s.handover.recipient === req.user.id || req.user.role === "admin"));
    return { drawers: db.prepare(`SELECT d.id,d.name FROM drawers d WHERE NOT EXISTS
      (SELECT 1 FROM shifts s WHERE s.drawer_id=d.id AND s.closed_at IS NULL) ORDER BY name`).all(),
      occupied: db.prepare("SELECT d.name AS drawerName,u.name AS cashierName FROM shifts s JOIN drawers d ON d.id=s.drawer_id JOIN users u ON u.id=s.cashier_id WHERE s.closed_at IS NULL ORDER BY d.name").all(),
      recipients: users.filter(u => userCan(authedUser(db,u),"bills.settle")), pending, userId:req.user.id, admin:req.user.role === "admin" };
  });
  app.post("/api/drawers", {preHandler:cashier}, async req => {
    if (req.user.role !== "admin") throw httpError(403,"Admin required");
    const {name} = z.object({name:z.string().trim().min(1).max(80)}).parse(req.body);
    db.prepare("INSERT INTO drawers(id,name) VALUES (?,?) ON CONFLICT(name) DO NOTHING").run(uuidv7(),name);
    return {saved:true};
  });

  app.post("/api/shifts/:id/handover", {preHandler:cashier}, async req => {
    const {id} = req.params as {id:string};
    const body = handoverBody.parse(req.body);
    const change = body.change;
    const actor = req.user.id;
    const signature = JSON.stringify({id,actor,...body});
    return db.transaction(() => {
      const replay = db.prepare("SELECT request_json FROM handover_events WHERE client_ref=?").get(body.clientRef) as {request_json:string} | undefined;
      if (replay) {
        if (replay.request_json !== signature) throw httpError(409,"Request reference already used");
        return {saved:true};
      }
      const shift = getShift(id);
      if (!shift || shift.closed_at !== null) throw httpError(409,"Shift is no longer open");
      const last = latest(db,id);
      if ((last?.seq ?? 0) !== body.revision) throw httpError(409,"Handover changed. Refresh the drawer.");
      const now = Date.now();
      let event;
      if (change.action === "submit") {
        if (actor !== shift.cashier_id) throw httpError(403,"Only the outgoing cashier can submit the count");
        if (last && last.state !== "recount") throw httpError(409,"Count already submitted");
        const user = db.prepare("SELECT id,name,role FROM users WHERE id=? AND is_active=1").get(change.recipient) as Recipient | undefined;
        if (!user || !userCan(authedUser(db,user),"bills.settle") || (!change.final && user.id === actor) || (change.final && user.role !== "admin"))
          throw httpError(400,"Select an eligible recipient");
        const expected = last?.expected ?? shiftCash(db,shift,now).expectedCashPaise;
        if (expected !== change.counted && !change.note) throw httpError(400,"Explain the cash difference");
        event = {...change, expected, state:expected === change.counted ? "awaiting receipt" : "awaiting approval", received:null};
      } else {
        if (!last) throw httpError(409,"Submit the outgoing count first");
        event = {...last};
        if (change.action === "recount") {
          if (actor !== shift.cashier_id) throw httpError(403,"Only the outgoing cashier can request a recount");
          event.state = "recount";
          event.received = null;
        } else if (change.action === "approve") {
          if (req.user.role !== "admin") throw httpError(403,"Admin approval required");
          if (last.state !== "awaiting approval") throw httpError(409,"Approval is no longer pending");
          event.state = "awaiting receipt";
        } else {
          if (actor !== last.recipient || (last.final && req.user.role !== "admin")) throw httpError(403,"Only the named recipient can receive this drawer");
          if (last.state !== "awaiting receipt") throw httpError(409,"Drawer is not ready for receipt");
          event.received = change.received;
          event.state = change.received === last.counted ? "accepted" : "recount";
          if (event.state === "accepted") {
            if (!last.final && db.prepare("SELECT 1 FROM shifts WHERE cashier_id=? AND closed_at IS NULL").get(actor))
              throw httpError(409,"Hand over your current drawer first");
            db.prepare(`UPDATE shifts SET closed_at=?,closed_by=?,counted_cash_paise=?,expected_cash_paise=?,variance_paise=?,close_note=?,close_client_ref=? WHERE id=?`)
              .run(now,actor,last.counted,last.expected,last.counted-last.expected,last.note,body.clientRef,id);
            if (!last.final) db.prepare(`INSERT INTO shifts(id,drawer_id,cashier_id,opened_at,opening_float_paise,open_client_ref)
              VALUES (?,?,?,?,?,?)`).run(uuidv7(),shift.drawer_id,actor,now,last.counted,uuidv7());
          }
        }
      }
      db.prepare(`INSERT INTO handover_events(shift_id,client_ref,request_json,actor,recipient,final,state,expected,counted,received,note,at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,body.clientRef,signature,actor,event.recipient,Number(event.final),event.state,event.expected,event.counted,event.received,event.note,now);
      return {saved:true};
    })();
  });
  app.get("/api/shifts", { preHandler: app.requirePermission("reports.read") }, async (req) => {
    const { from, to, bounds } = reportRange(req.query, dayStartHour(db));
    const rows = db.prepare("SELECT * FROM shifts WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at DESC").all(...bounds) as ShiftRow[];
    return { from, to, shifts: rows.map((row) => shiftJson(db, row)) };
  });

  app.get("/api/day-close", { preHandler: app.requirePermission("reports.read") }, async (req) => {
    const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
    return dayCloseState(date ?? businessToday(db));
  });

  app.post("/api/day-close", { preHandler: app.requirePermission("reports.close_day") }, async (req, reply) => {
    const body = DayClose.parse(req.body);
    const created = db.transaction(() => {
      const replay = db.prepare("SELECT business_date FROM day_closes WHERE client_ref = ?").get(body.clientRef) as { business_date: string } | undefined;
      if (replay) {
        if (replay.business_date !== body.date) throw httpError(409, "Day close reference already used for a different date");
        return false;
      }
      if (body.date > businessToday(db)) throw httpError(400, "A future date cannot be closed");
      if (db.prepare("SELECT 1 FROM day_closes WHERE business_date = ?").get(body.date)) throw httpError(409, `${body.date} is already closed`);
      const blockers = dayBlockers(db, body.date);
      const problems = [
        ...(blockers.openShifts.length ? [`close the open shift${blockers.openShifts.length > 1 ? "s" : ""} for ${blockers.openShifts.join(", ")}`] : []),
        ...(blockers.openOrders ? [`bill or cancel ${blockers.openOrders} open order${blockers.openOrders > 1 ? "s" : ""}`] : []),
        ...(blockers.unpaidBills ? [`settle ${blockers.unpaidBills} unpaid bill${blockers.unpaidBills > 1 ? "s" : ""}`] : []),
      ];
      if (problems.length) throw httpError(409, `Before closing ${body.date}: ${problems.join("; ")}.`, "day_open");
      const [start, end] = dayBounds(db, body.date);
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
