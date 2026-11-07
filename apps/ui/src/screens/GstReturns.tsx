import { useEffect, useState } from "react";
import type { GstReturnsReport, GstSpan } from "@masalapos/domain/gst-returns";
import { apiFetch } from "../api";
import { downloadText } from "../download";
import { operationalCsv } from "../operational-report";
import { withTimeout } from "../abort-signal";
import { defaultGstMonth, gstr1JsonName, gstReturnsCsvName, localToday } from "../gst-returns";
import { ReportTables } from "./ReportTables";
import { GstAuditorDialog } from "./GstAuditorDialog";

const REGIME_LABEL: Record<GstReturnsReport["regime"], string> = {
  regular: "Regular GST: GSTR-1 and GSTR-3B",
  composition: "Composition scheme: CMP-08",
  unregistered: "Not registered for GST",
};

/**
 * GST returns for a month or a financial-year quarter: GSTR-1 tables and GSTR-3B Table 3.1 for a regular restaurant, CMP-08 for a
 * composition one. The accountant downloads the CSV, and for GSTR-1 the JSON file the GST offline tool and portal import.
 */
export function GstReturns() {
  const [month, setMonth] = useState(() => defaultGstMonth(localToday()));
  const [span, setSpan] = useState<GstSpan>("month");
  const [report, setReport] = useState<GstReturnsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const [auditorReport, setAuditorReport] = useState<GstReturnsReport | null>(null);
  const query = new URLSearchParams({ period: month, span }).toString();

  useEffect(() => {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      setReport(null); setLoading(false); setMessage(""); setError("Choose a month to load GST returns.");
      return;
    }
    let active = true;
    const controller = new AbortController();
    setLoading(true); setReport(null); setError(""); setMessage("");
    apiFetch<{ report: GstReturnsReport }>(`/api/reports/gst-returns?${query}`, { signal: withTimeout(controller.signal, 20000) })
      .then(({ report }) => { if (active) setReport(report); })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Could not load GST returns"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [query, month, revision]);

  function exportCsv() {
    if (!report) return;
    try {
      downloadText(operationalCsv(report), gstReturnsCsvName(report), "text/csv;charset=utf-8");
      setError(""); setMessage("CSV downloaded. Amounts are in rupees.");
    } catch (e) { setMessage(""); setError(e instanceof Error ? e.message : "Could not export the report"); }
  }
  async function downloadGstr1() {
    if (!report) return;
    try {
      const json = await apiFetch<Record<string, unknown>>(`/api/reports/gst-returns/gstr1.json?${query}`);
      downloadText(JSON.stringify(json, null, 2), gstr1JsonName(report.gstin, report.period.fp), "application/json");
      setError(""); setMessage("GSTR-1 file downloaded. Open it in the GST offline tool or upload it on the GST portal, then check the totals before filing.");
    } catch (e) { setMessage(""); setError(e instanceof Error ? e.message : "Could not download the GSTR-1 file"); }
  }

  return <div className="operational-report gst-returns">
    {auditorReport && <GstAuditorDialog report={auditorReport} onClose={() => setAuditorReport(null)} />}
    <div className="page-header"><h3>GST returns</h3>
      <div className="gst-returns-actions">
        <button className="primary" disabled={!report || loading || report.regime === "unregistered"} onClick={() => setAuditorReport(report)} aria-haspopup="dialog">Send to auditor</button>
        <button disabled={!report || loading} onClick={exportCsv}>Export CSV</button>
        {report?.regime === "regular" && <button disabled={loading || !report.gstr1Available} onClick={() => void downloadGstr1()}
          title={report.gstr1Available ? undefined : "Fix the restaurant's GSTIN in Settings first"}>Download GSTR-1 JSON</button>}
      </div>
    </div>
    <div className="sales-period gst-returns-period" role="group" aria-label="Return period">
      <label>Month <input type="month" value={month} max={localToday().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} /></label>
      <label>Period <select value={span} onChange={(e) => setSpan(e.target.value as GstSpan)}>
        <option value="month">Month</option><option value="quarter">Quarter (quarterly filers)</option>
      </select></label>
      <button className="sales-refresh" disabled={loading} onClick={() => setRevision((v) => v + 1)}>{loading ? "Loading…" : "Refresh"}</button>
    </div>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {loading && <p role="status">Loading GST returns…</p>}
    {report && <>
      <div className="sales-range-caption">
        <span><strong>{report.period.label}</strong> · {report.from} → {report.to}</span>
        <span>{REGIME_LABEL[report.regime]}{report.gstin ? ` · GSTIN ${report.gstin}` : ""}</span>
      </div>
      {report.warnings.length > 0 && <div className="gst-returns-warnings" role="alert">
        {report.warnings.map((w) => <p key={w}>{w}</p>)}
      </div>}
      <ReportTables report={report} emptyText="Nothing to report for this period." />
    </>}
  </div>;
}
