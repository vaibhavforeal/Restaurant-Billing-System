import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch, session, type User } from "../api";
import type { Order, TableInfo } from "../types";
import { connectWs } from "../ws";
import { uuid } from "../uuid";
import { Icon } from "../Icon";
import { paiseToRupees } from "../money";
import { queuedRequests } from "../retry-queue";
import { mergeBlockedReason, mergeRoles } from "../table-transfer";
import { useIntegrations } from "../integrations";
import { userCan } from "../permissions";
import { checkoutBlocker, draftCount, orderSummary, pendingOrderActions } from "../table-order-summary";
import { BillingPanel } from "./BillingPanel";
import { OrderCustomer } from "./OrderCustomer";
import { MergeOrderDialog, MoveTableDialog, orderLabel, type MergeChoice } from "./TableTransferDialogs";

/**
 * The running order of the table selected on the table view: its dishes and total, the customer, moving or merging the
 * table, and billing (discount, print, payment) without opening the order screen. It loads its own copy of the order, so a
 * bill being paid stays on screen after the order leaves the running list.
 */
export function TableOrderPanel({ user, orderId, disabled, onEditItems, onSelectOrder, onClose, onChanged, onBusyChange }: {
  user: User; orderId: string; disabled: boolean;
  onEditItems: (orderId: string) => void;
  /** A merge moved the bill to another order: show that one instead. */
  onSelectOrder: (orderId: string) => void;
  onClose: () => void; onChanged: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [billingBusy, setBillingBusy] = useState(false);
  const [transferDialog, setTransferDialog] = useState<"move" | "merge" | null>(null);
  const [transferError, setTransferError] = useState("");
  const [transferSignal, setTransferSignal] = useState(0);
  const lock = useRef(false), billingLock = useRef(false);
  const transferRefs = useRef(new Map<string, string>());
  const crm = useIntegrations().isEnabled("crm");

  const reload = useCallback(async () => {
    try {
      const result = await apiFetch<{ order: Order }>(`/api/orders/${orderId}`);
      setOrder(result.order); setError("");
    } catch (e) {
      // A removed order (merged away, cancelled elsewhere) closes the panel; anything else keeps the last copy.
      if (e instanceof ApiError && e.status === 404) onClose();
      else setError(e instanceof Error ? e.message : "Could not load the order");
    }
  }, [orderId, onClose]);

  useEffect(() => {
    setOrder(null); setMessage(""); setError(""); setTransferDialog(null);
    void reload();
    const dispose = connectWs({
      onEvent: (event) => { if ((event === "order.updated" || event === "table.changed") && !billingLock.current) void reload(); },
      onStatus: (connected) => { if (connected) void reload(); },
      onAuthFail: () => session.clear(),
    });
    return dispose;
  }, [reload]);

  useEffect(() => { onBusyChange(pending || billingBusy); }, [pending, billingBusy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  const locked = disabled || pending || billingBusy;

  /** One lock and one client reference per intent; a retry of the same intent reuses its reference. */
  async function transfer(intent: string, request: (clientRef: string) => Promise<void>) {
    if (lock.current || billingLock.current) return;
    lock.current = true; setPending(true); setMessage(""); setTransferError("");
    const clientRef = transferRefs.current.get(intent) ?? uuid();
    transferRefs.current.set(intent, clientRef);
    try {
      await request(clientRef);
      transferRefs.current.delete(intent);
      onChanged();
    } catch (e) {
      if (e instanceof ApiError) transferRefs.current.delete(intent);
      setTransferError(e instanceof Error ? e.message : "Request failed");
      setTransferSignal((v) => v + 1);
      await reload();
    } finally { lock.current = false; setPending(false); }
  }

  const printNote = (printErrors: string[]) => printErrors.length ? `. Not printed: ${printErrors.join("; ")}` : "";

  function moveTable(table: TableInfo) {
    if (!order) return;
    const kitchenInformed = order.kots.some((kot) => !kot.doneAt);
    void transfer(`move:${order.id}:${table.id}`, async (clientRef) => {
      const result = await apiFetch<{ order: Order; printErrors: string[] }>(`/api/orders/${order.id}/move`, { method: "POST", body: JSON.stringify({ clientRef, tableId: table.id }) });
      setOrder(result.order); setTransferDialog(null);
      setMessage(`Moved to ${table.name}${kitchenInformed ? " · kitchen notified" : ""}${printNote(result.printErrors)}`);
    });
  }

  function mergeOrders(choice: MergeChoice) {
    if (!order) return;
    const { keepsBill, foldedIn } = mergeRoles(order.id, choice);
    const blocked = mergeBlockedReason({ foldedDraftCount: draftCount(user.id, foldedIn), foldedQueuedCount: queuedRequests(user.id).filter((r) => r.lane === foldedIn).length });
    if (blocked) { setTransferError(blocked); return; }
    void transfer(`merge:${foldedIn}:${keepsBill}`, async (clientRef) => {
      const result = await apiFetch<{ order: Order; printErrors: string[] }>(`/api/orders/${foldedIn}/merge`, { method: "POST", body: JSON.stringify({ clientRef, targetOrderId: keepsBill }) });
      setTransferDialog(null);
      setMessage(`Merged · ${orderLabel(result.order)} billed together${printNote(result.printErrors)}`);
      if (keepsBill === order.id) setOrder(result.order); else onSelectOrder(keepsBill);
    });
  }

  function close() { if (!lock.current && !billingLock.current) onClose(); }

  if (!order) {
    return <aside className="tables-parcels table-order-panel" aria-label="Selected table">
      <div className="panel-title"><h3>Loading order…</h3><button type="button" className="table-order-close" aria-label="Close order summary" onClick={close}><span aria-hidden="true">×</span></button></div>
      {error && <p className="error-message" role="alert">{error}</p>}
    </aside>;
  }

  const summary = orderSummary(order);
  const blocker = checkoutBlocker({ draftCount: draftCount(user.id, order.id), queuedCount: pendingOrderActions(queuedRequests(user.id), order.id), heldCount: summary.heldCount });
  const open = order.status === "open", dineIn = order.type === "dine_in";
  const canBill = userCan(user, "bills.create");
  // Only an open order still being taken can need finishing first. Billing's own requests are not counted, so issuing a
  // bill (which passes through the saved-actions queue) never blocks its own payment.
  const checkoutBlocked = !!blocker && open;

  return <aside className="tables-parcels table-order-panel" aria-label={`Order on ${orderLabel(order)}`}>
    <div className="panel-title">
      <div className="table-order-heading"><h3>{orderLabel(order)}</h3><span>{summary.itemCount} {summary.itemCount === 1 ? "item" : "items"}{order.captainName ? ` · Captain: ${order.captainName}` : ""}</span></div>
      <button type="button" className="table-order-close" aria-label="Close order summary" title="Back to reservations (Esc)" disabled={pending || billingBusy} onClick={close}><span aria-hidden="true">×</span></button>
    </div>
    <div className="table-order-actions">
      <button type="button" className="table-order-edit" disabled={locked} onClick={() => onEditItems(order.id)}><Icon name="arrow" size={14} />Edit items</button>
      {dineIn && open && <button type="button" disabled={locked} onClick={() => { setTransferError(""); setTransferDialog("move"); }}>Move table</button>}
      {dineIn && open && <button type="button" disabled={locked} onClick={() => { setTransferError(""); setTransferDialog("merge"); }}>Merge</button>}
    </div>
    <div className="table-order-body" role="region" aria-label="Dishes on this order" tabIndex={0}>
      {message && <p className="table-order-message" role="status">{message}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {crm && <OrderCustomer order={order} canAdd={userCan(user, "customers.manage")} disabled={locked || !open} onSaved={(saved) => { setOrder(saved); setMessage(saved.customer ? `Customer: ${saved.customer.name}` : "Customer removed."); }} />}
      {summary.lines.length === 0 ? <p className="reservation-panel-empty">No dishes on this order yet.</p>
        : <ul className="table-order-lines">{summary.lines.map((item) => <li key={item.id}>
          <span>{item.qty} × {item.name}{item.held && item.status === "pending" && <small className="status held">held</small>}</span>
          <span className="pos-money">₹{paiseToRupees(item.pricePaise * item.qty)}</span>
        </li>)}</ul>}
    </div>
    <div className="table-order-total"><span>Bill<small>{summary.itemCount} {summary.itemCount === 1 ? "item" : "items"} · before tax and discount</small></span><strong className="pos-money">₹{paiseToRupees(summary.subtotalPaise)}</strong></div>
    {canBill && checkoutBlocked && <p className="table-order-blocker">{blocker}</p>}
    {/* Always mounted, only disabled when blocked: unmounting it would close its dialog and lose a bill in progress. */}
    {canBill && <BillingPanel role={user.role} order={order} hasDraft={false} onChanged={async () => { await reload(); onChanged(); }} disabled={disabled || pending || checkoutBlocked}
      onGoToTables={dineIn ? () => { onChanged(); onClose(); } : undefined} onClosed={() => { onChanged(); onClose(); }}
      onBusyChange={(value) => { billingLock.current = value; setBillingBusy(value); }} />}
    <MoveTableDialog open={transferDialog === "move" && open} order={order} busy={locked} error={transferError} refreshSignal={transferSignal}
      onClose={() => { if (!lock.current) setTransferDialog(null); }} onConfirm={moveTable} />
    <MergeOrderDialog open={transferDialog === "merge" && open} order={order} busy={locked} error={transferError} refreshSignal={transferSignal}
      onClose={() => { if (!lock.current) setTransferDialog(null); }} onConfirm={mergeOrders} />
  </aside>;
}
