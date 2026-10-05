import { Fragment, useEffect, useState } from "react";
import { apiFetch } from "../api";
import { paiseToRupees } from "../money";
import { dayEndCsv, type DayEndReport } from "../report-export";
import { downloadText } from "../download";
import { OverflowMenu } from "../PosControls";
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
const money = (n: number) => `₹${paiseToRupees(n)}`;
export function DayEnd({ initialDate }: { initialDate?: string | undefined }) {
  const [date, setDate] = useState(() => initialDate ?? today());
  const [report, setReport] = useState<DayEndReport | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true; setReport(null); setError(""); setMessage("");
    if (!date) return () => { active = false; };
    apiFetch<{ report: DayEndReport }>(`/api/reports/day-end?date=${encodeURIComponent(date)}`).then((r) => { if (active) { setReport(r.report); setError(""); } }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Could not load report"); });
    return () => { active = false; };
  }, [date, version]);
  function exportReport() {
    if (!report || report.date !== date) return;
    try {
      downloadText(dayEndCsv(report), `forkflow-day-end-${report.date}.csv`, "text/csv;charset=utf-8");
      setError(""); setMessage(`CSV download started for ${report.date}. Open it in Excel or another spreadsheet.`);
    } catch (e) {
      setMessage(""); setError(e instanceof Error ? e.message : "Could not export report");
    }
  }
  return <section className="legacy-screen">
    <div className="pos-toolbar"><h2>Day-end report</h2>
      <label>Business date <input type="date" value={date} onChange={(e) => { setReport(null); setDate(e.target.value); }} /></label>
      <button disabled={!date} onClick={() => { setReport(null); setVersion((v) => v + 1); }}>Refresh report</button>
      <OverflowMenu label="Export"><button disabled={!report || report.date !== date} onClick={exportReport} title="Download this report as a CSV file for Excel">Export CSV</button></OverflowMenu>
    </div>
    <p role="alert" style={{ color: "var(--danger-text, crimson)" }}>{error}</p>
    {message && <p role="status">{message}</p>}
    {report && <>
      <p>{report.date} · Server timezone: {report.timezone}</p>
      <div className="pos-report-grid"><section><h3>Bills issued on this date</h3>
      <dl className="pos-totals">
        <dt>Number of bills</dt><dd>{report.sales.billCount}</dd>
        <dt>Sales including GST and rounding</dt><dd>{money(report.sales.totalPaise)}</dd>
        <dt>Discounts</dt><dd>{money(report.sales.discountPaise)}</dd>
        <dt>CGST</dt><dd>{money(report.sales.cgstPaise)}</dd><dt>SGST</dt><dd>{money(report.sales.sgstPaise)}</dd>
        <dt>Round off</dt><dd>{money(report.sales.roundingPaise)}</dd>
        <dt>Still unpaid (current)</dt><dd>{money(report.sales.outstandingPaise)}</dd>
        <dt>Orders cancelled on this date</dt><dd>{report.cancellations.orderCount}</dd>
      </dl>
      </section><section><h3>GST breakdown</h3>
      <table style={{ width: "100%", textAlign: "right", borderSpacing: 8 }}><thead><tr><th>Rate</th><th>Taxable</th><th>CGST</th><th>SGST</th></tr></thead><tbody>
        {report.taxes.map((t) => <tr key={t.gstRate}><td>{t.gstRate}%</td><td>{money(t.taxablePaise)}</td><td>{money(t.cgstPaise)}</td><td>{money(t.sgstPaise)}</td></tr>)}
      </tbody></table>
      </section><section><h3>Payments received on this date</h3>
      <p>Includes payments for older bills. This can differ from today's issued sales.</p>
      <dl className="pos-totals">{(["cash", "upi", "card"] as const).map((mode) => <Fragment key={mode}><dt>{mode.toUpperCase()}</dt><dd>{money(report.payments.find((p) => p.mode === mode)?.amountPaise ?? 0)}</dd></Fragment>)}</dl>
      <strong>Total received: {money(report.payments.reduce((sum, p) => sum + p.amountPaise, 0))}</strong></section></div>
    </>}
  </section>;
}
