import { useEffect, useId, useRef, useState } from "react";
import type { Bill, BillCreditNote } from "@forkflow/domain";
import { ApiError, apiFetch, authHeaders, session } from "../api";
import { PAY_MODES, REFUND_REASONS, clampRefundQty, creditReason, defaultRefundRows, refundRowsError, refundableQty, type PayMode } from "../credit-note-form";
import { paiseToRupees, rupeesToPaise } from "../money";
import type { Order, OrderItem, PrintJobInfo } from "../types";
import { uuid } from "../uuid";
import { WorkspaceDialog } from "../WorkspaceDialog";

const money = (value: number) => `₹${paiseToRupees(value)}`;
const PIN_INCORRECT = "Admin PIN is incorrect";
type Printer = { id: string; name: string };
type Refundable = Record<PayMode, number> & { total: number };
interface Preview {
  lines: Array<{ orderItemId: string; name: string; qty: number; totalPaise: number }>;
  taxes: Array<{ gstRate: number; taxablePaise: number; cgstPaise: number; sgstPaise: number }>;
  totals: { taxablePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; totalPaise: number };
  refundable: Refundable;
}
interface IssuedCredit { bill: Bill; creditNote: BillCreditNote; order: Order }
type RefundDraft = { id: string; mode: PayMode; amount: string };

const modeLabel = (mode: string) => mode.toUpperCase();

/** Print or view the slip of one credit note. `selectable` lets the cashier pick the printer; otherwise `printerId` is used as is. */
export function CreditNoteActions({ note, printers, printerId, selectable = false, printLabel = "Print credit note" }: {
  note: Pick<BillCreditNote, "id" | "cnNo">; printers: Printer[]; printerId: string; selectable?: boolean; printLabel?: string;
}) {
  const [chosen, setChosen] = useState(() => printers.some((p) => p.id === printerId) ? printerId : "");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [html, setHtml] = useState("");
  const [frameReady, setFrameReady] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const printerField = useId();
  const target = selectable ? chosen : printers.some((p) => p.id === printerId) ? printerId : "";

  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : "Request failed"); }
    finally { lock.current = false; setBusy(false); }
  }
  const print = () => run(async () => {
    const result = await apiFetch<{ job: PrintJobInfo }>(`/api/credit-notes/${note.id}/print`, { method: "POST", body: JSON.stringify({ printerId: target }) });
    setMessage(`CN-${note.cnNo} queued for printing${result.job.printerName ? ` on ${result.job.printerName}` : ""}.`);
  });
  const view = () => run(async () => {
    const response = await fetch(`/api/credit-notes/${note.id}/receipt`, { headers: authHeaders() });
    if (response.status === 401) session.clear();
    if (!response.ok) throw new ApiError(response.status, "Could not load the credit note");
    setFrameReady(false); setHtml(await response.text());
  });
  return <div className="credit-note-actions">
    <div className="credit-note-buttons">
      {selectable && printers.length > 0 && <label htmlFor={printerField}>Printer <select id={printerField} value={chosen} disabled={busy} onChange={(e) => setChosen(e.target.value)}>
        <option value="">Choose a printer</option>{printers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>}
      {target && <button type="button" className={selectable ? "primary" : ""} disabled={busy} aria-label={`${printLabel} CN-${note.cnNo}`} onClick={() => void print()}>{printLabel}</button>}
      <button type="button" disabled={busy} aria-label={`View CN-${note.cnNo}`} onClick={() => void view()}>View</button>
      {html && <button type="button" disabled={!frameReady} onClick={() => frame.current?.contentWindow?.print()}>Print / save PDF</button>}
      {html && <button type="button" onClick={() => setHtml("")}>Hide</button>}
    </div>
    {error && <p className="billing-error" role="alert">{error}</p>}
    {message && <p className="billing-message" role="status">{message}</p>}
    {html && <iframe className="billing-receipt-frame" ref={frame} title={`Credit note CN-${note.cnNo}`} sandbox="allow-same-origin allow-modals" srcDoc={html} onLoad={() => setFrameReady(true)} />}
  </div>;
}

