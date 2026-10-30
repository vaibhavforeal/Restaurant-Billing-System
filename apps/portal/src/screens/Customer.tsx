import { useState } from "react";
import type { ActivityPage, Colleague, CustomerDetail, InstallationSummary, OrderSummary, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { GST_STATES, roleCan } from "../../../licensing-worker/src/portal/shared";
import { api, query } from "../api";
import { date, money, plural } from "../format";
import { Link, navigate } from "../router";
import { CopyButton, LoadError, PageHead, Person, Tabs, useData } from "../ui";
import { ActivityTable } from "./Activity";
import { CounterDialog, counterName, LicenceState, SeatStrip } from "./Counter";
import { CustomerDialog, Renewal } from "./Customers";
import { OrdersTable } from "./Orders";

type Tab = "overview" | "orders" | "counters" | "activity";

export function Customer({ id, me }: { id: string; me: StaffUser }) {
  const { data, error, reload, setData } = useData(() => api<{ customer: CustomerDetail }>(`/customers/${id}`), id);
  const counters = useData(() => api<{ installations: InstallationSummary[] }>(`/customers/${id}/installations`), id);
  const staff = useData(() => api<{ staff: Colleague[] }>("/staff"), "staff");
  const [tab, setTab] = useState<Tab>("overview");
  const [editing, setEditing] = useState(false);
  const [counter, setCounter] = useState<string | null>(null);
  if (error) return <><PageHead title="Customer" back={<Link to="/customers">Customers</Link>} /><LoadError message={error} retry={reload} /></>;
  const c = data?.customer;
  if (!c) return <PageHead title="Loading…" back={<Link to="/customers">Customers</Link>} />;
  const list = counters.data?.installations ?? [];
  const enrolled = list.filter((i) => i.enrolled);
  const canOrder = roleCan(me.role, "orders.write");
  return <>
    <PageHead back={<Link to="/customers">Customers</Link>} title={c.businessName}
      sub={<span className="code-row">Customer ID <span className="code">{c.code}</span><CopyButton text={c.code} />{c.status === "inactive" && " · Inactive"}</span>}
      actions={<>{roleCan(me.role, "customers.write") && <button className="secondary" onClick={() => setEditing(true)}>Edit</button>}
        {canOrder && <button className="secondary" onClick={() => navigate(`/orders/new${query({ customerId: c.id, kind: "trial" })}`)}>Start a trial</button>}
        {canOrder && <button className="primary" onClick={() => navigate(`/orders/new${query({ customerId: c.id })}`)}>New order</button>}</>} />
    <div className="kpis">
      <div className="kpi"><div className="kpi-label">Outlets</div><div className="kpi-value">{enrolled.length}</div><div className="kpi-note">{plural(c.orders, "order")} so far</div></div>
      <div className="kpi"><div className="kpi-label">Next renewal</div><div className="kpi-value">{c.nextRenewalAt ? date(c.nextRenewalAt) : "—"}</div><div className="kpi-note">{c.nextRenewalAt ? <Renewal at={c.nextRenewalAt} /> : "No licence yet"}</div></div>
      <div className="kpi"><div className="kpi-label">Paid to date</div><div className="kpi-value">{money(c.paidPaise)}</div><div className="kpi-note">Cleared payments</div></div>
      <div className="kpi"><div className="kpi-label">Waiting for payment</div><div className="kpi-value">{money(c.outstandingPaise)}</div><div className="kpi-note">On confirmed orders</div></div>
    </div>
    <Tabs label="Customer" value={tab} onChange={setTab} tabs={[
      { id: "overview", label: "Overview" }, { id: "orders", label: <>Orders<span className="count">{c.orders}</span></> },
      { id: "counters", label: <>Counters<span className="count">{list.length}</span></> }, { id: "activity", label: "Activity" },
    ]} />
    {tab === "overview" && <div className="grid-main">
      <div className="stack">
        <section><div className="panel-head"><h2>Licences</h2><button className="ghost small" onClick={() => setTab("counters")}>All counters</button></div>
          {list.some((i) => i.licence) ? <SeatStrip counters={list} onOpen={(i) => setCounter(i.id)} />
            : <p className="empty-block">No counter has activated yet. Give the restaurant the setup card from an order: setup asks for the Customer ID and Order ID.</p>}</section>
        <section><div className="panel-head"><h2>Recent orders</h2><button className="ghost small" onClick={() => setTab("orders")}>View all</button></div>
          <CustomerOrders customerId={c.id} limit={5} /></section>
      </div>
      <aside className="rail">
        <h2>Details</h2>
        <dl className="kv">
          <dt>Contact</dt><dd>{c.contactName ?? "—"}</dd>
          <dt>Phone</dt><dd>{c.phone ? <><a href={`tel:${c.phone.replace(/\s/g, "")}`}>{c.phone}</a> · <a href={`https://wa.me/${whatsapp(c.phone)}`} target="_blank" rel="noopener noreferrer">WhatsApp</a></> : "—"}</dd>
          <dt>Email</dt><dd>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : "—"}</dd>
          <dt>GSTIN</dt><dd>{c.gstin ? <span className="mono">{c.gstin}</span> : "Not registered"}</dd>
          <dt>Address</dt><dd>{[c.address, c.city, c.stateCode && GST_STATES[c.stateCode], c.pincode].filter(Boolean).join(", ") || "—"}</dd>
          <dt>Sales rep</dt><dd>{c.owner ? <Person name={c.owner.name} id={c.owner.id} /> : "Not assigned"}</dd>
          <dt>Customer since</dt><dd>{date(c.createdAt)}</dd>
        </dl>
        {c.notes && <><h2 style={{ marginTop: 20 }}>Notes</h2><p style={{ whiteSpace: "pre-wrap" }}>{c.notes}</p></>}
      </aside>
    </div>}
    {tab === "orders" && <CustomerOrders customerId={c.id} />}
    {tab === "counters" && <CountersTable counters={list} onOpen={(i) => setCounter(i.id)} />}
    {tab === "activity" && <CustomerActivity customerId={c.id} />}
    {editing && <CustomerDialog me={me} staff={staff.data?.staff ?? []} customer={c} onClose={() => setEditing(false)} onSaved={(next) => { setEditing(false); setData({ customer: next }); }} />}
    {counter && <CounterDialog id={counter} me={me} onClose={() => setCounter(null)} onChanged={() => { void counters.reload(); void reload(); }} />}
  </>;
}

