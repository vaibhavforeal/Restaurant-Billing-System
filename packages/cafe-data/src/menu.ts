import { uuidv7 } from "@masalapos/domain/id";
import type { SqlDriver } from "./driver.js";
import { dataChanged } from "./events.js";

export class MenuError extends Error {
  constructor(readonly code: "duplicate_name" | "category_not_empty" | "not_found" | "invalid", message: string) {
    super(message);
    this.name = "MenuError";
  }
}

export interface Category { id: string; name: string; sort: number }
export interface Variant { id: string; itemId: string; name: string; pricePaise: number; sort: number }
export interface Item {
  id: string; categoryId: string; name: string; pricePaise: number; gstRate: number | null; available: boolean; sort: number; variants: Variant[];
}
export interface ItemInput {
  id?: string; categoryId: string; name: string; pricePaise: number; gstRate: number | null;
  variants: Array<{ id?: string; name: string; pricePaise: number }>;
}

const MAX_PRICE_PAISE = 10_000_000; // one lakh rupees
const GST_RATES = [0, 5, 12, 18, 28];

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 60) throw new MenuError("invalid", "A name needs 1 to 60 characters");
  return trimmed;
}
function checkPrice(paise: number): number {
  if (!Number.isInteger(paise) || paise < 0 || paise > MAX_PRICE_PAISE) throw new MenuError("invalid", "A price is from 0 to 1,00,000 rupees");
  return paise;
}

/** Runs one write in one transaction, then tells the screens. */
function write<T>(db: SqlDriver, fn: () => T): T {
  const value = db.transaction(fn);
  dataChanged();
  return value;
}

const nextSort = (db: SqlDriver, sql: string, params: unknown[] = []) =>
  (db.get<{ n: number | null }>(sql, params)?.n ?? 0) + 1;

interface CategoryRow { id: string; name: string; sort: number }
interface ItemRow { id: string; category_id: string; name: string; price_paise: number; gst_rate: number | null; available: number; sort: number }
interface VariantRow { id: string; item_id: string; name: string; price_paise: number; sort: number }

const variantOf = (v: VariantRow): Variant => ({ id: v.id, itemId: v.item_id, name: v.name, pricePaise: v.price_paise, sort: v.sort });

