import { useEffect, useState } from "react";
import { OPERATIONAL_REPORTS, type OperationalReport, type OperationalReportKind } from "@forkflow/domain/operational-reports";
import { apiFetch } from "../api";
import { SalesPeriodControls } from "../SalesReportControls";
import { recentPeriod, type ReportPeriod } from "../sales-report";
import { downloadText } from "../download";
import { operationalCell, operationalCsv } from "../operational-report";

export type ProfitReport = Omit<OperationalReport, "kind"> & { kind: "profit" };
type LoadedReport = OperationalReport | ProfitReport;
export const PROFIT_REPORT_TITLE = "Food cost & profit";

export function OperationalReports({ kind, initialPeriod, onPeriodChange }: { kind: OperationalReportKind | "profit"; initialPeriod?: ReportPeriod | undefined; onPeriodChange: (period: ReportPeriod) => void }) {
  const [period, setPeriod] = useState(initialPeriod ?? recentPeriod(7));
  const [report, setReport] = useState<LoadedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true); setReport(null); setError(""); setMessage("");
    apiFetch<{ report: LoadedReport }>(`${kind === "profit" ? "/api/reports/profit" : `/api/reports/operations/${kind}`}?${new URLSearchParams({ from: period.from, to: period.to })}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(({ report }) => { if (active) setReport(report); })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Could not load report"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [kind, period.from, period.to, revision]);
  function invalidate() { setReport(null); setLoading(true); setError(""); setMessage(""); }
  function exportReport() {
    if (!report || loading) return;
    try {
      downloadText(operationalCsv(report), `forkflow-${kind}-${report.from}-to-${report.to}.csv`, "text/csv;charset=utf-8");
      setMessage("CSV downloaded. Amounts are in rupees.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not export report"); }
  }
  return <div className="operational-report">
    <div className="page-header"><h3>{kind === "profit" ? PROFIT_REPORT_TITLE : OPERATIONAL_REPORTS.find((r) => r.id === kind)!.title}</h3><button disabled={!report || loading} onClick={exportReport}>Export CSV</button></div>
    <SalesPeriodControls period={period} today={report?.today} loading={loading} onChange={(next) => { invalidate(); setPeriod(next); onPeriodChange(next); setRevision((v) => v + 1); }} onRefresh={() => { invalidate(); setRevision((v) => v + 1); }} />
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {loading && <p role="status">Loading report…</p>}
    {report && <>
      <div className="sales-range-caption"><span>{report.from} → {report.to} · {report.timezone}</span><span>Updated {new Date(report.generatedAt).toLocaleTimeString()}</span></div>
      <details className="report-notes"><summary>How this report is calculated</summary>{report.notes.map((note) => <p key={note}>{note}</p>)}</details>
      {report.tables.map((table) => <section key={table.title}>
        <h3>{table.title} <small>({table.rows.length})</small></h3>
        {!table.rows.length ? <p className="sales-report-empty">No records for these dates.</p> : <div className="sales-report-table" role="region" aria-label={table.title} tabIndex={0}>
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
    </>}
  </div>;
}
