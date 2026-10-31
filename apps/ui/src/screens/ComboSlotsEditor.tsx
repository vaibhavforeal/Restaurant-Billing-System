import { isFixedGroup, type ComboGroup, type ComboGroupInputValue } from "@forkflow/domain/combos";
import { InfoTip } from "../InfoTip";
import { paiseToRupees, rupeesToPaise } from "../money";
import type { Product } from "../types";

export interface SlotOption { key: string; id?: string; productId: string; variantId: string | null; qty: string; extra: string }
export interface Slot { key: string; id?: string; name: string; fixed: boolean; minPicks: string; maxPicks: string; options: SlotOption[] }

let nextKey = 0;
const key = () => `slot-${nextKey++}`;
export const emptyOption = (): SlotOption => ({ key: key(), productId: "", variantId: null, qty: "1", extra: "" });
export const emptySlot = (fixed: boolean): Slot => ({ key: key(), name: fixed ? "Included" : "", fixed, minPicks: "1", maxPicks: "1", options: [emptyOption()] });

/** The editor's rows for a saved combo; a new combo starts with one fixed slot. */
export function slotsFromGroups(groups: ComboGroup[] | undefined): Slot[] {
  if (!groups?.length) return [emptySlot(true)];
  return groups.map((group) => ({ key: key(), id: group.id, name: group.name, fixed: isFixedGroup(group), minPicks: String(group.minPicks), maxPicks: String(group.maxPicks),
    options: group.options.map((option) => ({ key: key(), id: option.id, productId: option.productId, variantId: option.variantId, qty: String(option.qty),
      extra: option.extraPricePaise ? paiseToRupees(option.extraPricePaise) : "" })) }));
}

/** The slots as the server takes them, or the first thing staff must fix. A fixed slot includes every item in it. */
export function slotsToGroups(slots: Slot[]): { groups: ComboGroupInputValue[] } | { error: string } {
  if (!slots.length) return { error: "Add at least one slot to the combo." };
  const groups: ComboGroupInputValue[] = [];
  for (const [index, slot] of slots.entries()) {
    const name = slot.name.trim();
    if (!name) return { error: `Slot ${index + 1} needs a name, such as Drink.` };
    if (!slot.options.length) return { error: `${name}: add at least one item.` };
    const options: ComboGroupInputValue["options"] = [];
    for (const option of slot.options) {
      if (!option.productId) return { error: `${name}: choose an item for every row.` };
      const qty = Number(option.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) return { error: `${name}: quantity must be a whole number from 1 to 20.` };
      const extra = option.extra.trim() ? rupeesToPaise(option.extra) : 0;
      if (extra === null) return { error: `${name}: the extra price must be a valid amount or blank.` };
      options.push({ ...(option.id ? { id: option.id } : {}), productId: option.productId, variantId: option.variantId, qty, extraPricePaise: extra });
    }
    const min = slot.fixed ? options.length : Number(slot.minPicks), max = slot.fixed ? options.length : Number(slot.maxPicks);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1) return { error: `${name}: enter whole numbers for how many to choose.` };
    if (min > max) return { error: `${name}: the minimum is more than the maximum.` };
    if (max > options.length) return { error: `${name}: guests cannot choose ${max} from ${options.length} ${options.length === 1 ? "item" : "items"}.` };
    groups.push({ ...(slot.id ? { id: slot.id } : {}), name, minPicks: min, maxPicks: max, options });
  }
  return { groups };
}

/** Slots of a combo: fixed items that are always in it, and choices such as "1 drink from 3". */
export function ComboSlotsEditor({ slots, products, disabled, onChange }: { slots: Slot[]; products: Product[]; disabled: boolean; onChange: (slots: Slot[]) => void }) {
  const choices = products.filter((product) => product.kind !== "combo" && (product.isActive || slots.some((slot) => slot.options.some((option) => option.productId === product.id))))
    .flatMap((product) => {
      const variants = product.variants.filter((variant) => variant.isActive || slots.some((slot) => slot.options.some((option) => option.variantId === variant.id)));
      return [{ value: `${product.id}|`, label: product.name }, ...variants.map((variant) => ({ value: `${product.id}|${variant.id}`, label: `${product.name} (${variant.name})` }))];
    });
  const setSlot = (slotKey: string, patch: Partial<Slot>) => onChange(slots.map((slot) => slot.key === slotKey ? { ...slot, ...patch } : slot));
  const setOption = (slot: Slot, optionKey: string, patch: Partial<SlotOption>) =>
    setSlot(slot.key, { options: slot.options.map((option) => option.key === optionKey ? { ...option, ...patch } : option) });
  return <section className="combo-slots-editor" aria-label="Combo slots">
    <h3>What is in the combo <InfoTip>A fixed slot is always included, such as the burger and fries. A choice slot lets staff or the guest pick, such as 1 drink from 3. An extra price is added to the combo price when that item is picked. Each item goes to its own kitchen station and uses its own recipe.</InfoTip></h3>
    {slots.map((slot, index) => <fieldset key={slot.key} className="combo-slot-editor" disabled={disabled}>
      <legend>Slot {index + 1}</legend>
      <div className="combo-slot-settings">
        <label>Slot name<input value={slot.name} placeholder="e.g. Drink" maxLength={60} onChange={(event) => setSlot(slot.key, { name: event.target.value })} /></label>
        <label className="combo-slot-fixed"><input type="checkbox" checked={slot.fixed} onChange={(event) => setSlot(slot.key, { fixed: event.target.checked })} /> Fixed: every item included</label>
        {!slot.fixed && <>
          <label>Choose at least<input inputMode="numeric" value={slot.minPicks} onChange={(event) => setSlot(slot.key, { minPicks: event.target.value })} /></label>
          <label>Choose at most<input inputMode="numeric" value={slot.maxPicks} onChange={(event) => setSlot(slot.key, { maxPicks: event.target.value })} /></label>
        </>}
      </div>
      {slot.options.map((option) => <div className="combo-option-editor" key={option.key}>
        <label>Item<select value={option.productId ? `${option.productId}|${option.variantId ?? ""}` : ""} onChange={(event) => {
          const [productId = "", variantId = ""] = event.target.value.split("|");
          setOption(slot, option.key, { productId, variantId: variantId || null });
        }}><option value="">Choose an item</option>{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
        <label>Qty<input inputMode="numeric" value={option.qty} onChange={(event) => setOption(slot, option.key, { qty: event.target.value })} /></label>
        {!slot.fixed && <label>Extra (₹)<input inputMode="decimal" value={option.extra} placeholder="0" onChange={(event) => setOption(slot, option.key, { extra: event.target.value })} /></label>}
        <button type="button" aria-label="Remove item from slot" onClick={() => setSlot(slot.key, { options: slot.options.filter((value) => value.key !== option.key) })}>Remove</button>
      </div>)}
      <div className="combo-slot-actions">
        <button type="button" onClick={() => setSlot(slot.key, { options: [...slot.options, emptyOption()] })}>Add item</button>
        <button type="button" onClick={() => onChange(slots.filter((value) => value.key !== slot.key))}>Remove slot</button>
      </div>
    </fieldset>)}
    <div className="combo-slot-actions">
      <button type="button" disabled={disabled} onClick={() => onChange([...slots, emptySlot(true)])}>Add fixed slot</button>
      <button type="button" disabled={disabled} onClick={() => onChange([...slots, emptySlot(false)])}>Add choice slot</button>
    </div>
  </section>;
}
