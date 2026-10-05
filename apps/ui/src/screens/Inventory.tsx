import { useCallback, useEffect, useRef, useState } from "react";
import type { StockItem, StockMove, StockUnit } from "@forkflow/domain";
import { apiFetch, session, type User } from "../api";
import type { Product } from "../types";
import { uuid } from "../uuid";
import { connectWs } from "../ws";
import type { StockCost, StockCostChange } from "@forkflow/domain";
import { formatMovementCost, formatUnitCost, amountPaidToPaise, mergeCostChanges, mergeHistory, stockValueSummary } from "../stock-costs";
import { PerUnitHint, SetUnitCostForm } from "./StockCostControls";
import { RecipeEditor } from "./RecipeEditor";
import { DishCosting } from "./DishCosting";
import { useLicense } from "./LicenseSettings";
import { Icon } from "../Icon";
import "../recipes.css";

type InventoryTab = "stock" | "recipes" | "costing";
const TAB_LABELS: Record<InventoryTab, string> = { stock: "Stock", recipes: "Recipes", costing: "Dish costing" };
const UNITS: StockUnit[] = ["pcs", "kg", "g", "L", "ml"];
const quantity = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
const panel = { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--radius-panel)", padding: "var(--space-6)", marginTop: "var(--space-4)" };
const grid = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", alignItems: "end", gap: "var(--space-4)" } as const;
const fieldStyle = { display: "grid", gap: "var(--space-2)" };
function number(text: string) {
  if (!text.trim() || !Number.isFinite(Number(text))) throw new Error("Enter a valid quantity");
  return Number(text);
}

