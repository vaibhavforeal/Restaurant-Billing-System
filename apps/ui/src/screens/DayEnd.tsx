import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { paiseToRupees } from "../money";
import type { TaxLine } from "@forkflow/domain";

interface Report {
  date: string; timezone: string;
  sales: { billCount: number; subtotalPaise: number; discountPaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; totalPaise: number; outstandingPaise: number };
  taxes: TaxLine[]; payments: Array<{ mode: string; amountPaise: number }>; cancellations: { orderCount: number };
}
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
const money = (n: number) => `₹${paiseToRupees(n)}`;
export function DayEnd() {
  const [date, setDate] = useState(today);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true; setReport(null);
    apiFetch<{ report: Report }>(`/api/reports/day-end?date=${encodeURIComponent(date)}`).then((r) => { if (active) { setReport(r.report); setError(""); } }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Could not load report"); });
    return () => { active = false; };
  }, [date, version]);
  return <section className="legacy-screen">
    <h2>Day-end report</h2>
    <label>Business date <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>{" "}<button onClick={() => setVersion((v) => v + 1)}>Refresh report</button>
    <p role="alert" style={{ color: "crimson" }}>{error}</p>
    {report && <>
      <p>{report.date} · Server timezone: {report.timezone}</p>
      <h3>Bills issued on this date</h3>
      <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <dt>Number of bills</dt><dd>{report.sales.billCount}</dd>
        <dt>Sales including GST and rounding</dt><dd>{money(report.sales.totalPaise)}</dd>
        <dt>Discounts</dt><dd>{money(report.sales.discountPaise)}</dd>
        <dt>CGST</dt><dd>{money(report.sales.cgstPaise)}</dd><dt>SGST</dt><dd>{money(report.sales.sgstPaise)}</dd>
        <dt>Round off</dt><dd>{money(report.sales.roundingPaise)}</dd>
        <dt>Still unpaid (current)</dt><dd>{money(report.sales.outstandingPaise)}</dd>
        <dt>Orders cancelled on this date</dt><dd>{report.cancellations.orderCount}</dd>
      </dl>
      <h3>GST breakdown</h3>
      <table style={{ width: "100%", textAlign: "right", borderSpacing: 8 }}><thead><tr><th>Rate</th><th>Taxable</th><th>CGST</th><th>SGST</th></tr></thead><tbody>
        {report.taxes.map((t) => <tr key={t.gstRate}><td>{t.gstRate}%</td><td>{money(t.taxablePaise)}</td><td>{money(t.cgstPaise)}</td><td>{money(t.sgstPaise)}</td></tr>)}
      </tbody></table>
      <h3>Payments received on this date</h3>
      <p>Includes payments for older bills. This can differ from today's issued sales.</p>
      {(["cash", "upi", "card"] as const).map((mode) => <p key={mode}>{mode.toUpperCase()}: {money(report.payments.find((p) => p.mode === mode)?.amountPaise ?? 0)}</p>)}
      <strong>Total received: {money(report.payments.reduce((sum, p) => sum + p.amountPaise, 0))}</strong>
    </>}
  </section>;
}
