import { useState } from "react";
import type { CustomerSummary, OrderStatus, OrderSummary, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { PLAN_NAMES, roleCan, termLabel } from "../../../licensing-worker/src/portal/shared";
import { api, query } from "../api";
import { date, money, plural } from "../format";
import { Link, navigate } from "../router";
import { Dialog, EmptyRow, LoadError, PageHead, Pill, Tabs, useData } from "../ui";

/** What an order is waiting for, in the trade's words, with one status mark. */
export function OrderStatusMark({ order }: { order: Pick<OrderSummary, "status" | "kind" | "creditUntil" | "paidPaise" | "totalPaise"> }) {
  if (order.status === "draft") return <Pill>Draft</Pill>;
  if (order.status === "cancelled") return <Pill>Cancelled</Pill>;
  if (order.status === "paid") return <Pill tone="positive">Paid</Pill>;
  if (order.kind === "trial") return <Pill tone="accent">Trial</Pill>;
  if (order.creditUntil) return <Pill tone="warning">On credit to {date(order.creditUntil)}</Pill>;
  return <Pill tone="warning">{order.paidPaise > 0 ? "Part paid" : "Waiting for payment"}</Pill>;
}

const KIND_NAMES = { new: "New outlets", renewal: "Renewal", trial: "Trial" } as const;
type Filter = "all" | OrderStatus;

export function Orders({ me }: { me: StaffUser }) {
  const [filter, setFilter] = useState<Filter>("confirmed");
  const [text, setText] = useState("");
  const [picking, setPicking] = useState(false);
  const key = query({ status: filter === "all" ? null : filter, q: text.trim() });
  const { data, error, reload } = useData(() => api<{ orders: OrderSummary[]; total: number; counts: Record<string, number> }>(`/orders${key}`), key);
  const count = (status: string) => data?.counts[status] ?? 0;
  const all = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  return <>
    <PageHead title="Orders" sub={data ? `${plural(count("confirmed"), "order")} waiting for payment, ${count("draft")} in draft` : "Loading orders…"}
      actions={roleCan(me.role, "orders.write") && <button className="primary" onClick={() => setPicking(true)}>New order</button>} />
    <Tabs label="Order status" value={filter} onChange={setFilter} tabs={[
      { id: "confirmed", label: <>Waiting for payment<span className="count">{count("confirmed")}</span></> },
      { id: "draft", label: <>Drafts<span className="count">{count("draft")}</span></> },
      { id: "paid", label: <>Paid<span className="count">{count("paid")}</span></> },
      { id: "cancelled", label: <>Cancelled<span className="count">{count("cancelled")}</span></> },
      { id: "all", label: <>All<span className="count">{all}</span></> },
    ]} />
    <div className="toolbar"><input type="search" className="search-box" aria-label="Search orders" placeholder="Order ID or customer name" value={text} onChange={(e) => setText(e.target.value)} />
      <span className="spacer" /><span className="total">{data ? plural(data.total, "order") : ""}</span></div>
    {error && <LoadError message={error} retry={reload} />}
    <OrdersTable orders={data?.orders ?? []} loaded={!!data} empty={text ? `No order matches “${text}”.` : "No orders here."} />
    {picking && <PickCustomer onClose={() => setPicking(false)} />}
  </>;
}

export function OrdersTable({ orders, loaded, hideCustomer, empty }: { orders: OrderSummary[]; loaded: boolean; hideCustomer?: boolean; empty: string }) {
  const columns = hideCustomer ? 5 : 6;
  return <div className="table-wrap"><table className="data stack-phone">
    <thead><tr><th>Order</th>{!hideCustomer && <th>Customer</th>}<th className="phone-hide">What</th><th className="phone-hide">Status</th><th className="num">Total</th><th className="num phone-hide">Created</th></tr></thead>
    <tbody>
      {orders.map((o) => <tr key={o.id} className="clickable" onClick={() => navigate(`/orders/${o.id}`)}>
        <td><Link className="name mono" to={`/orders/${o.id}`} onClick={(e) => e.stopPropagation()}>{o.code}</Link><span className="sub">{KIND_NAMES[o.kind]}</span></td>
        {!hideCustomer && <td>{o.customer.name}</td>}
        <td className="phone-hide">{PLAN_NAMES[o.plan]}, {termLabel(o)}<span className="sub">{o.kind === "renewal" ? "Extends counters" : `${o.seatsUsed} of ${plural(o.outlets, "outlet")} activated`}</span></td>
        <td className="phone-hide"><OrderStatusMark order={o} /></td>
        <td className="num">{money(o.totalPaise)}{o.status === "confirmed" && o.paidPaise > 0 && <span className="sub">{money(o.paidPaise)} paid</span>}</td>
        <td className="num phone-hide muted">{date(o.createdAt)}</td>
      </tr>)}
      {loaded && orders.length === 0 && <EmptyRow columns={columns}>{empty}</EmptyRow>}
    </tbody>
  </table></div>;
}

export function PickCustomer({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const key = query({ q: text.trim() });
  const { data } = useData(() => api<{ customers: CustomerSummary[] }>(`/customers${key}`), key);
  return <Dialog title="New order for which customer?" onClose={onClose}>
    <input type="search" autoFocus aria-label="Find a customer" placeholder="Name, phone or Customer ID" value={text} onChange={(e) => setText(e.target.value)} />
    <ul className="stack" style={{ marginTop: 12, gap: 2 }}>
      {data?.customers.slice(0, 8).map((c) => <li key={c.id}><button type="button" className="ghost" style={{ width: "100%", justifyContent: "space-between" }}
        onClick={() => navigate(`/orders/new${query({ customerId: c.id })}`)}><span>{c.businessName}</span><span className="mono muted">{c.code}</span></button></li>)}
      {data && data.customers.length === 0 && <li className="empty-block">No customer matches. Add the customer first, from Customers.</li>}
    </ul>
  </Dialog>;
}
