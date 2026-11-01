import type { HomeData, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { roleCan } from "../../../licensing-worker/src/portal/shared";
import { api } from "../api";
import { date, money, plural } from "../format";
import { Link } from "../router";
import { LoadError, PageHead, Pill, useData } from "../ui";
import { counterName } from "./Counter";
import { FollowUpRows } from "./FollowUps";
import { STAGE_NAMES } from "./Leads";
import { OrderStatusMark } from "./Orders";
import { PriorityMark } from "./Tickets";

/** What to do today: follow-ups due, money waiting, licences ending, and support waiting. Each block opens its full list. */
export function Home({ me }: { me: StaffUser }) {
  const { data, error, reload } = useData(() => api<HomeData>("/home"), "home");
  const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" });
  if (error) return <><PageHead title="Today" /><LoadError message={error} retry={reload} /></>;
  if (!data) return <PageHead title="Today" sub={today} />;
  const { followUps, renewals, orders, tickets, leads, month } = data;
  const finding = followUps.overdue ? `${plural(followUps.overdue, "follow-up")} overdue` : renewals.expired ? `${plural(renewals.expired, "counter")} past its end date` : orders.waiting ? `${money(orders.owedPaise)} waiting on ${plural(orders.waiting, "order")}` : "Nothing overdue";
  return <>
    <PageHead title="Today" sub={`${today} · ${finding}`} />
    <div className="kpis">
      <div className="kpi"><div className="kpi-label">Received this month</div><div className="kpi-value">{money(month.receivedPaise)}</div><div className="kpi-note">{plural(month.invoices, "invoice")} issued</div></div>
      <div className="kpi"><div className="kpi-label">Waiting for payment</div><div className="kpi-value">{money(orders.owedPaise)}</div><div className="kpi-note">On {plural(orders.waiting, "confirmed order")}</div></div>
      <div className="kpi"><div className="kpi-label">Licences ending in 30 days</div><div className="kpi-value">{renewals.due30}</div><div className="kpi-note">{renewals.expired ? `${renewals.expired} already ended` : "None ended"}</div></div>
      <div className="kpi"><div className="kpi-label">New customers</div><div className="kpi-value">{month.newCustomers}</div><div className="kpi-note">This month</div></div>
    </div>
    <div className="grid-2">
      {roleCan(me.role, "followups.write") && <section className="panel">
        <div className="panel-head"><h2>Your follow-ups</h2><Link className="muted" to="/follow-ups">All follow-ups</Link></div>
        <p className="muted small" style={{ marginBottom: 8 }}>{followUps.overdue ? `${followUps.overdue} overdue. ` : ""}{followUps.dueToday ? `${followUps.dueToday} more due later today.` : "Nothing else due today."}</p>
        <FollowUpRows items={followUps.items} onChanged={() => void reload()} />
      </section>}
      <section className="panel">
        <div className="panel-head"><h2>Waiting for payment</h2><Link className="muted" to="/orders">All orders</Link></div>
        <ul className="stack" style={{ gap: 0 }}>{orders.items.map((o) => <li key={o.id} className="home-row">
          <span><Link to={`/orders/${o.id}`} className="mono">{o.code}</Link> <span className="muted">{o.customer.name}</span></span>
          <span className="num">{money(o.totalPaise - o.paidPaise)} <OrderStatusMark order={o} /></span></li>)}
          {orders.items.length === 0 && <li className="empty-block">No order is waiting for payment.</li>}</ul>
      </section>
      <section className="panel">
        <div className="panel-head"><h2>Licences ending soon</h2><Link className="muted" to="/renewals">Renewals</Link></div>
        <ul className="stack" style={{ gap: 0 }}>{renewals.items.map((r) => <li key={r.installation.id} className="home-row">
          <span><Link to={`/customers/${r.customer.id}`}>{r.customer.name}</Link> <span className="muted">{counterName(r.installation)}</span></span>
          <span className="num">{date(r.installation.licence!.expiresAt)} {r.openRenewal ? <Pill tone="positive">Order drafted</Pill> : null}</span></li>)}
          {renewals.items.length === 0 && <li className="empty-block">No licence ends in the next 30 days.</li>}</ul>
      </section>
      {tickets && <section className="panel">
        <div className="panel-head"><h2>{me.role === "support" ? "Your tickets" : "Open tickets"}</h2><Link className="muted" to="/tickets">Support</Link></div>
        <p className="muted small" style={{ marginBottom: 8 }}>{plural(tickets.open, "ticket")} open{tickets.urgent ? `, ${tickets.urgent} urgent` : ""}.</p>
        <ul className="stack" style={{ gap: 0 }}>{tickets.items.map((t) => <li key={t.id} className="home-row">
          <span><Link to={`/tickets/${t.id}`}>{t.subject}</Link> <span className="muted">{t.customer.name}</span></span><span><PriorityMark priority={t.priority} /></span></li>)}
          {tickets.items.length === 0 && <li className="empty-block">No open tickets.</li>}</ul>
      </section>}
      {leads && <section className="panel">
        <div className="panel-head"><h2>Pipeline</h2><Link className="muted" to="/leads">Leads</Link></div>
        <ul className="stack" style={{ gap: 0 }}>{(["new", "contacted", "demo_scheduled", "demo_done", "proposal"] as const).map((s) => <li key={s} className="home-row">
          <span>{STAGE_NAMES[s]}</span><span className="num">{leads.byStage[s] ?? 0}</span></li>)}</ul>
      </section>}
    </div>
  </>;
}
