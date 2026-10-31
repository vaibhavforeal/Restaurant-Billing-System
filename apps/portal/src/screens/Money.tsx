import { useState } from "react";
import type { InvoiceSummary, OrderDetail, PaymentRecord, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { parseRupees, roleCan } from "../../../licensing-worker/src/portal/shared";
import { api, post, query } from "../api";
import { date, isoDay, money, plural, startOfIsoDay } from "../format";
import { Link } from "../router";
import { CopyButton, Dialog, EmptyRow, Field, LoadError, PageHead, Pill, useData, useRun } from "../ui";

const METHODS: Record<PaymentRecord["method"], string> = { cash: "Cash", bank: "Bank transfer", upi: "UPI", cheque: "Cheque", card: "Card", razorpay: "Razorpay" };

/** The order page's payment column: what is owed, what came in, the links sent and the invoice. */
export function OrderMoney({ order, me, onChanged }: { order: OrderDetail; me: StaffUser; onChanged: (o: OrderDetail) => void }) {
  const [recording, setRecording] = useState(false);
  const { busy, run, status } = useRun();
  const owing = Math.max(0, order.totalPaise - order.paidPaise);
  const payable = order.status === "confirmed" && order.kind !== "trial";
  const can = (p: Parameters<typeof roleCan>[1]) => roleCan(me.role, p);
  const live = order.invoices.find((i) => !i.cancelledAt);
  const act = (path: string, body: unknown, done: string) => run(async () => onChanged((await post<{ order: OrderDetail }>(path, body)).order), done);
  return <section className="stack">
    <div><h2>Payment</h2>
      <dl className="kv" style={{ marginTop: 8 }}>
        <dt>Total</dt><dd>{money(order.totalPaise)}</dd>
        <dt>Received</dt><dd>{money(order.paidPaise)}{order.paidPaise > order.totalPaise && <span className="muted"> · {money(order.paidPaise - order.totalPaise)} over</span>}</dd>
        {payable && <><dt>Still to pay</dt><dd><strong>{money(owing)}</strong></dd></>}
        {order.creditUntil && order.status === "confirmed" && <><dt>On credit until</dt><dd>{date(order.creditUntil)}{order.creditApprovedBy && <span className="muted"> · {order.creditApprovedBy.name}</span>}</dd></>}
        {order.paidAt && <><dt>Paid</dt><dd>{date(order.paidAt)}</dd></>}
      </dl></div>
    {payable && <div className="actions">
      {can("payments.record") && <button className="primary" onClick={() => setRecording(true)}>Record payment</button>}
      {can("orders.write") && owing >= 100 && <button className="secondary" disabled={busy} onClick={() => void run(async () => {
        const res = await post<{ order: OrderDetail; link: { shortUrl: string } }>(`/orders/${order.id}/payment-link`);
        onChanged(res.order);
      }, "Payment link sent. Razorpay texts and emails it to the customer.")}>Send payment link</button>}
    </div>}
    {status}
    {order.payments.length > 0 && <ul className="stack" style={{ gap: 8 }}>{order.payments.map((p) => <li key={p.id}>
      <div><strong>{money(p.amountPaise)}</strong> by {METHODS[p.method]} {p.status === "pending" ? <Pill tone="warning">Not cleared</Pill> : p.status === "bounced" ? <Pill tone="negative">Bounced</Pill> : null}</div>
      <div className="muted small">{date(p.receivedAt)}{p.reference ? ` · ${p.reference}` : ""}{p.recordedBy ? ` · ${p.recordedBy.name}` : ""}{p.note ? ` · ${p.note}` : ""}</div>
      {p.status === "pending" && can("payments.record") && <div className="actions" style={{ marginTop: 4 }}>
        <button className="secondary small" disabled={busy} onClick={() => void act(`/payments/${p.id}/status`, { status: "cleared" }, "Cheque cleared.")}>Cleared</button>
        <button className="ghost small" disabled={busy} onClick={() => { if (window.confirm("Mark this cheque as bounced?")) void act(`/payments/${p.id}/status`, { status: "bounced" }, "Marked as bounced."); }}>Bounced</button></div>}
    </li>)}</ul>}
    {order.links.length > 0 && <div><h2 style={{ fontSize: 14 }}>Payment links</h2><ul className="stack" style={{ gap: 6, marginTop: 6 }}>{order.links.map((l) => <li key={l.id} className="code-row" style={{ flexWrap: "wrap" }}>
      <span>{money(l.amountPaise)}</span>
      {l.status === "created" ? <><a href={l.shortUrl} target="_blank" rel="noopener noreferrer">{l.shortUrl.replace(/^https?:\/\//, "")}</a><CopyButton text={l.shortUrl} />
        {can("orders.write") && <button className="ghost small" disabled={busy} onClick={() => void act(`/payment-links/${l.id}/cancel`, undefined, "Link cancelled.")}>Cancel</button>}</>
        : <Pill tone={l.status === "paid" ? "positive" : "neutral"}>{l.status === "paid" ? "Paid" : l.status === "expired" ? "Expired" : l.status === "cancelled" ? "Cancelled" : l.status}</Pill>}
      <span className="muted small">sent {date(l.createdAt)}</span></li>)}</ul></div>}
    {(order.invoices.length > 0 || (order.totalPaise > 0 && order.status !== "draft" && order.status !== "cancelled")) && <div>
      <h2 style={{ fontSize: 14 }}>Tax invoice</h2>
      <ul className="stack" style={{ gap: 6, marginTop: 6 }}>{order.invoices.map((i) => <li key={i.id} className="code-row" style={{ flexWrap: "wrap" }}>
        <a className="mono" href={`/portal/api/invoices/${i.id}/pdf`}>{i.number}</a>{i.cancelledAt ? <Pill>Cancelled</Pill> : <span className="muted small">{date(i.issuedAt)}</span>}
        {!i.cancelledAt && can("invoices.cancel") && <CancelInvoice invoice={i} onDone={() => void api<{ order: OrderDetail }>(`/orders/${order.id}`).then((r) => onChanged(r.order))} />}
      </li>)}</ul>
      {!live && <p className="muted small" style={{ marginTop: 4 }}>{order.status === "paid" ? "No live invoice." : "Issued automatically when the order is paid in full."}</p>}
      {!live && can("invoices.issue") && <button className="secondary small" style={{ marginTop: 6 }} disabled={busy} onClick={() => void run(async () => {
        await post(`/orders/${order.id}/invoice`); onChanged((await api<{ order: OrderDetail }>(`/orders/${order.id}`)).order);
      }, "Invoice issued.")}>Issue invoice now</button>}
    </div>}
    {recording && <RecordPayment order={order} owing={owing} onClose={() => setRecording(false)} onSaved={(o) => { setRecording(false); onChanged(o); }} />}
  </section>;
}

function RecordPayment({ order, owing, onClose, onSaved }: { order: OrderDetail; owing: number; onClose: () => void; onSaved: (o: OrderDetail) => void }) {
  const [amount, setAmount] = useState((owing / 100).toFixed(2));
  const [method, setMethod] = useState<Exclude<PaymentRecord["method"], "razorpay">>("upi");
  const [reference, setReference] = useState("");
  const [day, setDay] = useState(isoDay(Date.now()));
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");
  const { busy, run, status, setError } = useRun();
  return <Dialog title={`Record a payment for ${order.code}`} onClose={onClose}>
    <form className="form-grid" onSubmit={(e) => {
      e.preventDefault();
      const amountPaise = parseRupees(amount);
      if (!amountPaise) { setError("Enter the amount received."); return; }
      const receivedAt = day === isoDay(Date.now()) ? Date.now() : startOfIsoDay(day) + 12 * 3_600_000;
      void run(async () => onSaved((await post<{ order: OrderDetail }>(`/orders/${order.id}/payments`, { amountPaise, method, reference, receivedAt, note, pending: method === "cheque" && pending })).order));
    }}>
      <Field label="Amount (Rs.)" hint={`${money(owing)} is still to pay.`}><input inputMode="decimal" required autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} /></Field>
      <Field label="Method"><select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} disabled={busy}>
        {(["upi", "bank", "cash", "cheque", "card"] as const).map((m) => <option key={m} value={m}>{METHODS[m]}</option>)}</select></Field>
      <Field label={method === "cheque" ? "Cheque number" : method === "cash" ? "Receipt number" : "Transaction reference"}><input maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} disabled={busy} /></Field>
      <Field label="Received on"><input type="date" required max={isoDay(Date.now())} value={day} onChange={(e) => setDay(e.target.value)} disabled={busy} /></Field>
      {method === "cheque" && <label className="check wide"><input type="checkbox" checked={pending} onChange={(e) => setPending(e.target.checked)} disabled={busy} /> Not cleared yet: count it only once it clears</label>}
      <Field label="Note" wide><input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} /></Field>
      <p className="wide muted small">When the order is paid in full, its tax invoice is issued and its counters get their full licence.</p>
      <div className="wide">{status}</div>
      <div className="form-actions wide"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Record payment</button></div>
    </form>
  </Dialog>;
}

