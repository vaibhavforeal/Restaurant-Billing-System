import { useState } from "react";
import type { ReportData } from "../../../licensing-worker/src/portal/api-types";
import { formatPaise, PLAN_NAMES } from "../../../licensing-worker/src/portal/shared";
import { api, query } from "../api";
import { date, money, plural } from "../format";
import { LoadError, PageHead, useData } from "../ui";
import { SOURCE_NAMES, STAGE_NAMES } from "./Leads";

type Period = "fy" | "90" | "30";
const PERIOD_NAMES: Record<Period, string> = { fy: "This financial year", "90": "Last 90 days", "30": "Last 30 days" };

/** Round steps for a money axis: the top tick is the first of 1, 2, 2.5 or 5 x 10^n above the largest value. */
function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4, power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s * 4 >= max)!;
  return [0, step, step * 2, step * 3, step * 4];
}
const short = (paise: number) => {
  const rupees = paise / 100;
  return rupees >= 1_00_00_000 ? `Rs. ${+(rupees / 1_00_00_000).toFixed(1)} Cr` : rupees >= 1_00_000 ? `Rs. ${+(rupees / 1_00_000).toFixed(1)} L` : rupees >= 1000 ? `Rs. ${+(rupees / 1000).toFixed(1)}k` : `Rs. ${rupees}`;
};
const monthLabel = (month: string) => new Date(`${month}-15T00:00:00Z`).toLocaleDateString("en-IN", { month: "short" });
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

export function Reports() {
  const [period, setPeriod] = useState<Period>("fy");
  const range = period === "fy" ? {} : { from: Date.now() - Number(period) * 86_400_000 };
  const key = query(range);
  const { data, error, reload } = useData(() => api<ReportData>(`/reports${key}`), period);
  return <>
    <PageHead title="Reports" sub={data ? `${PERIOD_NAMES[period]}: ${date(data.from)} to ${date(data.to - 1)}. Money is payments received; a rep sees their own customers.` : "Loading…"}
      actions={<select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value as Period)} style={{ width: 210, height: 34 }}>
        {Object.entries(PERIOD_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>} />
    {error && <LoadError message={error} retry={reload} />}
    {data && <ReportBody data={data} />}
  </>;
}

