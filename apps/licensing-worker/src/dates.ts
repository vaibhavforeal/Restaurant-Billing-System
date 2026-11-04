export const DAY_MS = 86_400_000;
/** Paid licences keep working this long past their end date, so a late renewal never stops billing mid-service. */
export const GRACE_MS = 7 * DAY_MS;

// MasalaPOS sells, invoices and reports on the Indian calendar, so day, month and year arithmetic happens on the IST wall clock.
export const IST_OFFSET_MS = 330 * 60_000;
const ist = (at: number) => new Date(at + IST_OFFSET_MS);

/** The moment today began in India. */
export const istDayStart = (at: number) => { const d = ist(at); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_OFFSET_MS; };
/** The moment this month began in India. */
export const istMonthStart = (at: number) => { const d = ist(at); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST_OFFSET_MS; };
/** The year the Indian financial year (April to March) containing `at` began in. */
export const financialYearOf = (at: number) => { const d = ist(at); return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; };
/** The moment that financial year began (1 April, IST). */
export const financialYearStart = (at: number) => Date.UTC(financialYearOf(at), 3, 1) - IST_OFFSET_MS;
/** SQL: the IST month (YYYY-MM) of a Unix-ms column. */
export const istMonthSql = (column: string) => `strftime('%Y-%m', (${column} + ${IST_OFFSET_MS}) / 1000, 'unixepoch')`;

/** The same wall-clock time `months` later in IST; the 31st of January plus one month is the last day of February. */
export function addMonths(at: number, months: number): number {
  const local = ist(at);
  const target = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + months, 1,
    local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(local.getUTCDate(), lastDay));
  return target.getTime() - IST_OFFSET_MS;
}
