import { useState } from "react";
import type { HomeData, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { roleCan } from "../../../licensing-worker/src/portal/shared";
import { api } from "../api";
import { date, money, plural } from "../format";
import { Link } from "../router";
import { LoadError, PageHead, Pill, useData } from "../ui";
import { counterName } from "./Counter";
import { FollowUpRows } from "./FollowUps";
import { STAGE_NAMES } from "./Leads";
import { OrderStatusMark, PickCustomer } from "./Orders";
import { PriorityMark } from "./Tickets";

/** A compact business summary and one work list at a time. */
export function Home({ me }: { me: StaffUser }) {
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const { data, error, reload } = useData(() => api<HomeData>("/home"), "home");
  const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" });
  return <div className="home-page">
    <PageHead title="Today" sub={today} actions={<>
      <Link className="button" to="/reports">View reports</Link>
      {roleCan(me.role, "orders.write") && <button className="primary" onClick={() => setPickingCustomer(true)}>New order</button>}
    </>} />
    {error && <LoadError message={error} retry={reload} />}
    {data && <HomeOverview me={me} data={data} onChanged={() => void reload()} />}
    {pickingCustomer && <PickCustomer onClose={() => setPickingCustomer(false)} />}
  </div>;
}

type WorkTab = "followups" | "payments" | "renewals" | "support";
function HomeOverview({ me, data, onChanged }: { me: StaffUser; data: HomeData; onChanged: () => void }) {
  const { followUps, renewals, orders, tickets, leads, month } = data;
  const canFollow = roleCan(me.role, "followups.write");
  const tabs: Array<{ id: WorkTab; label: string; count: number }> = [
    ...(canFollow ? [{ id: "followups" as const, label: "Follow-ups", count: followUps.overdue + followUps.dueToday }] : []),
    { id: "payments", label: "Payments", count: orders.waiting },
    { id: "renewals", label: "Renewals", count: renewals.due30 },
    ...(tickets ? [{ id: "support" as const, label: "Support", count: tickets.open }] : []),
  ];
  const [selected, setSelected] = useState<WorkTab>(() => canFollow && followUps.overdue ? "followups"
    : tickets?.urgent ? "support" : tabs.find((tab) => tab.count > 0)?.id ?? tabs[0]!.id);
  const active = tabs.find((tab) => tab.id === selected)?.id ?? tabs[0]!.id;
  return <>
    <div className="kpis home-summary" aria-label="Business summary">
      <div className="kpi"><div className="kpi-label">Received this month</div><div className="kpi-value">{money(month.receivedPaise)}</div><div className="kpi-note">{plural(month.invoices, "invoice")} issued</div></div>
      <div className="kpi"><div className="kpi-label">Waiting for payment</div><div className="kpi-value">{money(orders.owedPaise)}</div><div className="kpi-note">On {plural(orders.waiting, "confirmed order")}</div></div>
      <div className="kpi"><div className="kpi-label">Licences ending in 30 days</div><div className="kpi-value">{renewals.due30}</div><div className="kpi-note">{renewals.expired ? `${renewals.expired} already ended` : "None ended"}</div></div>
      <div className="kpi"><div className="kpi-label">New customers</div><div className="kpi-value">{month.newCustomers}</div><div className="kpi-note">This month</div></div>
    </div>
    <div className={`home-workspace${leads ? " has-pipeline" : ""}`}>
      <section className="home-work" aria-labelledby="home-work-title">
        <div className="home-section-head"><div><h2 id="home-work-title">Your work</h2><p>Follow up, collect payments, and keep customers running.</p></div></div>
        <div className="tabs home-work-tabs" role="tablist" aria-label="Work lists">
          {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`home-tab-${tab.id}`}
            aria-controls={`home-panel-${tab.id}`} aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1}
            onClick={() => setSelected(tab.id)} onKeyDown={(event) => {
              const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
              if (next === null) return;
              event.preventDefault(); setSelected(tabs[next]!.id);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}>{tab.label}<span className="home-tab-count">{tab.count}</span></button>)}
        </div>
      {canFollow && <section className="home-work-panel" role="tabpanel" id="home-panel-followups" aria-labelledby="home-tab-followups" tabIndex={0} hidden={active !== "followups"}>
        <div className="panel-head"><h2>Your follow-ups</h2><Link className="muted" to="/follow-ups">All follow-ups</Link></div>
        <p className="muted small" style={{ marginBottom: 8 }}>{followUps.overdue ? `${followUps.overdue} overdue. ` : ""}{followUps.dueToday ? `${followUps.dueToday} more due later today.` : "Nothing else due today."}</p>
        {followUps.items.length > 0 ? <FollowUpRows items={followUps.items} onChanged={onChanged} />
          : <p className="empty-block">No follow-ups due today. You're all caught up.</p>}
      </section>}
      <section className="home-work-panel" role="tabpanel" id="home-panel-payments" aria-labelledby="home-tab-payments" tabIndex={0} hidden={active !== "payments"}>
        <div className="panel-head"><h2>Waiting for payment</h2><Link className="muted" to="/orders">All orders</Link></div>
        <ul className="stack" style={{ gap: 0 }}>{orders.items.map((o) => <li key={o.id} className="home-row">
          <span className="home-row-label"><Link to={`/orders/${o.id}`}>{o.customer.name}</Link><span className="muted mono">{o.code}</span></span>
          <span className="home-row-value"><strong>{money(o.totalPaise - o.paidPaise)}</strong><OrderStatusMark order={o} /></span></li>)}
          {orders.items.length === 0 && <li className="empty-block">No order is waiting for payment.</li>}</ul>
      </section>
      <section className="home-work-panel" role="tabpanel" id="home-panel-renewals" aria-labelledby="home-tab-renewals" tabIndex={0} hidden={active !== "renewals"}>
        <div className="panel-head"><h2>Licences ending soon</h2><Link className="muted" to="/renewals">Renewals</Link></div>
        <ul className="stack" style={{ gap: 0 }}>{renewals.items.map((r) => <li key={r.installation.id} className="home-row">
          <span className="home-row-label"><Link to={`/customers/${r.customer.id}`}>{r.customer.name}</Link><span className="muted">{counterName(r.installation)}</span></span>
          <span className="home-row-value"><span>{date(r.installation.licence!.expiresAt)}</span>{r.openRenewal ? <Pill tone="positive">Order drafted</Pill> : null}</span></li>)}
          {renewals.items.length === 0 && <li className="empty-block">No licence ends in the next 30 days.</li>}</ul>
      </section>
      {tickets && <section className="home-work-panel" role="tabpanel" id="home-panel-support" aria-labelledby="home-tab-support" tabIndex={0} hidden={active !== "support"}>
        <div className="panel-head"><h2>{me.role === "support" ? "Your tickets" : "Open tickets"}</h2><Link className="muted" to="/tickets">Support</Link></div>
        <p className="muted small" style={{ marginBottom: 8 }}>{plural(tickets.open, "ticket")} open{tickets.urgent ? `, ${tickets.urgent} urgent` : ""}.</p>
        <ul className="stack" style={{ gap: 0 }}>{tickets.items.map((t) => <li key={t.id} className="home-row">
          <span className="home-row-label"><Link to={`/tickets/${t.id}`}>{t.subject}</Link><span className="muted">{t.customer.name}</span></span><span><PriorityMark priority={t.priority} /></span></li>)}
          {tickets.items.length === 0 && <li className="empty-block">No open tickets.</li>}</ul>
      </section>}
      </section>
      {leads && <aside className="home-pipeline" aria-labelledby="home-pipeline-title">
        <div className="home-section-head"><h2 id="home-pipeline-title">Sales pipeline</h2><Link to="/leads">View leads →</Link></div>
        <p className="home-pipeline-total"><strong>{leads.open}</strong> open leads</p>
        {leads.open > 0 ? <ul className="home-stage-list">{(["new", "contacted", "demo_scheduled", "demo_done", "proposal"] as const).map((stage) => <li key={stage}>
          <div><span>{STAGE_NAMES[stage]}</span><strong>{leads.byStage[stage] ?? 0}</strong></div>
          <div className="home-stage-track" aria-hidden="true"><span style={{ width: `${((leads.byStage[stage] ?? 0) / leads.open) * 100}%` }} /></div>
        </li>)}</ul> : <p className="home-pipeline-empty">New leads and their progress will appear here.</p>}
      </aside>}
    </div>
  </>;
}
