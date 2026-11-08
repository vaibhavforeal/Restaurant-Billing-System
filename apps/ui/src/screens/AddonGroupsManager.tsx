import { useNavigationGuard } from "../navigation-guard";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import { addonHint } from "../addon-cart";
import type { AddonGroup, Product } from "../types";
import { WorkspaceDialog } from "../WorkspaceDialog";
import "../addons.css";

type Option = { id?: string; productId: string; variantId: string | null };
export function AddonGroupsManager({ groups, products, onChanged, onClose }: { groups: AddonGroup[]; products: Product[]; onChanged: () => Promise<void>; onClose: () => void }) {
  const [editing, setEditing] = useState<AddonGroup | "new" | null>(null);
  const [name, setName] = useState("");
  const [min, setMin] = useState("0"), [max, setMax] = useState("1");
  const [options, setOptions] = useState<Option[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  useNavigationGuard(() => {
    if (lock.current) { window.alert("Wait for the add-on group to finish saving."); return false; }
    return editing === null || window.confirm("Discard your unsaved add-on group changes?");
  });
  useEffect(() => {
    if (!editing && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editing, busy]);
  const choices = products.filter((product) => product.kind !== "combo").flatMap<{ productId: string; variantId: string | null; name: string; available: boolean }>((product) => product.variants.length
    ? product.variants.map((variant) => ({ productId: product.id, variantId: variant.id, name: `${product.name} (${variant.name})`, available: product.isActive && variant.isActive }))
    : [{ productId: product.id, variantId: null, name: product.name, available: product.isActive }]);
  function edit(group: AddonGroup | "new") {
    setEditing(group); setError(""); setName(group === "new" ? "" : group.name);
    setMin(group === "new" ? "0" : String(group.minPicks)); setMax(group === "new" ? "1" : String(group.maxPicks));
    setOptions(group === "new" ? [] : group.options.map(({ id, productId, variantId }) => ({ id, productId, variantId })));
  }
  async function write(path: string, method: string, body: object) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await apiFetch(path, { method, body: JSON.stringify(body) }); setEditing(null); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save add-on group."); }
    finally { lock.current = false; setBusy(false); }
  }
  function save() {
    const minPicks = Number(min), maxPicks = Number(max);
    if (!name.trim() || name.trim().length > 60) { setError("Enter a group name of up to 60 characters."); return; }
    if (!min.trim() || !max.trim() || !Number.isInteger(minPicks) || !Number.isInteger(maxPicks) || minPicks < 0 || maxPicks < 1 || maxPicks < minPicks || minPicks > options.length) {
      setError("Enter whole numbers: minimum 0 or more, maximum at least 1 and at least the minimum. Include enough options for the minimum."); return;
    }
    if (!options.length || options.length > 40 || options.some((option) => !option.productId)) { setError("Choose between 1 and 40 options."); return; }
    if (new Set(options.map((option) => `${option.productId}|${option.variantId ?? ""}`)).size !== options.length) { setError("Choose each product and variant only once."); return; }
    void write(editing === "new" ? "/api/addon-groups" : `/api/addon-groups/${(editing as AddonGroup).id}`, editing === "new" ? "POST" : "PATCH", { name: name.trim(), minPicks, maxPicks, options });
  }
  return <section className="panel addon-manager">
    <div className="addon-manager-header"><h2>Add-on groups</h2><button disabled={busy} onClick={() => edit("new")}>New group</button><button disabled={busy} onClick={onClose}>Back to products</button></div>
    {error && <p role="alert" className="error-message">{error}</p>}
    {!groups.length && <p>No add-on groups yet. Create a group, then attach it to dishes in the product editor.</p>}
    {groups.map((group) => <div className="addon-group-row" key={group.id}><div><strong>{group.name}</strong><small>{group.isActive ? "Active" : "Archived"} · {addonHint(group)} · {group.options.length} options · {group.productIds.length} dishes</small></div><button disabled={busy} onClick={() => edit(group)}>Edit</button><button disabled={busy} onClick={() => void write(`/api/addon-groups/${group.id}`, "PATCH", { isActive: !group.isActive })}>{group.isActive ? "Archive" : "Unarchive"}</button></div>)}
    <WorkspaceDialog open={editing !== null} title={editing === "new" ? "New add-on group" : "Edit add-on group"} busy={busy} onClose={() => setEditing(null)}>
      <form onSubmit={(event) => { event.preventDefault(); save(); }}><fieldset disabled={busy} className="combo-slot-editor">
        <label>Name<input maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="combo-slot-settings"><label>Choose at least<input type="number" min={0} step={1} value={min} onChange={(event) => setMin(event.target.value)} /></label><label>Choose at most<input type="number" min={1} step={1} value={max} onChange={(event) => setMax(event.target.value)} /></label></div>
        {options.map((option, index) => <div className="combo-option-editor" key={index}><label>Product and variant<select value={option.productId ? `${option.productId}|${option.variantId ?? ""}` : ""} onChange={(event) => {
          const [productId = "", variantId = ""] = event.target.value.split("|");
          setOptions(options.map((value, i) => i === index ? { productId, variantId: variantId || null } : value));
        }}><option value="">Choose a product</option>{choices.filter((choice) => choice.available || (choice.productId === option.productId && choice.variantId === option.variantId)).map((choice) => <option key={`${choice.productId}|${choice.variantId ?? ""}`} value={`${choice.productId}|${choice.variantId ?? ""}`} disabled={!choice.available}>{choice.name}{!choice.available ? " (Inactive)" : ""}</option>)}</select></label>
          <button type="button" onClick={() => setOptions(options.filter((_, i) => i !== index))}>Remove</button></div>)}
        <button type="button" disabled={options.length >= 40} onClick={() => setOptions([...options, { productId: "", variantId: null }])}>Add option</button>
        {error && <p role="alert" className="error-message">{error}</p>}
        <div className="combo-dialog-footer"><button type="button" onClick={() => setEditing(null)}>Cancel</button><button className="primary" type="submit">{busy ? "Saving…" : "Save group"}</button></div>
      </fieldset></form>
    </WorkspaceDialog>
  </section>;
}
