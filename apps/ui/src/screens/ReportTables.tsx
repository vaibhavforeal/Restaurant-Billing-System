import type { ReportTable } from "@masalapos/domain/operational-reports";
import { operationalCell } from "../operational-report";

/** The part of a table report the reader sees: how it is calculated, then each table with its totals. */
export function ReportTables({ report, emptyText = "No records for these dates." }: {
  report: { from: string; to: string; timezone: string; notes: string[]; tables: ReportTable[] };
  emptyText?: string;
}) {
  return <>
    {report.notes.length > 0 && <details className="report-notes"><summary>How this report is calculated</summary>{report.notes.map((note) => <p key={note}>{note}</p>)}</details>}
    {report.tables.map((table) => <section key={table.title}>
      <h3>{table.title} <small>({table.rows.length})</small></h3>
      {!table.rows.length ? <p className="sales-report-empty">{emptyText}</p> : <div className="sales-report-table" role="region" aria-label={table.title} tabIndex={0}>
        <table><caption>{table.title} · {report.from} to {report.to}</caption>
          <thead><tr>{table.columns.map((c) => <th scope="col" key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, index) => <tr key={index}>{table.columns.map((c, i) => i === 0
            ? <th scope="row" key={c.key}>{operationalCell(row[c.key], c, report.timezone)}</th>
            : <td key={c.key}>{operationalCell(row[c.key], c, report.timezone)}</td>)}</tr>)}</tbody>
          {table.totals && <tfoot><tr>{table.columns.map((c, i) => i === 0
            ? <th scope="row" key={c.key}>{operationalCell(table.totals![c.key], c, report.timezone)}</th>
            : <td key={c.key}>{operationalCell(table.totals![c.key], c, report.timezone)}</td>)}</tr></tfoot>}
        </table>
      </div>}
    </section>)}
  </>;
}
