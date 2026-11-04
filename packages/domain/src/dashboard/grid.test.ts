import { describe, expect, it } from "vitest";
import { clampItem, collides, compact, moveItem, resizeItem, resolveOverlaps, stackOrder, type GridItem, type SizeLimits } from "./grid.js";

const item = (key: string, x: number, y: number, w: number, h: number): GridItem => ({ key, x, y, w, h });
const LIMITS: SizeLimits = { min: { w: 2, h: 1 }, max: { w: 12, h: 6 } };
const byKey = (items: GridItem[], key: string) => items.find((i) => i.key === key)!;

/** Small seeded generator so the property test is repeatable. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function expectNoOverlap(items: readonly GridItem[]): void {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      expect(collides(items[i]!, items[j]!)).toBe(false);
    }
  }
}

describe("dashboard grid", () => {
  it("detects overlap only when rectangles share a cell", () => {
    expect(collides(item("a", 0, 0, 4, 2), item("b", 3, 1, 4, 2))).toBe(true);
    expect(collides(item("a", 0, 0, 4, 2), item("b", 4, 0, 4, 2))).toBe(false); // touching sides
    expect(collides(item("a", 0, 0, 4, 2), item("b", 0, 2, 4, 2))).toBe(false); // touching top and bottom
  });

  it("compacts items upward without overlaps", () => {
    const out = compact([item("a", 0, 3, 4, 2), item("b", 4, 0, 4, 2)]);
    expect(byKey(out, "a").y).toBe(0);
    expect(byKey(out, "b").y).toBe(0);
    const stacked = compact([item("a", 0, 5, 4, 2), item("b", 0, 9, 4, 2)]);
    expect(byKey(stacked, "a").y).toBe(0);
    expect(byKey(stacked, "b").y).toBe(2);
  });

  it("moves an item and pushes the one underneath down", () => {
    const items = [item("a", 0, 0, 6, 2), item("b", 0, 2, 6, 2)];
    const out = moveItem(items, "b", { x: 0, y: 0 }, LIMITS);
    expect(byKey(out, "b").y).toBe(0);
    expect(byKey(out, "a").y).toBe(2);
    expect(items[1]!.y).toBe(2); // input untouched
  });

  it("clamps moves and resizes to the grid and the widget's limits", () => {
    const items = [item("a", 0, 0, 4, 2)];
    const moved = moveItem(items, "a", { x: 11, y: -3 }, LIMITS);
    expect(byKey(moved, "a").x).toBe(8);
    expect(byKey(moved, "a").y).toBe(0);
    const resized = resizeItem(items, "a", { w: 20, h: 0 }, LIMITS);
    expect(byKey(resized, "a").w).toBe(12);
    expect(byKey(resized, "a").h).toBe(1);
    const free = moveItem(items, "a", { x: 2.6, y: 1.4 }, LIMITS);
    expect(byKey(free, "a")).toMatchObject({ x: 2.6, y: 1.4 });
    expect(clampItem(item("a", 2.6, 1.4, 3.5, 2.2), LIMITS)).toEqual(item("a", 2.6, 1.4, 3.5, 2.2));
  });

  it("retains the drop point and unrelated gaps when pushing a collision aside", () => {
    const items = [item("a", 0, 0, 3, 2), item("b", 3, 0, 3, 2), item("c", 8, 9.4, 3, 2)];
    const moved = moveItem(items, "a", { x: 0.13, y: 0.27 }, LIMITS);
    expect(byKey(moved, "a")).toMatchObject({ x: 0.13, y: 0.27 });
    expect(byKey(moved, "b").y).toBe(2.27);
    expect(byKey(moved, "c")).toEqual(items[2]);
    expectNoOverlap(moved);
  });

  it("repairs stored overlaps without compacting a valid free layout", () => {
    const items = [item("a", 0.2, 3.8, 3.1, 2), item("b", 0.2, 3.9, 3.1, 2), item("c", 8, 20, 3, 2)];
    const repaired = resolveOverlaps(items);
    expectNoOverlap(repaired);
    expect(byKey(repaired, "a")).toEqual(items[0]);
    expect(byKey(repaired, "c")).toEqual(items[2]);
    expect(resolveOverlaps(repaired)).toEqual(repaired);
  });

  it("keeps a resized item inside the grid when it grows past the right edge", () => {
    const out = resizeItem([item("a", 8, 0, 4, 2)], "a", { w: 8, h: 2 }, LIMITS);
    expect(byKey(out, "a").x).toBe(4);
    expect(byKey(out, "a").w).toBe(8);
  });

  it("returns the items unchanged for an unknown key", () => {
    const items = [item("a", 0, 0, 4, 2)];
    expect(moveItem(items, "zzz", { x: 1, y: 1 }, LIMITS)).toBe(items);
    expect(resizeItem(items, "zzz", { w: 3, h: 3 }, LIMITS)).toBe(items);
  });

  it("never leaves two items overlapping after any move", () => {
    const rand = mulberry32(20261102);
    let items: GridItem[] = [];
    for (let i = 0; i < 8; i++) items.push(item(`w${i}`, 0, i * 2, 3 + (i % 4), 2));
    items = compact(items);
    expectNoOverlap(items);
    for (let step = 0; step < 200; step++) {
      const key = `w${Math.floor(rand() * 8)}`;
      if (rand() < 0.5) {
        items = moveItem(items, key, { x: rand() * 16 - 2, y: rand() * 20 - 2 }, LIMITS);
      } else {
        items = resizeItem(items, key, { w: rand() * 14, h: rand() * 8 }, LIMITS);
      }
      expect(items).toHaveLength(8);
      expectNoOverlap(items);
      for (const it of items) {
        expect(it.x).toBeGreaterThanOrEqual(0);
        expect(it.x + it.w).toBeLessThanOrEqual(12);
        expect(it.y).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("stacks in reading order", () => {
    const out = stackOrder([item("c", 0, 2, 4, 2), item("b", 6, 0, 4, 2), item("a", 0, 0, 4, 2), item("d", 0, 0, 4, 2)]);
    expect(out.map((i) => i.key)).toEqual(["a", "d", "b", "c"]);
  });
});
