import { useState, type ReactNode } from "react";
import type { HomeData, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { roleCan } from "../../../licensing-worker/src/portal/shared";
import { api } from "../api";
import { date, money, plural } from "../format";
import { Icon, type IconName } from "../icons";
import { Link } from "../router";
import { LoadError, PageHead, Pill, useData } from "../ui";
import { counterName } from "./Counter";
import { FollowUpRows } from "./FollowUps";
import { STAGE_NAMES } from "./Leads";
import { OrderStatusMark, PickCustomer } from "./Orders";
import { PriorityMark } from "./Tickets";

function Metric({ label, value, note, to, featured = false }: {
  label: string; value: ReactNode; note: string; icon: IconName; to: string; featured?: boolean;
}) {
  return <Link to={to} className={`overview-metric${featured ? " featured" : ""}`}>
    <div className="metric-top"><span>{label}</span></div>
    <div className="metric-value">{value}</div>
    <div className="metric-foot"><span>{note}</span></div>
  </Link>;
}

function SectionHead({ title, to, link, children }: { title: string; to: string; link: string; children?: ReactNode }) {
  return <div className="panel-head"><div><h2>{title}</h2>{children && <p className="section-note">{children}</p>}</div><Link className="section-link" to={to}>{link}</Link></div>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="dashboard-empty"><p>{children}</p></div>;
}

/** Today's work and monthly totals, all from the existing role-scoped home endpoint. */
export function Home({ me }: { me: StaffUser }) {
  const [picking, setPicking] = useState(false);
  const { data, error, reload, loading } = useData(() => api<HomeData>("/home"), "home");
  const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" });
  const heading = <PageHead title="Today" sub={`${today}. ${me.name.trim().split(/\s+/)[0] || me.name}, here is your work for today.`} actions={<>
    <button className="secondary" disabled={loading} onClick={() => void reload()}><Icon name="renewals" />{loading ? "Refreshing…" : "Refresh"}</button>
    {roleCan(me.role, "orders.write") && <button className="primary" disabled={!data || !!error} onClick={() => setPicking(true)}><Icon name="plus" />New order</button>}
  </>} />;
  if (error) return <>{heading}<LoadError message={error} retry={reload} /></>;
  if (!data) return <>{heading}<div className="overview-metrics" aria-label="Loading overview" aria-busy="true">{[0, 1, 2, 3].map((i) => <div className="overview-metric" key={i}><span className="skeleton" /><div className="metric-value skeleton" /></div>)}</div></>;
  const { followUps, renewals, orders, tickets, leads, month } = data;
  const stages = ["new", "contacted", "demo_scheduled", "demo_done", "proposal"] as const;
  const pipelineTotal = leads ? stages.reduce((sum, stage) => sum + (leads.byStage[stage] ?? 0), 0) : 0;
  const attention = tickets?.urgent ? { text: `${plural(tickets.urgent, "urgent support ticket")} needing attention`, to: "/tickets", link: "Open support" }
    : roleCan(me.role, "followups.write") && followUps.overdue ? { text: `${plural(followUps.overdue, "overdue follow-up")} to catch up on`, to: "/follow-ups", link: "View follow-ups" }
      : renewals.expired ? { text: `${plural(renewals.expired, "counter")} past its licence end date`, to: "/renewals", link: "View renewals" } : null;
  return <div className="dashboard">
    {heading}
    {picking && <PickCustomer onClose={() => setPicking(false)} />}
    <div className="overview-caption"><h2>Business overview</h2></div>
    <div className="overview-metrics">
      <Metric label="Received this month" value={money(month.receivedPaise)} note={`${plural(month.invoices, "invoice")} issued`} icon="reports" to="/reports" featured />
      <Metric label="Waiting for payment" value={money(orders.owedPaise)} note={`Across ${plural(orders.waiting, "confirmed order")}`} icon="orders" to="/orders" />
      <Metric label="Upcoming renewals" value={renewals.due30} note="Licences ending in the next 30 days" icon="renewals" to="/renewals" />
      <Metric label="New customers" value={month.newCustomers} note="Added this month" icon="customers" to="/customers" />
    </div>
    {attention && <div className="attention-banner"><p>{attention.text}</p><Link to={attention.to}>{attention.link}</Link></div>}
    <div className="dashboard-columns">
      <div className="dashboard-main">
        {roleCan(me.role, "followups.write") && <section className="dashboard-panel">
          <SectionHead title="Your follow-ups" to="/follow-ups" link="View all">{followUps.overdue ? `${plural(followUps.overdue, "follow-up")} overdue. ` : ""}{plural(followUps.dueToday, "follow-up")} due later today</SectionHead>
          {followUps.items.length > 0 ? <FollowUpRows items={followUps.items} onChanged={() => void reload()} /> : <Empty>You're all caught up. No follow-ups due right now.</Empty>}
        </section>}
        <section className="dashboard-panel">
          <SectionHead title="Waiting for payment" to="/orders" link="All orders">Keep your outstanding orders moving.</SectionHead>
          {orders.items.length ? <div className="table-wrap"><table className="data payment-table">
            <thead><tr><th>Customer / order</th><th>Status</th><th className="num">Outstanding</th></tr></thead>
            <tbody>{orders.items.map((o) => <tr key={o.id}>
              <td><Link to={`/orders/${o.id}`} className="name">{o.customer.name}</Link><span className="sub mono">{o.code}</span></td>
              <td><OrderStatusMark order={o} /></td><td className="num payment-amount">{money(o.totalPaise - o.paidPaise)}</td>
            </tr>)}</tbody>
          </table></div> : <Empty>No orders are waiting for payment.</Empty>}
          <div className="panel-summary"><span>Total outstanding</span><strong>{money(orders.owedPaise)}</strong></div>
        </section>
        {tickets && <section className="dashboard-panel">
          <SectionHead title={me.role === "support" ? "Your tickets" : "Open tickets"} to="/tickets" link="View support">{plural(tickets.open, "open ticket")}{tickets.urgent ? `. ${tickets.urgent} urgent` : ""}</SectionHead>
          {tickets.items.length ? <ul className="dashboard-list">{tickets.items.map((t) => <li key={t.id}>
            <span className="list-icon"><Icon name="tickets" /></span><div className="list-copy"><Link to={`/tickets/${t.id}`}>{t.subject}</Link><span>{t.customer.name}</span></div><PriorityMark priority={t.priority} />
          </li>)}</ul> : <Empty>No open tickets. Everything is in hand.</Empty>}
        </section>}
      </div>
      <div className="dashboard-rail">
        {leads && <section className="dashboard-panel pipeline-panel">
          <SectionHead title="Lead pipeline" to="/leads" link="View leads" />
          <div className="pipeline-total"><strong>{pipelineTotal}</strong><span>active {pipelineTotal === 1 ? "lead" : "leads"}</span></div>
          <ul className="pipeline-stages">{stages.map((stage, i) => <li key={stage}>
            <div><span>{STAGE_NAMES[stage]}</span><strong>{leads.byStage[stage] ?? 0}</strong></div>
            <div className="pipeline-track" aria-hidden="true"><span className={`stage-${i}`} style={{ width: `${pipelineTotal ? (leads.byStage[stage] ?? 0) / pipelineTotal * 100 : 0}%` }} /></div>
          </li>)}</ul>
        </section>}
        <section className="dashboard-panel">
          <SectionHead title="Licences ending soon" to="/renewals" link="View all">Next 30 days{renewals.expired ? `. ${renewals.expired} already ended` : ""}</SectionHead>
          {renewals.items.length ? <ul className="dashboard-list renewal-list">{renewals.items.map((r) => <li key={r.installation.id}>
            <span className="list-icon"><Icon name="renewals" /></span><div className="list-copy"><Link to={`/customers/${r.customer.id}`}>{r.customer.name}</Link><span>{counterName(r.installation)}</span><span className="renewal-date">Ends {date(r.installation.licence!.expiresAt)}</span>{r.openRenewal && <Pill tone="positive">Order drafted</Pill>}</div>
          </li>)}</ul> : <Empty>No licences ending in the next 30 days.</Empty>}
        </section>
      </div>
    </div>
  </div>;
}
