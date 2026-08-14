import { useEffect, useState } from "react";
import { ApiError, apiFetch, type User } from "../api";
import type { Order, TableInfo } from "../types";
import { connectWs } from "../ws";
import { uuid } from "../uuid";

export function Tables({ user, onOpenOrder }: { user: User; onOpenOrder: (orderId: string) => void }) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [managing, setManaging] = useState(false);
  const [newTable, setNewTable] = useState({ name: "", area: "" });
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

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
        if (event === "table.changed" || event === "order.updated") void reload();
      },
      onStatus: (connected) => { if (connected) void reload(); },
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
    if (table.status === "occupied" || table.status === "billed") {
      onOpenOrder(table.openOrderId!);
    } else {
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
    }
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

  const grouped = new Map<string, TableInfo[]>();
  for (const t of tables) {
    const area = t.area ?? "Main";
    const list = grouped.get(area) ?? [];
    list.push(t);
    grouped.set(area, list);
  }

  const openParcels = orders.filter((o) => o.type === "parcel");

  const isAdmin = user.role === "admin";

  return (
    <div style={{ padding: 16, fontFamily: "system-ui" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2>Tables</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={newParcel} disabled={creating} style={{ padding: "8px 16px", fontWeight: 700 }}>
            New parcel
          </button>
          {isAdmin && (
            <button onClick={() => setManaging(!managing)} style={{ padding: "8px 16px" }}>
              {managing ? "Done managing" : "Manage tables"}
            </button>
          )}
        </div>
      </div>

      <div style={{ color: "crimson", minHeight: 20 }}>{error}</div>

      {managing && isAdmin && (
        <div style={{ marginBottom: 24, padding: 16, border: "1px solid #ddd", borderRadius: 4 }}>
          <h3>Add table</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="Table name" value={newTable.name} onChange={(e) => setNewTable({ ...newTable, name: e.target.value })} />
            <input placeholder="Area (optional)" value={newTable.area} onChange={(e) => setNewTable({ ...newTable, area: e.target.value })} />
            <button onClick={addTable}>Add</button>
          </div>
          <h3 style={{ marginTop: 16 }}>All tables</h3>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {tables.map((t) => (
              <li key={t.id} style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0", opacity: t.isActive ? 1 : 0.45 }}>
                <span style={{ flex: 1 }}>
                  {t.name} {t.area && `(${t.area})`}
                </span>
                <button onClick={() => move(t, -1)} title="Move up">
                  ▲
                </button>
                <button onClick={() => move(t, 1)} title="Move down">
                  ▼
                </button>
                <button onClick={() => rename(t)} title="Rename">
                  ✎
                </button>
                <button onClick={() => patchTable(t.id, { isActive: !t.isActive })} title={t.isActive ? "Deactivate" : "Activate"}>
                  {t.isActive ? "⏸" : "▶"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!managing && (
        <>
          {Array.from(grouped.entries()).map(([area, list]) => (
            <div key={area} style={{ marginBottom: 24 }}>
              <h3>{area}</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 12 }}>
                {list
                  .filter((t) => t.isActive)
                  .map((t) => (
                    <button
                      key={t.id}
                      onClick={() => openTable(t)}
                      disabled={t.status === "free" && creating}
                      style={{
                        padding: 16,
                        fontSize: 16,
                        fontWeight: 700,
                        backgroundColor: t.status === "free" ? "#e0f7e0" : t.status === "occupied" ? "#ffe0b2" : "#ffcccc",
                        border: "1px solid #ccc",
                        borderRadius: 4,
                      }}
                    >
                      {t.name}
                      <div style={{ fontSize: 12, fontWeight: 400, marginTop: 4, textTransform: "capitalize" }}>{t.status}</div>
                    </button>
                  ))}
              </div>
            </div>
          ))}

          {openParcels.length > 0 && (
            <div>
              <h3>Open parcels</h3>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {openParcels.map((o) => (
                  <li key={o.id} style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
                    <button onClick={() => onOpenOrder(o.id)} style={{ fontSize: 16, padding: 8 }}>
                      Parcel {o.clientRef.slice(0, 8)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