/** wa.me wants the number with its country code and no symbols; Indian numbers are written without +91 more often than not. */
const whatsapp = (phone: string) => { const digits = phone.replace(/\D/g, ""); return digits.length === 10 ? `91${digits}` : digits; };

function CustomerOrders({ customerId, limit }: { customerId: string; limit?: number }) {
  const { data, error, reload } = useData(() => api<{ orders: OrderSummary[]; total: number }>(`/orders${query({ customerId })}`), customerId);
  if (error) return <LoadError message={error} retry={reload} />;
  return <OrdersTable orders={limit ? (data?.orders ?? []).slice(0, limit) : data?.orders ?? []} loaded={!!data} hideCustomer
    empty="No orders yet. Start a trial or draft an order." />;
}

function CountersTable({ counters, onOpen }: { counters: InstallationSummary[]; onOpen: (c: InstallationSummary) => void }) {
  return <div className="table-wrap"><table className="data stack-phone">
    <thead><tr><th>Counter</th><th className="phone-hide">Order</th><th className="phone-hide">Plan</th><th className="phone-hide">Last seen</th><th className="num">Licence</th></tr></thead>
    <tbody>
      {counters.map((i) => <tr key={i.id} className="clickable" onClick={() => onOpen(i)}>
        <td><button type="button" className="link" style={{ textDecoration: "none" }}>{counterName(i)}</button><span className="sub">{i.appVersion ? `ForkFlow ${i.appVersion}` : "Version not reported"}</span></td>
        <td className="phone-hide">{i.order ? <span className="mono">{i.order.code}</span> : <span className="muted">Seat released</span>}</td>
        <td className="phone-hide">{i.licence ? `${i.licence.plan === "pro" ? "Pro" : "Basic"}${i.licence.trial ? " trial" : ""}, ${i.licence.maxDevices} devices` : "—"}</td>
        <td className="phone-hide muted">{date(i.lastSeenAt)}</td>
        <td className="num"><LicenceState counter={i} /></td>
      </tr>)}
      {counters.length === 0 && <tr className="empty"><td colSpan={5}>No counters yet. They appear here when a restaurant activates with this customer's IDs.</td></tr>}
    </tbody>
  </table></div>;
}

function CustomerActivity({ customerId }: { customerId: string }) {
  const { data, error, reload } = useData(() => api<ActivityPage>(`/customers/${customerId}/activity`), customerId);
  if (error) return <LoadError message={error} retry={reload} />;
  return <ActivityTable entries={data?.entries ?? []} loaded={!!data} compact />;
}
