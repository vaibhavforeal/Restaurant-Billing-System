import { localDateKey, type Database } from "@forkflow/domain";
import { httpError } from "./http-error.js";

export const localMinute = (ms: number) => {
  const d = new Date(ms);
  return `${localDateKey(ms)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export function reservationTime(value: string): number {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms) || localMinute(ms) !== value) throw httpError(400, "Invalid reservation date or time");
  return ms;
}
export function assertReservationSlot(db: Database, tableId: string, start: number, end: number, exclude = "") {
  const conflict = db.prepare(`SELECT r.id FROM reservations r LEFT JOIN orders o ON o.id = r.order_id
    WHERE r.table_id = ? AND r.id != ? AND r.starts_at < ? AND r.ends_at > ?
      AND (r.status = 'booked' OR (r.status = 'seated' AND o.status IN ('open','billed'))) LIMIT 1`).get(tableId, exclude, end, start);
  if (conflict) throw httpError(409, "This table already has a reservation during that time. Choose another table or time.");
}
/** New walk-in groups cannot consume a table currently held for a booked party. */
export function assertTableNotReserved(db: Database, tableId: string, now: number) {
  const row = db.prepare("SELECT id FROM reservations WHERE table_id = ? AND status = 'booked' AND starts_at <= ? AND ends_at > ? LIMIT 1").get(tableId, now, now);
  if (row) throw httpError(409, "This table is reserved now. Open Reservations to seat the party, reschedule or cancel the booking.");
}
