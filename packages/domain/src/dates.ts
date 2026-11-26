/** Local-time YYYY-MM-DD key: the calendar date. GST invoice dates, offers and reservations use this. */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The business day a moment belongs to. The day starts at `startHour` (0-6, set in Settings) rather than midnight, so a
 * restaurant open past midnight counts the whole night as one day: with a 4 a.m. start, 1:45 a.m. on the 10th is still
 * the 9th. Day-end, day close, KOT numbers and the daily report totals use this; calendar dates use `localDateKey`.
 */
export function businessDateKey(ms: number, startHour = 0): string {
  const d = new Date(ms);
  if (d.getHours() < startHour) d.setDate(d.getDate() - 1);
  return localDateKey(d.getTime());
}

/** The local start and end (ms) of business day `date` (YYYY-MM-DD): from its start hour to the next day's. */
export function businessDayBounds(date: string, startHour = 0): [number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const start = new Date(y, m - 1, d, startHour);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || localDateKey(start.getTime()) !== date) throw new Error(`Invalid date: ${date}`);
  // Calendar arithmetic rather than adding 24 hours, so a daylight-saving change cannot move the boundary.
  const end = new Date(y, m - 1, d + 1, startHour);
  return [start.getTime(), end.getTime()];
}

/** SQL for the business day (YYYY-MM-DD) of a millisecond column, matching `businessDateKey`. */
export function businessDateSql(column: string, startHour = 0): string {
  const hour = Math.trunc(startHour);
  return `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch', 'localtime'${hour ? `, '-${hour} hours'` : ""})`;
}
