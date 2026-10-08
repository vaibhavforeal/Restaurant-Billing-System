import { useEffect, useState, type CSSProperties } from "react";
import { localDay, recentPeriod, salesMetrics, type ReportPeriod, type SalesReport } from "./sales-report";

export function SalesPeriodControls({ period, today = localDay(), loading, onChange, onRefresh }: {
  period: ReportPeriod; today?: string | undefined; loading: boolean; onChange: (period: ReportPeriod) => void; onRefresh: () => void;
}) {
  const [draft, setDraft] = useState(() => ({ from: period.from, to: period.to }));
  const [error, setError] = useState("");
  useEffect(() => { setDraft({ from: period.from, to: period.to }); setError(""); }, [period.from, period.to]);
  function apply() {
    if (!draft.from || !draft.to || draft.from > draft.to) { setError("Choose a start date on or before the end date."); return; }
    setError(""); onChange(draft);
  }
  return <form className="sales-period" aria-label="Report date range" onSubmit={(event) => { event.preventDefault(); apply(); }}>
    <div className="sales-presets" aria-label="Quick date ranges">{[{ days: 1, label: "Today" }, { days: 7, label: "7 days" }, { days: 30, label: "30 days" }].map(({ days, label }) => {
      const value = recentPeriod(days, today);
      return <button type="button" key={days} aria-pressed={period.from === value.from && period.to === value.to} onClick={() => { setDraft(value); setError(""); onChange(value); }}>{label}</button>;
    })}</div>
    <label>From<input type="date" required value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
    <label>To<input type="date" required value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
    <button type="submit">Apply dates</button>
    <button className="sales-refresh" type="button" disabled={loading} onClick={onRefresh} title="Refresh sales and payment collections">{loading ? "Loading…" : "Refresh"}</button>
    {error && <p className="sales-period-error" role="alert">{error}</p>}
  </form>;
}

export function SalesMetrics({ report }: { report: SalesReport }) {
  return <div className="sales-metrics">{salesMetrics(report).map((metric) => <div className={`sales-metric${metric.label === "Collections received" ? " sales-metric-collections" : ""}`} key={metric.label}><p>{metric.label}</p><strong style={{ "--sales-value-length": metric.value.length } as CSSProperties}>{metric.value}</strong><small>{metric.note}</small></div>)}</div>;
}

export function SalesRangeCaption({ report }: { report: Pick<SalesReport, "from" | "to" | "timezone" | "generatedAt"> }) {
  return <div className="sales-range-caption"><span>{report.from} → {report.to} · {report.timezone}</span><span>Updated {new Date(report.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>;
}
