import { useEffect, useRef, useState } from "react";
import type { Bill, BillCreateInput, BillTotals } from "@forkflow/domain";
import { ApiError, apiFetch, session } from "../api";
import { paiseToRupees, rupeesToPaise } from "../money";
import type { Order, PrintJobInfo } from "../types";
import { uuid } from "../uuid";
import { connectWs } from "../ws";
import { reliablePost } from "../retry-queue";

const money = (value: number) => `₹${paiseToRupees(value)}`;
type Preview = BillTotals & { previewKey: string };
type PaymentDraft = { id: string; mode: "cash" | "upi" | "card"; amount: string; refNote: string };

export function BillSummary({ value }: { value: BillTotals }) {
  return <div className="bill-summary">
    <p>{value.taxInclusive ? "Menu prices include GST" : "GST added to menu prices"}</p>
    <p>Subtotal: {money(value.subtotalPaise)} · Discount: {money(value.discountPaise)}</p>
    <div style={{ overflowX: "auto" }}><table style={{ width: "100%", textAlign: "right", borderSpacing: "8px" }}>
      <thead><tr><th scope="col">GST rate</th><th scope="col">Taxable</th><th scope="col">CGST</th><th scope="col">SGST</th></tr></thead>
      <tbody>{value.taxes.map((t) => <tr key={t.gstRate}><td>{t.gstRate}%</td><td>{money(t.taxablePaise)}</td><td>{money(t.cgstPaise)} ({t.gstRate / 2}%)</td><td>{money(t.sgstPaise)} ({t.gstRate / 2}%)</td></tr>)}</tbody>
    </table></div>
    <p>Round off: {money(value.roundingPaise)}</p>
    <p className="payable"><span>Payable:</span><strong>{money(value.totalPaise)}</strong></p>
  </div>;
}