export function Inventory({ user }: { user: User }) {
  const canManage = user.role === "admin";
  const [items, setItems] = useState<StockItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<StockItem | null>(null);
  const [filter, setFilter] = useState("active");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [form, setForm] = useState({ name: "", unit: "pcs" as StockUnit, opening: "0", threshold: "" });
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const createRequest = useRef<{ fingerprint: string; ref: string } | null>(null);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<InventoryTab>("stock");
  const [recipeDirty, setRecipeDirty] = useState(false);
  const [recipeBusy, setRecipeBusy] = useState(false);
  const [recipeRefresh, setRecipeRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reloadInventory, setReloadInventory] = useState(0);
  const { status } = useLicense();
  const canSeeCosts = user.role === "admin" && status?.features.recipes === true;
  const [costData, setCostData] = useState<{ items: StockCost[]; totalValuePaise: number } | null>(null);
  const [costError, setCostError] = useState("");
  // Cost figures are refreshed whenever stock reloads (stock.changed, reconnect, or a save): historyVersion bumps each time.
  useEffect(() => {
    if (!canSeeCosts) { setCostData(null); setCostError(""); return; }
    let active = true;
    apiFetch<{ items: StockCost[]; totalValuePaise: number }>("/api/costing/stock")
      .then((r) => { if (active) { setCostData(r); setCostError(""); } })
      .catch((e: unknown) => { if (active) setCostError(e instanceof Error ? e.message : "Could not load stock costs"); });
    return () => { active = false; };
  }, [canSeeCosts, historyVersion]);
  const costById = new Map((costData?.items ?? []).map((c) => [c.stockItemId, c]));
  const valueSummary = costData ? stockValueSummary(costData.items) : null;
  // Dish costing shows cost data, so only administrators get the tab (Basic plans see the upgrade prompt inside it).
  const tabs: InventoryTab[] = user.role === "admin" ? ["stock", "recipes", "costing"] : ["stock", "recipes"];
  function canLeaveRecipe() {
    if (recipeBusy) return false;
    return !recipeDirty || window.confirm("Discard your unsaved recipe or stock-item changes?");
  }

  useEffect(() => {
    let active = true;
    let sequence = 0;
    async function reload() {
      const request = ++sequence;
      try {
        const [s, p] = await Promise.all([apiFetch<{ items: StockItem[] }>("/api/stock-items"), apiFetch<{ products: Product[] }>("/api/products")]);
        if (active && request === sequence) { setItems(s.items); setProducts(p.products); setHistoryVersion((v) => v + 1); setError(""); }
      } catch (e) { if (active && request === sequence) setError(e instanceof Error ? e.message : "Could not load inventory"); }
      finally { if (active && request === sequence) setLoading(false); }
    }
    void reload();
    const dispose = connectWs({
      onEvent: (event) => {
        if (event === "stock.changed" || event === "catalog.changed") { void reload(); setRecipeRefresh((value) => value + 1); }
        if (event === "recipe.changed") setRecipeRefresh((value) => value + 1);
      },
      onStatus: (up) => { setConnected(up); if (up) { void reload(); setRecipeRefresh((value) => value + 1); } }, onAuthFail: () => session.clear(),
    });
    return () => { active = false; dispose(); };
  }, [reloadInventory]);
  function saved(item: StockItem) {
    setItems((old) => [...old.filter((i) => i.id !== item.id), item].sort((a, b) => a.name.localeCompare(b.name)));
    setSelected(item); setHistoryVersion((v) => v + 1);
  }
  async function create() {
    if (creating.current) return;
    creating.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const body = { name: form.name, unit: form.unit, openingQty: number(form.opening), lowStockThreshold: form.threshold.trim() ? number(form.threshold) : null };
      const fingerprint = JSON.stringify(body);
      if (createRequest.current?.fingerprint !== fingerprint) createRequest.current = { fingerprint, ref: uuid() };
      const result = await apiFetch<{ item: StockItem }>("/api/stock-items", { method: "POST", body: JSON.stringify({ ...body, clientRef: createRequest.current.ref }) });
      saved(result.item); setForm({ name: "", unit: "pcs", opening: "0", threshold: "" });
      createRequest.current = null; setMessage(`Added ${result.item.name}.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not add stock item"); }
    finally { creating.current = false; setBusy(false); }
  }
  const low = items.filter((i) => i.isActive && i.isLow);
  const visible = items.filter((i) => (filter === "all" || (filter === "low" ? i.isActive && i.isLow : i.isActive)) && i.name.toLowerCase().includes(search.toLowerCase()));
  return <section className="screen inventory-screen">
    <div className="inventory-heading"><h2>Inventory</h2><div className="inventory-tabs" role="tablist" aria-label="Inventory sections">
      {tabs.map((value) => <button key={value} id={`inventory-${value}-tab`} role="tab" aria-selected={tab === value} aria-controls={`inventory-${value}-panel`} disabled={recipeBusy} onClick={() => {
        if (value === tab || !canLeaveRecipe()) return;
        setTab(value); setRecipeDirty(false);
      }} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const at = tabs.indexOf(value);
        const next = event.key === "Home" ? tabs[0]! : event.key === "End" ? tabs[tabs.length - 1]! : tabs[(at + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
        if (next !== tab && canLeaveRecipe()) { setTab(next); setRecipeDirty(false); document.getElementById(`inventory-${next}-tab`)?.focus(); }
      }}>{TAB_LABELS[value]}</button>)}
    </div></div>
    {!connected && <p role="status">Reconnecting…</p>}
    {error && <div className="recipe-error"><p role="alert">{error}</p><button disabled={recipeBusy} onClick={() => setReloadInventory((value) => value + 1)}>Retry inventory load</button></div>}<p role="status">{tab === "stock" ? message : ""}</p>
    {tab === "recipes" ? <div id="inventory-recipes-panel" role="tabpanel" aria-labelledby="inventory-recipes-tab">
      <RecipesWorkspace products={products} items={items} loading={loading} canManage={canManage && status?.canOperate === true} fullRecipe={status?.features.recipes === true} refresh={recipeRefresh}
        onDirtyChange={setRecipeDirty} onBusyChange={setRecipeBusy} canLeave={canLeaveRecipe} onStockCreated={(item) => setItems((old) => [...old.filter((entry) => entry.id !== item.id), item].sort((a, b) => a.name.localeCompare(b.name)))} />
    </div> : tab === "costing" && canManage ? <div id="inventory-costing-panel" role="tabpanel" aria-labelledby="inventory-costing-tab">
      <DishCosting fullRecipe={status?.features.recipes === true} refresh={recipeRefresh} />
    </div> : <div id="inventory-stock-panel" role="tabpanel" aria-labelledby="inventory-stock-tab">
    <p role="status" style={{ color: low.length ? "var(--warning-text, #874500)" : "var(--success-text, #176336)" }}>{low.length ? `${low.length} active stock item${low.length === 1 ? " is" : "s are"} low or out of stock.` : "No low-stock items."}</p>
    {canManage && <details className="pos-section" aria-label="Add stock item"><summary>Add stock item</summary><div className="pos-section-body">
      <form onSubmit={(e) => { e.preventDefault(); void create(); }} style={grid}>
        <label style={fieldStyle}>Stock name<input required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={busy} /></label>
        <label style={fieldStyle}>Unit<select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value as StockUnit })} disabled={busy}>{UNITS.map((unit) => <option key={unit}>{unit}</option>)}</select></label>
        <label style={fieldStyle}>Opening quantity<input type="number" min="0" step="0.001" required value={form.opening} onChange={(e) => setForm({ ...form, opening: e.target.value })} disabled={busy} /></label>
        <label style={fieldStyle}>Low-stock threshold<input type="number" min="0" step="0.001" placeholder="Optional" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} disabled={busy} /></label>
        <button className="primary" disabled={busy}>Add stock item</button>
      </form><p>Use up to 3 decimal places. The unit cannot be changed later.</p>
    </div></details>}
    <section style={panel}><h3>Stock balances</h3><div style={grid}>
      <label style={fieldStyle}>Find stock<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      <label style={fieldStyle}>Show stock<select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="active">Active</option><option value="low">Low stock</option><option value="all">All, including archived</option></select></label>
    </div><div style={{ overflowX: "auto" }}><table style={{ width: "100%", textAlign: "left", borderSpacing: "10px 14px" }}>
      <thead><tr><th>Name</th><th>On hand</th>{canSeeCosts && <><th>Avg cost</th><th>Stock value</th></>}<th>Threshold</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>{visible.map((item) => <tr key={item.id}><td>{item.name}</td><td>{quantity(item.qty)} {item.unit}</td>{canSeeCosts && <><td>{costData ? formatUnitCost(costById.get(item.id)?.unitCostMilliPaise ?? null, item.unit) : "…"}</td><td>{costData ? (costById.get(item.id)?.valuePaise == null ? "—" : formatMovementCost(costById.get(item.id)!.valuePaise)) : "…"}</td></>}<td>{item.lowStockThreshold === null ? "At zero" : `${quantity(item.lowStockThreshold)} ${item.unit}`}</td>
        <td style={{ color: item.isLow && item.isActive ? "var(--warning-text, #874500)" : undefined }}>{!item.isActive ? "Archived" : item.qty <= 0 ? "Out of stock" : item.isLow ? "Low" : "Available"}</td>
        <td><button onClick={() => setSelected(item)}>{canManage ? "Manage" : "View"} {item.name}</button></td></tr>)}</tbody>
    </table></div>{!visible.length && <p>No stock items match this view.</p>}{canSeeCosts && costData && valueSummary && <p>{valueSummary.label}: <strong>{formatMovementCost(costData.totalValuePaise)}</strong>{valueSummary.uncostedNote && <> <span className="muted">{valueSummary.uncostedNote}</span></>}</p>}{canSeeCosts && costError && <p role="alert" style={{ color: "var(--danger-text, crimson)" }}>{costError}</p>}</section>
    {selected && <StockDetail key={`${selected.id}:${selected.version}`} item={selected} canManage={canManage} onSaved={saved} historyVersion={historyVersion} canSeeCosts={canSeeCosts} unitCostMilliPaise={costData ? (costById.get(selected.id)?.unitCostMilliPaise ?? null) : undefined} onNotice={setMessage} />}
    </div>}
  </section>;
}

function StockDetail({ item, canManage, onSaved, historyVersion, canSeeCosts, unitCostMilliPaise, onNotice }: { item: StockItem; canManage: boolean; onSaved: (item: StockItem) => void; historyVersion: number; canSeeCosts: boolean; unitCostMilliPaise: number | null | undefined; onNotice: (text: string) => void }) {
  const [name, setName] = useState(item.name);
  const [threshold, setThreshold] = useState(item.lowStockThreshold?.toString() ?? "");
  const [reason, setReason] = useState<"purchase" | "wastage" | "adjustment">("purchase");
  const [amount, setAmount] = useState("");
  const [amountPaid, setAmountPaid] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const request = useRef<{ fingerprint: string; ref: string } | null>(null);
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); }
    finally { lock.current = false; setBusy(false); }
  }
  async function metadata(isActive = item.isActive) {
    const { item: next } = await apiFetch<{ item: StockItem }>(`/api/stock-items/${item.id}`, { method: "PATCH", body: JSON.stringify({ expectedVersion: item.version, name, lowStockThreshold: threshold.trim() ? number(threshold) : null, isActive }) });
    onSaved(next);
  }
  async function movement() {
    const costPaise = canSeeCosts && reason === "purchase" ? amountPaidToPaise(amountPaid) : undefined;
    const body = { reason, quantity: number(amount), note, expectedVersion: item.version, ...(costPaise === undefined ? {} : { costPaise }) };
    const fingerprint = JSON.stringify(body);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, ref: uuid() };
    const { item: next } = await apiFetch<{ item: StockItem }>(`/api/stock-items/${item.id}/movements`, { method: "POST", body: JSON.stringify({ ...body, clientRef: request.current.ref }) });
    onSaved(next);
  }
  return <section style={panel} aria-label={`Stock detail ${item.name}`}><h3>{item.name}</h3>
    {canSeeCosts && unitCostMilliPaise !== undefined && <p>Average cost: <strong>{formatUnitCost(unitCostMilliPaise, item.unit)}</strong></p>}
    <p>Balance when opened: <strong>{quantity(item.qty)} {item.unit}</strong>{" "}<button disabled={busy} onClick={() => void run(async () => {
      const result = await apiFetch<{ items: StockItem[] }>("/api/stock-items"); const next = result.items.find((s) => s.id === item.id); if (next) onSaved(next);
    })}>Refresh balance</button></p>
    <p role="alert" style={{ color: "var(--danger-text, crimson)" }}>{error}</p>
    {canManage && <>
      <form style={grid} onSubmit={(e) => { e.preventDefault(); void run(() => metadata()); }}>
        <label style={fieldStyle}>Item name<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} /></label>
        <label style={fieldStyle}>Warning threshold ({item.unit})<input type="number" min="0" step="0.001" placeholder="At zero" value={threshold} onChange={(e) => setThreshold(e.target.value)} disabled={busy} /></label>
        <button disabled={busy}>Save stock details</button>
        <button type="button" disabled={busy} onClick={() => void run(() => metadata(!item.isActive))}>{item.isActive ? "Archive item" : "Reactivate item"}</button>
      </form>
      {item.isActive && <form style={{ ...grid, marginTop: "var(--space-6)" }} onSubmit={(e) => { e.preventDefault(); void run(movement); }}>
        <label style={fieldStyle}>Movement<select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)} disabled={busy}>
          <option value="purchase">Receive stock</option><option value="wastage">Record wastage</option><option value="adjustment">Physical stock count</option>
        </select></label>
        <label style={fieldStyle}>{reason === "adjustment" ? "Counted quantity" : "Movement quantity"} ({item.unit})<input type="number" min={reason === "adjustment" ? "0" : "0.001"} step="0.001" required value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} /></label>
        {canSeeCosts && reason === "purchase" && <label style={fieldStyle}>Amount paid (₹, incl. GST)<input type="text" inputMode="decimal" placeholder="Optional" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} disabled={busy} /></label>}
        {canSeeCosts && reason === "purchase" && <PerUnitHint amountPaid={amountPaid} quantity={amount} unit={item.unit} />}
        <label style={fieldStyle}>Reason / reference<input required maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} /></label>
        <button disabled={busy}>Record movement</button>
      </form>}
      {canSeeCosts && item.isActive && <SetUnitCostForm item={item} onSaved={onSaved} onNotice={onNotice} />}
      <p>A physical count replaces the balance you reviewed. If stock changes meanwhile, refresh the balance before trying again.</p>
    </>}
    <StockHistory itemId={item.id} unit={item.unit} refresh={historyVersion} showCost={canSeeCosts} />
  </section>;
}

function StockHistory({ itemId, unit, refresh, showCost }: { itemId: string; unit: StockUnit; refresh: number; showCost: boolean }) {
  const [moves, setMoves] = useState<StockMove[]>([]);
  const [changes, setChanges] = useState<StockCostChange[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    apiFetch<{ movements: StockMove[]; costChanges?: StockCostChange[] }>(`/api/stock-items/${itemId}/movements`).then((r) => { if (active) { setMoves(r.movements); setChanges(r.costChanges ?? []); setMore(r.movements.length === 100); setError(""); } }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Could not load history"); });
    return () => { active = false; };
  }, [itemId, refresh]);
  return <div><h4>Movement history</h4><p role="alert" style={{ color: "var(--danger-text, crimson)" }}>{error}</p><div style={{ overflowX: "auto" }}>
    <table style={{ width: "100%", textAlign: "left", borderSpacing: "10px 12px" }}><thead><tr><th>Date</th><th>Movement</th><th>Change</th><th>Balance after</th>{showCost && <th>Cost</th>}<th>Reason</th><th>Staff</th></tr></thead>
      <tbody>{mergeHistory(moves, showCost ? changes : []).map((row) => row.kind === "cost"
        ? <tr key={`cost:${row.id}`}><td>{new Date(row.at).toLocaleString()}</td><td>Unit cost set</td><td>—</td><td>—</td><td>{formatUnitCost(row.change.oldCostMilliPaise, unit)} → {formatUnitCost(row.change.newCostMilliPaise, unit)}</td><td>{row.change.note}</td><td>{row.change.createdByName ?? "—"}</td></tr>
        : <tr key={row.id}><td>{new Date(row.at).toLocaleString()}</td><td>{row.move.reason.replaceAll("_", " ")}</td><td>{row.move.delta > 0 ? "+" : ""}{quantity(row.move.delta)} {unit}</td><td>{row.move.balanceAfter === null ? "—" : quantity(row.move.balanceAfter)}</td>{showCost && <td>{formatMovementCost(row.move.costPaise)}</td>}<td>{row.move.note ?? (row.move.orderItemId ? "Order item" : "—")}</td><td>{row.move.createdByName ?? "—"}</td></tr>)}</tbody>
    </table></div>{!moves.length && !changes.length && <p>No movements yet.</p>}
    {more && <button disabled={busy} onClick={async () => {
      setBusy(true); try {
        const result = await apiFetch<{ movements: StockMove[]; costChanges?: StockCostChange[] }>(`/api/stock-items/${itemId}/movements?before=${encodeURIComponent(moves[moves.length - 1]!.id)}`);
        setChanges((prior) => mergeCostChanges(prior, result.costChanges ?? []));
        setMoves((prior) => [...prior, ...result.movements.filter((m) => !prior.some((p) => p.id === m.id))]); setMore(result.movements.length === 100);
      } catch (e) { setError(e instanceof Error ? e.message : "Could not load history"); } finally { setBusy(false); }
    }}>Older movements</button>}
  </div>;
}

function RecipesWorkspace({ products, items, loading, canManage, fullRecipe, refresh, onDirtyChange, onBusyChange, canLeave, onStockCreated }: {
  products: Product[]; items: StockItem[]; loading: boolean; canManage: boolean; fullRecipe: boolean; refresh: number;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void; canLeave: () => boolean;
  onStockCreated: (item: StockItem) => void;
}) {
  const [productId, setProductId] = useState("");
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const product = products.find((entry) => entry.id === productId);
  const visible = products.filter((entry) => (showInactive || entry.isActive) && entry.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const busyChanged = useCallback((value: boolean) => { setBusy(value); onBusyChange(value); }, [onBusyChange]);
  function choose(id: string) {
    if (id === productId || !canLeave()) return;
    setProductId(id); onDirtyChange(false);
  }
  useEffect(() => { if (productId) heading.current?.focus(); }, [productId]);
  function back() {
    if (!canLeave()) return;
    setProductId(""); onDirtyChange(false); requestAnimationFrame(() => searchInput.current?.focus());
  }
  return <div className={`recipes-workspace${productId ? " has-selection" : ""}`}>
    <aside className="recipe-product-pane" aria-label="Menu items">
      <div className="recipe-list-heading"><h3>Menu items</h3><span className="muted">{visible.length}</span></div>
      <label className="recipe-product-search">Find menu item<input ref={searchInput} type="search" placeholder="Search menu items" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label className="recipe-inactive-filter"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} /> Include inactive items</label>
      <div className="recipe-product-list">
        {visible.map((entry) => <button key={entry.id} className={productId === entry.id ? "selected" : ""} aria-pressed={productId === entry.id} disabled={busy} onClick={() => choose(entry.id)}>
          <span>{entry.name}{!entry.isActive && <small>Inactive</small>}</span><Icon name="arrow" size={16} />
        </button>)}
        {!visible.length && <p className="recipe-list-empty">{loading ? "Loading menu items…" : products.length ? "No menu items match this view." : "Create a menu item in Catalog, then add its ingredients here."}</p>}
      </div>
    </aside>
    <section className="recipe-detail-pane" aria-label="Selected recipe">
      {product ? <>
        <header className="recipe-product-heading"><button className="recipe-back" disabled={busy} onClick={back}>Back to menu items</button><div><p className="muted">Recipe</p><h3 ref={heading} tabIndex={-1}>{product.name}</h3></div>{!product.isActive && <span className="recipe-unit-tag">Inactive menu item</span>}</header>
        <RecipeEditor key={product.id} productId={product.id} items={items} canManage={canManage} fullRecipe={fullRecipe} refresh={refresh} onDirtyChange={onDirtyChange}
          onBusyChange={busyChanged} onStockCreated={onStockCreated} />
      </> : <div className="recipe-welcome"><Icon name="kitchen" size={36} /><h3>Build recipes for your menu</h3><p>Choose a menu item to manage the ingredients used for each sale.</p><small>Stock balances and purchases are in the Stock tab.</small></div>}
    </section>
  </div>;
}
