import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch, session, type User } from "../api";
import type { Order, TableInfo } from "../types";
import { connectWs } from "../ws";
import { uuid } from "../uuid";
import { Icon } from "../Icon";
import { paiseToRupees } from "../money";
import { useNavigationGuard } from "../navigation-guard";
import { receivingLabel, tableCardNote, tableOpenTargets } from "../table-transfer";
import { QrRequests, QrTableManager } from "./QrRequests";
import { ServiceRequests } from "./ServiceRequests";
import { Reservations } from "./Reservations";
import { WorkspaceDialog } from "../WorkspaceDialog";
import { useShortcutLabels } from "../pos-shortcuts";
import { useIntegrations } from "../integrations";
import { zomatoOrders } from "../zomato-desk";
import { ZomatoPanel } from "../ZomatoPanel";
import { NewZomatoOrderDialog } from "../NewZomatoOrderDialog";
import "../tables-screen.css";
import "../tables-overview.css";

export function Tables({ user, qrInbox, onOpenOrder, onTakeaway, captain = false }: { user: User; qrInbox?: number | undefined; onOpenOrder: (orderId: string) => void; onTakeaway: () => void; captain?: boolean }) {
  const { shortcut, shortcutProps } = useShortcutLabels();
  const [filter, setFilter] = useState<"all" | TableInfo["status"]>("all");
  const [search, setSearch] = useState("");
  const [areaFilter, setAreaFilter] = useState("");
  const [mobilePane, setMobilePane] = useState<"tables" | "parcels" | "zomato">("tables");
  const { isEnabled } = useIntegrations();
  const [zomatoDialog, setZomatoDialog] = useState(false);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [managing, setManaging] = useState(false);
  const [managingQr, setManagingQr] = useState(false);
  const [qrBusy, setQrBusy] = useState(false);
  const [qrManagerBusy, setQrManagerBusy] = useState(false);
  const [serviceBusy, setServiceBusy] = useState(false);
  const [reservationView, setReservationView] = useState<{ tableId: string | null } | null>(null);
  const [reservationBusy, setReservationBusy] = useState(false);
  const [reservationDirty, setReservationDirty] = useState(false);
  const reservationLock = useRef(false), reservationDirtyLock = useRef(false);
  const onReservationBusy = useCallback((value: boolean) => { reservationLock.current = value; setReservationBusy(value); }, []);
  const onReservationDirty = useCallback((value: boolean) => { reservationDirtyLock.current = value; setReservationDirty(value); }, []);
  const qrLock = useRef(false);
  const qrManagerLock = useRef(false);
  const serviceLock = useRef(false);
  const [newTable, setNewTable] = useState<{ name: string; area: string; priceTier: "non_ac" | "ac" }>({ name: "", area: "", priceTier: "non_ac" });
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const actionLock = useRef(false);
  const [pickerTableId, setPickerTableId] = useState<string | null>(null);

  useNavigationGuard(() => {
    if (!actionLock.current && !qrLock.current && !qrManagerLock.current && !serviceLock.current && !reservationLock.current) {
      return !reservationDirtyLock.current || window.confirm("Discard the unsaved reservation changes?");
    }
    window.alert("Wait for the table request to finish saving before leaving.");
    return false;
  });
  useEffect(() => {
    if (!actionBusy && !qrBusy && !qrManagerBusy && !serviceBusy && !reservationBusy && !reservationDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [actionBusy, qrBusy, qrManagerBusy, serviceBusy, reservationBusy, reservationDirty]);

  function openOrder(orderId: string) {
    if (!qrLock.current && !qrManagerLock.current && !serviceLock.current && !reservationLock.current) onOpenOrder(orderId);
  }

  async function reload() {
    const [t, o] = await Promise.all([
      apiFetch<{ tables: TableInfo[] }>("/api/tables"),
      apiFetch<{ orders: Order[] }>("/api/orders"),
    ]);
    setTables(t.tables);
    setOrders(o.orders);
  }

  useEffect(() => {
    reload().catch(() => setError("Failed to load tables"));
    const dispose = connectWs({
      onEvent: (event) => {
        if (event === "table.changed" || event === "order.updated" || (captain && event === "kot.updated")) void reload().catch(() => {});
      },
      onStatus: (connected) => { if (connected) void reload().catch(() => {}); },
      onAuthFail: () => session.clear(),
    });
    const timer = window.setInterval(() => { void reload().catch(() => {}); }, 30000);
    return () => { dispose(); window.clearInterval(timer); };
  }, [captain]);

  async function run(action: () => Promise<unknown>) {
    if (actionLock.current) return;
    actionLock.current = true; setActionBusy(true);
    setError("");
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed");
    } finally { actionLock.current = false; setActionBusy(false); }
  }

  function addTable() {
    const name = newTable.name.trim();
    if (!name) return;
    const maxSort = Math.max(0, ...tables.map((t) => t.sortOrder));
    void run(async () => {
      await apiFetch("/api/tables", {
        method: "POST",
        body: JSON.stringify({ name, area: newTable.area.trim() || null, priceTier: newTable.priceTier, sortOrder: maxSort + 1 }),
      });
      setNewTable({ name: "", area: "", priceTier: "non_ac" });
    });
  }

  function patchTable(id: string, patch: Partial<Pick<TableInfo, "name" | "area" | "sortOrder" | "isActive" | "priceTier">>) {
    void run(() => apiFetch(`/api/tables/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
  }

  function move(table: TableInfo, dir: -1 | 1) {
    const i = tables.findIndex((t) => t.id === table.id);
    const neighbor = tables[i + dir];
    if (!neighbor) return;
    void run(async () => {
      await apiFetch(`/api/tables/${table.id}`, { method: "PATCH", body: JSON.stringify({ sortOrder: neighbor.sortOrder }) });
      await apiFetch(`/api/tables/${neighbor.id}`, { method: "PATCH", body: JSON.stringify({ sortOrder: table.sortOrder }) });
    });
  }

  function rename(table: TableInfo) {
    const name = window.prompt("Table name", table.name)?.trim();
    if (name && name !== table.name) patchTable(table.id, { name });
  }

  function openTable(table: TableInfo) {
    if (qrLock.current || qrManagerLock.current || serviceLock.current || reservationLock.current) return;
    if (table.status === "reserved") { setReservationView({ tableId: table.id }); return; }
    const targets = tableOpenTargets(table);
    if (targets.length === 0) {
      // Free table: create split A
      if (creating) return;
      setCreating(true);
      void run(async () => {
        try {
          const { order } = await apiFetch<{ order: Order }>("/api/orders", {
            method: "POST",
            body: JSON.stringify({ clientRef: uuid(), type: "dine_in", tableId: table.id }),
          });
          openOrder(order.id);
        } finally {
          setCreating(false);
        }
      });
    } else if (targets.length === 1) {
      // Fast path: one bill (a split, or the combined order of a linked table), open directly
      openOrder(targets[0]!.orderId);
    } else {
      // Multiple splits: show picker
      setPickerTableId(table.id);
    }
  }

  function createSplitOnTable(tableId: string) {
    if (creating || qrLock.current || qrManagerLock.current || serviceLock.current || reservationLock.current) return;
    setCreating(true);
    void run(async () => {
      try {
        const { order } = await apiFetch<{ order: Order }>("/api/orders", {
          method: "POST",
          body: JSON.stringify({ clientRef: uuid(), type: "dine_in", tableId }),
        });
        setPickerTableId(null); // close picker
        openOrder(order.id);
      } finally {
        setCreating(false);
      }
    });
  }

  function newParcel() {
    if (creating || qrLock.current || qrManagerLock.current || serviceLock.current || reservationLock.current) return;
    setCreating(true);
    void run(async () => {
      try {
        const { order } = await apiFetch<{ order: Order }>("/api/orders", {
          method: "POST",
          body: JSON.stringify({ clientRef: uuid(), type: "parcel", tableId: null }),
        });
        openOrder(order.id);
      } finally {
        setCreating(false);
      }
    });
  }

  // Clear picker if the target table's splits drop below 2 (e.g., remote settle/cancel)
  useEffect(() => {
    if (pickerTableId === null) return;
    const table = tables.find((t) => t.id === pickerTableId);
    if (!table || tableOpenTargets(table).length < 2) {
      setPickerTableId(null);
    }
  }, [tables, pickerTableId]);

  const openParcels = orders.filter((o) => o.type === "parcel");
  const isAdmin = !captain && user.role === "admin";
  const canQuickBill = !captain && (isAdmin || user.role === "cashier");
  // Zomato is for admin and cashier. While it is off, orders still open stay visible so they can be finished, but no new ones start.
  const zomatoList = canQuickBill ? zomatoOrders(orders) : [];
  const zomatoOn = canQuickBill && isEnabled("zomato");
  const showZomatoPanel = zomatoOn || zomatoList.length > 0;
  const hasSide = openParcels.length > 0 || showZomatoPanel;
  const busy = creating || actionBusy || qrBusy || qrManagerBusy || serviceBusy || reservationBusy;
  const active = tables.filter((table) => table.isActive);
  const areas = Array.from(new Set(active.map((table) => table.area ?? "Main")));
  const query = search.toLocaleLowerCase().trim();
  const visible = active.filter((table) => (filter === "all" || table.status === filter) && (!areaFilter || (table.area ?? "Main") === areaFilter) && `${table.name} ${table.area ?? ""}`.toLocaleLowerCase().includes(query));
  const grouped = new Map<string, TableInfo[]>();
  for (const table of visible) {
    const area = table.area ?? "Main";
    const list = grouped.get(area) ?? [];
    list.push(table); grouped.set(area, list);
  }
  const pickerTable = tables.find((table) => table.id === pickerTableId);
  const showParcels = mobilePane === "parcels" && openParcels.length > 0;
  const showZomato = mobilePane === "zomato" && showZomatoPanel;
  const visiblePane = showParcels ? "parcels" : showZomato ? "zomato" : "tables";
  return <section className="screen tables-screen table-overview">
    <div className="page-header tables-header"><div className="tables-heading"><h2>{captain ? "Tables" : "Tables & orders"}</h2><p><span className="tables-available-dot" aria-hidden="true" />{active.filter((table) => table.status === "free").length} available <span aria-hidden="true">·</span> {active.length} tables across {areas.length} {areas.length === 1 ? "area" : "areas"}</p></div><div className="actions">
      <button disabled={busy} aria-haspopup="dialog" onClick={() => setReservationView({ tableId: null })}>Reservations</button>
      {isAdmin && <><button disabled={busy} aria-haspopup="dialog" onClick={() => setManagingQr(true)}>Table QR codes</button><button disabled={busy} aria-haspopup="dialog" onClick={() => setManaging(true)}>Manage tables</button></>}
      <button className="primary button-icon" {...shortcutProps("takeaway")} title={shortcut("takeaway", "Takeaway")} onClick={() => {
        if (busy || actionLock.current || qrLock.current || qrManagerLock.current || serviceLock.current || reservationLock.current) return;
        if (canQuickBill) onTakeaway(); else newParcel();
      }} disabled={busy}><Icon name="bag" size={15} />{shortcut("takeaway", "Takeaway")}</button>
    </div></div>
    <div className="error-message" role="alert">{error}</div>
    <div className="tables-request-strip">
      <QrRequests compact openSignal={qrInbox} tables={tables} disabled={creating || actionBusy || qrManagerBusy || serviceBusy || !!reservationView} onOpenOrder={openOrder} onChanged={() => { void reload().catch(() => setError("Failed to refresh tables")); }} onBusyChange={(value) => { qrLock.current = value; setQrBusy(value); }} />
      <ServiceRequests compact disabled={creating || actionBusy || qrBusy || qrManagerBusy || !!reservationView} onBusyChange={(value) => { serviceLock.current = value; setServiceBusy(value); }} />
    </div>
    {hasSide && <div className="tables-pane-switch" aria-label="Tables view">
      <button aria-pressed={visiblePane === "tables"} aria-controls="table-list" onClick={() => setMobilePane("tables")}>Tables · {active.length}</button>
      {openParcels.length > 0 && <button aria-pressed={visiblePane === "parcels"} aria-controls="parcel-list" onClick={() => setMobilePane("parcels")}>Takeaways · {openParcels.length}</button>}
      {showZomatoPanel && <button aria-pressed={visiblePane === "zomato"} aria-controls="zomato-list" onClick={() => setMobilePane("zomato")}>Zomato · {zomatoList.length}</button>}
    </div>}
    <div className="filter-bar tables-filter-bar"><div className="tabs" aria-label="Table status">
        {(["all", "free", "occupied", "reserved", "billed"] as const).map((status) => <button key={status} className={filter === status ? "selected" : ""} aria-pressed={filter === status} onClick={() => setFilter(status)}>{({ all: "All tables", free: "Available", reserved: "Reserved", occupied: "Occupied", billed: "Billed" })[status]}<span className="count">{status === "all" ? active.length : active.filter((t) => t.status === status).length}</span></button>)}
      </div><div className="tables-search-controls"><div className="search-field"><Icon name="search" size={15} /><input aria-label="Search tables" placeholder="Find a table or area…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <select aria-label="Table area" value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)}><option value="">All areas</option>{areaFilter && !areas.includes(areaFilter) && <option value={areaFilter}>{areaFilter}</option>}{areas.map((area) => <option value={area} key={area}>{area}</option>)}</select>
      </div></div>
    <div className={`tables-layout ${hasSide ? "has-parcels" : ""} show-${visiblePane}`}>
      <div className="table-list" id="table-list" role="region" aria-label="Dining tables" tabIndex={0}>
      {Array.from(grouped.entries()).map(([area, list]) => <section className="table-area" key={area}>
        <h3><span className="table-area-name">{area}</span><span>{list.length} {list.length === 1 ? "table" : "tables"}</span><span className="table-area-rule" aria-hidden="true" /></h3>
        <div className="table-grid">{list.map((t) => {
          const running = orders.filter((order) => order.tableId === t.id);
          const subtotal = running.flatMap((order) => order.items).filter((item) => item.status !== "cancelled").reduce((sum, item) => sum + item.pricePaise * item.qty, 0);
          const minutes = running.length ? Math.max(0, Math.floor((Date.now() - Math.min(...running.map((order) => order.openedAt))) / 60000)) : 0;
          const note = tableCardNote(t), combined = receivingLabel(t, tables), targetCount = tableOpenTargets(t).length;
          const ready = captain && running.some((order) => order.kots.some((kot) => kot.doneAt));
          return <button key={t.id} className={`table-card ${t.status}`} onClick={() => openTable(t)} disabled={busy}>
          <div className="table-card-heading"><strong>{combined ?? t.name}</strong><span className="table-price-tier">{t.priceTier === "ac" ? "AC" : "Non-AC"}</span></div>
          <span className="table-state"><span aria-hidden="true" />{({ free: "Available", occupied: "Occupied", reserved: "Reserved", billed: "Billed" })[t.status]}</span>
          <div className="table-card-detail">
            {running.some((o) => o.captainName) && <span className="table-ready-label">Captain: {[...new Set(running.map((o) => o.captainName).filter(Boolean))].join(", ")}</span>}
            {running.length > 0 ? <span className="table-amount-row"><span className="pos-money" title="Items subtotal before billing">₹{paiseToRupees(subtotal)}</span><small><Icon name="clock" size={12} />{minutes} min</small></span>
              : !t.reservation && !t.link && <span className="table-ready-label">Ready for guests</span>}
            {note && <span className="table-ready-label">{note}</span>}
            {t.reservation && <span className="table-reservation-note"><span>{t.status === "reserved" ? "Reserved for" : "Next booking:"} {t.reservation.customerName}</span><small>{t.reservation.startsLocal.replace("T", " ")} · {t.reservation.partySize} guests</small></span>}
          </div>
          <div className="table-card-footer"><span><Icon name="tables" size={16} />{ready ? "Kitchen ready" : targetCount > 1 ? `${targetCount} split bills` : t.status === "billed" ? "Awaiting payment" : targetCount ? "View order" : t.status === "reserved" ? "View reservation" : "Open table"}</span><Icon name={ready ? "check" : "arrow"} size={14} /></div>
        </button>; })}</div>
      </section>)}
      {visible.length === 0 && <div className="panel empty-state"><Icon name="tables" size={34} /><h3>{active.length ? "No tables match this view" : "No tables yet"}</h3><p>{active.length ? "Try another status or search." : isAdmin ? "Add tables using Manage tables." : "Ask an admin to add tables."}</p></div>}
      </div>
      {hasSide && <div className="tables-side">
      {openParcels.length > 0 && <aside className="tables-parcels" aria-label="Open takeaways"><div className="panel-title"><h3>Open takeaways</h3><span>{openParcels.length}</span></div><div className="parcel-list" id="parcel-list" role="region" aria-label="Takeaway orders" tabIndex={0}>
        {openParcels.map((order) => <button key={order.id} disabled={busy} onClick={() => openOrder(order.id)}><span className="takeaway-glyph"><Icon name="bag" size={17} /></span><span className="takeaway-info">Takeaway {order.clientRef.slice(0, 8)}<small>{order.status === "billed" ? "Awaiting payment" : "Open order"}</small><strong className="pos-money">₹{paiseToRupees(order.items.filter((item) => item.status !== "cancelled").reduce((sum, item) => sum + item.pricePaise * item.qty, 0))}</strong></span><Icon name="arrow" size={13} /></button>)}
      </div></aside>}
      {showZomatoPanel && <aside className="tables-parcels tables-zomato" id="zomato-list" aria-label="Zomato orders"><ZomatoPanel orders={zomatoList} canCreate={zomatoOn} disabled={busy} onNew={() => setZomatoDialog(true)} onOpenOrder={openOrder} onChanged={() => { void reload().catch(() => setError("Failed to refresh tables")); }} /></aside>}
      </div>}
    </div>
    {canQuickBill && <NewZomatoOrderDialog open={zomatoDialog} orders={zomatoList} onClose={() => setZomatoDialog(false)} onCreated={(orderId) => { setZomatoDialog(false); openOrder(orderId); }} />}
    {reservationView && <Reservations user={user} tables={tables} initialTableId={reservationView.tableId}
      onClose={() => setReservationView(null)} onOpenOrder={(id) => { setReservationView(null); openOrder(id); }}
      onChanged={() => { void reload().catch(() => setError("Failed to refresh tables")); }}
      onBusyChange={onReservationBusy} onDirtyChange={onReservationDirty} />}
    {isAdmin && <WorkspaceDialog open={managing} title="Manage tables" onClose={() => { if (!busy) setManaging(false); }} busy={busy} className="table-manager-dialog">
      {error && <p className="error-message" role="alert">{error}</p>}
      <form className="table-add-form" onSubmit={(event) => { event.preventDefault(); if (!busy) addTable(); }}>
        <label>Table name<input required disabled={busy} placeholder="e.g. Table 12" value={newTable.name} onChange={(e) => setNewTable({ ...newTable, name: e.target.value })} /></label>
        <label>Pricing<select disabled={busy} value={newTable.priceTier} onChange={(e) => setNewTable({ ...newTable, priceTier: e.target.value as "ac" | "non_ac" })}><option value="non_ac">Non-AC</option><option value="ac">AC</option></select></label>
        <label>Area<input disabled={busy} placeholder="Optional" value={newTable.area} onChange={(e) => setNewTable({ ...newTable, area: e.target.value })} /></label>
        <button className="primary" disabled={busy || !newTable.name.trim()}>Add</button>
      </form>
      <h3>All tables · {tables.length}</h3><ul className="table-manager-list">{tables.map((table, index) => <li key={table.id} className={table.isActive ? "" : "inactive"}>
        <span><strong>{table.name}</strong><small>{table.area ?? "Main"} · {table.priceTier === "ac" ? "AC" : "Non-AC"}{!table.isActive ? " · Inactive" : ""}</small></span>
        <div className="actions"><select aria-label={`Pricing for ${table.name}`} title={table.activeOrders.length ? "Close all orders before changing pricing" : "Table pricing"} disabled={busy || table.activeOrders.length > 0} value={table.priceTier} onChange={(e) => patchTable(table.id, { priceTier: e.target.value as "ac" | "non_ac" })}><option value="non_ac">Non-AC</option><option value="ac">AC</option></select><button disabled={busy || index === 0} onClick={() => move(table, -1)} title="Move up" aria-label={`Move ${table.name} up`}>▲</button><button disabled={busy || index === tables.length - 1} onClick={() => move(table, 1)} title="Move down" aria-label={`Move ${table.name} down`}>▼</button><button disabled={busy} onClick={() => rename(table)} aria-label={`Rename ${table.name}`}>Rename</button><button disabled={busy} onClick={() => patchTable(table.id, { isActive: !table.isActive })} aria-label={`${table.isActive ? "Deactivate" : "Activate"} ${table.name}`}>{table.isActive ? "Deactivate" : "Activate"}</button></div>
      </li>)}</ul>
    </WorkspaceDialog>}
    {isAdmin && <WorkspaceDialog open={managingQr} title="Table QR codes" onClose={() => { if (!busy) setManagingQr(false); }} busy={busy} className="table-qr-dialog">
      {managingQr && <QrTableManager disabled={creating || actionBusy || qrBusy || serviceBusy} onBusyChange={(value) => { qrManagerLock.current = value; setQrManagerBusy(value); }} />}
    </WorkspaceDialog>}
    <WorkspaceDialog open={!!pickerTable} title={`${pickerTable?.name ?? "Table"} — splits`} onClose={() => { if (!busy) setPickerTableId(null); }} busy={busy} className="table-split-dialog">
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="split-options">{pickerTable && tableOpenTargets(pickerTable).map((target) => { const status = pickerTable.activeOrders.find((order) => order.id === target.orderId)?.status ?? pickerTable.link?.status; return <button key={target.orderId} disabled={busy} onClick={() => { setPickerTableId(null); openOrder(target.orderId); }}>{target.label}{status && <span className={`status ${status}`}>{status}</span>}</button>; })}</div>
      <button className="primary" onClick={() => { if (pickerTableId) createSplitOnTable(pickerTableId); }} disabled={busy}>New split</button>
    </WorkspaceDialog>
  </section>;
}