/** Credit notes of a bill, newest last: number, date, kind, amount, reason, who requested and approved, and a reprint. */
export function CreditNoteList({ notes, printers, printerId }: { notes: BillCreditNote[]; printers: Printer[]; printerId: string }) {
  if (!notes.length) return null;
  return <section className="credit-note-list" aria-label="Credit notes">
    <h3>Credit notes</h3>
    <ul>{notes.map((note) => <li key={note.id}>
      <div className="credit-note-head"><strong>CN-{note.cnNo}</strong><span>{new Date(note.createdAt).toLocaleString()}</span><span className="credit-note-kind">{note.kind === "void" ? "Void" : "Refund"}</span><strong className="pos-money">{money(note.totalPaise)}</strong></div>
      <p>Reason: {note.reason}</p>
      <p className="muted">Requested by {note.requestedByName} · Approved by {note.approvedByName}{note.refunds.length > 0 && ` · Refunded ${note.refunds.map((r) => `${modeLabel(r.mode)} ${money(r.amountPaise)}`).join(" + ")}`}</p>
      <CreditNoteActions note={note} printers={printers} printerId={printerId} printLabel="Reprint" />
    </li>)}</ul>
  </section>;
}

/** The items of an issued bill with how many were billed and refunded. */
export function BillItemLines({ items, refundedQty, showRefunded }: { items: OrderItem[]; refundedQty: Record<string, number>; showRefunded: boolean }) {
  const billed = items.filter((item) => item.status !== "cancelled");
  if (!billed.length) return null;
  return <section className="bill-item-lines" aria-label="Billed items">
    <h3>Items</h3>
    <ul>{billed.map((item) => <li key={item.id}><span>{item.name}</span><span className="muted">{item.qty} billed{showRefunded ? ` · ${refundedQty[item.id] ?? 0} refunded` : ""}</span></li>)}</ul>
  </section>;
}

