/** Number of columns in the dashboard grid. Rows are unbounded. */
export const GRID_COLUMNS = 12;

export interface GridSize {
  w: number;
  h: number;
}

export interface GridRect extends GridSize {
  x: number;
  y: number;
}

export interface GridItem extends GridRect {
  key: string;
}

export interface SizeLimits {
  min: GridSize;
  max: GridSize;
}

/** True only when the two rectangles share at least one cell. Touching edges do not count. */
export function collides(a: GridRect, b: GridRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Rounds to whole cells, keeps w/h inside the limits, then keeps the item inside the grid columns and below row 0. */
export function clampItem<T extends GridItem>(item: T, limits: SizeLimits): T {
  const w = clamp(Math.round(item.w), limits.min.w, Math.min(limits.max.w, GRID_COLUMNS));
  const h = clamp(Math.round(item.h), limits.min.h, limits.max.h);
  const x = clamp(Math.round(item.x), 0, GRID_COLUMNS - w);
  const y = Math.max(Math.round(item.y), 0);
  return { ...item, x, y, w, h };
}

function readingOrder(a: GridItem, b: GridItem): number {
  return a.y - b.y || a.x - b.x || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Copies of the items sorted top to bottom, then left to right, then by key. */
export function stackOrder<T extends GridItem>(items: readonly T[]): T[] {
  return items.map((i) => ({ ...i })).sort(readingOrder);
}

/** Lets every item rise as far as it can without touching an item already placed above it. */
export function compact<T extends GridItem>(items: readonly T[]): T[] {
  const placed: T[] = [];
  for (const item of stackOrder(items)) {
    let y = 0;
    for (const other of placed) {
      if (item.x < other.x + other.w && other.x < item.x + item.w) y = Math.max(y, other.y + other.h);
    }
    placed.push({ ...item, y });
  }
  return placed;
}

/**
 * Puts the target where the user dropped it, then pushes colliding items down until nothing overlaps.
 * Every push moves an item strictly lower and the total height is bounded, so the loop always ends.
 */
function place<T extends GridItem>(items: readonly T[], target: T): T[] {
  const out: T[] = items.map((i) => (i.key === target.key ? target : { ...i }));
  for (;;) {
    let pushed = false;
    for (let i = 0; i < out.length && !pushed; i++) {
      for (let j = i + 1; j < out.length && !pushed; j++) {
        const a = out[i]!;
        const b = out[j]!;
        if (!collides(a, b)) continue;
        // The target always stays put; otherwise the lower item gives way.
        const giveWay = a.key === target.key ? j : b.key === target.key ? i : readingOrder(a, b) <= 0 ? j : i;
        const stays = giveWay === i ? b : a;
        out[giveWay] = { ...out[giveWay]!, y: stays.y + stays.h };
        pushed = true;
      }
    }
    if (!pushed) return compact(out);
  }
}

export function moveItem<T extends GridItem>(
  items: readonly T[],
  key: string,
  to: { x: number; y: number },
  limits: SizeLimits,
): T[] {
  const current = items.find((i) => i.key === key);
  if (!current) return items as T[];
  return place(items, clampItem({ ...current, x: to.x, y: to.y }, limits));
}

export function resizeItem<T extends GridItem>(
  items: readonly T[],
  key: string,
  size: GridSize,
  limits: SizeLimits,
): T[] {
  const current = items.find((i) => i.key === key);
  if (!current) return items as T[];
  return place(items, clampItem({ ...current, w: size.w, h: size.h }, limits));
}
