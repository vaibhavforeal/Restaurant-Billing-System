import { tablePriceTier } from "./pricing.js";
import { ReservationCreate, ReservationUpdate, ReservationVersion, ReservationStatus, uuidv7, localDateKey, nextSplitLabel, type Reservation, type ReservationInput } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";
import { loadOrderJson } from "./mappers.js";
import { assertReservationSlot, localMinute, reservationTime } from "./reservation-rules.js";

interface Row {
  id: string; client_ref: string; request_json: string; table_id: string; table_name: string; area: string | null;
  customer_name: string; phone: string; party_size: number; starts_at: number; ends_at: number; notes: string;
  status: Reservation["status"]; order_id: string | null; order_status: string | null; version: number;
}
const select = `SELECT r.*, t.name AS table_name, t.area, o.status AS order_status FROM reservations r
  JOIN dining_tables t ON t.id = r.table_id LEFT JOIN orders o ON o.id = r.order_id`;
const json = (r: Row): Reservation => ({ id: r.id, tableId: r.table_id, tableName: r.table_name, area: r.area,
  customerName: r.customer_name, phone: r.phone, partySize: r.party_size, startsAt: r.starts_at, endsAt: r.ends_at,
  startsLocal: localMinute(r.starts_at), durationMinutes: (r.ends_at - r.starts_at) / 60000, notes: r.notes,
  status: r.status, orderId: r.order_id, orderStatus: r.order_status, version: r.version });

