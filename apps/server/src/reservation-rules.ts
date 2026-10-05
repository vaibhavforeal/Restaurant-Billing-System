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
/** Status of the order a seated party's bill ended up in: merges fold an order into another, possibly more than once. */
function finalOrderStatus(db: Database, orderId: string): string | null {
  const get = db.prepare("SELECT status, merged_into FROM orders WHERE id = ?");
  const seen = new Set<string>();
  let id: string | null = orderId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const row = get.get(id) as { status: string; merged_into: string | null } | undefined;
    if (!row) return null;
    if (!row.merged_into) return row.status;
    id = row.merged_into;
  }
  return null;
}
export function assertReservationSlot(db: Database, tableId: string, start: number, end: number, exclude = "") {
  const overlapping = db.prepare(`SELECT status, order_id FROM reservations
    WHERE table_id = ? AND id != ? AND starts_at < ? AND ends_at > ? AND status IN ('booked','seated')`).all(tableId, exclude, end, start) as Array<{ status: "booked" | "seated"; order_id: string | null }>;
  // A seated party holds its slot while its bill — or the combined bill it was merged into — is open or billed.
  const conflict = overlapping.some((r) => r.status === "booked" || (r.order_id !== null && ["open", "billed"].includes(finalOrderStatus(db, r.order_id) ?? "")));
  if (conflict) throw httpError(409, "This table already has a reservation during that time. Choose another table or time.");
}
/** New walk-in groups cannot consume a table currently held for a booked party. */
export function assertTableNotReserved(db: Database, tableId: string, now: number) {
  const row = db.prepare("SELECT id FROM reservations WHERE table_id = ? AND status = 'booked' AND starts_at <= ? AND ends_at > ? LIMIT 1").get(tableId, now, now);
  if (row) throw httpError(409, "This table is reserved now. Open Reservations to seat the party, reschedule or cancel the booking.");
}
