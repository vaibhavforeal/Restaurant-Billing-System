import type { GstReturnsReport } from "@masalapos/domain/gst-returns";
import { operationalCsv } from "./operational-report";

export interface GstAuditorFile { name: string; content: string; type: string }

export function gstAuditorCsv(report: GstReturnsReport): GstAuditorFile {
  return { name: gstReturnsCsvName(report), type: "text/csv;charset=utf-8", content: operationalCsv({
    ...report, notes: [`GSTIN: ${report.gstin}`, `GST regime: ${report.regime}`, ...report.notes, ...report.warnings.map(w => `Warning: ${w}`)],
  }) };
}

export function gstAuditorEmail(report: GstReturnsReport, files: GstAuditorFile[]) {
  return {
    subject: `GST reports — ${report.period.label} — ${report.gstin}`,
    body: [`Hello,`, ``, `Please review the GST reports for ${report.period.label} (${report.from} to ${report.to}).`,
      `GSTIN: ${report.gstin}`, ``, `Files to attach:`, ...files.map(file => file.name),
      ...(report.warnings.length ? ["", "Report warnings:", ...report.warnings] : []), "", "Please verify the figures before filing.", "", "Thank you."].join("\n"),
  };
}

/** The month GST returns open on: last month, the one a restaurant files for. `today` is YYYY-MM-DD. */
export function defaultGstMonth(today: string): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** e.g. masalapos-gst-returns-2026-10-01-to-2026-10-31.csv */
export const gstReturnsCsvName = (r: Pick<GstReturnsReport, "from" | "to">) => `masalapos-gst-returns-${r.from}-to-${r.to}.csv`;
/** The name GSTN tools expect is free-form; the GSTIN and return period make each file easy to find. */
export const gstr1JsonName = (gstin: string, fp: string) => `GSTR1_${gstin}_${fp}.json`;

/** Today on this device, as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
