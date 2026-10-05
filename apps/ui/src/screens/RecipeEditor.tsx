import { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { StockItem, StockLink, StockUnit } from "@forkflow/domain";
import { ApiError, apiFetch } from "../api";
import { uuid } from "../uuid";
import { useNavigationGuard } from "../navigation-guard";
import { Icon } from "../Icon";
import { defaultRecipeUnit, displayRecipeAmount, recipeAmount, recipeIsDirty, recipeUnits, recipeWrite, switchRecipeUnit, type RecipeDraftRow } from "../recipe-quantities";
import { RecipeIngredientPicker } from "./RecipeIngredientPicker";

interface Recipe { version: number; links: StockLink[] }
interface Props {
  productId: string; items: StockItem[]; canManage: boolean; fullRecipe: boolean; refresh: number;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
  onStockCreated: (item: StockItem) => void;
}
const draftRows = (recipe: Recipe): RecipeDraftRow[] => recipe.links.map((link) => ({ key: uuid(), stockItemId: link.stockItemId,
  displayUnit: defaultRecipeUnit(link.unit), quantity: displayRecipeAmount(link.qtyPerSale, link.unit, defaultRecipeUnit(link.unit)) }));

export function RecipeEditor({ productId, items, canManage, fullRecipe, refresh, onDirtyChange, onBusyChange, onStockCreated }: Props) {
  const [base, setBase] = useState<Recipe | null>(null);
  const [rows, setRows] = useState<RecipeDraftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [reload, setReload] = useState(0);
  const [picker, setPicker] = useState(false);
  const [stockDirty, setStockDirty] = useState(false);
  const [stockBusy, setStockBusy] = useState(false);
  const lock = useRef(false);
  const amountRefs = useRef(new Map<string, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const id = useId();
  const unitFor = (stockId: string) => items.find((item) => item.id === stockId)?.unit ?? base?.links.find((link) => link.stockItemId === stockId)?.unit;
  const dirty = base !== null && recipeIsDirty(rows, base.links, unitFor);
  const editable = canManage && (fullRecipe || (base !== null && base.links.length <= 1));
  const working = busy || stockBusy;
  const disabled = working || loading || loadFailed || !editable;

  useNavigationGuard(useCallback(() => {
    if (lock.current || stockBusy) { window.alert("Wait for saving to finish before leaving this page."); return false; }
    return !(dirty || stockDirty) || window.confirm("Discard your unsaved recipe or stock-item changes?");
  }, [dirty, stockDirty, stockBusy]));
  useEffect(() => { onDirtyChange(dirty || stockDirty); }, [dirty, stockDirty, onDirtyChange]);
  useEffect(() => { onBusyChange(working); }, [working, onBusyChange]);
  useEffect(() => {
    if (!dirty && !stockDirty && !working) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, stockDirty, working]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadFailed(false); setError(""); setMessage("");
    void apiFetch<Recipe>(`/api/products/${productId}/stock-links`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) }).then((recipe) => {
      if (controller.signal.aborted) return;
      setBase(recipe); setRows(draftRows(recipe)); setFieldErrors({}); setConflict(false); setExternalChange(false);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) { setLoadFailed(true); setError(cause instanceof Error ? cause.message : "Could not load recipe."); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [productId, reload]);
  const applyExternalRefresh = useEffectEvent(() => {
    if (lock.current || stockBusy || loading || picker) return;
    if (dirty) setExternalChange(true);
    else setReload((value) => value + 1);
  });
  const lastRefresh = useRef(refresh);
  useEffect(() => {
    if (lastRefresh.current === refresh) return;
    lastRefresh.current = refresh;
    applyExternalRefresh();
  }, [refresh]);
  useEffect(() => {
    if (picker || !pendingFocus.current) return;
    amountRefs.current.get(pendingFocus.current)?.focus(); pendingFocus.current = null;
  }, [rows, picker]);

  function changeRow(key: string, change: Partial<RecipeDraftRow>) {
    setRows((old) => old.map((row) => row.key === key ? { ...row, ...change } : row));
    setFieldErrors((old) => { const next = { ...old }; delete next[key]; return next; }); setMessage("");
  }
  function addIngredient(item: StockItem) {
    if (!editable || loading || rows.length >= (fullRecipe ? 100 : 1) || rows.some((row) => row.stockItemId === item.id)) return;
    const key = uuid(); pendingFocus.current = key;
    setRows((old) => [...old, { key, stockItemId: item.id, quantity: "", displayUnit: defaultRecipeUnit(item.unit) }]);
    setPicker(false); setStockDirty(false); setMessage("");
  }
  function closePicker() { setPicker(false); setStockDirty(false); requestAnimationFrame(() => addButton.current?.focus()); }
  function discard() {
    if (!base || working || (dirty && !window.confirm("Discard your unsaved recipe changes?"))) return;
    setRows(draftRows(base)); setFieldErrors({}); setError(""); setMessage("");
    if (externalChange || conflict) setReload((value) => value + 1);
  }
  function reloadSaved() {
    if (working || (dirty && !window.confirm("Discard your draft and load the latest saved recipe?"))) return;
    setReload((value) => value + 1);
  }
  async function save() {
    if (!base || lock.current || disabled || !dirty) return;
    const errors: Record<string, string> = {};
    const ingredients = rows.flatMap((row) => {
      const unit = unitFor(row.stockItemId);
      try {
        if (!unit) throw new Error("This stock item is unavailable. Remove it and choose another ingredient.");
        const item = items.find((stock) => stock.id === row.stockItemId);
        if (!item?.isActive) throw new Error("This stock item is archived or unavailable. Remove it or reactivate it in Stock.");
        return [{ stockItemId: row.stockItemId, qtyPerSale: recipeAmount(row.quantity, unit, row.displayUnit) }];
      } catch (cause) { errors[row.key] = cause instanceof Error ? cause.message : "Check the amount."; return []; }
    });
    setFieldErrors(errors);
    const firstError = rows.find((row) => errors[row.key]);
    if (firstError) { amountRefs.current.get(firstError.key)?.focus(); return; }
    if (!rows.length && base.links.length && !window.confirm("Remove this recipe? Future sales will no longer deduct its ingredients. Previous stock movements will be kept.")) return;
    lock.current = true; setBusy(true); onBusyChange(true); setError(""); setMessage("");
    try {
      const write = recipeWrite(productId, base.version, ingredients, fullRecipe);
      const result = await apiFetch<Recipe>(write.path, { method: "PUT", body: JSON.stringify(write.body) });
      setBase(result); setConflict(false); setExternalChange(false); onDirtyChange(false);
      setMessage(result.links.length ? "Recipe saved. Future kitchen sends and bills use these amounts." : "Recipe removed. Future sales will not deduct ingredients.");
    } catch (cause) {
      setConflict(cause instanceof ApiError && cause.status === 409);
      setError(cause instanceof Error ? cause.message : "Could not save recipe. Your draft is kept.");
    } finally { lock.current = false; setBusy(false); onBusyChange(false); }
  }

  return <div className="recipe-editor" aria-label="Recipe editor" aria-busy={loading || working}>
    <div className="recipe-editor-heading"><div><h4>Ingredients for one item sold</h4><p className="muted">These quantities apply to all variants.</p></div>
      <span className={`recipe-state${dirty ? " is-dirty" : ""}`} role="status">{loading ? "Loading…" : working ? "Saving…" : dirty ? "Unsaved changes" : base ? `${base.links.length} ingredient${base.links.length === 1 ? "" : "s"}` : ""}</span></div>
    {!canManage && <p className="recipe-access-note">Only administrators can edit recipes.</p>}
    {canManage && !fullRecipe && <p className="recipe-access-note">{base && base.links.length > 1 ? "This recipe is view-only on Basic. Pro is required to edit multiple ingredients." : "Basic supports one ingredient per menu item. Multiple ingredients require Pro."}</p>}
    {error && <div className="recipe-error"><p role="alert">{error}</p>{(loadFailed || conflict) && <button disabled={working || loading} onClick={reloadSaved}>{conflict ? "Load latest recipe" : "Retry loading recipe"}</button>}</div>}
    {externalChange && !conflict && <p className="recipe-access-note" role="status">Stock or recipe data changed on another counter. Your draft is kept. <button disabled={working} onClick={reloadSaved}>Load latest recipe</button></p>}
    {message && <p className="recipe-success" role="status"><Icon name="check" size={16} />{message}</p>}
    {base && !loading && <form noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {rows.length > 0 && <div className="recipe-columns" aria-hidden="true"><span>Ingredient</span><span>Amount</span><span>Unit</span><span /></div>}
      <div className="recipe-ingredients">
        {rows.map((row, index) => {
          const stock = items.find((item) => item.id === row.stockItemId);
          const saved = base.links.find((link) => link.stockItemId === row.stockItemId);
          const unit = unitFor(row.stockItemId);
          let converted = "";
          if (unit && unit !== row.displayUnit) { try { converted = `${recipeAmount(row.quantity, unit, row.displayUnit)} ${unit} from stock`; } catch { /* Validation explains invalid input. */ } }
          const errorId = `${id}-${row.key}-error`, hintId = `${id}-${row.key}-hint`;
          return <div className="recipe-ingredient" key={row.key}>
            <div className="recipe-ingredient-name"><strong>{stock?.name ?? saved?.stockName ?? "Unavailable stock item"}</strong><small className="muted">{stock ? `${stock.qty.toLocaleString("en-IN", { maximumFractionDigits: 3 })} ${stock.unit} on hand${stock.isActive ? "" : " · Archived"}` : "Unavailable"}</small></div>
            <label className="recipe-amount"><span className="recipe-mobile-label">Amount</span><input ref={(element) => { if (element) amountRefs.current.set(row.key, element); else amountRefs.current.delete(row.key); }}
              aria-label={`Quantity for ingredient ${index + 1}`} aria-invalid={!!fieldErrors[row.key]} aria-describedby={`${hintId}${fieldErrors[row.key] ? ` ${errorId}` : ""}`}
              type="number" inputMode="decimal" step="any" placeholder="Amount" value={row.quantity} disabled={disabled} onChange={(event) => changeRow(row.key, { quantity: event.target.value })} /></label>
            <label className="recipe-unit"><span className="recipe-mobile-label">Unit</span>{unit && recipeUnits(unit).length > 1 ? <select aria-label={`Unit for ingredient ${index + 1}`} disabled={disabled} value={row.displayUnit} onChange={(event) => {
              const displayUnit = event.target.value as StockUnit; changeRow(row.key, { displayUnit, quantity: switchRecipeUnit(row.quantity, unit, row.displayUnit, displayUnit) });
            }}>{recipeUnits(unit).map((choice) => <option key={choice}>{choice}</option>)}</select> : <span className="recipe-unit-fixed">{unit ?? "—"}</span>}</label>
            {editable && <button className="recipe-remove" type="button" aria-label={`Remove ingredient ${index + 1}`} disabled={disabled} onClick={() => {
              const nextFocus = rows[index + 1]?.key ?? rows[index - 1]?.key;
              setRows((old) => old.filter((entry) => entry.key !== row.key)); setMessage("");
              requestAnimationFrame(() => { if (nextFocus) amountRefs.current.get(nextFocus)?.focus(); else addButton.current?.focus(); });
            }}>Remove</button>}
            <small id={hintId} className="recipe-amount-hint">{converted || (unit && row.displayUnit !== unit ? `Whole ${row.displayUnit} · stock measured in ${unit}` : "Up to 3 decimal places")}</small>
            {fieldErrors[row.key] && <p id={errorId} className="recipe-field-error" role="alert">{fieldErrors[row.key]}</p>}
          </div>;
        })}
      </div>
      {!rows.length && <div className="recipe-empty"><Icon name="kitchen" size={28} /><h4>No ingredients yet</h4><p>{base.links.length ? "Saving will remove this recipe and stop future stock deductions." : "Add the stock ingredients used to prepare one menu item."}</p></div>}
      {editable && <button ref={addButton} className="recipe-add" type="button" disabled={disabled || rows.length >= (fullRecipe ? 100 : 1)} onClick={() => setPicker(true)}><Icon name="plus" size={16} /> Add ingredient</button>}
      {editable && <div className="recipe-actions"><span className="muted">{rows.length === 100 ? "100 ingredient limit reached" : "Save to apply your changes"}</span><button type="button" disabled={working || !dirty} onClick={discard}>Discard changes</button><button className="primary" disabled={disabled || !dirty}>{busy ? "Saving recipe…" : "Save recipe"}</button></div>}
    </form>}
    <details className="recipe-help"><summary>How recipes affect stock</summary><p>Kitchen items deduct stock when sent. Other items deduct stock when billed. Changes also apply to punched items that have not reached that step. Earlier deductions and cancellation reversals keep their original quantities.</p><p>Grams and millilitres convert to the ingredient’s saved stock unit. Each ingredient can appear once; Pro supports up to 100 ingredients.</p></details>
    {picker && <RecipeIngredientPicker items={items} selectedIds={rows.map((row) => row.stockItemId)} canCreate={editable} onSelect={addIngredient} onCreated={onStockCreated} onClose={closePicker} onBusyChange={setStockBusy} onDirtyChange={setStockDirty} />}
  </div>;
}
