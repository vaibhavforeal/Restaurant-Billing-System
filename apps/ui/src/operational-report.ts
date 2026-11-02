import type { OperationalReport, ReportCell, ReportColumn } from "@masalapos/domain";
import { toCsv, type CsvCell } from "@masalapos/domain/csv";
import { reportMoney } from "./sales-report";

export function operationalCell(value: ReportCell | undefined, column: ReportColumn, timezone: string, csv = false): string {
  if (value === null || value === undefined) return csv ? "" : "—";
  if (column.format === "money") return csv ? (Number(value) / 100).toFixed(2) : reportMoney(Number(value));
  if (column.format === "time") return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(Number(value)));
  if (column.format === "minutes") return Number(value).toFixed(1);
  if (column.format === "percent") return Number(value).toFixed(1) + (csv ? "" : "%");
  if (column.format === "quantity") return String(Math.round(Number(value) * 1000) / 1000);
  return String(value);
}

/** CSV header: money gets " INR"; percent gets " %" unless the label already says percent ("Food cost %", "Percent"). */
function csvHeader(column: ReportColumn): string {
  if (column.format === "money") return column.label + " INR";
  if (column.format === "percent" && !/%|percent/i.test(column.label)) return column.label + " %";
  return column.label;
}

export function operationalCsv(report: Omit<OperationalReport, "kind"> & { kind: string }): string {
  const rows: CsvCell[][] = [["Report", report.kind], ["From", report.from], ["To", report.to], ["Server timezone", report.timezone], ["Generated at", new Date(report.generatedAt).toISOString()], ...report.notes.map((note) => ["Note", note])];
  for (const table of report.tables) {
    rows.push([], [table.title], table.columns.map(csvHeader));
    for (const row of [...table.rows, ...(table.totals ? [table.totals] : [])]) rows.push(table.columns.map((c) => operationalCell(row[c.key], c, report.timezone, true)));
  }
  return toCsv(rows);
}