export function CreditNoteDialog({ kind, bill, items, role, printers, printerId, onClose, onIssued, onStale }: {
  kind: "void" | "refund" | null;
  bill: Bill;
  items: OrderItem[];
  role: "admin" | "cashier";
  printers: Printer[];
  printerId: string;
  onClose: () => void;
  onIssued: (result: IssuedCredit) => void;
  /** The server says the bill changed: reload it. */
  onStale: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const title = `${kind === "refund" ? "Refund items" : "Void bill"} · Bill #${bill.billNo}`;
  return <WorkspaceDialog open={kind !== null} title={title} className="credit-note-dialog" busy={busy} onClose={onClose}>
    {kind && <CreditBody kind={kind} bill={bill} items={items} role={role} printers={printers} printerId={printerId} onBusyChange={setBusy} onClose={onClose} onIssued={onIssued} onStale={onStale} />}
  </WorkspaceDialog>;
}

function CreditBody({ kind, bill, items, role, printers, printerId, onBusyChange, onClose, onIssued, onStale }: {
  kind: "void" | "refund"; bill: Bill; items: OrderItem[]; role: "admin" | "cashier"; printers: Printer[]; printerId: string;
  onBusyChange: (busy: boolean) => void; onClose: () => void; onIssued: (result: IssuedCredit) => void; onStale: () => void;
}) {
  const billable = items.filter((item) => item.status !== "cancelled");
  const unpaid = bill.status === "unpaid";
  const [qty, setQty] = useState<Record<string, number>>({});
  const [pick, setPick] = useState("");
  const [detail, setDetail] = useState("");
  const [pin, setPin] = useState("");
  const [preview, setPreview] = useState<(Preview & { key: string }) | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [tick, setTick] = useState(0);
  const [rows, setRows] = useState<RefundDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const attempt = useRef<{ clientRef: string; fingerprint: string } | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<IssuedCredit | null>(null);
  const ids = { reason: useId(), pin: useId() };

  const lines = billable.map((item) => ({ orderItemId: item.id, qty: qty[item.id] ?? 0 })).filter((line) => line.qty > 0);
  const key = JSON.stringify(lines);
  const needsItems = kind === "refund";

  useEffect(() => {
    if (result) return;
    setPreview(null); setPreviewError("");
    if (needsItems && !lines.length) { setLoadingPreview(false); return; }
    let active = true;
    setLoadingPreview(true);
    apiFetch<{ preview: Preview }>(`/api/bills/${bill.id}/credit-preview`, { method: "POST", body: JSON.stringify(needsItems ? { kind, lines } : { kind }) })
      .then((r) => { if (active) setPreview({ ...r.preview, key }); })
      .catch((e: unknown) => { if (active) setPreviewError(e instanceof Error ? e.message : "Could not work out the credit"); })
      .finally(() => { if (active) setLoadingPreview(false); });
    return () => { active = false; };
  }, [kind, key, tick, bill.id, result]);

  // A paid void gives back all the money still held; a refund gives back the credit note total; an unpaid void refunds nothing.
  const refundTotal = !preview || unpaid ? 0 : kind === "void" ? preview.refundable.total : preview.totals.totalPaise;
  useEffect(() => {
    if (!preview) { setRows([]); return; }
    setRows(defaultRefundRows(bill.payments, preview.refundable, refundTotal).map((row) => ({ id: uuid(), mode: row.mode, amount: paiseToRupees(row.amountPaise) })));
  }, [preview]);

  const parsed = rows.map((row) => ({ ...row, amountPaise: rupeesToPaise(row.amount) }));
  const rowsError = !preview || unpaid ? null
    : parsed.some((row) => row.amountPaise === null) ? "Enter a valid refund amount"
    : refundRowsError(parsed.filter((row) => row.amountPaise).map((row) => ({ mode: row.mode, amountPaise: row.amountPaise! })), refundTotal, preview.refundable);
  const reason = creditReason(pick, detail);
  const needsPin = role === "cashier";
  const pinValid = !needsPin || /^\d{4,6}$/.test(pin);
  const ready = !!preview && preview.key === key && !loadingPreview && !rowsError && reason.length > 0 && reason.length <= 200 && pinValid && (!needsItems || lines.length > 0);
  const confirmLabel = busy ? "Saving…" : kind === "void" ? "Void bill" : preview ? `Refund ${money(preview.totals.totalPaise)} as credit note` : "Refund as credit note";

  function changeBusy(value: boolean) { setBusy(value); onBusyChange(value); }
  async function submit() {
    if (lock.current || !ready || !preview) return;
    const refunds = unpaid ? [] : parsed.filter((row) => row.amountPaise).map((row) => ({ mode: row.mode, amountPaise: row.amountPaise! }));
    const request = { reason, refunds, ...(needsItems ? { lines } : {}) };
    // A retry of the same request replays; a changed request needs its own reference.
    const fingerprint = JSON.stringify({ kind, ...request });
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { clientRef: uuid(), fingerprint };
    lock.current = true; changeBusy(true); setError("");
    try {
      const issued = await apiFetch<{ bill: Bill; creditNote: BillCreditNote; order: Order }>(`/api/bills/${bill.id}/${kind}`, {
        method: "POST", body: JSON.stringify({ clientRef: attempt.current.clientRef, ...request, ...(needsPin ? { approverPin: pin } : {}) }),
      }, { keepSessionOnMessage: PIN_INCORRECT });
      setResult(issued); setPin("");
      onIssued(issued);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const message = e instanceof Error ? e.message : "Request failed";
      if (status === 401) setPin("");
      if (status === 409) { setTick((n) => n + 1); onStale(); }
      setError(status === 429 ? "Too many wrong PIN attempts. Wait a few minutes, then try again." : message);
    } finally { lock.current = false; changeBusy(false); }
  }

  function setRow(id: string, patch: Partial<RefundDraft>) { setRows((all) => all.map((row) => row.id === id ? { ...row, ...patch } : row)); }
  function addRow() {
    if (!preview) return;
    const mode = PAY_MODES.find((m) => preview.refundable[m] > 0 && !rows.some((row) => row.mode === m)) ?? PAY_MODES.find((m) => preview.refundable[m] > 0);
    if (!mode) return;
    const entered = parsed.reduce((sum, row) => sum + (row.amountPaise ?? 0), 0);
    setRows((all) => [...all, { id: uuid(), mode, amount: paiseToRupees(Math.max(0, refundTotal - entered)) }]);
  }

  if (result) {
    const note = result.creditNote;
    return <div className="credit-note-result">
      <p className="billing-message" role="status">Credit note CN-{note.cnNo} issued for {money(note.totalPaise)}.{note.refunds.length > 0 && ` Refunded ${note.refunds.map((r) => `${modeLabel(r.mode)} ${money(r.amountPaise)}`).join(" + ")}.`}</p>
      <CreditNoteActions note={note} printers={printers} printerId={printerId} selectable />
      <div className="credit-note-footer"><button type="button" className="primary" onClick={onClose}>Done</button></div>
    </div>;
  }

  return <form className="credit-note-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {error && <p className="billing-error" role="alert">{error}</p>}
    {kind === "void" && unpaid && <p>This cancels the bill and frees the table</p>}
    {kind === "void" && !unpaid && <p>This voids the whole bill and refunds the money still held. Items already refunded are not refunded again.</p>}

    {needsItems && <fieldset disabled={busy}><legend>Items to refund</legend>
      <ul className="credit-note-items">{billable.map((item) => {
        const refunded = bill.refundedQty[item.id] ?? 0;
        const left = refundableQty(item.qty, refunded);
        const value = qty[item.id] ?? 0;
        const set = (next: number) => setQty((all) => ({ ...all, [item.id]: clampRefundQty(next, item.qty, refunded) }));
        return <li key={item.id}>
          <div><strong>{item.name}</strong><span className="muted"> {item.qty} billed · {refunded} refunded{left === 0 ? " · nothing left to refund" : ""}</span></div>
          <div className="credit-note-stepper">
            <button type="button" aria-label={`Fewer ${item.name}`} disabled={value <= 0} onClick={() => set(value - 1)}>−</button>
            <input type="number" inputMode="numeric" min={0} max={left} step={1} aria-label={`Quantity to refund of ${item.name}`} value={value} disabled={left === 0} onChange={(e) => set(Number(e.target.value))} />
            <button type="button" aria-label={`More ${item.name}`} disabled={value >= left} onClick={() => set(value + 1)}>+</button>
            <button type="button" aria-label={`All remaining ${item.name}`} disabled={left === 0 || value === left} onClick={() => set(left)}>All remaining</button>
          </div>
        </li>;
      })}</ul>
    </fieldset>}

    <fieldset disabled={busy}><legend>Reason</legend>
      <div className="credit-note-reasons" role="group" aria-label="Quick reasons">{REFUND_REASONS.map((r) => <button type="button" key={r} aria-pressed={pick === r} onClick={() => setPick(r)}>{r}</button>)}</div>
      <label htmlFor={ids.reason}>{pick && pick !== "Other" ? "Details (optional)" : "Reason (required)"}
        <input id={ids.reason} maxLength={180} value={detail} onChange={(e) => setDetail(e.target.value)} />
      </label>
    </fieldset>

    <section className="credit-note-preview" aria-label="Credit preview" aria-live="polite">
      <h3>Credit note</h3>
      {needsItems && !lines.length && <p className="muted">Choose how many of each item to refund.</p>}
      {loadingPreview && <p role="status">Working out the credit…</p>}
      {previewError && <p className="billing-error" role="alert">{previewError}</p>}
      {preview && preview.key === key && <>
        <ul>{preview.lines.map((line) => <li key={line.orderItemId}><span>{line.qty} × {line.name}</span><span className="pos-money">{money(line.totalPaise)}</span></li>)}</ul>
        <dl className="pos-totals">
          <dt>Taxable value</dt><dd>{money(preview.totals.taxablePaise)}</dd>
          <dt>CGST</dt><dd>{money(preview.totals.cgstPaise)}</dd>
          <dt>SGST</dt><dd>{money(preview.totals.sgstPaise)}</dd>
          <dt>Round off</dt><dd>{money(preview.totals.roundingPaise)}</dd>
          <dt>Credit total</dt><dd><strong>{money(preview.totals.totalPaise)}</strong></dd>
        </dl>
      </>}
    </section>

    {preview && !unpaid && refundTotal > 0 && <fieldset disabled={busy} className="credit-note-refunds"><legend>Refund to guest</legend>
      {rows.map((row, index) => <div key={row.id} className="credit-note-refund-row">
        <label>Method {index + 1}<select value={row.mode} onChange={(e) => setRow(row.id, { mode: e.target.value as PayMode })}>{PAY_MODES.map((m) => <option key={m} value={m}>{modeLabel(m)} (up to {money(preview.refundable[m])})</option>)}</select></label>
        <label>Amount {index + 1} (₹)<input type="number" min="0.01" step="0.01" value={row.amount} onChange={(e) => setRow(row.id, { amount: e.target.value })} /></label>
        <button type="button" aria-label={`Remove refund method ${index + 1}`} onClick={() => setRows((all) => all.filter((r) => r.id !== row.id))}>Remove</button>
      </div>)}
      <button type="button" disabled={rows.length >= PAY_MODES.length} onClick={addRow}>Add refund method</button>
      <p className="billing-remaining">To refund: {money(refundTotal)}</p>
      {rowsError && <p className="billing-error" role="alert">{rowsError}</p>}
    </fieldset>}

    {needsPin && <fieldset disabled={busy}><legend>Admin approval</legend>
      <label htmlFor={ids.pin}>Admin PIN<input id={ids.pin} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} /></label>
      <p className="muted">An admin must approve this {kind === "void" ? "void" : "refund"}.</p>
    </fieldset>}

    <div className="credit-note-footer">
      <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="submit" className="primary" disabled={!ready || busy}>{confirmLabel}</button>
    </div>
  </form>;
}
