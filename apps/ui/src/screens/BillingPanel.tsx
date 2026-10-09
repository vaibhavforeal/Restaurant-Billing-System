import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Bill, BillCreateInput, BillTotals } from "@forkflow/domain";
import { ApiError, apiFetch, authHeaders, session } from "../api";
import { billStatusLabel } from "../credit-note-form";
import { paiseToRupees, rupeesToPaise } from "../money";
import type { Order, PrintJobInfo } from "../types";
import { uuid } from "../uuid";
import { connectWs } from "../ws";
import { reliablePost } from "../retry-queue";
import { SegmentedControl } from "../PosControls";
import { UpiQrPreview } from "./UpiQrPreview";
import { BillItemLines, CreditNoteDialog, CreditNoteList } from "./CreditNoteDialog";
import { readPreference, savePreference, useShortcutLabels } from "../pos-shortcuts";
import { billPaymentLabel, taxModeNote, useZomatoStatus, ZOMATO_PILL, zomatoCardAction } from "../zomato-desk";
import "../billing-panel.css";
import "../zomato.css";

const money = (value: number) => `₹${paiseToRupees(value)}`;
type Preview = BillTotals & { previewKey: string; receipt: Bill["receipt"] };
const paymentModes = [{ value: "cash", label: "Cash" }, { value: "card", label: "Card" }, { value: "upi", label: "UPI" }] as const;
function preferredPayment(): "cash" | "card" | "upi" { const value = readPreference("forkflow.payment-mode", "cash"); return value === "card" || value === "upi" ? value : "cash"; }

type PaymentDraft = { id: string; mode: "cash" | "upi" | "card"; amount: string; refNote: string };

export function BillSummary({ value, compact = false, gstPaidBy }: { value: BillTotals; compact?: boolean; gstPaidBy?: "zomato" | undefined }) {
  const breakdown = <>
    <p>{taxModeNote({ taxInclusive: value.taxInclusive, gstPaidBy })}</p>
    <p>Subtotal: {money(value.subtotalPaise)} · Discount: {money(value.discountPaise)}</p>
    <div style={{ overflowX: "auto" }}><table style={{ width: "100%", textAlign: "right", borderSpacing: "8px" }}>
      <thead><tr><th scope="col">GST rate</th><th scope="col">Taxable</th><th scope="col">CGST</th><th scope="col">SGST</th></tr></thead>
      <tbody>{value.taxes.map((t) => <tr key={t.gstRate}><td>{t.gstRate}%</td><td>{money(t.taxablePaise)}</td><td>{money(t.cgstPaise)} ({t.gstRate / 2}%)</td><td>{money(t.sgstPaise)} ({t.gstRate / 2}%)</td></tr>)}</tbody>
    </table></div>
    <p>Round off: {money(value.roundingPaise)}</p>
  </>;
  const amounts = <dl className="pos-totals"><dt>Subtotal</dt><dd>{money(value.subtotalPaise)}</dd><dt>Discount</dt><dd>{money(value.discountPaise)}</dd><dt>CGST</dt><dd>{money(value.taxes.reduce((sum, tax) => sum + tax.cgstPaise, 0))}</dd><dt>SGST</dt><dd>{money(value.taxes.reduce((sum, tax) => sum + tax.sgstPaise, 0))}</dd><dt>Round off</dt><dd>{money(value.roundingPaise)}</dd></dl>;
  const payable = <p className="payable"><span>Payable:</span><strong>{money(value.totalPaise)}</strong></p>;
  return <div className={`bill-summary${compact ? " bill-summary-compact" : ""}`}>
    {compact ? <>{amounts}{payable}<details className="bill-tax-details"><summary>Tax details</summary>{breakdown}</details></> : <>{breakdown}{payable}</>}
  </div>;
}

