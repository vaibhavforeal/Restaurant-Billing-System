import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch, session, type User } from "../api";
import type { Order, Product, TableInfo } from "../types";
import { connectWs } from "../ws";
import { uuid } from "../uuid";
import { Icon } from "../Icon";
import { paiseToRupees } from "../money";
import { queuedRequests, subscribeQueue } from "../retry-queue";
import { mergeBlockedReason, mergeRoles } from "../table-transfer";
import { userCan } from "../permissions";
import { checkoutBlocker, draftCount, maskedPhone, orderSummary, pendingOrderActions } from "../table-order-summary";
import { BillingPanel } from "./BillingPanel";
import { TableSummaryControls } from "./TableSummaryControls";
import "../table-summary-controls.css";
import { MergeOrderDialog, MoveTableDialog, orderLabel, type MergeChoice } from "./TableTransferDialogs";
import { WorkspaceDialog } from "../WorkspaceDialog";
import { DigitalBillDialog } from "./DigitalBillDialog";
import { TransferItemsDialog } from "./TransferItemsDialog";
import { sendableLines } from "../hold-order";
import "../table-click-summary.css";

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
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [actionDialog, setActionDialog] = useState<"more" | "kot" | "digital" | "items" | null>(null);
  const [billTotal, setBillTotal] = useState<number | null>(null);
  const [, refreshQueue] = useState(0);
  useEffect(() => subscribeQueue(() => refreshQueue((v) => v + 1)), []);
  useEffect(() => {
    let active = true;
    apiFetch<{ products: Product[] }>("/api/products").then((r) => { if (active) setProducts(r.products); }).catch(() => { if (active) setError("Could not load item details. Reopen the summary to retry."); });
    return () => { active = false; };
  }, []);
  const summaryLock = useRef(false);
  const checkout = useRef<() => void>(null);
  const [transferDialog, setTransferDialog] = useState<"move" | "merge" | null>(null);
  const [transferError, setTransferError] = useState("");
  const [transferSignal, setTransferSignal] = useState(0);
  const lock = useRef(false), billingLock = useRef(false);
  const transferRefs = useRef(new Map<string, string>());

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

  useEffect(() => { onBusyChange(pending || billingBusy || summaryBusy); }, [pending, billingBusy, summaryBusy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  const locked = disabled || pending || billingBusy || summaryBusy;

  /** One lock and one client reference per intent; a retry of the same intent reuses its reference. */
  async function transfer(intent: string, request: (clientRef: string) => Promise<void>) {
    if (disabled || lock.current || billingLock.current || summaryLock.current) return;
    lock.current = true; setPending(true); onBusyChange(true); setMessage(""); setTransferError("");
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
    } finally { lock.current = false; setPending(false); onBusyChange(billingLock.current || summaryLock.current); }
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

  function close() { if (!disabled && !lock.current && !billingLock.current && !summaryLock.current) onClose(); }
  function openAction(kind: NonNullable<typeof actionDialog>) { setTransferError(""); setActionDialog(kind); }
  function openCheckout() { setActionDialog(null); checkout.current?.(); }
  function transferItems(targetOrderId: string, items: Array<{ id: string; qty: number }>) {
    if (!order) return;
    if ([order.id, targetOrderId].some((id) => draftCount(user.id, id) || queuedRequests(user.id).some((r) => r.lane === id))) {
      setTransferError("Finish the cart and saved actions on both orders before transferring items."); return;
    }
    void transfer(`items:${order.id}:${targetOrderId}:${JSON.stringify(items)}`, async (clientRef) => {
      const result = await apiFetch<{ order: Order; targetOrder: Order }>(`/api/orders/${order.id}/transfer-items`, { method: "POST", body: JSON.stringify({ clientRef, targetOrderId, items }) });
      setOrder(result.order); setActionDialog(null); setMessage(`Items moved to ${orderLabel(result.targetOrder)} · ${result.targetOrder.splitLabel ?? "A"}. This table remains open.`);
    });
  }

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
  const localPending = draftCount(user.id, order.id) > 0 || pendingOrderActions(queuedRequests(user.id), order.id) > 0;
  const kitchenItems = sendableLines(order.items, products);
  const dietary = new Map(products.map((product) => [product.id, product.isVeg]));
  const detailsBusy = (value: boolean) => { summaryLock.current = value; setSummaryBusy(value); onBusyChange(value || lock.current || billingLock.current); };

  return <aside className="tables-parcels table-order-panel" aria-label={`Order on ${orderLabel(order)}`}>
    <div className="panel-title">
      <div className="table-order-heading"><h3>{orderLabel(order)} <small>| {summary.itemCount} {summary.itemCount === 1 ? "item" : "items"}</small></h3><span>Sale By: {order.soldByName ?? "Unassigned"}</span></div>
      {order.customer && <button type="button" className="table-summary-phone" disabled={locked} onClick={() => openAction("more")} aria-label="Customer details">{maskedPhone(order.customer.phone)}</button>}
      <button type="button" className="table-order-close" aria-label="Close order summary" title="Back to reservations (Esc)" disabled={locked} onClick={close}><span aria-hidden="true">×</span></button>
    </div>
    <div className="table-click-actions" aria-label="Table order actions">
      <button type="button" className="table-order-edit" disabled={locked} onClick={() => onEditItems(order.id)}>Edit items</button>
      <button type="button" disabled={locked || !userCan(user, "kots.read")} onClick={() => openAction("kot")}><Icon name="kitchen" /><span>KOT</span></button>
      <button type="button" disabled={locked || !userCan(user, "bills.read")} onClick={() => openAction("digital")}><Icon name="bills" /><span>Send<br />digital bill</span></button>
      <button type="button" disabled={locked || !open || !dineIn || !userCan(user, "orders.update")} onClick={() => openAction("items")}><Icon name="transfer" /><span>Transfer<br />items</span></button>
      <button type="button" disabled={locked} onClick={() => openAction("more")}><Icon name="more" /><span>More</span></button>
    </div>
    <div className="table-order-body" role="region" aria-label="Dishes on this order" tabIndex={0}>
      {message && <p className="table-order-message" role="status">{message}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {order.notes && <p className="table-order-note"><strong>Order notes</strong>{order.notes}</p>}
      {summary.lines.length === 0 ? <p className="reservation-panel-empty">No dishes on this order yet.</p>
        : <ul className="table-order-lines">{summary.lines.map((item) => {
          const children = order.items.filter((child) => child.parentItemId === item.id && child.status !== "cancelled");
          return <li key={item.id}>
            {dietary.has(item.productId) ? <span className={`table-diet-mark ${dietary.get(item.productId) ? "veg" : "nonveg"}`} role="img" aria-label={dietary.get(item.productId) ? "Vegetarian" : "Non-vegetarian"}><i /></span> : <span />}
            <div className="table-dish-name">{item.name}{item.held && item.status === "pending" && <small className="status held">held</small>}</div>
            <span className="table-dish-qty"><small>QTY:</small> {String(item.qty).padStart(2, "0")}</span>
            <strong className="pos-money">₹{paiseToRupees(item.pricePaise * item.qty)}</strong>
            {(item.note || children.length > 0) && <div className="table-dish-details">{item.note && <small>{item.note}</small>}{children.length > 0 && <details><summary>{children.length} combo {children.length === 1 ? "item" : "items"} · Expand</summary><ul>{children.map((child) => <li key={child.id}>{child.qty} × {child.name}</li>)}</ul></details>}</div>}
          </li>;
        })}</ul>}
    </div>
    <div className="table-order-total"><span className="table-bill-label">Bill</span><div><span>Total number of items <strong>{String(summary.itemCount).padStart(2, "0")}</strong></span><span><b>{billTotal === null ? "Items subtotal" : "Bill amount"}</b><strong className="pos-money">₹{paiseToRupees(billTotal ?? summary.subtotalPaise)}</strong></span>{billTotal === null && <small>Before tax and discount</small>}</div></div>
    {canBill && checkoutBlocked && <p className="table-order-blocker">{blocker}</p>}
    {/* Always mounted, only disabled when blocked: unmounting it would close its dialog and lose a bill in progress. */}
    {canBill && <BillingPanel summaryFooter onTotalChange={setBillTotal} checkoutRef={checkout} role={user.role} order={order} hasDraft={false} onChanged={async () => { await reload(); onChanged(); }} disabled={disabled || pending || summaryBusy || checkoutBlocked}
      onGoToTables={dineIn ? () => { onChanged(); onClose(); } : undefined} onClosed={() => { onChanged(); onClose(); }}
      onBusyChange={(value) => { billingLock.current = value; setBillingBusy(value); }} />}
    <WorkspaceDialog open={actionDialog === "more"} title="Order details" busy={locked} onClose={() => setActionDialog(null)} className="table-summary-dialog">
      {actionDialog === "more" && <>
        <TableSummaryControls user={user} order={order} disabled={locked} onSaved={(saved) => { setOrder(saved); onChanged(); }} onBusyChange={detailsBusy}
          onRefresh={reload} onClose={close} onCheckout={openCheckout} canCheckout={canBill && (open || order.status === "billed") && !checkoutBlocked && summary.lines.length > 0} checkoutHint={checkoutBlocked ? blocker : null} />
        <div className="table-more-actions">{dineIn && open && <><button disabled={locked} onClick={() => { setActionDialog(null); setTransferError(""); setTransferDialog("move"); }}>Move table</button><button disabled={locked} onClick={() => { setActionDialog(null); setTransferError(""); setTransferDialog("merge"); }}>Merge bills</button></>}</div>
      </>}
    </WorkspaceDialog>
    <WorkspaceDialog open={actionDialog === "kot"} title="Kitchen order tickets" busy={locked} onClose={() => setActionDialog(null)} className="table-summary-dialog">
      {transferError && <p className="error-message" role="alert">{transferError}</p>}
      {order.kots.length ? <ul>{order.kots.map((kot) => <li key={kot.id}>KOT #{kot.kotNo} · {kot.doneAt ? "Ready" : kot.acceptedAt ? "Preparing" : "Sent"}</li>)}</ul> : <p>No kitchen tickets yet.</p>}
      {summary.heldCount > 0 && <p>{summary.heldCount} held dishes will stay on hold. Open Edit items to release or fire them.</p>}
      {open && kitchenItems.length > 0 && <button className="primary" disabled={locked || localPending || !userCan(user, "kots.create")} onClick={() => {
        const itemIds = kitchenItems.map((item) => item.id).sort();
        void transfer(`kot:${order.id}:${itemIds.join(",")}`, async (clientRef) => {
          const result = await apiFetch<{ order: Order; kots: unknown[]; printErrors?: string[] }>(`/api/orders/${order.id}/send`, { method: "POST", body: JSON.stringify({ clientRef, itemIds }) });
          setOrder(result.order); setMessage(`Sent to kitchen · ${result.kots.length} ticket(s)${printNote(result.printErrors ?? [])}`); setActionDialog(null);
        });
      }}>Send pending items to kitchen</button>}
      {localPending && <p>Finish the cart and saved actions in Edit items first.</p>}
    </WorkspaceDialog>
    {actionDialog === "items" && <TransferItemsDialog order={order} busy={locked} error={transferError} onClose={() => setActionDialog(null)} onConfirm={transferItems} />}
    {actionDialog === "digital" && <DigitalBillDialog orderId={order.id} onClose={() => setActionDialog(null)} onCheckout={openCheckout} onBusyChange={detailsBusy} />}
    <MoveTableDialog open={transferDialog === "move" && open} order={order} busy={locked} error={transferError} refreshSignal={transferSignal}
      onClose={() => { if (!lock.current) setTransferDialog(null); }} onConfirm={moveTable} />
    <MergeOrderDialog open={transferDialog === "merge" && open} order={order} busy={locked} error={transferError} refreshSignal={transferSignal}
      onClose={() => { if (!lock.current) setTransferDialog(null); }} onConfirm={mergeOrders} />
  </aside>;
}
