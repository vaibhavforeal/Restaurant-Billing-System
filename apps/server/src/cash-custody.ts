import type { Database } from "@masalapos/domain";
import { httpError } from "./http-error.js";

export function tradingShift(db: Database, actor: string) {
  const shift = db.prepare("SELECT id FROM shifts WHERE cashier_id=? AND closed_at IS NULL").get(actor) as {id: string} | undefined;
  if (!shift) throw httpError(409, "Open a drawer shift before handling cash.");
  if (db.prepare("SELECT 1 FROM handover_events WHERE shift_id=?").get(shift.id))
    throw httpError(409, "This drawer is frozen for handover.");
  return shift.id;
}