export function registerReservations(app: FastifyInstance) {
  const read = app.requirePermission("reservations.read"), manage = app.requirePermission("reservations.manage");
  const idOf = (params: unknown) => z.object({ id: z.string().uuid() }).parse(params).id;
  const get = (id: string) => app.db.prepare(`${select} WHERE r.id = ?`).get(id) as Row | undefined;
  const requireRow = (id: string) => { const row = get(id); if (!row) throw httpError(404, "Reservation not found"); return row; };
  const current = (row: Row, version: number) => {
    if (row.version !== version) throw httpError(409, "This reservation changed at another counter. Refresh and review it before saving.");
    if (row.status !== "booked") throw httpError(409, "Only booked reservations can be changed");
  };
  const activeTable = (id: string) => {
    const row = app.db.prepare("SELECT is_active FROM dining_tables WHERE id = ?").get(id) as { is_active: number } | undefined;
    if (!row?.is_active) throw httpError(400, "Choose an active table");
  };
  const validate = (body: ReservationInput, existing?: Row) => {
    activeTable(body.tableId);
    const start = reservationTime(body.startsLocal), end = start + body.durationMinutes * 60000, now = Date.now();
    if (end <= now || (start < now - 5 * 60000 && start !== existing?.starts_at)) throw httpError(400, "Choose a current or future reservation time");
    assertReservationSlot(app.db, body.tableId, start, end, existing?.id);
    return { start, end, now };
  };
  const changed = (id: string, tableId: string, oldTableId?: string) => {
    // Broadcast IDs only; customer details are returned through the permission-checked API.
    app.broadcast("reservation.changed", { id });
    app.broadcast("table.changed", { tableId });
    if (oldTableId && oldTableId !== tableId) app.broadcast("table.changed", { tableId: oldTableId });
  };

  app.get("/api/reservations", { preHandler: read }, async (req, reply) => {
    const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(localDateKey(Date.now())) }).parse(req.query);
    const start = reservationTime(`${date}T00:00`), end = new Date(start); end.setDate(end.getDate() + 1);
    const rows = app.db.prepare(`${select} WHERE r.starts_at < ? AND r.ends_at > ? ORDER BY r.starts_at, r.created_at, r.id`).all(end.getTime(), start) as Row[];
    const now = Date.now();
    reply.header("Cache-Control", "no-store");
    return { date, reservations: rows.map(json), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, now, nowLocal: localMinute(now) };
  });

  app.post("/api/reservations", { preHandler: manage }, async (req, reply) => {
    const body = ReservationCreate.parse(req.body), fingerprint = JSON.stringify(body);
    let created = false;
    const id = app.db.transaction(() => {
      const old = app.db.prepare("SELECT id, request_json FROM reservations WHERE client_ref = ?").get(body.clientRef) as { id: string; request_json: string } | undefined;
      if (old) {
        if (old.request_json !== fingerprint) throw httpError(409, "This request was already used for another reservation. Refresh the list before trying again.");
        return old.id;
      }
      const { start, end, now } = validate(body), id = uuidv7();
      app.db.prepare(`INSERT INTO reservations (id, client_ref, request_json, table_id, customer_name, phone, party_size, starts_at, ends_at, notes, created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, body.clientRef, fingerprint, body.tableId, body.customerName, body.phone, body.partySize, start, end, body.notes, now, req.user.id, now, req.user.id);
      created = true; return id;
    })();
    if (created) changed(id, body.tableId);
    return reply.status(created ? 201 : 200).send({ reservation: json(requireRow(id)) });
  });

  app.patch("/api/reservations/:id", { preHandler: manage }, async (req) => {
    const id = idOf(req.params), body = ReservationUpdate.parse(req.body);
    const oldTableId = app.db.transaction(() => {
      const row = requireRow(id); current(row, body.version);
      const { start, end, now } = validate(body, row);
      app.db.prepare(`UPDATE reservations SET table_id=?, customer_name=?, phone=?, party_size=?, starts_at=?, ends_at=?, notes=?,
        version=version+1, updated_at=?, updated_by=? WHERE id=?`).run(body.tableId, body.customerName, body.phone, body.partySize, start, end, body.notes, now, req.user.id, id);
      return row.table_id;
    })();
    changed(id, body.tableId, oldTableId);
    return { reservation: json(requireRow(id)) };
  });

  app.post("/api/reservations/:id/status", { preHandler: manage }, async (req) => {
    const id = idOf(req.params), body = ReservationStatus.parse(req.body);
    const row = app.db.transaction(() => {
      const row = requireRow(id);
      if (row.status === body.status) return row;
      current(row, body.version);
      if (body.status === "no_show" && Date.now() < row.starts_at) throw httpError(409, "A future reservation cannot be marked as a no-show yet");
      app.db.prepare("UPDATE reservations SET status=?, version=version+1, updated_at=?, updated_by=? WHERE id=?").run(body.status, Date.now(), req.user.id, id);
      return requireRow(id);
    })();
    changed(id, row.table_id);
    return { reservation: json(row) };
  });

  app.post("/api/reservations/:id/seat", { preHandler: [manage, app.requirePermission("orders.create")] }, async (req) => {
    const id = idOf(req.params), body = ReservationVersion.parse(req.body);
    let created = false;
    const orderId = app.db.transaction(() => {
      const row = requireRow(id);
      if (row.status === "seated" && row.order_id) return row.order_id;
      current(row, body.version); activeTable(row.table_id);
      const now = Date.now();
      if (now < row.starts_at - 30 * 60000) throw httpError(409, "Seat the party from 30 minutes before its reservation time, or edit the time first.");
      if (now >= row.ends_at) throw httpError(409, "This reservation has ended. Reschedule it before seating the party.");
      if (app.db.prepare("SELECT id FROM orders WHERE table_id = ? AND status IN ('open','billed') LIMIT 1").get(row.table_id)) throw httpError(409, "This table is still occupied. Finish its current orders or move the reservation to another table.");
      assertReservationSlot(app.db, row.table_id, Math.min(now, row.starts_at), row.ends_at, id);
      const orderId = uuidv7(), ref = `reservation:${id}`, label = nextSplitLabel(app.db, row.table_id);
      if (!label || app.db.prepare("SELECT id FROM orders WHERE client_ref = ?").get(ref)) throw httpError(409, "Could not open this table. Refresh and review the reservation.");
      app.db.prepare("INSERT INTO orders (id, client_ref, type, table_id, split_label, opened_by, opened_at, price_tier) VALUES (?, ?, 'dine_in', ?, ?, ?, ?, ?)").run(orderId, ref, row.table_id, label, req.user.id, now, tablePriceTier(app.db, row.table_id));
      app.db.prepare("UPDATE reservations SET status='seated', order_id=?, version=version+1, updated_at=?, updated_by=? WHERE id=?").run(orderId, now, req.user.id, id);
      created = true; return orderId;
    })();
    const row = requireRow(id), order = loadOrderJson(app.db, orderId)!;
    if (created) { changed(id, row.table_id); app.broadcast("order.updated", { order }); }
    return { reservation: json(row), order };
  });
}
