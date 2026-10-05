import type { OperationalReport, ReportCell, ReportColumn } from "@forkflow/domain";
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
  const quote = (text: string, numeric = false) => '"' + ((!numeric && /^(?:\s*[=+\-@]|[\t\r\n'])/.test(text) ? "'" : "") + text).replaceAll('"', '""') + '"';
  const lines = [["Report", report.kind], ["From", report.from], ["To", report.to], ["Server timezone", report.timezone], ["Generated at", new Date(report.generatedAt).toISOString()], ...report.notes.map((note) => ["Note", note])].map((row) => row.map((cell) => quote(cell)).join(","));
  for (const table of report.tables) {
    lines.push("", quote(table.title), table.columns.map((c) => quote(csvHeader(c))).join(","));
    for (const row of [...table.rows, ...(table.totals ? [table.totals] : [])]) {
      lines.push(table.columns.map((c) => quote(operationalCell(row[c.key], c, report.timezone, true), typeof row[c.key] === "number" && c.format !== "time")).join(","));
    }
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
