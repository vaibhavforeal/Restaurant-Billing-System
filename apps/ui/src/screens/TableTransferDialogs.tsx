import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { mergeTargets, moveTargets } from "../table-transfer";
import type { Order, TableInfo } from "../types";
import { WorkspaceDialog } from "../WorkspaceDialog";

export type MergeBillAt = "this" | "other";
export interface MergeChoice { otherOrderId: string; otherLabel: string; billAt: MergeBillAt }

interface DialogProps {
  open: boolean;
  order: Order;
  /** True while any order action is saving; every control is disabled. */
  busy: boolean;
  /** Server message from the last failed attempt (for example a 409 conflict). */
  error: string;
  /** Changes after a conflict so the lists are fetched again. */
  refreshSignal: number;
  onClose: () => void;
}

export const orderLabel = (order: Order) => order.tableLabel ?? order.tableName ?? "Table";

export function MoveTableDialog({ open, order, busy, error, refreshSignal, onClose, onConfirm }: DialogProps & { onConfirm: (table: TableInfo) => void }) {
  return <WorkspaceDialog open={open} title="Move table" className="order-captain-dialog table-transfer-dialog" busy={busy} onClose={onClose}>
    {open && <MoveBody order={order} busy={busy} error={error} refreshSignal={refreshSignal} onClose={onClose} onConfirm={onConfirm} />}
  </WorkspaceDialog>;
}

function MoveBody({ order, busy, error, refreshSignal, onClose, onConfirm }: Omit<DialogProps, "open"> & { onConfirm: (table: TableInfo) => void }) {
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [chosen, setChosen] = useState<TableInfo | null>(null);
  useEffect(() => {
    let current = true;
    setLoadError("");
    apiFetch<{ tables: TableInfo[] }>("/api/tables")
      .then((data) => { if (current) { setTables(data.tables); setChosen(null); } })
      .catch((e) => { if (current) setLoadError(e instanceof Error ? e.message : "Could not load tables"); });
    return () => { current = false; };
  }, [refreshSignal]);
  const targets = tables && order.tableId ? moveTargets(tables, order.tableId, order.id) : [];
  const from = `${orderLabel(order)}-${order.splitLabel ?? "A"}`;
  return <>
    {(error || loadError) && <div className="error-message" role="alert">{error || loadError}</div>}
    {!tables && !loadError && <p role="status">Loading tables…</p>}
    {tables && !chosen && <>
      <p>Move {from} to which table?</p>
      {!targets.length && <p className="muted">No other active tables.</p>}
      <div className="order-captain-options" role="group" aria-label="Tables">
        {targets.map(({ table, selectable, note }) => <button type="button" key={table.id} disabled={busy || !selectable} onClick={() => setChosen(table)}>
          <span>{table.name}{table.area ? ` · ${table.area}` : ""}</span>{note && <span className="muted">{note}</span>}
        </button>)}
      </div>
      <div className="table-transfer-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button></div>
    </>}
    {chosen && <>
      <p>Move {from} to {chosen.name}?</p>
      <p className="muted">Items keep their prices. New items use the prices of {chosen.name}, and the kitchen is told about the new table.</p>
      <div className="table-transfer-actions">
        <button type="button" disabled={busy} onClick={() => setChosen(null)}>Back</button>
        <button type="button" className="primary" disabled={busy} onClick={() => onConfirm(chosen)}>{busy ? "Moving…" : "Move"}</button>
      </div>
    </>}
  </>;
}

export function MergeOrderDialog({ open, order, busy, error, refreshSignal, onClose, onConfirm }: DialogProps & { onConfirm: (choice: MergeChoice) => void }) {
  return <WorkspaceDialog open={open} title="Merge bills" className="order-captain-dialog table-transfer-dialog" busy={busy} onClose={onClose}>
    {open && <MergeBody order={order} busy={busy} error={error} refreshSignal={refreshSignal} onClose={onClose} onConfirm={onConfirm} />}
  </WorkspaceDialog>;
}

function MergeBody({ order, busy, error, refreshSignal, onClose, onConfirm }: Omit<DialogProps, "open"> & { onConfirm: (choice: MergeChoice) => void }) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [chosen, setChosen] = useState<{ orderId: string; label: string } | null>(null);
  const [billAt, setBillAt] = useState<MergeBillAt>("this");
  useEffect(() => {
    let current = true;
    setLoadError("");
    apiFetch<{ orders: Order[] }>("/api/orders")
      .then((data) => { if (current) { setOrders(data.orders); setChosen(null); } })
      .catch((e) => { if (current) setLoadError(e instanceof Error ? e.message : "Could not load orders"); });
    return () => { current = false; };
  }, [refreshSignal]);
  const groups = orders ? mergeTargets(orders, order.id) : [];
  const thisLabel = orderLabel(order);
  const other = chosen && orders?.find((o) => o.id === chosen.orderId);
  const group = chosen && groups.find((g) => g.options.some((o) => o.orderId === chosen.orderId));
  // Two bills at the same table need the split letter to tell them apart.
  const otherLabel = other && group ? (group.tableLabel === thisLabel ? `${group.tableLabel} (${other.splitLabel ?? "A"})` : group.tableLabel) : "";
  return <>
    {(error || loadError) && <div className="error-message" role="alert">{error || loadError}</div>}
    {!orders && !loadError && <p role="status">Loading open bills…</p>}
    {orders && !chosen && <>
      <p>Merge {thisLabel}-{order.splitLabel ?? "A"} with which bill?</p>
      {!groups.length && <p className="muted">There are no other open bills to merge with.</p>}
      {groups.map((g) => <div key={g.tableLabel} className="table-transfer-group" role="group" aria-label={g.tableLabel}>
        <h3>{g.tableLabel}</h3>
        <div className="order-captain-options">
          {g.options.map((option) => <button type="button" key={option.orderId} disabled={busy} onClick={() => { setBillAt("this"); setChosen(option); }}><span>{option.label}</span></button>)}
        </div>
      </div>)}
      <div className="table-transfer-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button></div>
    </>}
    {chosen && other && <>
      <p>Merge with {chosen.label}. Where should the combined bill go?</p>
      <div className="order-captain-options" role="group" aria-label="Where to bill">
        <button type="button" disabled={busy} aria-pressed={billAt === "this"} onClick={() => setBillAt("this")}><span>Bill at {thisLabel} (this order)</span></button>
        <button type="button" disabled={busy} aria-pressed={billAt === "other"} onClick={() => setBillAt("other")}><span>Bill at {otherLabel}</span></button>
      </div>
      <p className="muted">The other table stays linked until payment, and new items use the receiving table's prices.</p>
      <div className="table-transfer-actions">
        <button type="button" disabled={busy} onClick={() => setChosen(null)}>Back</button>
        <button type="button" className="primary" disabled={busy} onClick={() => onConfirm({ otherOrderId: other.id, otherLabel, billAt })}>{busy ? "Merging…" : "Merge"}</button>
      </div>
    </>}
  </>;
}
