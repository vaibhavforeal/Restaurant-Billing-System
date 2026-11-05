import { useEffect, useRef, useState } from "react";
import { apiFetch, type User } from "../api";
import type { Order, OrderTypeInfo, TableInfo } from "../types";
import { Icon } from "../Icon";
import { WorkspaceDialog } from "../WorkspaceDialog";
import { userCan } from "../permissions";
import { draftCount } from "../table-order-summary";
import { queuedRequests, subscribeQueue } from "../retry-queue";
import { punchItems, type HoldDraftRow } from "../hold-order";
import { OrderCustomer } from "./OrderCustomer";
import { useIntegrations } from "../integrations";
import { PRICE_TIER_LABELS } from "@masalapos/domain/pricing";

type Staff = { id: string; name: string };
type Editor = { kind: "notes" | "type" | "delete"; revision: number } | null;

export function TableSummaryControls({ user, order, disabled, onSaved, onClose, onBusyChange, onRefresh, onHoldOrder, onDeleteOrder }: {
  user: User; order: Order; disabled: boolean;
  onSaved: (order: Order) => void | Promise<void>; onClose: () => void;
  onBusyChange: (busy: boolean) => void; onRefresh: () => Promise<void>;
  onHoldOrder?: () => void;
  onDeleteOrder?: (reason: string) => Promise<void>;
}) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [captains, setCaptains] = useState<Staff[]>([]);
  const [types, setTypes] = useState<OrderTypeInfo[]>([]);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [holdEnabled, setHoldEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<Editor>(null);
  const [notes, setNotes] = useState("");
  const [typeId, setTypeId] = useState(order.orderTypeId);
  const [tableId, setTableId] = useState("");
  const [reason, setReason] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [guests, setGuests] = useState(String(order.guestCount ?? ""));
  const [guestRevision, setGuestRevision] = useState(order.summaryRevision ?? 0);
  const [, refreshQueue] = useState(0);
  const crm = useIntegrations().isEnabled("crm");
  const editable = order.status === "open" && userCan(user, "orders.update");
  const locked = disabled || busy;
  const hasLocal = draftCount(user.id, order.id) > 0;
  const hasQueue = queuedRequests(user.id).some((r) => r.lane === order.id);

  useEffect(() => subscribeQueue(() => refreshQueue((v) => v + 1)), []);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      apiFetch<{ staff: Staff[] }>("/api/order-staff").then((r) => { if (active) setStaff(r.staff); }),
      apiFetch<{ captains: Staff[] }>("/api/captains").then((r) => { if (active) setCaptains(r.captains); }),
      apiFetch<{ orderTypes: OrderTypeInfo[] }>("/api/order-types").then((r) => { if (active) setTypes(r.orderTypes.filter((t) => t.isActive && t.kind !== "aggregator")); }),
      apiFetch<{ holdOrders: boolean }>("/api/order-settings").then((r) => { if (active) setHoldEnabled(r.holdOrders); }),
    ]).then((results) => { if (active && results.some((r) => r.status === "rejected")) setError("Some order controls could not load. Reopen this summary to retry."); });
    return () => { active = false; };
  }, []);

  async function run(action: () => Promise<void>, closeAfter = false) {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(true); onBusyChange(true); setError(""); setMessage("");
    let success = false;
    try { await action(); success = true; }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save the order. Try again."); await onRefresh().catch(() => {}); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
    if (success && closeAfter) onClose();
  }

  async function save(path: string, body: object, success: string) {
    const result = await apiFetch<{ order: Order }>(`/api/orders/${order.id}/${path}`, { method: "PATCH", body: JSON.stringify(body) });
    await onSaved(result.order); setMessage(success); setEditor(null);
  }

  function openEditor(kind: NonNullable<Editor>["kind"]) {
    setError(""); setMessage(""); setNotes(order.notes ?? ""); setTypeId(order.orderTypeId); setReason("");
    setEditor({ kind, revision: order.summaryRevision ?? 0 });
    if (kind === "type") {
      setTables([]); setTableId("");
      void apiFetch<{ tables: TableInfo[] }>("/api/tables").then((r) => setTables(r.tables.filter((t) => t.isActive))).catch(() => setError("Could not load tables. Reopen Order type to retry."));
    }
  }

  async function hold() {
    if (hasQueue) throw new Error("Open Edit items to review this order's saved actions before holding it.");
    const settings = await apiFetch<{ holdOrders: boolean }>("/api/order-settings");
    setHoldEnabled(settings.holdOrders);
    if (!settings.holdOrders) throw new Error("Hold orders is turned off in Settings.");
    const key = `masalapos.draft.${user.id}.${order.id}`, legacy = `masalapos.draft.${order.id}`;
    const draftKey = localStorage.getItem(key) !== null ? key : legacy;
    const rows: HoldDraftRow[] = JSON.parse(localStorage.getItem(draftKey) ?? "[]");
    if (!Array.isArray(rows)) throw new Error("Open Edit items to review this order's cart.");
    if (rows.length) {
      const { order: saved } = await apiFetch<{ order: Order }>(`/api/orders/${order.id}/items`, { method: "POST", body: JSON.stringify({ items: punchItems(rows) }) });
      const refs = new Set(rows.map((r) => r.clientRef));
      const current: HoldDraftRow[] = JSON.parse(localStorage.getItem(draftKey) ?? "[]");
      localStorage.setItem(draftKey, JSON.stringify(current.filter((r) => !refs.has(r.clientRef))));
      onSaved(saved);
    } else {
      const { order: saved } = await apiFetch<{ order: Order }>(`/api/orders/${order.id}`);
      if (saved.status !== "open") throw new Error("This order is no longer open. Refresh it before continuing.");
      onSaved(saved);
    }
  }

  const soldById = order.soldById ?? order.openedBy;
  const typeLabel = types.find((t) => t.id === order.orderTypeId)?.name ?? order.orderTypeName ?? (order.type === "dine_in" ? "Dine In" : "Takeaway");
  const typeBlock = order.kots.length ? "Order type cannot change after a KOT." : hasLocal || hasQueue ? "Finish this order's cart and saved actions before changing type." : null;
  const deleteBlock = order.items.some((i) => i.status === "sent") ? "Cancel sent dishes before deleting this order." : (hasLocal && !onDeleteOrder) || hasQueue ? "Review the cart and saved actions before deleting this order." : null;

  return <div className="table-summary-controls">
    <div className={`table-summary-people${crm ? " with-customer" : ""}`}>
      {crm && <OrderCustomer compact order={order} canAdd={userCan(user, "customers.manage")} disabled={locked || !editable} onSaved={onSaved} onBusyChange={onBusyChange} />}
      <label className="table-summary-sales">Sale By<select aria-label="Sale By" value={soldById} disabled={locked || !editable || !staff.length}
        onChange={(e) => void run(() => save("summary", { soldById: e.target.value, expectedRevision: order.summaryRevision ?? 0 }, "Sales staff saved."))}>
        {!staff.some((s) => s.id === soldById) && <option value={soldById}>{order.soldByName ?? "Assigned staff"}</option>}
        {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select></label>
    </div>
    <div className="table-summary-toolbar" aria-label="Order actions">
      <button type="button" className="table-summary-type" disabled={locked || !editable || !!typeBlock} title={typeBlock ?? "Change order type"} onClick={() => openEditor("type")}><span>{typeLabel}</span><span aria-hidden="true">⌄</span></button>
      <button type="button" disabled={locked || !editable || !!deleteBlock} title={deleteBlock ?? "Cancel this order"} onClick={() => openEditor("delete")}><Icon name="trash" /><span>Delete order</span></button>
      <button type="button" disabled={locked} title={order.notes ? "View or edit order notes" : "Add order notes"} onClick={() => openEditor("notes")}><Icon name="note" /><span>Order notes{order.notes ? " •" : ""}</span></button>
      <button type="button" disabled={locked || !editable || !holdEnabled || hasQueue} title={!holdEnabled ? "Enable Hold orders in Settings" : hasQueue ? "Review saved actions before holding this order." : "Save the order and return to tables"} onClick={onHoldOrder ?? (() => void run(hold, true))}><Icon name="pause" /><span>Hold order</span></button>
    </div>
    {order.type === "dine_in" && <>
      <button type="button" className="table-summary-disclosure" aria-expanded={detailsOpen} aria-controls={`dine-details-${order.id}`} disabled={locked} onClick={() => {
        if (!detailsOpen) { setGuests(String(order.guestCount ?? "")); setGuestRevision(order.summaryRevision ?? 0); }
        setDetailsOpen(!detailsOpen);
      }}><span aria-hidden="true">{detailsOpen ? "−" : "+"}</span> Dine In Details</button>
      {detailsOpen && <div id={`dine-details-${order.id}`} className="table-summary-details">
        <dl><dt>Table</dt><dd>{order.tableLabel ?? order.tableName}{order.splitLabel ? ` · ${order.splitLabel}` : ""}</dd><dt>Opened</dt><dd>{new Date(order.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</dd><dt>Pricing</dt><dd>{PRICE_TIER_LABELS[order.priceTier]}</dd></dl>
        <label>Captain<select aria-label="Captain" value={order.captainId ?? ""} disabled={locked || !editable} onChange={(e) => void run(() => save("captain", { captainId: e.target.value || null, expectedCaptainId: order.captainId ?? null }, "Captain saved."))}>
          <option value="">Unassigned</option>{order.captainId && !captains.some((c) => c.id === order.captainId) && <option value={order.captainId}>{order.captainName}</option>}{captains.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await save("summary", { guestCount: guests ? Number(guests) : null, expectedRevision: guestRevision }, "Guest count saved."); setDetailsOpen(false); }); }}>
          <label>Guests<input type="number" min={1} max={999} step={1} value={guests} disabled={locked || !editable} onChange={(e) => setGuests(e.target.value)} /></label>
          {editable && <button type="submit" disabled={locked}>Save guests</button>}
        </form>
      </div>}
    </>}
    {message && <p className="table-summary-feedback" role="status">{message}</p>}
    {error && !editor && <p className="table-summary-feedback error-message" role="alert">{error}</p>}
    <WorkspaceDialog open={editor !== null} title={editor?.kind === "notes" ? "Order notes" : editor?.kind === "type" ? "Order type" : "Delete order"} busy={locked} onClose={() => setEditor(null)} className="table-summary-dialog">
      {error && <p className="error-message" role="alert">{error}</p>}
      {editor?.kind === "notes" && <form onSubmit={(e) => { e.preventDefault(); void run(() => save("summary", { notes, expectedRevision: editor.revision }, "Order notes saved.")); }}>
        <label>Notes for this order<textarea rows={5} maxLength={1000} value={notes} readOnly={!editable} disabled={locked} onChange={(e) => setNotes(e.target.value)} /></label>
        <p className="muted">For the counter team. Add cooking instructions to individual dishes.</p>
        <small>{notes.length}/1000</small>{editable && <button className="primary" disabled={locked}>Save notes</button>}
      </form>}
      {editor?.kind === "type" && <form onSubmit={(e) => { e.preventDefault(); void run(() => save("service-type", { orderTypeId: typeId, ...(typeId === "dine_in" ? { tableId } : {}), expectedRevision: editor.revision }, "Order type changed.")); }}>
        <label>Order type<select value={typeId} disabled={locked} onChange={(e) => setTypeId(e.target.value)}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        {typeId === "dine_in" && order.type !== "dine_in" && <label>Table<select required value={tableId} disabled={locked} onChange={(e) => setTableId(e.target.value)}><option value="">Choose a table</option>{tables.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.area || "Dining area"}</option>)}</select></label>}
        <p>Existing item prices are kept. New dishes use the selected order type’s prices.{order.type === "dine_in" && typeId !== "dine_in" ? " This order will leave the table and appear under Takeaway." : ""}</p>
        <button className="primary" disabled={locked || typeId === order.orderTypeId || !!typeBlock}>Change type</button>
      </form>}
      {editor?.kind === "delete" && <form onSubmit={(e) => { e.preventDefault(); void run(async () => {
        if (onDeleteOrder) { await onDeleteOrder(reason.trim()); return; }
        const result = await apiFetch<{ order: Order }>(`/api/orders/${order.id}/cancel`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) });
        await onSaved(result.order);
      }, true); }}>
        <p>Cancel this order and its pending dishes? It stays in the order history.</p>
        <label>Reason<textarea required rows={3} maxLength={200} value={reason} disabled={locked} onChange={(e) => setReason(e.target.value)} /></label>
        <button className="danger" disabled={locked || !reason.trim() || !!deleteBlock}>Delete order</button>
      </form>}
    </WorkspaceDialog>
  </div>;
}
