/** A GST return period: one month, or a financial-year quarter (Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar) for quarterly (QRMP) filers. */
export type GstSpan = "month" | "quarter";
export interface GstPeriod {
  span: GstSpan;
  /** First and last day, as YYYY-MM-DD. */
  from: string; to: string;
  /** The months covered, as YYYY-MM. */
  months: string[];
  /** The return period GSTN expects in the JSON: MMYYYY of the last month. */
  fp: string;
  label: string;
  /** e.g. "2026-27". */
  financialYear: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The month or quarter that contains `month` (YYYY-MM). Throws on a malformed month. */
export function gstPeriod(month: string, span: GstSpan): GstPeriod {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const year = m ? Number(m[1]) : NaN, mon = m ? Number(m[2]) : NaN;
  if (!m || mon < 1 || mon > 12 || year < 2017) throw new Error("Choose a month like 2026-10");
  const fyStart = mon >= 4 ? year : year - 1;
  const financialYear = `${fyStart}-${pad((fyStart + 1) % 100)}`;
  if (span === "month") {
    return { span, from: `${month}-01`, to: `${month}-${pad(lastDay(year, mon))}`, months: [month], fp: `${pad(mon)}${year}`,
      label: `${MONTHS[mon - 1]} ${year}`, financialYear };
  }
  // Quarter 1 starts in April; its months are offsets 0-2 from the quarter's first month.
  const quarter = Math.floor(((mon + 8) % 12) / 3) + 1;
  const firstMonth = ((quarter - 1) * 3 + 3) % 12 + 1;
  const months = [0, 1, 2].map((i) => {
    const mm = firstMonth + i, yy = quarter === 4 ? fyStart + 1 : fyStart;
    return `${yy}-${pad(mm)}`;
  });
  const [ly, lm] = months[2]!.split("-").map(Number) as [number, number];
  const [fy, fm] = months[0]!.split("-").map(Number) as [number, number];
  return { span, from: `${months[0]}-01`, to: `${months[2]}-${pad(lastDay(ly, lm))}`, months, fp: `${pad(lm)}${ly}`,
    label: `Q${quarter} FY ${financialYear} (${MONTHS[fm - 1]!.slice(0, 3)} ${fy} - ${MONTHS[lm - 1]!.slice(0, 3)} ${ly})`, financialYear };
}

/** "2026-10-05" -> "05-10-2026", the date format in GSTN JSON. */
export const gstDate = (dateKey: string) => dateKey.split("-").reverse().join("-");