export function BillingPanel({ order, hasDraft, onChanged }: { order: Order; hasDraft: boolean; onChanged: () => Promise<void> }) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [discount, setDiscount] = useState("0");
  const [reason, setReason] = useState("");
  const [printers, setPrinters] = useState<Array<{ id: string; name: string }>>([]);
  const [printerId, setPrinterId] = useState(() => localStorage.getItem("forkflow.receipt-printer") ?? "");
  const [payments, setPayments] = useState<PaymentDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [html, setHtml] = useState("");
  const [frameReady, setFrameReady] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const createRequest = useRef<BillCreateInput | null>(null);
  const settlement = useRef<{ clientRef: string; fingerprint: string } | null>(null);
  const [job, setJob] = useState<PrintJobInfo | null>(null);

  function acceptBill(value: Bill | null) {
    setBill(value);
    if (value && value.status === "unpaid") setPayments((p) => p.length ? p : value.totalPaise ? [{ id: uuid(), mode: "cash", amount: paiseToRupees(value.totalPaise), refNote: "" }] : []);
  }
  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetch<{ bill: Bill | null }>(`/api/orders/${order.id}/bill`),
      apiFetch<{ printers: Array<{ id: string; name: string }> }>("/api/billing-printers"),
    ]).then(([b, p]) => {
      if (!active) return;
      acceptBill(b.bill); setPrinters(p.printers);
      setPrinterId((id) => p.printers.some((printer) => printer.id === id) ? id : "");
    }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Failed to load billing"); });
    return () => { active = false; };
  }, [order.id, order.status]);
  useEffect(() => { setPreview(null); createRequest.current = null; }, [order.items, discount, reason]);
  useEffect(() => { setHtml(""); setFrameReady(false); }, [bill?.id, bill?.status]);
  useEffect(() => {
    if (!bill || !job || (job.status !== "queued" && job.status !== "printing")) return;
    let active = true;
    const refresh = () => {
      apiFetch<{ jobs: PrintJobInfo[] }>(`/api/bills/${bill.id}/print-jobs`).then((r) => {
        const current = r.jobs.find((j) => j.id === job.id);
        if (active && current) setJob(current);
      }).catch(() => { /* reconnect or next poll will recover */ });
    };
    refresh(); const timer = setInterval(refresh, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [bill?.id, job?.id, job?.status]);
  useEffect(() => connectWs({
    onEvent: (event, data) => {
      if (event === "print.job") {
        const next = (data as { job: PrintJobInfo }).job;
        setJob((prev) => prev?.id === next.id ? next : prev);
      }
    }, onStatus: () => {}, onAuthFail: () => session.clear(),
  }), []);

  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      // Resolve an ambiguous response from the persisted bill before another attempt.
      try { acceptBill((await apiFetch<{ bill: Bill | null }>(`/api/orders/${order.id}/bill`)).bill); } catch { /* retain the retryable request */ }
    } finally { lock.current = false; setBusy(false); }
  }
  async function getPreview() {
    const discountPaise = rupeesToPaise(discount);
    if (discountPaise === null) throw new Error("Enter a valid discount amount");
    if (discountPaise > 0 && !reason.trim()) throw new Error("Enter a discount reason");
    const { preview: value } = await apiFetch<{ preview: Preview }>(`/api/orders/${order.id}/bill-preview`, {
      method: "POST", body: JSON.stringify({ discountPaise, discountNote: reason }),
    });
    setPreview(value);
    createRequest.current = { clientRef: uuid(), previewKey: value.previewKey, discountPaise, discountNote: reason.trim(), printerId: printerId || null };
  }
  async function issue() {
    if (!createRequest.current || hasDraft) throw new Error("Review the bill preview first");
    const { bill: value, job: printJob } = await reliablePost<{ bill: Bill; job: PrintJobInfo | null }>(`/api/orders/${order.id}/bill`, createRequest.current, "Issue bill");
    acceptBill(value); setPreview(null); setJob(printJob);
    setMessage(`Bill #${value.billNo} issued. Record payment below.`);
    await onChanged();
  }
  async function settle() {
    if (!bill) return;
    const rows = payments.map((p) => {
      const amountPaise = rupeesToPaise(p.amount);
      if (!amountPaise) throw new Error("Each payment amount must be positive");
      return { mode: p.mode, amountPaise, refNote: p.refNote };
    });
    if (rows.reduce((sum, p) => sum + p.amountPaise, 0) !== bill.totalPaise) throw new Error("Payments must exactly match the bill total");
    const fingerprint = JSON.stringify(rows);
    if (settlement.current?.fingerprint !== fingerprint) settlement.current = { clientRef: uuid(), fingerprint };
    const { bill: value } = await reliablePost<{ bill: Bill }>(`/api/bills/${bill.id}/settle`, { clientRef: settlement.current.clientRef, payments: rows }, "Record payment");
    acceptBill(value); setMessage("Payment recorded. This group is settled."); await onChanged();
  }
  async function viewReceipt() {
    if (!bill) return;
    const response = await fetch(`/api/bills/${bill.id}/receipt`, { headers: { authorization: `Bearer ${session.token}` } });
    if (response.status === 401) session.clear();
    if (!response.ok) throw new ApiError(response.status, "Could not load receipt");
    setFrameReady(false); setHtml(await response.text());
  }
  function changePrinter(value: string) {
    setPrinterId(value); localStorage.setItem("forkflow.receipt-printer", value);
    setPreview(null); createRequest.current = null;
  }
  const entered = payments.reduce((sum, p) => sum + (rupeesToPaise(p.amount) ?? 0), 0);
  return <section aria-label="Billing" className="billing-panel">
    <h2>{bill ? `Bill #${bill.billNo} — ${bill.status}` : "Billing"}</h2>
    <div role="alert" style={{ color: "crimson" }}>{error}</div>
    <p role="status" style={{ color: "#176336" }}>{message}</p>
    <label>Receipt printer <select value={printerId} onChange={(e) => changePrinter(e.target.value)} disabled={busy}>
      <option value="">Browser / A4 receipt</option>{printers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select></label>
    {!bill && order.status === "open" && <>
      <p><label>Discount (₹) <input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} disabled={busy} /></label></p>
      <p><label>Discount reason <input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} /></label></p>
      {hasDraft && <p>Punch or remove the items in your cart before billing.</p>}
      <button className="primary" disabled={busy || hasDraft} onClick={() => void run(getPreview)}>Preview bill</button>
      {preview && <><BillSummary value={preview} /><p>Issuing freezes the items and totals.</p><button className="primary" disabled={busy || hasDraft} onClick={() => void run(issue)}>Issue bill</button></>}
    </>}
    {bill && <>
      <BillSummary value={bill} />
      {bill.discountNote && <p>Discount reason: {bill.discountNote}</p>}
      {bill.status === "unpaid" && <fieldset disabled={busy} style={{ padding: 16, marginBottom: 16 }}><legend>Record payment</legend>
        {payments.map((p, index) => <div key={p.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          <label>Mode {index + 1} <select value={p.mode} onChange={(e) => setPayments((rows) => rows.map((r) => r.id === p.id ? { ...r, mode: e.target.value as PaymentDraft["mode"] } : r))}>
            <option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option>
          </select></label>
          <label>Amount {index + 1} (₹) <input style={{ width: 110 }} type="number" min="0.01" step="0.01" value={p.amount} onChange={(e) => setPayments((rows) => rows.map((r) => r.id === p.id ? { ...r, amount: e.target.value } : r))} /></label>
          <label>Reference {index + 1} <input style={{ width: 140 }} maxLength={200} value={p.refNote} onChange={(e) => setPayments((rows) => rows.map((r) => r.id === p.id ? { ...r, refNote: e.target.value } : r))} /></label>
          <button aria-label={`Remove payment ${index + 1}`} onClick={() => setPayments((rows) => rows.filter((r) => r.id !== p.id))}>Remove</button>
        </div>)}
        {bill.totalPaise > 0 && <button disabled={payments.length >= 20} onClick={() => setPayments((rows) => [...rows, { id: uuid(), mode: "upi", amount: paiseToRupees(Math.max(0, bill.totalPaise - entered)), refNote: "" }])}>Add payment method</button>}
        <p>Remaining: {money(bill.totalPaise - entered)}</p>
        <button className="primary" disabled={entered !== bill.totalPaise} onClick={() => void run(settle)}>Settle bill</button>
      </fieldset>}
      {bill.status === "paid" && <p>Paid: {bill.payments.length ? bill.payments.map((p) => `${p.mode.toUpperCase()} ${money(p.amountPaise)}`).join(" + ") : "No payment due"}</p>}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button disabled={busy} onClick={() => void run(viewReceipt)}>View receipt</button>
        {printerId && <button disabled={busy} onClick={() => void run(async () => {
          const result = await apiFetch<{ job: PrintJobInfo }>(`/api/bills/${bill.id}/print`, { method: "POST", body: JSON.stringify({ printerId }) });
          setJob(result.job); setMessage("Receipt queued for printing.");
        })}>Print receipt</button>}
        {html && <button disabled={!frameReady} onClick={() => frame.current?.contentWindow?.print()}>Print / save PDF</button>}
      </div>
    </>}
    {job && <p role="status">Receipt print: {job.status}{job.error ? ` — ${job.error}. Use Print receipt to try again, or ask an admin to retry in Settings.` : ""}</p>}
    {html && <iframe ref={frame} title={`Receipt for bill ${bill?.billNo}`} sandbox="allow-same-origin allow-modals" srcDoc={html} onLoad={() => setFrameReady(true)} style={{ width: "100%", height: 650, marginTop: 16, border: "1px solid #ccc" }} />}
  </section>;
}