function ReportBody({ data }: { data: ReportData }) {
  const received = data.revenueByMonth.reduce((sum, m) => sum + m.paise, 0);
  const lastMonth = data.revenueByMonth.at(-1)!;
  const won = data.funnel.find((f) => f.stage === "won")!.count, lost = data.funnel.find((f) => f.stage === "lost")!.count;
  const leads = data.funnel.reduce((sum, f) => sum + f.count, 0);
  const planTotal = data.revenueByPlan.reduce((sum, p) => sum + p.paise, 0);
  return <div className="stack" style={{ gap: 24 }}>
    <div className="kpis">
      <div className="kpi"><div className="kpi-label">Received, last 12 months</div><div className="kpi-value">{money(received)}</div><div className="kpi-note">{money(lastMonth.paise)} in {monthLabel(lastMonth.month)}</div></div>
      <div className="kpi"><div className="kpi-label">Leads won</div><div className="kpi-value">{pct(won, won + lost)}</div><div className="kpi-note">{won} won, {lost} lost of {plural(leads, "lead")} added</div></div>
      <div className="kpi"><div className="kpi-label">Renewed on time</div><div className="kpi-value">{pct(data.renewals.renewed, data.renewals.due)}</div><div className="kpi-note">{data.renewals.renewed} of {plural(data.renewals.due, "counter")} that came due</div></div>
      <div className="kpi"><div className="kpi-label">Trials that bought</div><div className="kpi-value">{pct(data.trials.converted, data.trials.started)}</div><div className="kpi-note">{data.trials.converted} of {plural(data.trials.started, "trial")}</div></div>
    </div>
    <div className="grid-main">
      <section><h2 className="section-title" style={{ marginBottom: 12 }}>Payments received by month</h2><MonthChart months={data.revenueByMonth} /></section>
      <section className="rail"><h2>Paid orders by plan</h2>
        {planTotal === 0 ? <p className="muted">No paid orders in this period.</p> : data.revenueByPlan.map((p) => <div key={p.plan} className="bar-row" style={{ gridTemplateColumns: "60px minmax(0, 1fr) 110px" }}>
          <span>{PLAN_NAMES[p.plan]}</span><div className="bar-track"><div className="bar-fill" style={{ width: `${(p.paise / planTotal) * 100}%` }} /></div>
          <span className="num">{money(p.paise)}<span className="muted small" style={{ display: "block" }}>{plural(p.orders, "order")}</span></span></div>)}
      </section>
    </div>
    <div className="grid-2">
      <section><h2 className="section-title" style={{ marginBottom: 8 }}>Leads added, by where they are now</h2>
        {data.funnel.map((f) => { const max = Math.max(1, ...data.funnel.map((x) => x.count));
          return <div key={f.stage} className="bar-row"><span>{STAGE_NAMES[f.stage]}</span>
            <div className="bar-track"><div className={`bar-fill${f.stage === "lost" ? " quiet" : ""}`} style={{ width: `${(f.count / max) * 100}%` }} /></div><span className="num">{f.count}</span></div>; })}
      </section>
      <section><h2 className="section-title" style={{ marginBottom: 8 }}>Where leads came from</h2>
        <table className="data"><thead><tr><th>Source</th><th className="num">Leads</th><th className="num">Won</th><th className="num">Win rate</th></tr></thead><tbody>
          {data.sources.map((s) => <tr key={s.source}><td>{SOURCE_NAMES[s.source]}</td><td className="num">{s.leads}</td><td className="num">{s.won}</td><td className="num">{pct(s.won, s.leads)}</td></tr>)}
          {data.sources.length === 0 && <tr className="empty"><td colSpan={4}>No leads added in this period.</td></tr>}
        </tbody></table></section>
    </div>
    <div className="grid-2">
      {data.reps.length > 0 && <section><h2 className="section-title" style={{ marginBottom: 8 }}>Sales reps</h2>
        <table className="data"><thead><tr><th>Rep</th><th className="num">Leads won</th><th className="num">Orders paid</th><th className="num">Worth</th></tr></thead><tbody>
          {data.reps.map((r) => <tr key={r.rep.id}><td>{r.rep.name}</td><td className="num">{r.leadsWon}</td><td className="num">{r.ordersPaid}</td><td className="num">{money(r.revenuePaise)}</td></tr>)}
        </tbody></table></section>}
      <section><h2 className="section-title" style={{ marginBottom: 8 }}>Support</h2>
        <dl className="kv">
          <dt>Opened</dt><dd>{plural(data.tickets.opened, "ticket")}</dd>
          <dt>Resolved</dt><dd>{plural(data.tickets.resolved, "ticket")}</dd>
          <dt>Time to resolve</dt><dd>{data.tickets.medianHoursToResolve === null ? "—" : `${data.tickets.medianHoursToResolve} hours (median)`}</dd>
          <dt>Open now</dt><dd>{(["urgent", "high", "normal", "low"] as const).map((p) => `${data.tickets.openByPriority[p] ?? 0} ${p}`).join(" · ")}</dd>
        </dl></section>
    </div>
  </div>;
}

/** Twelve months as columns on one scale; hovering a column names its month and amount, and the same numbers are in a table below. */
function MonthChart({ months }: { months: ReportData["revenueByMonth"] }) {
  const scale = ticks(Math.max(...months.map((m) => m.paise)));
  const top = scale.at(-1)!;
  return <figure className="month-chart">
    <div className="month-plot" role="img" aria-label="Payments received in each of the last twelve months">
      <div className="month-grid">{[...scale].reverse().map((t) => <div key={t} className="month-gridline"><span>{t === 0 ? "Rs. 0" : short(t)}</span></div>)}</div>
      <div className="month-bars">{months.map((m) => <div key={m.month} className="month-col" title={`${monthLabel(m.month)} ${m.month.slice(0, 4)}: ${formatPaise(m.paise)}`}>
        <div className="month-bar" style={{ height: top ? `${(m.paise / top) * 100}%` : "0%" }} /></div>)}</div>
    </div>
    <div className="month-labels">{months.map((m) => <span key={m.month}>{monthLabel(m.month)}</span>)}</div>
    <details><summary className="muted small">Show as a table</summary>
      <table className="data" style={{ marginTop: 8 }}><tbody>{months.map((m) => <tr key={m.month}><td>{monthLabel(m.month)} {m.month.slice(0, 4)}</td><td className="num">{money(m.paise)}</td></tr>)}</tbody></table>
    </details>
  </figure>;
}
