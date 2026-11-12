import { describe, expect, it } from "vitest";
import { saveCafe } from "./cafe.js";
import { base } from "./testing/fixtures.js";
import {
  deleteCategory, deleteItem, listMenu, MenuError, moveInList, saveCategory, saveItem, seedSampleMenu, setItemAvailable,
} from "./menu.js";
import { memoryCafeDb } from "./testing/sqlite-driver.js";

const menuError = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof MenuError ? e.code : e; }
  return "no error";
};

describe("menu", () => {
  it("lists categories and items in order, with variants", () => {
    const db = memoryCafeDb();
    const tea = saveCategory(db, { name: "Tea" }, 1), snacks = saveCategory(db, { name: "Snacks" }, 2);
    const chai = saveItem(db, { categoryId: tea.id, name: "Masala Chai", pricePaise: 2000, gstRate: null, variants: [{ name: "Small", pricePaise: 1500 }, { name: "Large", pricePaise: 2500 }] }, 3);
    saveItem(db, { categoryId: snacks.id, name: "Samosa", pricePaise: 1800, gstRate: 5, variants: [] }, 4);
    const menu = listMenu(db);
    expect(menu.categories.map((c) => c.name)).toEqual(["Tea", "Snacks"]);
    expect(menu.items.map((i) => i.name)).toEqual(["Masala Chai", "Samosa"]);
    expect(menu.items[0]!.variants.map((v) => [v.name, v.pricePaise])).toEqual([["Small", 1500], ["Large", 2500]]);
    expect(chai.available).toBe(true);
  });

  it("replaces an item's variants and soft-deletes the ones left out", () => {
    const db = memoryCafeDb();
    const tea = saveCategory(db, { name: "Tea" }, 1);
    const chai = saveItem(db, { categoryId: tea.id, name: "Masala Chai", pricePaise: 2000, gstRate: null, variants: [{ name: "Small", pricePaise: 1500 }, { name: "Large", pricePaise: 2500 }] }, 2);
    const small = chai.variants.find((v) => v.name === "Small")!, large = chai.variants.find((v) => v.name === "Large")!;
    const saved = saveItem(db, { id: chai.id, categoryId: tea.id, name: "Masala Chai", pricePaise: 2000, gstRate: null, variants: [{ id: small.id, name: "Small", pricePaise: 1500 }] }, 3);
    expect(saved.variants.map((v) => v.id)).toEqual([small.id]);
    expect(listMenu(db).items[0]!.variants).toHaveLength(1);
    expect(db.get<{ deleted_at: number | null }>("SELECT deleted_at FROM item_variants WHERE id = ?", [large.id])!.deleted_at).toBe(3);
  });

  it("rejects a duplicate category name whatever its case", () => {
    const db = memoryCafeDb();
    saveCategory(db, { name: "Tea" }, 1);
    expect(menuError(() => saveCategory(db, { name: " tea " }, 2))).toBe("duplicate_name");
  });

  it("will not delete a category that still has items", () => {
    const db = memoryCafeDb();
    const tea = saveCategory(db, { name: "Tea" }, 1);
    const chai = saveItem(db, { categoryId: tea.id, name: "Chai", pricePaise: 1500, gstRate: null, variants: [] }, 2);
    expect(menuError(() => deleteCategory(db, tea.id, 3))).toBe("category_not_empty");
    deleteItem(db, chai.id, 4);
    deleteCategory(db, tea.id, 5);
    expect(listMenu(db).categories).toEqual([]);
  });

  it("hides deleted items and keeps unavailable ones", () => {
    const db = memoryCafeDb();
    const tea = saveCategory(db, { name: "Tea" }, 1);
    const chai = saveItem(db, { categoryId: tea.id, name: "Chai", pricePaise: 1500, gstRate: null, variants: [] }, 2);
    setItemAvailable(db, chai.id, false, 3);
    expect(listMenu(db).items).toMatchObject([{ id: chai.id, available: false }]);
    deleteItem(db, chai.id, 4);
    expect(listMenu(db).items).toEqual([]);
  });

  it("moves a category up and down and stops at the ends", () => {
    const db = memoryCafeDb();
    const a = saveCategory(db, { name: "A" }, 1);
    saveCategory(db, { name: "B" }, 2);
    const c = saveCategory(db, { name: "C" }, 3);
    const names = () => listMenu(db).categories.map((x) => x.name);
    moveInList(db, "categories", c.id, "up", 4);
    expect(names()).toEqual(["A", "C", "B"]);
    moveInList(db, "categories", a.id, "up", 5);
    expect(names()).toEqual(["A", "C", "B"]);
    moveInList(db, "categories", c.id, "down", 6);
    expect(names()).toEqual(["A", "B", "C"]);
    moveInList(db, "categories", c.id, "down", 7);
    expect(names()).toEqual(["A", "B", "C"]);
  });

  it("rejects an empty name and a price above one lakh rupees", () => {
    const db = memoryCafeDb();
    const tea = saveCategory(db, { name: "Tea" }, 1);
    expect(menuError(() => saveItem(db, { categoryId: tea.id, name: "  ", pricePaise: 100, gstRate: null, variants: [] }, 2))).toBe("invalid");
    expect(menuError(() => saveItem(db, { categoryId: tea.id, name: "Chai", pricePaise: 10_000_001, gstRate: null, variants: [] }, 2))).toBe("invalid");
    expect(menuError(() => saveCategory(db, { name: "  " }, 2))).toBe("invalid");
  });

  it("seeds a small sample menu only into an empty menu", () => {
    const db = memoryCafeDb();
    saveCafe(db, base, 1);
    seedSampleMenu(db, 2);
    const menu = listMenu(db);
    expect(menu.categories).toHaveLength(3);
    expect(menu.items).toHaveLength(8);
    seedSampleMenu(db, 3);
    expect(listMenu(db).categories).toHaveLength(3);
    expect(listMenu(db).items).toHaveLength(8);
  });
});
