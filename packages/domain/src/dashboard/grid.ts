/** Responsive coordinate width. Positions and sizes may be fractional; vertical space is unbounded. */
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

/** Touching edges and floating-point roundoff do not count as overlap. */
export function collides(a: GridRect, b: GridRect): boolean {
  const epsilon = 1e-9;
  return a.x < b.x + b.w - epsilon && b.x < a.x + a.w - epsilon && a.y < b.y + b.h - epsilon && b.y < a.y + a.h - epsilon;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Keeps fractional dimensions inside their limits and the item inside the canvas. */
export function clampItem<T extends GridItem>(item: T, limits: SizeLimits): T {
  const w = clamp(item.w, limits.min.w, Math.min(limits.max.w, GRID_COLUMNS));
  const h = clamp(item.h, limits.min.h, limits.max.h);
  const x = clamp(item.x, 0, GRID_COLUMNS - w);
  const y = Math.max(item.y, 0);
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

/** Repairs collisions in stored layouts while preserving deliberate empty space and input order. */
export function resolveOverlaps<T extends GridItem>(items: readonly T[]): T[] {
  const placed: T[] = [];
  for (const item of stackOrder(items)) {
    let next = item;
    for (;;) {
      const blockers = placed.filter((other) => collides(next, other));
      if (!blockers.length) break;
      next = { ...next, y: Math.max(...blockers.map((other) => other.y + other.h)) };
    }
    placed.push(next);
  }
  const byKey = new Map(placed.map((item) => [item.key, item]));
  return items.map((item) => byKey.get(item.key)!);
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
    if (!pushed) return out;
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
