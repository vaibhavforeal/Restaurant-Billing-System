export const DAY_MS = 86_400_000;
/** Paid licences keep working this long past their end date, so a late renewal never stops billing mid-service. */
export const GRACE_MS = 7 * DAY_MS;

// Licence terms are sold in Indian calendar months, so month arithmetic happens on the IST wall clock.
const IST_OFFSET_MS = 330 * 60_000;

/** The same wall-clock time `months` later in IST; the 31st of January plus one month is the last day of February. */
export function addMonths(at: number, months: number): number {
  const local = new Date(at + IST_OFFSET_MS);
  const target = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + months, 1,
    local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(local.getUTCDate(), lastDay));
  return target.getTime() - IST_OFFSET_MS;
}