function readItem(db: SqlDriver, id: string): Item | null {
  const r = db.get<ItemRow>("SELECT * FROM items WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!r) return null;
  const variants = db.all<VariantRow>("SELECT * FROM item_variants WHERE item_id = ? AND deleted_at IS NULL ORDER BY sort, id", [id]).map(variantOf);
  return { id: r.id, categoryId: r.category_id, name: r.name, pricePaise: r.price_paise, gstRate: r.gst_rate, available: r.available === 1, sort: r.sort, variants };
}

/** Live categories and items, in their saved order; items follow their category's order. */
export function listMenu(db: SqlDriver): { categories: Category[]; items: Item[] } {
  const categories = db.all<CategoryRow>("SELECT id, name, sort FROM categories WHERE deleted_at IS NULL ORDER BY sort, id");
  const rows = db.all<ItemRow>(`SELECT i.* FROM items i JOIN categories c ON c.id = i.category_id
    WHERE i.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY c.sort, c.id, i.sort, i.id`);
  const variants = db.all<VariantRow>("SELECT * FROM item_variants WHERE deleted_at IS NULL ORDER BY sort, id");
  const byItem = new Map<string, Variant[]>();
  for (const v of variants) byItem.set(v.item_id, [...(byItem.get(v.item_id) ?? []), variantOf(v)]);
  return {
    categories: categories.map((c) => ({ id: c.id, name: c.name, sort: c.sort })),
    items: rows.map((r) => ({ id: r.id, categoryId: r.category_id, name: r.name, pricePaise: r.price_paise, gstRate: r.gst_rate,
      available: r.available === 1, sort: r.sort, variants: byItem.get(r.id) ?? [] })),
  };
}

export function saveCategory(db: SqlDriver, input: { id?: string; name: string }, now: number): Category {
  const name = cleanName(input.name);
  return write(db, () => {
    const clash = db.get("SELECT id FROM categories WHERE deleted_at IS NULL AND lower(name) = lower(?) AND id <> ?", [name, input.id ?? ""]);
    if (clash) throw new MenuError("duplicate_name", "There is already a category with this name");
    if (input.id) {
      const row = db.get<CategoryRow>("SELECT id, sort FROM categories WHERE id = ? AND deleted_at IS NULL", [input.id]);
      if (!row) throw new MenuError("not_found", "This category no longer exists");
      db.run("UPDATE categories SET name = ?, updated_at = ? WHERE id = ?", [name, now, input.id]);
      return { id: input.id, name, sort: row.sort };
    }
    const id = uuidv7();
    const sort = nextSort(db, "SELECT MAX(sort) AS n FROM categories WHERE deleted_at IS NULL");
    db.run("INSERT INTO categories (id, name, sort, updated_at) VALUES (?, ?, ?, ?)", [id, name, sort, now]);
    return { id, name, sort };
  });
}

export function deleteCategory(db: SqlDriver, id: string, now: number): void {
  write(db, () => {
    if (!db.get("SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL", [id])) throw new MenuError("not_found", "This category no longer exists");
    if (db.get("SELECT id FROM items WHERE category_id = ? AND deleted_at IS NULL", [id])) {
      throw new MenuError("category_not_empty", "Move or delete this category's items first");
    }
    db.run("UPDATE categories SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  });
}

/** Adds or edits an item with its variants. Variants left out of the input are deleted. */
export function saveItem(db: SqlDriver, input: ItemInput, now: number): Item {
  const name = cleanName(input.name);
  const pricePaise = checkPrice(input.pricePaise);
  if (input.gstRate !== null && !GST_RATES.includes(input.gstRate)) throw new MenuError("invalid", "GST rate must be 0, 5, 12, 18 or 28");
  const variants = input.variants.map((v) => ({ id: v.id, name: cleanName(v.name), pricePaise: checkPrice(v.pricePaise) }));
  return write(db, () => {
    if (!db.get("SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL", [input.categoryId])) {
      throw new MenuError("not_found", "This category no longer exists");
    }
    let id = input.id;
    if (id) {
      if (!db.get("SELECT id FROM items WHERE id = ? AND deleted_at IS NULL", [id])) throw new MenuError("not_found", "This item no longer exists");
      db.run("UPDATE items SET category_id = ?, name = ?, price_paise = ?, gst_rate = ?, updated_at = ? WHERE id = ?",
        [input.categoryId, name, pricePaise, input.gstRate, now, id]);
    } else {
      id = uuidv7();
      const sort = nextSort(db, "SELECT MAX(sort) AS n FROM items WHERE category_id = ? AND deleted_at IS NULL", [input.categoryId]);
      db.run("INSERT INTO items (id, category_id, name, price_paise, gst_rate, available, sort, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
        [id, input.categoryId, name, pricePaise, input.gstRate, sort, now]);
    }
    const live = new Set(db.all<{ id: string }>("SELECT id FROM item_variants WHERE item_id = ? AND deleted_at IS NULL", [id]).map((v) => v.id));
    const kept = new Set<string>();
    variants.forEach((v, index) => {
      if (v.id && live.has(v.id)) {
        db.run("UPDATE item_variants SET name = ?, price_paise = ?, sort = ?, updated_at = ? WHERE id = ?", [v.name, v.pricePaise, index + 1, now, v.id]);
        kept.add(v.id);
      } else {
        db.run("INSERT INTO item_variants (id, item_id, name, price_paise, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          [uuidv7(), id, v.name, v.pricePaise, index + 1, now]);
      }
    });
    for (const old of live) {
      if (!kept.has(old)) db.run("UPDATE item_variants SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, old]);
    }
    return readItem(db, id)!;
  });
}

export function setItemAvailable(db: SqlDriver, id: string, available: boolean, now: number): void {
  write(db, () => {
    if (!db.get("SELECT id FROM items WHERE id = ? AND deleted_at IS NULL", [id])) throw new MenuError("not_found", "This item no longer exists");
    db.run("UPDATE items SET available = ?, updated_at = ? WHERE id = ?", [available ? 1 : 0, now, id]);
  });
}

export function deleteItem(db: SqlDriver, id: string, now: number): void {
  write(db, () => {
    if (!db.get("SELECT id FROM items WHERE id = ? AND deleted_at IS NULL", [id])) throw new MenuError("not_found", "This item no longer exists");
    db.run("UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    db.run("UPDATE item_variants SET deleted_at = ?, updated_at = ? WHERE item_id = ? AND deleted_at IS NULL", [now, now, id]);
  });
}

/** Swaps a category with its neighbour, or an item with its neighbour in the same category. Does nothing at either end. */
export function moveInList(db: SqlDriver, table: "categories" | "items", id: string, direction: "up" | "down", now: number): void {
  write(db, () => {
    const row = table === "categories"
      ? db.get<{ id: string; sort: number; category_id?: string }>("SELECT id, sort FROM categories WHERE id = ? AND deleted_at IS NULL", [id])
      : db.get<{ id: string; sort: number; category_id?: string }>("SELECT id, sort, category_id FROM items WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!row) throw new MenuError("not_found", "This entry no longer exists");
    const siblings = table === "categories"
      ? db.all<{ id: string; sort: number }>("SELECT id, sort FROM categories WHERE deleted_at IS NULL ORDER BY sort, id")
      : db.all<{ id: string; sort: number }>("SELECT id, sort FROM items WHERE category_id = ? AND deleted_at IS NULL ORDER BY sort, id", [row.category_id]);
    const at = siblings.findIndex((s) => s.id === id);
    const other = siblings[direction === "up" ? at - 1 : at + 1];
    if (!other) return;
    // Renumber so equal sort values cannot make the swap a no-op.
    const order = siblings.map((s) => s.id);
    [order[at], order[siblings.indexOf(other)]] = [other.id, id];
    order.forEach((rowId, index) => db.run(`UPDATE ${table} SET sort = ?, updated_at = ? WHERE id = ?`, [index + 1, now, rowId]));
  });
}

/** Our own small starter menu, all at the cafe's default GST rate. Adds nothing when the menu already has entries. */
export function seedSampleMenu(db: SqlDriver, now: number): void {
  const sample: Array<[string, Array<[string, number]>]> = [
    ["Hot Drinks", [["Tea", 1500], ["Coffee", 2000], ["Masala Chai", 2000]]],
    ["Cold Drinks", [["Cold Coffee", 6000], ["Lemon Soda", 4000]]],
    ["Snacks", [["Samosa", 1800], ["Veg Sandwich", 5000], ["Bun Maska", 3000]]],
  ];
  write(db, () => {
    if (db.get("SELECT id FROM categories WHERE deleted_at IS NULL") || db.get("SELECT id FROM items WHERE deleted_at IS NULL")) return;
    sample.forEach(([category, items], c) => {
      const categoryId = uuidv7();
      db.run("INSERT INTO categories (id, name, sort, updated_at) VALUES (?, ?, ?, ?)", [categoryId, category, c + 1, now]);
      items.forEach(([name, pricePaise], i) => {
        db.run("INSERT INTO items (id, category_id, name, price_paise, gst_rate, available, sort, updated_at) VALUES (?, ?, ?, ?, NULL, 1, ?, ?)",
          [uuidv7(), categoryId, name, pricePaise, i + 1, now]);
      });
    });
  });
}
