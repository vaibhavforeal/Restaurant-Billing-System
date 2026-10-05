import { useRef, useState } from "react";
import type { StockItem, StockUnit } from "@forkflow/domain";
import { apiFetch } from "../api";
import { uuid } from "../uuid";
import { WorkspaceDialog } from "../WorkspaceDialog";
import { Icon } from "../Icon";

const units: StockUnit[] = ["pcs", "kg", "g", "L", "ml"];
const emptyStock = { name: "", unit: "kg" as StockUnit, opening: "0", threshold: "" };

export function RecipeIngredientPicker({ items, selectedIds, canCreate, onSelect, onCreated, onClose, onBusyChange, onDirtyChange }: {
  items: StockItem[]; selectedIds: string[]; canCreate: boolean;
  onSelect: (item: StockItem) => void; onCreated: (item: StockItem) => void; onClose: () => void;
  onBusyChange: (busy: boolean) => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyStock);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const request = useRef<{ fingerprint: string; ref: string } | null>(null);
  const dirty = creating && (form.name !== "" || form.unit !== "kg" || form.opening !== "0" || form.threshold !== "");
  const available = items.filter((item) => item.isActive && !selectedIds.includes(item.id));
  const visible = available.filter((item) => item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  function update(next: typeof form) {
    setForm(next); onDirtyChange(next.name !== "" || next.unit !== "kg" || next.opening !== "0" || next.threshold !== "");
  }
  function close() {
    if (lock.current) return;
    if (dirty && !window.confirm("Discard this unsaved stock item? Your recipe draft will be kept.")) return;
    onDirtyChange(false); onClose();
  }
  async function create() {
    if (lock.current || !canCreate) return;
    lock.current = true; setBusy(true); onBusyChange(true); setError("");
    try {
      const openingQty = Number(form.opening), threshold = form.threshold.trim() ? Number(form.threshold) : null;
      if (!form.name.trim() || !form.opening.trim() || !Number.isFinite(openingQty) || (threshold !== null && !Number.isFinite(threshold))) throw new Error("Enter a name and valid stock quantities.");
      const body = { name: form.name.trim(), unit: form.unit, openingQty, lowStockThreshold: threshold };
      const fingerprint = JSON.stringify(body);
      if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, ref: uuid() };
      const result = await apiFetch<{ item: StockItem }>("/api/stock-items", { method: "POST", body: JSON.stringify({ ...body, clientRef: request.current.ref }) });
      onDirtyChange(false); onCreated(result.item); onSelect(result.item);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create stock item."); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
  }
  return <WorkspaceDialog open title={creating ? "Create stock item" : "Add ingredient"} onClose={close} busy={busy} className="recipe-picker-dialog">
    {creating ? <form className="recipe-stock-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <p className="muted">The stock item is created immediately. Save the recipe to start using it.</p>
      <label>Stock name<input autoFocus required maxLength={120} value={form.name} disabled={busy || !canCreate} onChange={(event) => update({ ...form, name: event.target.value })} /></label>
      <label>Stock unit<select value={form.unit} disabled={busy || !canCreate} onChange={(event) => update({ ...form, unit: event.target.value as StockUnit })}>{units.map((unit) => <option key={unit}>{unit}</option>)}</select><small className="muted">This unit cannot be changed later.</small></label>
      <div className="recipe-stock-amounts">
        <label>Opening quantity ({form.unit})<input required type="number" min="0" max="1000000000" step="0.001" value={form.opening} disabled={busy || !canCreate} onChange={(event) => update({ ...form, opening: event.target.value })} /></label>
        <label>Low-stock threshold ({form.unit})<input type="number" min="0" max="1000000000" step="0.001" placeholder="Optional" value={form.threshold} disabled={busy || !canCreate} onChange={(event) => update({ ...form, threshold: event.target.value })} /></label>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="recipe-dialog-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button className="primary" disabled={busy || !canCreate}>{busy ? "Creating…" : "Create and add ingredient"}</button></div>
    </form> : <>
      <label className="recipe-picker-search">Find ingredient<input autoFocus type="search" value={search} placeholder="Search stock items" onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="recipe-picker-list" aria-label="Available ingredients">
        {visible.map((item) => <button key={item.id} onClick={() => onSelect(item)}><span>{item.name}<small>{item.qty.toLocaleString("en-IN", { maximumFractionDigits: 3 })} {item.unit} on hand</small></span><span className="recipe-unit-tag">{item.unit}</span><Icon name="plus" size={16} /></button>)}
        {!visible.length && <p className="recipe-empty">{available.length ? "No ingredients match your search." : "No unused active stock items. Create a stock item to add another ingredient."}</p>}
      </div>
      {canCreate && <button className="recipe-create-stock" onClick={() => { setCreating(true); update({ ...emptyStock, name: search.trim() }); }}><Icon name="plus" size={16} /> Create stock item</button>}
    </>}
  </WorkspaceDialog>;
}