export function BillingPanel({ order, hasDraft, onChanged, onPrepare, disabled = false, onBusyChange, onGoToTables, onClosed, role }: { order: Order; hasDraft: boolean; onChanged: () => Promise<void>; onPrepare?: (() => Promise<void>) | undefined; disabled?: boolean; onBusyChange?: (busy: boolean) => void; onGoToTables?: (() => void) | undefined; /** A Zomato order was picked up and closed: the screen should go back. */ onClosed?: (() => void) | undefined; /** Void and refund are offered to admins and cashiers only. */ role?: "admin" | "cashier" | "waiter" | "kitchen" | undefined }) {
  const { shortcut, shortcutProps } = useShortcutLabels();
  const [bill, setBill] = useState<Bill | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [discount, setDiscount] = useState("0");
  const [reason, setReason] = useState("");
  const [printers, setPrinters] = useState<Array<{ id: string; name: string }>>([]);
  const [printerId, setPrinterId] = useState(() => readPreference("forkflow.receipt-printer"));
  const [payments, setPayments] = useState<PaymentDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [html, setHtml] = useState("");
  const [showQr, setShowQr] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const createRequest = useRef<BillCreateInput | null>(null);
  const settlement = useRef<{ clientRef: string; fingerprint: string } | null>(null);
  const billRevision = useRef(0);
  const [job, setJob] = useState<PrintJobInfo | null>(null);
  const [creditKind, setCreditKind] = useState<"void" | "refund" | null>(null);
  const [quickMode, setQuickMode] = useState<PaymentDraft["mode"]>(preferredPayment);
  const [cashReceived, setCashReceived] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogTitle = useRef<HTMLHeadingElement>(null);
  const options = useRef<HTMLDetailsElement>(null);
  const dialogTitleId = useId();
  const quick = !!onPrepare;
  const zomatoStatus = useZomatoStatus();
  const zomatoLock = useRef(false);
  const blocked = busy || disabled;
  const itemsKey = JSON.stringify(order.items);

  function openDialog(showOptions = false) {
    if (showOptions && options.current) options.current.open = true;
    if (dialog.current && !dialog.current.open) {
      dialog.current.showModal();
      dialogTitle.current?.focus();
    }
  }
  function closeDialog() {
    if (!lock.current && !disabled) dialog.current?.close();
  }
  function goToTables() {
    if (lock.current || disabled || bill?.status !== "paid" || order.type !== "dine_in" || !onGoToTables) return;
    dialog.current?.close();
    onGoToTables();
  }
  useEffect(() => { if (error) openDialog(); }, [error]);

  function acceptBill(value: Bill | null) {
    billRevision.current++;
    setBill(value);
    if (value && value.status === "unpaid") setPayments((p) => p.length ? p : value.totalPaise ? [{ id: uuid(), mode: preferredPayment(), amount: paiseToRupees(value.totalPaise), refNote: "" }] : []);
  }
  useEffect(() => {
    let active = true;
    const revision = billRevision.current;
    Promise.all([
      apiFetch<{ bill: Bill | null }>(`/api/orders/${order.id}/bill`),
      apiFetch<{ printers: Array<{ id: string; name: string }> }>("/api/billing-printers"),
    ]).then(([b, p]) => {
      if (!active) return;
      if (revision === billRevision.current) acceptBill(b.bill);
      setPrinters(p.printers);
      setPrinterId((id) => p.printers.some((printer) => printer.id === id) ? id : "");
    }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Failed to load billing"); });
    return () => { active = false; };
  }, [order.id, order.status]);
  useEffect(() => { setPreview(null); createRequest.current = null; }, [itemsKey, hasDraft, discount, reason]);
  useEffect(() => { setHtml(""); setFrameReady(false); }, [bill?.id, bill?.status]);
  useEffect(() => { setShowQr(false); }, [bill?.id, bill?.status]);
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
    if (lock.current || disabled) return;
    openDialog();
    lock.current = true; setBusy(true); onBusyChange?.(true); setError(""); setMessage("");
    try { await action(); }
    catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      // Resolve an ambiguous response from the persisted bill before another attempt.
      try { acceptBill((await apiFetch<{ bill: Bill | null }>(`/api/orders/${order.id}/bill`)).bill); } catch { /* retain the retryable request */ }
      try { await onChanged(); } catch { /* preserve the last confirmed view until reconnect */ }
    } finally { lock.current = false; setBusy(false); onBusyChange?.(false); }
  }
  async function getPreview() {
    const discountPaise = rupeesToPaise(discount);
    if (discountPaise === null) throw new Error("Enter a valid discount amount");
    if (discountPaise > 0 && !reason.trim()) throw new Error("Enter a discount reason");
    if (onPrepare) {
      setMessage("Saving your takeaway and sending kitchen items…");
      await onPrepare();
    }
    const { preview: value } = await apiFetch<{ preview: Preview }>(`/api/orders/${order.id}/bill-preview`, {
      method: "POST", body: JSON.stringify({ discountPaise, discountNote: reason }),
    });
    setPreview(value);
    setMessage(""); setCashReceived("");
    createRequest.current = { clientRef: uuid(), previewKey: value.previewKey, discountPaise, discountNote: reason.trim(), printerId: printerId || null };
  }
  async function issue() {
    if (!createRequest.current || hasDraft) throw new Error("Review the bill preview first");
    const { bill: value, job: printJob, printError } = await reliablePost<{ bill: Bill; job: PrintJobInfo | null; printError?: string | null }>(`/api/orders/${order.id}/bill`, createRequest.current, "Issue bill");
    acceptBill(value); setPreview(null); setJob(printJob);
    setMessage(`Bill #${value.billNo} issued. Record payment below.${printError ? ` ${printError}. Use Print receipt to try again.` : ""}`);
    await onChanged();
  }
  async function issueAndPay() {
    const request = createRequest.current;
    if (!request || !preview || hasDraft) throw new Error("Review the takeaway total first");
    const received = cashReceived.trim() ? rupeesToPaise(cashReceived) : preview.totalPaise;
    if (quickMode === "cash" && (received === null || received < preview.totalPaise)) throw new Error("Cash received must cover the total");
    const rows = preview.totalPaise ? [{ mode: quickMode, amountPaise: preview.totalPaise, refNote: "" }] : [];
    // Print after recording payment so the quick-flow receipt includes payment.
    const { bill: issued } = await reliablePost<{ bill: Bill; job: PrintJobInfo | null }>(`/api/orders/${order.id}/bill`, { ...request, printerId: null }, "Issue takeaway bill");
    acceptBill(issued); setPreview(null);
    setPayments(rows.map((row) => ({ id: uuid(), mode: row.mode, amount: paiseToRupees(row.amountPaise), refNote: row.refNote })));
    const fingerprint = JSON.stringify(rows);
    if (settlement.current?.fingerprint !== fingerprint) settlement.current = { clientRef: uuid(), fingerprint };
    const { bill: paid } = await reliablePost<{ bill: Bill }>(`/api/bills/${issued.id}/settle`, { clientRef: settlement.current.clientRef, payments: rows }, "Record takeaway payment");
    acceptBill(paid);
    setMessage(`Payment recorded.${quickMode === "cash" && received !== null && received > paid.totalPaise ? ` Change: ${money(received - paid.totalPaise)}.` : ""}`);
    try { await onChanged(); }
    catch { setError("Payment is recorded. Reopen the order if its status has not refreshed."); }
    if (printerId) {
      try {
        const result = await apiFetch<{ job: PrintJobInfo }>(`/api/bills/${paid.id}/print`, { method: "POST", body: JSON.stringify({ printerId }) });
        setJob(result.job);
      } catch { setError("Payment is recorded. Receipt printing was not confirmed; check the printer before printing again."); }
    }
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
  function creditIssued(result: { bill: Bill }) {
    acceptBill(result.bill);
    onChanged().catch(() => { /* the order refreshes on the next update */ });
  }
  async function advanceZomato() {
    const { status } = zomatoCardAction(order);
    if (!status || blocked || hasDraft || zomatoLock.current) return;
    zomatoLock.current = true; onBusyChange?.(true);
    let applied = false;
    try { applied = await zomatoStatus.advance(order, status); }
    finally { zomatoLock.current = false; onBusyChange?.(false); }
    if (!applied) return;
    try { await onChanged(); } catch { /* the order refreshes on the next update */ }
    if (status === "picked_up") onClosed?.();
  }
  async function reloadBill() {
    try { acceptBill((await apiFetch<{ bill: Bill | null }>(`/api/orders/${order.id}/bill`)).bill); } catch { /* keep the last confirmed bill */ }
    try { await onChanged(); } catch { /* keep the last confirmed order */ }
  }
  async function viewReceipt() {
    if (!bill) return;
    const response = await fetch(`/api/bills/${bill.id}/receipt`, { headers: authHeaders() });
    if (response.status === 401) session.clear();
    if (!response.ok) throw new ApiError(response.status, "Could not load receipt");
    setFrameReady(false); setHtml(await response.text());
  }
  function changePrinter(value: string) {
    setPrinterId(value); savePreference("forkflow.receipt-printer", value);
    setPreview(null); createRequest.current = null;
  }
  const entered = payments.reduce((sum, p) => sum + (rupeesToPaise(p.amount) ?? 0), 0);
  const quickReceived = cashReceived.trim() ? rupeesToPaise(cashReceived) : preview?.totalPaise ?? 0;
  const cashValid = quickMode !== "cash" || (quickReceived !== null && quickReceived >= (preview?.totalPaise ?? 0));
  const previewDisabled = blocked || (!quick && hasDraft) || (!hasDraft && !order.items.some((item) => item.status !== "cancelled"));
  const previewLabel = quick ? busy ? "Preparing checkout…" : preview ? "Refresh total" : "Checkout" : "Preview bill";
  const totals = bill ?? preview;
  const canShowQr = !!bill && bill.status === "unpaid" && !!bill.receipt.upiId && bill.totalPaise > 0;
  const canGoToTables = bill?.status === "paid" && order.type === "dine_in" && !!onGoToTables;
  // Zomato bills are never printed and never credited: Zomato issues the customer invoice and handles refunds.
  const zomatoBill = bill?.receipt.orderType === "zomato";
  const zomatoDesk = order.type === "zomato";
  const zomatoAction = zomatoCardAction(order);
  const zomatoPill = order.zomatoStatus ?? "new";
  const canVoid = !!bill && !zomatoBill && (role === "admin" || role === "cashier") && bill.status !== "void" && bill.refundState !== "refunded";
  const canRefund = canVoid && bill?.status === "paid" && bill.totalPaise > 0;
  // A cancelled order with no bill has nothing to bill; a voided bill on a cancelled order stays viewable.
  if (order.status === "cancelled" && !bill) return null;
  return <section aria-label="Billing" className="billing-panel billing-footer">
    {bill && <div className="billing-footer-total"><span>Bill #{bill.billNo}<span className={`status ${bill.status} refund-${bill.refundState}`}>{billStatusLabel(bill)}</span></span><strong>{money(bill.totalPaise)}</strong></div>}
    <div className="billing-footer-actions">
      {!bill && order.status === "open" && zomatoDesk && <>
        <span className={`zomato-desk-pill is-${zomatoPill}`}>{ZOMATO_PILL[zomatoPill]}</span>
        <button className="primary pos-pay" disabled={blocked || hasDraft || zomatoAction.status === null || zomatoStatus.busyId !== null} onClick={() => void advanceZomato()}>{zomatoStatus.busyId !== null ? "Saving…" : zomatoAction.label}</button>
      </>}
      {!bill && order.status === "open" && !zomatoDesk && <>
        <button {...shortcutProps("discount")} title={shortcut("discount", "Discount and printer options")} disabled={blocked} onClick={() => openDialog(true)}>{shortcut("discount", "Discount")}</button>
        <button className="primary pos-pay" {...shortcutProps("billing")} title={shortcut("billing", "Review total and payment")} disabled={previewDisabled} onClick={() => void run(getPreview)}>{quick ? busy ? "Preparing…" : shortcut("billing", "Pay") : shortcut("billing", "Preview bill")}</button>
      </>}
      {bill && <button className="primary pos-pay" {...shortcutProps("billing")} title={shortcut("billing", "Open bill / payment")} disabled={busy} onClick={() => openDialog()}>{bill.status === "unpaid" ? "Record payment" : "View bill"}</button>}
      {canShowQr && <button disabled={blocked} onClick={() => setShowQr(true)}>Show UPI QR</button>}
      {canGoToTables && <button className="primary" disabled={blocked} onClick={goToTables}>Go to tables</button>}
    </div>
    {!bill && order.status === "open" && zomatoDesk && <>
      {zomatoStatus.error && <p className="error-message" role="alert">{zomatoStatus.error}</p>}
      {hasDraft ? <p className="billing-zomato-hint">Punch or remove the items in your cart first.</p> : zomatoAction.status === null && <p className="billing-zomato-hint">Add items to hand this order over.</p>}
    </>}
    {!zomatoDesk && <div className="pos-printer-status">Printer: {printerId ? printers.find((p) => p.id === printerId)?.name ?? "Selected printer" : "Browser / A4"}{job ? ` · ${job.status}` : ""}</div>}
    {error && <button className="billing-attention" onClick={() => openDialog()}>Billing needs attention</button>}
    {createPortal(<dialog ref={dialog} className="billing-dialog" aria-labelledby={dialogTitleId} onCancel={(event) => { if (lock.current || disabled) event.preventDefault(); }}>
      <header className="billing-dialog-header">
        <h2 ref={dialogTitle} id={dialogTitleId} tabIndex={-1}>{bill ? `Bill #${bill.billNo} — ${billStatusLabel(bill)}` : quick ? "Takeaway checkout" : "Billing"}</h2>
        {!bill && <button {...shortcutProps("discount")} title={shortcut("discount", "Discount and printer options")} disabled={blocked} onClick={() => { openDialog(true); options.current?.querySelector("input")?.focus(); }}>{shortcut("discount", "Discount")}</button>}
        <button disabled={blocked} onClick={closeDialog} aria-label="Close billing">Close</button>
      </header>
      <div className="billing-dialog-body">
        {error && <p className="billing-error" role="alert">{error}</p>}
        {message && <p className="billing-message" role="status">{message}</p>}
        <div className={`billing-dialog-grid${totals ? "" : " billing-awaiting-preview"}`}>
          <div className="billing-review">
            {totals && <BillSummary value={totals} compact gstPaidBy={bill?.receipt.gstPaidBy} />}
            {bill?.discountNote && <p className="billing-note">Discount reason: {bill.discountNote}</p>}
            {bill && <BillItemLines items={order.items} refundedQty={bill.refundedQty} showRefunded={bill.creditNotes.length > 0} />}
            {!zomatoBill && <details ref={options} className="billing-options" open={!totals}>
              <summary>Bill options</summary>
              <div className="billing-options-fields">
                <label>Receipt printer <select value={printerId} onChange={(e) => changePrinter(e.target.value)} disabled={blocked}>
                  <option value="">Browser / A4 receipt</option>{printers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select></label>
                {!bill && order.status === "open" && <>
                  <label>Discount (₹) <input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} disabled={blocked} /></label>
                  <label className="billing-wide-field">Discount reason <input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} disabled={blocked} /></label>
                </>}
              </div>
            </details>}
            {!bill && order.status === "open" && <>
              {hasDraft && !quick && <p className="billing-note">Punch or remove the items in your cart before billing.</p>}
              <button {...(!preview ? shortcutProps("billing") : {})} title={!preview ? shortcut("billing", "Refresh server total") : "Refresh server total"} className={preview ? "billing-refresh" : "primary billing-refresh"} disabled={previewDisabled} onClick={() => void run(getPreview)}>{previewLabel}</button>
            </>}
          </div>
          {preview && !bill && <div className="billing-payment">
            {quick ? <fieldset disabled={blocked} className="quick-payment"><legend>Payment received</legend>
              <div className="billing-payment-fields">
                <div className="billing-wide-field"><span className="pos-field-label">Payment method</span><SegmentedControl label="Payment method" value={quickMode} options={paymentModes} onChange={(mode) => { setQuickMode(mode); savePreference("forkflow.payment-mode", mode); }} /></div>
                {quickMode === "cash" && <label>Cash received (₹)<input type="number" min={paiseToRupees(preview.totalPaise)} step="0.01" placeholder={paiseToRupees(preview.totalPaise)} value={cashReceived} onChange={(event) => setCashReceived(event.target.value)} /></label>}
              </div>
              {quickMode === "cash" && <div className="cash-chips" aria-label="Cash quick amounts">{[preview.totalPaise, ...[50000, 100000, 200000].filter((amount) => amount > preview.totalPaise)].map((amount, index) => <button key={amount} onClick={() => setCashReceived(paiseToRupees(amount))}>{index === 0 ? "Exact" : money(amount)}</button>)}</div>}
              {quickMode === "cash" && <p className="billing-change" role="status">Change: {money(Math.max(0, (quickReceived ?? 0) - preview.totalPaise))}</p>}
              {quickMode === "upi" && preview.receipt.upiId && preview.totalPaise > 0 && <>
                <p className="billing-note">Customer paying by QR? Issue the bill first, then verify payment before settling.</p>
                <button disabled={blocked || hasDraft} onClick={() => void run(issue)}>{printerId ? "Print UPI bill" : "Issue UPI bill"}</button>
              </>}
              <p className="billing-note">Confirm after receiving payment.</p><button className="primary pos-pay" {...shortcutProps("billing")} title={shortcut("billing", "Issue bill and record received payment")} disabled={blocked || hasDraft || !cashValid} onClick={() => void run(issueAndPay)}>{shortcut("billing", printerId ? "Pay & print" : "Record payment")}</button>
            </fieldset> : <div className="billing-issue"><p>Issuing freezes the items and totals.</p><button className="primary pos-pay" {...shortcutProps("billing")} title={shortcut("billing", "Issue the reviewed bill")} disabled={blocked || hasDraft} onClick={() => void run(issue)}>{shortcut("billing", printerId ? "Save & print bill" : "Issue bill")}</button></div>}
          </div>}
          {bill && <div className="billing-payment">
            {bill.status === "unpaid" && <fieldset disabled={busy} className="billing-payment-form"><legend>Record payment</legend>
              {canShowQr && <><button onClick={() => setShowQr(true)}>Show UPI QR</button><p className="billing-note">Customers can scan from this screen or the printed bill. Verify payment in your UPI app before settling.</p></>}
              {payments.map((p, index) => <div key={p.id} className="billing-payment-row">
                <div className="billing-wide-field"><span className="pos-field-label">Mode {index + 1}</span><SegmentedControl label={`Mode ${index + 1}`} value={p.mode} options={paymentModes} onChange={(mode) => { setPayments((rows) => rows.map((r) => r.id === p.id ? { ...r, mode } : r)); savePreference("forkflow.payment-mode", mode); }} /></div>
                <label>Amount {index + 1} (₹) <input type="number" min="0.01" step="0.01" value={p.amount} onChange={(e) => setPayments((rows) => rows.map((r) => r.id === p.id ? { ...r, amount: e.target.value } : r))} /></label>
                <label>Reference {index + 1} <input maxLength={200} value={p.refNote} onChange={(e) => setPayments((rows) => rows.map((r) => r.id === p.id ? { ...r, refNote: e.target.value } : r))} /></label>
                <button className="billing-remove-payment" aria-label={`Remove payment ${index + 1}`} onClick={() => setPayments((rows) => rows.filter((r) => r.id !== p.id))}>Remove</button>
              </div>)}
              {bill.totalPaise > 0 && <button disabled={payments.length >= 20} onClick={() => setPayments((rows) => [...rows, { id: uuid(), mode: "upi", amount: paiseToRupees(Math.max(0, bill.totalPaise - entered)), refNote: "" }])}>Add payment method</button>}
              <p className="billing-remaining">Remaining: {money(bill.totalPaise - entered)}</p>
              <button className="primary pos-pay" {...shortcutProps("billing")} title={shortcut("billing", "Record the entered payment amounts")} disabled={entered !== bill.totalPaise} onClick={() => void run(settle)}>{shortcut("billing", "Settle bill")}</button>
            </fieldset>}
            {bill.status === "void" && <p className="billing-note" role="status">This bill is void.</p>}
            {bill.status === "paid" && <p className="billing-paid">Paid: {bill.payments.length ? bill.payments.map((p) => `${billPaymentLabel(p.mode)} ${money(p.amountPaise)}`).join(" + ") : "No payment due"}</p>}
            <div className="billing-receipt-actions">
              {canGoToTables && <button className="primary" disabled={blocked} onClick={goToTables}>Go to tables</button>}
              <button disabled={busy} onClick={() => void run(viewReceipt)}>View receipt</button>
              {printerId && !zomatoBill && <button disabled={busy} onClick={() => void run(async () => {
                const result = await apiFetch<{ job: PrintJobInfo }>(`/api/bills/${bill.id}/print`, { method: "POST", body: JSON.stringify({ printerId }) });
                setJob(result.job); setMessage("Receipt queued for printing.");
              })}>Print receipt</button>}
              {html && !zomatoBill && <button disabled={!frameReady} onClick={() => frame.current?.contentWindow?.print()}>Print / save PDF</button>}
              {canRefund && <button disabled={blocked} onClick={() => setCreditKind("refund")}>Refund items</button>}
              {canVoid && <button className="billing-void" disabled={blocked} onClick={() => setCreditKind("void")}>Void bill</button>}
            </div>
            <CreditNoteList notes={bill.creditNotes} printers={printers} printerId={printerId} />
            {job && <p className="billing-print-status" role="status">Receipt print: {job.status === "done" ? "submitted" : job.status}{job.error ? ` — ${job.error}. Check the paper before reprinting. An admin can retry the affected copy in Settings.` : ""}{job.copyCount > 1 ? ` · ${job.copyCount} copies requested; each copy is tracked in Settings.` : ""}</p>}
          </div>}
        </div>
        {html && <iframe className="billing-receipt-frame" ref={frame} title={`Receipt for bill ${bill?.billNo}`} sandbox="allow-same-origin allow-modals" srcDoc={html} onLoad={() => setFrameReady(true)} />}
      </div>
    </dialog>, document.body)}
    {bill && <UpiQrPreview billId={bill.id} open={showQr && canShowQr} onClose={() => setShowQr(false)} />}
    {bill && !zomatoBill && (role === "admin" || role === "cashier") && <CreditNoteDialog kind={creditKind} bill={bill} items={order.items} role={role} printers={printers} printerId={printerId} onClose={() => setCreditKind(null)} onIssued={creditIssued} onStale={() => void reloadBill()} />}
  </section>;
}
