import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { Order } from "../types";
import { WorkspaceDialog } from "../WorkspaceDialog";
import { paiseToRupees } from "../money";
import { transferableItems } from "../table-order-summary";
import { orderLabel } from "./TableTransferDialogs";

export function TransferItemsDialog({ order, busy, error, onClose, onConfirm }: {
  order: Order; busy: boolean; error: string; onClose: () => void;
  onConfirm: (targetOrderId: string, items: Array<{ id: string; qty: number }>) => void;
}) {
  const [targets, setTargets] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [target, setTarget] = useState("");
  const [selected, setSelected] = useState<Array<{ id: string; qty: number }>>([]);
  useEffect(() => {
    let active = true;
    apiFetch<{ orders: Order[] }>("/api/orders").then((r) => {
      if (active) setTargets(r.orders.filter((o) => o.id !== order.id && o.type === "dine_in" && o.status === "open" && !o.mergedInto));
    }).catch(() => { if (active) setLoadError("Could not load open orders. Close and retry."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [order.id]);
  const items = transferableItems(order);
  const changed = selected.some((s) => !items.some((i) => i.id === s.id && i.qty === s.qty));
  return <WorkspaceDialog open title="Transfer items" busy={busy} onClose={onClose} className="table-summary-dialog">
    <p>Move whole unsent item rows to another open table order. Quantities, prices, notes and holds stay with the items. Combo contents move together.</p>
    <p className="muted">Kitchen and guest QR items stay on their current order. Use Move table or Merge under More for those orders. The source table stays open.</p>
    {(error || loadError) && <p role="alert" className="error-message">{error || loadError}</p>}
    {loading ? <p role="status">Loading open table orders…</p> : !targets.length ? <p>No other open dine-in orders. Open an order on the destination table first.</p> : <form onSubmit={(e) => { e.preventDefault(); onConfirm(target, selected); }}>
      <label>Destination order<select aria-label="Destination order" value={target} required disabled={busy} onChange={(e) => setTarget(e.target.value)}><option value="">Choose a table order</option>{targets.map((o) => <option key={o.id} value={o.id}>{orderLabel(o)} · {o.splitLabel ?? "A"}</option>)}</select></label>
      {!items.length && <p>No unsent items are available to transfer.</p>}
      <fieldset disabled={busy} className="table-transfer-item-list"><legend>Items to transfer</legend>{items.map((item) => <label key={item.id}>
        <input type="checkbox" checked={selected.some((s) => s.id === item.id)} onChange={(e) => setSelected((current) => e.target.checked ? [...current.filter((s) => s.id !== item.id), { id: item.id, qty: item.qty }] : current.filter((s) => s.id !== item.id))} />
        <span>{item.qty} × {item.name}</span><strong>₹{paiseToRupees(item.pricePaise * item.qty)}</strong>
      </label>)}</fieldset>
      {changed && <p role="alert">Selected items changed. Clear their selection and choose them again.</p>}
      <button className="primary" disabled={busy || !target || !selected.length || changed}>Transfer selected items</button>
    </form>}
  </WorkspaceDialog>;
}
