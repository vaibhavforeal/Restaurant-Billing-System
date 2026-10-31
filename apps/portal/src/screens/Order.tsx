import { useState } from "react";
import type { OrderDetail, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { PLAN_NAMES, roleCan, termLabel } from "../../../licensing-worker/src/portal/shared";
import { api, post } from "../api";
import { date, dateTime, isoDay, money, plural, startOfIsoDay } from "../format";
import { Link, navigate } from "../router";
import { CopyButton, Dialog, Field, LoadError, PageHead, useData, useRun } from "../ui";
import { CounterDialog, counterName, download, LicenceState, SeatStrip } from "./Counter";
import { OrderMoney } from "./Money";
import { OrderStatusMark } from "./Orders";

const KIND_NAMES = { new: "New outlets", renewal: "Renewal", trial: "Trial" } as const;

export function Order({ id, me }: { id: string; me: StaffUser }) {
  const { data, error, reload, setData } = useData(() => api<{ order: OrderDetail }>(`/orders/${id}`), id);
  const [dialog, setDialog] = useState<"credit" | "cancel" | "offline" | null>(null);
  const [counter, setCounter] = useState<string | null>(null);
  const { busy, run, status } = useRun();
  if (error) return <><PageHead title="Order" back={<Link to="/orders">Orders</Link>} /><LoadError message={error} retry={reload} /></>;
  const o = data?.order;
  if (!o) return <PageHead title="Loading…" back={<Link to="/orders">Orders</Link>} />;
  const set = (order: OrderDetail) => setData({ order });
  const usable = o.kind !== "renewal" && (o.status === "paid" || (o.status === "confirmed" && (o.kind === "trial" || (o.creditUntil !== null && o.creditUntil > Date.now()))));
  const can = (p: Parameters<typeof roleCan>[1]) => roleCan(me.role, p);
  return <>
    <PageHead back={<><Link to="/orders">Orders</Link> / <Link to={`/customers/${o.customer.id}`}>{o.customer.name}</Link></>}
      title={<span className="mono" style={{ fontSize: "inherit" }}>{o.code}</span>}
      sub={<>{KIND_NAMES[o.kind]} · {PLAN_NAMES[o.plan]}, {termLabel(o)} · <OrderStatusMark order={o} /></>}
      actions={<>
        {o.status === "draft" && can("orders.write") && <button className="secondary" onClick={() => navigate(`/orders/${o.id}/edit`)}>Edit</button>}
        {(o.status === "draft" || o.status === "confirmed") && can("orders.approve") && <button className="secondary" onClick={() => setDialog("cancel")}>Cancel order</button>}
        {o.status === "confirmed" && o.kind !== "trial" && can("orders.approve") && <button className="secondary" onClick={() => setDialog("credit")}>{o.creditUntil ? "Change credit" : "Approve on credit"}</button>}
        {o.status === "draft" && can("orders.write") && <button className="primary" disabled={busy} onClick={() => void run(async () => set((await post<{ order: OrderDetail }>(`/orders/${o.id}/confirm`)).order),
          o.totalPaise === 0 ? "Confirmed. It costs nothing, so it's paid already." : "Confirmed. Send a payment link or record the payment when it arrives.")}>Confirm order</button>}
      </>} />
    {status}
    <div className="grid-main">
      <div className="stack">
        {o.kind !== "renewal" && o.status !== "cancelled" && o.status !== "draft" && <SetupCard order={o} usable={usable} />}
        {o.status === "draft" && <p className="notice">A draft can still change. Confirm it when the customer agrees, and its price is fixed.</p>}
        {o.kind !== "trial" && <section><h2 className="section-title" style={{ marginBottom: 8 }}>Lines</h2>
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Description</th><th className="phone-hide">SAC</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Taxable value</th></tr></thead>
            <tbody>
              {o.lines.map((l) => <tr key={l.id}><td>{l.description}{l.discountPaise > 0 && <span className="sub">Less {money(l.discountPaise)} discount</span>}</td>
                <td className="phone-hide mono">{l.sac}</td><td className="num">{l.quantity}</td><td className="num">{money(l.unitPricePaise)}</td><td className="num">{money(l.taxablePaise)}</td></tr>)}
              <tr><td colSpan={4}>Taxable value</td><td className="num">{money(o.subtotalPaise)}</td></tr>
              {o.intraState === false ? <tr><td colSpan={4}>IGST</td><td className="num">{money(o.igstPaise)}</td></tr>
                : <><tr><td colSpan={4}>CGST</td><td className="num">{money(o.cgstPaise)}</td></tr><tr><td colSpan={4}>SGST</td><td className="num">{money(o.sgstPaise)}</td></tr></>}
              <tr><td colSpan={4}><strong>Total</strong></td><td className="num"><strong>{money(o.totalPaise)}</strong></td></tr>
            </tbody></table></div>
          {o.intraState === null && <p className="notice warning" style={{ marginTop: 8 }}>The customer's state or the seller's state is missing, so CGST and SGST are assumed until it's added.</p>}</section>}
        {o.kind !== "renewal" && <section><div className="panel-head"><h2>Counters on this order</h2><span className="muted">{o.seatsUsed} of {plural(o.outlets, "outlet")} activated</span></div>
          {o.seats.length ? <SeatStrip counters={o.seats} onOpen={(c) => setCounter(c.id)} />
            : <p className="empty-block">{usable ? "None yet. The restaurant activates by entering the Customer ID and Order ID at setup." : "Counters can activate once the order is paid, approved on credit, or a trial."}</p>}
          {usable && o.seatsUsed < o.outlets && can("licences.manage") && <button className="ghost small" style={{ marginTop: 8 }} onClick={() => setDialog("offline")}>Activate a counter without internet</button>}</section>}
        {o.kind === "renewal" && <section><h2 className="section-title" style={{ marginBottom: 8 }}>Counters this order renews</h2>
          <div className="table-wrap"><table className="data"><tbody>{o.renewalTargets.map((c) => <tr key={c.id} className="clickable" onClick={() => setCounter(c.id)}>
            <td>{counterName(c)}<span className="sub mono">{c.order?.code}</span></td><td className="num"><LicenceState counter={c} /></td></tr>)}</tbody></table></div>
          <p className="muted small" style={{ marginTop: 8 }}>{o.status === "paid" ? "Extended when the order was paid." : "Each gets the term added to its end date when the order is paid."}</p></section>}
      </div>
      <aside className="rail stack">
        <OrderMoney order={o} me={me} onChanged={set} />
        <section><h2>Order</h2><dl className="kv">
          <dt>Customer</dt><dd><Link to={`/customers/${o.customer.id}`}>{o.customer.name}</Link></dd>
          <dt>Devices</dt><dd>{o.maxDevices} per outlet</dd>
          {Object.keys(o.modules).length > 0 && <><dt>Modules</dt><dd>{Object.entries(o.modules).map(([m, on]) => `${m} ${on ? "allowed" : "blocked"}`).join(", ")}</dd></>}
          <dt>Sales rep</dt><dd>{o.owner?.name ?? "—"}</dd>
          <dt>Created</dt><dd>{dateTime(o.createdAt)}</dd>
          {o.confirmedAt && <><dt>Confirmed</dt><dd>{dateTime(o.confirmedAt)}</dd></>}
          {o.cancelledAt && <><dt>Cancelled</dt><dd>{dateTime(o.cancelledAt)}</dd></>}
        </dl>{o.notes && <p style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{o.notes}</p>}</section>
      </aside>
    </div>
    {dialog === "credit" && <CreditDialog order={o} onClose={() => setDialog(null)} onSaved={(next) => { setDialog(null); set(next); }} />}
    {dialog === "cancel" && <CancelDialog order={o} onClose={() => setDialog(null)} onSaved={(next) => { setDialog(null); set(next); }} />}
    {dialog === "offline" && <OfflineDialog order={o} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void reload(); }} />}
    {counter && <CounterDialog id={counter} me={me} onClose={() => setCounter(null)} onChanged={() => void reload()} />}
  </>;
}

/** What the restaurant needs at setup, large enough to read over the phone and printable on its own. */
function SetupCard({ order, usable }: { order: OrderDetail; usable: boolean }) {
  return <section className="setup-card">
    <div className="panel-head"><h2>Setup card</h2><button type="button" className="ghost small no-print" onClick={() => window.print()}>Print</button></div>
    <p className="muted">At first run, MasalaPOS asks for these two IDs. {!usable ? "They work once the order is paid or approved on credit." : order.seatsUsed >= order.outlets ? "Every outlet on this order is activated." : `They activate ${plural(order.outlets - order.seatsUsed, "more outlet")}.`}</p>
    <div className="ids">
      <div><div className="kpi-label">Customer ID</div><div className="code-row"><span className="setup-id">{order.customer.code}</span><span className="no-print"><CopyButton text={order.customer.code} /></span></div></div>
      <div><div className="kpi-label">Order ID</div><div className="code-row"><span className="setup-id">{order.code}</span><span className="no-print"><CopyButton text={order.code} /></span></div></div>
    </div>
    <p className="muted small">{order.customer.name} · {PLAN_NAMES[order.plan]}{order.kind === "trial" ? ` trial, ${termLabel(order)}` : `, ${termLabel(order)}`} from the day each outlet activates.</p>
  </section>;
}

function CreditDialog({ order, onClose, onSaved }: { order: OrderDetail; onClose: () => void; onSaved: (o: OrderDetail) => void }) {
  const [day, setDay] = useState(isoDay(order.creditUntil ?? Date.now() + 15 * 86_400_000));
  const { busy, run, status } = useRun();
  return <Dialog title="Approve on credit" onClose={onClose}>
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => onSaved((await post<{ order: OrderDetail }>(`/orders/${order.id}/credit`, { until: startOfIsoDay(day) + 86_399_000 })).order)); }}>
      <p>The restaurant can activate before paying. Each outlet's licence runs until this date, and gets the full {termLabel(order)} when the order is paid.</p>
      <Field label="Credit until"><input type="date" required value={day} onChange={(e) => setDay(e.target.value)} disabled={busy} /></Field>
      {status}
      <div className="form-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Approve credit</button></div>
    </form>
  </Dialog>;
}