function CancelInvoice({ invoice, onDone }: { invoice: InvoiceSummary; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { busy, run, status } = useRun();
  return <>
    <button className="ghost small" onClick={() => setOpen(true)}>Cancel</button>
    {open && <Dialog title={`Cancel invoice ${invoice.number}?`} onClose={() => setOpen(false)}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(`/invoices/${invoice.id}/cancel`, { reason }); setOpen(false); onDone(); }); }}>
        <p>Only before it is reported in a GST return. Its number stays used; a corrected invoice gets the next number.</p>
        <Field label="Why"><input required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} /></Field>
        {status}
        <div className="form-actions"><button type="button" className="secondary" onClick={() => setOpen(false)}>Keep it</button><button className="danger" disabled={busy}>Cancel invoice</button></div>
      </form>
    </Dialog>}
  </>;
}

/** Every tax invoice, newest first, for Accounts: the GST return is filed from this list. */
export function Invoices() {
  const [text, setText] = useState("");
  const [month, setMonth] = useState("");
  const range = month ? { from: startOfIsoDay(`${month}-01`), to: startOfIsoDay(nextMonth(month)) } : {};
  const key = query({ q: text.trim(), ...range });
  const { data, error, reload } = useData(() => api<{ invoices: InvoiceSummary[]; total: number; valuePaise: number }>(`/invoices${key}`), key);
  return <>
    <PageHead title="Invoices" sub={data ? `${plural(data.total, "invoice")}${month ? ` in ${monthName(month)}` : ""}, ${money(data.valuePaise)} not counting cancelled ones` : "Loading invoices…"} />
    <div className="toolbar">
      <input type="search" className="search-box" aria-label="Search invoices" placeholder="Invoice number or customer" value={text} onChange={(e) => setText(e.target.value)} />
      <input type="month" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 180 }} />
    </div>
    {error && <LoadError message={error} retry={reload} />}
    <div className="table-wrap"><table className="data stack-phone">
      <thead><tr><th>Invoice</th><th>Customer</th><th className="phone-hide">Order</th><th className="num phone-hide">Date</th><th className="num">Total</th></tr></thead>
      <tbody>
        {data?.invoices.map((i) => <tr key={i.id}>
          <td><a className="name mono" href={`/portal/api/invoices/${i.id}/pdf`}>{i.number}</a>{i.cancelledAt && <span className="sub">Cancelled {date(i.cancelledAt)}</span>}</td>
          <td><Link to={`/customers/${i.customer.id}`}>{i.customer.name}</Link></td>
          <td className="phone-hide"><Link className="mono" to={`/orders/${i.orderId}`}>{i.orderCode}</Link></td>
          <td className="num phone-hide muted">{date(i.issuedAt)}</td>
          <td className="num">{i.cancelledAt ? <s className="muted">{money(i.totalPaise)}</s> : money(i.totalPaise)}</td>
        </tr>)}
        {data && data.invoices.length === 0 && <EmptyRow columns={5}>No invoices{month ? " in this month" : " yet"}. They're issued when orders are paid in full.</EmptyRow>}
      </tbody>
    </table></div>
  </>;
}

const nextMonth = (month: string) => { const [y, m] = month.split("-").map(Number) as [number, number]; return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`; };
const monthName = (month: string) => new Date(`${month}-15T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
