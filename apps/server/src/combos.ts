import { uuidv7, type ComboGroup, type ComboGroupInputValue, type Database } from "@masalapos/domain";
import { httpError } from "./http-error.js";

interface OptionRow {
  id: string; group_id: string; product_id: string; variant_id: string | null; qty: number; extra_price_paise: number;
  product_name: string; variant_name: string | null; product_active: number; sold_out: number; variant_active: number | null;
}
interface GroupRow { id: string; combo_id: string; name: string; min_picks: number; max_picks: number }

/** Every combo's slots, keyed by combo id. Options are marked unavailable while their item is sold out or switched off. */
export function comboGroupsByCombo(db: Database, comboId?: string): Map<string, ComboGroup[]> {
  const groups = db.prepare(`SELECT id, combo_id, name, min_picks, max_picks FROM combo_groups ${comboId ? "WHERE combo_id = ?" : ""} ORDER BY combo_id, sort_order`)
    .all(...(comboId ? [comboId] : [])) as GroupRow[];
  const options = db.prepare(`SELECT o.id, o.group_id, o.product_id, o.variant_id, o.qty, o.extra_price_paise,
      p.name AS product_name, v.name AS variant_name, p.is_active AS product_active, p.is_sold_out AS sold_out, v.is_active AS variant_active
    FROM combo_options o JOIN combo_groups g ON g.id = o.group_id JOIN products p ON p.id = o.product_id LEFT JOIN variants v ON v.id = o.variant_id
    ${comboId ? "WHERE g.combo_id = ?" : ""} ORDER BY o.group_id, o.sort_order`).all(...(comboId ? [comboId] : [])) as OptionRow[];
  const byGroup = new Map<string, OptionRow[]>();
  for (const option of options) byGroup.set(option.group_id, [...byGroup.get(option.group_id) ?? [], option]);
  const result = new Map<string, ComboGroup[]>();
  for (const g of groups) {
    const group: ComboGroup = { id: g.id, name: g.name, minPicks: g.min_picks, maxPicks: g.max_picks,
      options: (byGroup.get(g.id) ?? []).map((o) => ({
        id: o.id, productId: o.product_id, variantId: o.variant_id, qty: o.qty, extraPricePaise: o.extra_price_paise,
        name: o.variant_name ? `${o.product_name} (${o.variant_name})` : o.product_name,
        ...(o.product_active !== 1 || o.sold_out === 1 || o.variant_active === 0 ? { unavailable: true } : {}),
      })) };
    result.set(g.combo_id, [...result.get(g.combo_id) ?? [], group]);
  }
  return result;
}

export const comboGroups = (db: Database, comboId: string): ComboGroup[] => comboGroupsByCombo(db, comboId).get(comboId) ?? [];

/**
 * Replaces a combo's slots. Options keep their ids when the editor sends them back, so a cart punched before the edit
 * still matches. Call inside a transaction.
 */
export function saveComboGroups(db: Database, comboId: string, groups: ComboGroupInputValue[]): void {
  const previousGroups = new Set((db.prepare("SELECT id FROM combo_groups WHERE combo_id = ?").all(comboId) as Array<{ id: string }>).map((r) => r.id));
  const previousOptions = new Set((db.prepare("SELECT o.id FROM combo_options o JOIN combo_groups g ON g.id = o.group_id WHERE g.combo_id = ?").all(comboId) as Array<{ id: string }>).map((r) => r.id));
  for (const group of groups) {
    for (const option of group.options) {
      const product = db.prepare("SELECT kind FROM products WHERE id = ?").get(option.productId) as { kind: string } | undefined;
      if (!product) throw httpError(400, "unknown product in combo");
      if (product.kind === "combo") throw httpError(400, "A combo cannot hold another combo");
      if (option.variantId && !db.prepare("SELECT 1 FROM variants WHERE id = ? AND product_id = ?").get(option.variantId, option.productId)) throw httpError(400, "variant does not belong to product");
    }
  }
  db.prepare("DELETE FROM combo_options WHERE group_id IN (SELECT id FROM combo_groups WHERE combo_id = ?)").run(comboId);
  db.prepare("DELETE FROM combo_groups WHERE combo_id = ?").run(comboId);
  const usedIds = new Set<string>();
  const keep = (id: string | undefined, previous: Set<string>) => {
    const value = id && previous.has(id) && !usedIds.has(id) ? id : uuidv7();
    usedIds.add(value);
    return value;
  };
  const insertGroup = db.prepare("INSERT INTO combo_groups (id, combo_id, name, min_picks, max_picks, sort_order) VALUES (?, ?, ?, ?, ?, ?)");
  const insertOption = db.prepare("INSERT INTO combo_options (id, group_id, product_id, variant_id, qty, extra_price_paise, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)");
  groups.forEach((group, groupIndex) => {
    const groupId = keep(group.id, previousGroups);
    insertGroup.run(groupId, comboId, group.name, group.minPicks, group.maxPicks, groupIndex);
    group.options.forEach((option, optionIndex) => insertOption.run(keep(option.id, previousOptions), groupId, option.productId, option.variantId, option.qty, option.extraPricePaise, optionIndex));
  });
}
