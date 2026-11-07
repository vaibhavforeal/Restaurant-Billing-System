import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import type { TableInfo } from "../types";
import { movedTableOrder } from "../table-order";
import { useCan } from "../permissions";
import { useModules } from "../modules";
import { useNavigationGuard } from "../navigation-guard";
import { QrTableManager } from "./QrRequests";
import "../tables-screen.css";
import "../table-settings.css";

export function TableSettings({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const can = useCan();
  const modules = useModules();
  const canManage = can("tables.manage");
  const [view, setView] = useState<"tables" | "qr">("tables");
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newTable, setNewTable] = useState<{ name: string; area: string; priceTier: "non_ac" | "ac" }>({ name: "", area: "", priceTier: "non_ac" });
  const lock = useRef(false);
  function working(value: boolean) { lock.current = value; setBusy(value); onBusyChange(value); }
  useNavigationGuard(() => {
    if (!lock.current) return true;
    window.alert("Wait for the table settings to finish saving before leaving.");
    return false;
  });
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  async function reload() {
    const result = await apiFetch<{ tables: TableInfo[] }>("/api/tables");
    setTables(result.tables);
  }
  useEffect(() => {
    if (!canManage) { setLoading(false); return; }
    let active = true;
    const controller = new AbortController();
    apiFetch<{ tables: TableInfo[] }>("/api/tables", { signal: controller.signal })
      .then(result => { if (active) setTables(result.tables); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Could not load tables."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); onBusyChange(false); };
  }, [canManage, onBusyChange]);
  async function run(action?: () => Promise<unknown>) {
    if (lock.current) return;
    working(true); setError("");
    try { await action?.(); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : "Table settings could not be saved."); }
    finally { working(false); }
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
    const ids = movedTableOrder(tables, table.id, dir);
    if (!ids) return;
    void run(() => apiFetch("/api/tables/order", { method: "PUT", body: JSON.stringify({ ids }) }));
  }

  function rename(table: TableInfo) {
    const name = window.prompt("Table name", table.name)?.trim();
    if (name && name !== table.name) patchTable(table.id, { name });
  }

  if (!canManage) return <p role="status">You need Manage tables permission to change table settings.</p>;
  return <div className="table-settings">
    <div className="tabs" aria-label="Table settings sections">
      <button aria-pressed={view === "tables"} disabled={busy} onClick={() => setView("tables")}>Manage tables</button>
      <button aria-pressed={view === "qr"} disabled={busy} onClick={() => setView("qr")}>Table QR codes</button>
    </div>
    {view === "tables" ? <section aria-label="Manage tables">
      <div className="table-settings-heading"><p>Add tables, change pricing, and arrange their display order.</p><button disabled={busy || loading} onClick={() => void run()}>Refresh</button></div>
      {error && <p role="alert">{error}</p>}
      {loading ? <p role="status">Loading tables…</p> : <>
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
      </>}
    </section> : <section aria-label="Table QR codes">
      {modules.isActive("qrOrdering") ? <QrTableManager disabled={busy} onBusyChange={working} />
        : <p>Enable QR Ordering in Marketplace to manage table QR codes.</p>}
    </section>}
  </div>;
}
