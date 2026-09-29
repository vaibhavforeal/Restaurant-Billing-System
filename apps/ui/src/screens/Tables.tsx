import { useEffect, useState } from "react";
import { ApiError, apiFetch, session, type User } from "../api";
import type { Order, TableInfo } from "../types";
import { connectWs } from "../ws";
import { uuid } from "../uuid";
import { Icon } from "../Icon";

export function Tables({ user, onOpenOrder }: { user: User; onOpenOrder: (orderId: string) => void }) {
  const [filter, setFilter] = useState<"all" | TableInfo["status"]>("all");
  const [search, setSearch] = useState("");
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [managing, setManaging] = useState(false);
  const [newTable, setNewTable] = useState({ name: "", area: "" });
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [pickerTableId, setPickerTableId] = useState<string | null>(null);

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
        if (event === "table.changed" || event === "order.updated") void reload().catch(() => {});
      },
      onStatus: (connected) => { if (connected) void reload().catch(() => {}); },
      onAuthFail: () => session.clear(),
    });
    return dispose;
  }, []);

  async function run(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed");
    }
  }

  function addTable() {
    const name = newTable.name.trim();
    if (!name) return;
    const maxSort = Math.max(0, ...tables.map((t) => t.sortOrder));
    void run(async () => {
      await apiFetch("/api/tables", {
        method: "POST",
        body: JSON.stringify({ name, area: newTable.area.trim() || null, sortOrder: maxSort + 1 }),
      });
      setNewTable({ name: "", area: "" });
    });
  }

  function patchTable(id: string, patch: Partial<Pick<TableInfo, "name" | "area" | "sortOrder" | "isActive">>) {
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
    if (table.activeOrders.length === 0) {
      // Free table: create split A
      if (creating) return;
      setCreating(true);
      void run(async () => {
        try {
          const { order } = await apiFetch<{ order: Order }>("/api/orders", {
            method: "POST",
            body: JSON.stringify({ clientRef: uuid(), type: "dine_in", tableId: table.id }),
          });
          onOpenOrder(order.id);
        } finally {
          setCreating(false);
        }
      });
    } else if (table.activeOrders.length === 1) {
      // Fast path: one split, open directly
      onOpenOrder(table.activeOrders[0]!.id);
    } else {
      // Multiple splits: show picker
      setPickerTableId(table.id);
    }
  }

  function createSplitOnTable(tableId: string) {
    if (creating) return;
    setCreating(true);
    void run(async () => {
      try {
        const { order } = await apiFetch<{ order: Order }>("/api/orders", {
          method: "POST",
          body: JSON.stringify({ clientRef: uuid(), type: "dine_in", tableId }),
        });
        setPickerTableId(null); // close picker
        onOpenOrder(order.id);
      } finally {
        setCreating(false);
      }
    });
  }

  function newParcel() {
    if (creating) return;
    setCreating(true);
    void run(async () => {
      try {
        const { order } = await apiFetch<{ order: Order }>("/api/orders", {
          method: "POST",
          body: JSON.stringify({ clientRef: uuid(), type: "parcel", tableId: null }),
        });
        onOpenOrder(order.id);
      } finally {
        setCreating(false);
      }
    });
  }

  // Clear picker if the target table's splits drop below 2 (e.g., remote settle/cancel)
  useEffect(() => {
    if (pickerTableId === null) return;
    const table = tables.find((t) => t.id === pickerTableId);
    if (!table || table.activeOrders.length < 2) {
      setPickerTableId(null);
    }
  }, [tables, pickerTableId]);

  const grouped = new Map<string, TableInfo[]>();
  for (const t of tables) {
    const area = t.area ?? "Main";
    const list = grouped.get(area) ?? [];
    list.push(t);
    grouped.set(area, list);
  }

  const openParcels = orders.filter((o) => o.type === "parcel");

  const isAdmin = user.role === "admin";

  const active = tables.filter((table) => table.isActive);
  const visible = active.filter((table) => (filter === "all" || table.status === filter) && `${table.name} ${table.area ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()));
  return <section className="screen">
    <div className="page-header"><div><h2>Tables & orders</h2></div><div className="actions">
      {isAdmin && <button onClick={() => setManaging(!managing)}>{managing ? "Done managing" : "Manage tables"}</button>}
      <button className="primary button-icon" onClick={newParcel} disabled={creating}><Icon name="plus" size={17} />New parcel</button>
    </div></div>
    <div className="error-message" role="alert">{error}</div>
    {managing && isAdmin ? <div className="panel">
      <h3>Add table</h3><div className="actions"><input aria-label="Table name" placeholder="Table name" value={newTable.name} onChange={(e) => setNewTable({ ...newTable, name: e.target.value })} /><input aria-label="Area" placeholder="Area (optional)" value={newTable.area} onChange={(e) => setNewTable({ ...newTable, area: e.target.value })} /><button className="primary" onClick={addTable}>Add</button></div>
      <h3 style={{ marginTop: 26 }}>All tables</h3>
      <ul style={{ listStyle: "none", padding: 0 }}>{tables.map((t) => <li key={t.id} className="actions" style={{ padding: "12px 0", borderBottom: "1px solid var(--line)", opacity: t.isActive ? 1 : .5 }}>
        <span style={{ flex: 1 }}>{t.name} {t.area && <small className="muted">· {t.area}</small>}</span>
        <button onClick={() => move(t, -1)} title="Move up" aria-label={`Move ${t.name} up`}>▲</button><button onClick={() => move(t, 1)} title="Move down" aria-label={`Move ${t.name} down`}>▼</button><button onClick={() => rename(t)} title="Rename">Rename</button><button onClick={() => patchTable(t.id, { isActive: !t.isActive })}>{t.isActive ? "Deactivate" : "Activate"}</button>
      </li>)}</ul>
    </div> : <>
      <div className="filter-bar"><div className="tabs" aria-label="Table status">
        {(["all", "free", "occupied", "billed"] as const).map((status) => <button key={status} className={filter === status ? "selected" : ""} aria-pressed={filter === status} onClick={() => setFilter(status)}>{({ all: "All tables", free: "Available", occupied: "Occupied", billed: "Billed" })[status]}<span className="count">{status === "all" ? active.length : active.filter((t) => t.status === status).length}</span></button>)}
      </div><div className="search-field"><Icon name="search" size={16} /><input aria-label="Search tables" placeholder="Find a table or area…" value={search} onChange={(e) => setSearch(e.target.value)} /></div></div>
      {Array.from(grouped.entries()).filter(([,list]) => list.some((t) => visible.includes(t))).map(([area, list]) => <section className="table-area" key={area}>
        <h3>{area}<span>{list.filter((t) => visible.includes(t)).length} tables</span></h3>
        <div className="table-grid">{list.filter((t) => visible.includes(t)).map((t) => <button key={t.id} className={`table-card ${t.status}`} onClick={() => openTable(t)} disabled={t.status === "free" && creating}>
          <div className="table-card-header"><Icon name="tables" size={20} /><span className={`status ${t.status}`}>{t.status === "free" ? "Available" : t.status}</span></div>
          <strong>{t.name}</strong><div className="table-card-footer"><span>{t.activeOrders.length ? `${t.activeOrders.length} active ${t.activeOrders.length === 1 ? "order" : "splits"}` : ""}</span><Icon name="arrow" size={15} /></div>
        </button>)}</div>
        {pickerTableId && list.some((t) => t.id === pickerTableId) && <div className="panel split-picker"><h3>{list.find((t) => t.id === pickerTableId)?.name} — splits</h3><div className="actions">
          {list.find((t) => t.id === pickerTableId)?.activeOrders.map((o) => <button key={o.id} onClick={() => { setPickerTableId(null); onOpenOrder(o.id); }}>Split {o.splitLabel ?? "?"}{o.status === "billed" ? " (billed)" : ""}</button>)}
          <button className="primary" onClick={() => createSplitOnTable(pickerTableId)} disabled={creating}>New split</button><button onClick={() => setPickerTableId(null)}>Close</button>
        </div></div>}
      </section>)}
      {visible.length === 0 && <div className="panel empty-state"><Icon name="tables" size={34} /><h3>{active.length ? "No tables match this view" : "No tables yet"}</h3><p>{active.length ? "Try another status or search." : isAdmin ? "Add tables using Manage tables." : "Ask an admin to add tables."}</p></div>}
      {openParcels.length > 0 && <section className="panel" style={{ marginTop: 28 }}><div className="panel-title"><h3>Open parcels</h3><span>{openParcels.length} orders</span></div><div className="parcel-grid">
        {openParcels.map((o) => <button key={o.id} onClick={() => onOpenOrder(o.id)}><Icon name="bag" size={18} />Parcel {o.clientRef.slice(0, 8)}</button>)}
      </div></section>}
    </>}
  </section>;
}