function CancelDialog({ order, onClose, onSaved }: { order: OrderDetail; onClose: () => void; onSaved: (o: OrderDetail) => void }) {
  const [reason, setReason] = useState("");
  const { busy, run, status } = useRun();
  return <Dialog title={`Cancel ${order.code}?`} onClose={onClose}>
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => onSaved((await post<{ order: OrderDetail }>(`/orders/${order.id}/cancel`, { reason })).order)); }}>
      <p>No more counters can activate with it.{order.seatsUsed > 0 ? ` The ${plural(order.seatsUsed, "counter")} already active keep their licences until they end.` : ""}</p>
      <Field label="Why" hint="Goes into the activity log."><input required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} /></Field>
      {status}
      <div className="form-actions"><button type="button" className="secondary" onClick={onClose}>Keep it</button><button className="danger" disabled={busy}>Cancel order</button></div>
    </form>
  </Dialog>;
}

function OfflineDialog({ order, onClose, onDone }: { order: OrderDetail; onClose: () => void; onDone: () => void }) {
  const { busy, run, status } = useRun();
  return <Dialog title="Activate a counter without internet" onClose={onClose}>
    <div className="stack">
      <p>On the counter, open Settings › Plan and devices › Activation details and download the activation request. Choose that file here: the counter takes one of this order's seats, and you get its licence file to apply there.</p>
      <Field label="Activation request file"><input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => {
        const file = e.target.files?.[0]; e.target.value = "";
        if (file) void run(async () => {
          const { license, fileName } = await post<{ license: string; fileName: string }>(`/orders/${order.id}/offline-licence`, { activationRequest: await file.text() });
          download(license, fileName);
          onDone();
        });
      }} /></Field>
      {status}
    </div>
  </Dialog>;
}
