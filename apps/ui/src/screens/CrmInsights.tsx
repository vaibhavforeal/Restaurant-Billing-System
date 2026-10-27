import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../api";
import { todayKey } from "../crm";
import { paiseToRupees } from "../money";

interface CrmReport {
  customers: { total: number; active: number; new: number; returning: number; repeatRate: number; optedIn: number };
  bills: { bills: number; withCustomer: number; attachRate: number };
  points: { enabled: boolean; issued: number; redeemed: number; expired: number; reversed: number; outstanding: number; liabilityPaise: number };
  tiers: Array<{ name: string; customers: number }>;
  feedback: { count: number; average: number | null; low: number; spread: Array<{ rating: number; count: number }> };
  topCustomers: Array<{ id: string; name: string; phone: string; visits: number; spendPaise: number; tierName: string | null }>;
}
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return todayKey(d); };
const percent = (n: number) => `${Math.round(n * 100)}%`;

/** How the customer base is doing over a date range: who came, who came back, points given and spent, and ratings. */
export function CrmInsights() {
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(todayKey());
  const [report, setReport] = useState<CrmReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    apiFetch<CrmReport>(`/api/reports/crm?from=${from}&to=${to}`)
      .then((r) => { if (active) { setReport(r); setError(""); } })
      .catch((e) => { if (active) setError(e instanceof ApiError ? e.message : "Could not load insights"); });
    return () => { active = false; };
  }, [from, to]);

  const spreadMax = Math.max(1, ...(report?.feedback.spread.map((s) => s.count) ?? [1]));
  return <div className="panel crm-insights">
    <div className="cash-drawer-form">
      <label>From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value || from)} /></label>
      <label>To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value || to)} /></label>
    </div>
    {error && <p role="alert">{error}</p>}
    {report && <>
      <h3>Customers</h3>
      <dl className="crm-tiles">
        <div><dt>Came in</dt><dd>{report.customers.active}</dd></div>
        <div><dt>New</dt><dd>{report.customers.new}</dd></div>
        <div><dt>Returning</dt><dd>{report.customers.returning}</dd></div>
        <div><dt>Repeat rate</dt><dd>{percent(report.customers.repeatRate)}</dd></div>
        <div><dt>Bills with a customer</dt><dd>{percent(report.bills.attachRate)}</dd></div>
        <div><dt>Customers on file</dt><dd>{report.customers.total}</dd></div>
        <div><dt>Opted in to offers</dt><dd>{report.customers.optedIn}</dd></div>
      </dl>

      {report.points.enabled && <>
        <h3>Loyalty points</h3>
        <dl className="crm-tiles">
          <div><dt>Given</dt><dd>{report.points.issued}</dd></div>
          <div><dt>Redeemed</dt><dd>{report.points.redeemed}</dd></div>
          <div><dt>Expired</dt><dd>{report.points.expired}</dd></div>
          <div><dt>Unspent now</dt><dd>{report.points.outstanding}</dd></div>
          <div><dt>Worth now</dt><dd>₹{paiseToRupees(report.points.liabilityPaise)}</dd></div>
        </dl>
      </>}

      {report.tiers.length > 0 && <>
        <h3>Tiers today</h3>
        <dl className="crm-tiles">{report.tiers.map((t) => <div key={t.name}><dt>{t.name}</dt><dd>{t.customers}</dd></div>)}</dl>
      </>}

      <h3>Feedback</h3>
      {report.feedback.count ? <>
        <p><strong>{report.feedback.average?.toFixed(1)}</strong> average from {report.feedback.count} rating{report.feedback.count === 1 ? "" : "s"}{report.feedback.low ? ` · ${report.feedback.low} low (1–2 stars)` : ""}</p>
        <ul className="crm-spread" aria-label="Ratings by stars">{[5, 4, 3, 2, 1].map((stars) => {
          const count = report.feedback.spread.find((s) => s.rating === stars)?.count ?? 0;
          return <li key={stars}><span>{stars}★</span><span className="crm-bar"><span style={{ width: `${(count / spreadMax) * 100}%` }} /></span><span>{count}</span></li>;
        })}</ul>
      </> : <p className="muted">No ratings for these dates.</p>}

      <h3>Top customers</h3>
      <table className="customer-ledger">
        <thead><tr><th>Name</th><th>Phone</th><th>Tier</th><th>Visits</th><th>Spend</th></tr></thead>
        <tbody>{report.topCustomers.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.phone}</td><td>{c.tierName ?? ""}</td><td>{c.visits}</td><td className="pos-money">₹{paiseToRupees(c.spendPaise)}</td></tr>)}
          {!report.topCustomers.length && <tr><td className="muted" colSpan={5}>No customer bills for these dates.</td></tr>}</tbody>
      </table>
    </>}
  </div>;
}
