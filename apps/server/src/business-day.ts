import { businessDateKey, businessDayBounds, type Database } from "@masalapos/domain";
import { httpError } from "./http-error.js";

/** The hour (0-6) the restaurant's business day starts, from Settings → Bill settings. */
export function dayStartHour(db: Database): number {
  return (db.prepare("SELECT day_start_hour AS h FROM settings WHERE id = 1").get() as { h: number }).h;
}

/** Today's business date: before the start hour, still yesterday. */
export function businessToday(db: Database, now = Date.now()): string {
  return businessDateKey(now, dayStartHour(db));
}

/** The [start, end) times of a business date for report and day-close queries; a date that does not exist is a 400. */
export function businessBounds(date: string, startHour: number): [number, number] {
  try {
    return businessDayBounds(date, startHour);
  } catch {
    throw httpError(400, "Invalid report date");
  }
}
