import { GRID_COLUMNS, type GridRect, type GridSize, type SizeLimits } from "@masalapos/domain/dashboard";

export const ROW_HEIGHT_PX = 56;
export const EDIT_ROW_HEIGHT_PX = 88;
export const GAP_PX = 12;
const ALIGN_DISTANCE_PX = 12;

/** Align nearby visible edges or leave one standard gap between cards, before collision resolution. */
export function alignRect(rect: GridRect, others: readonly GridRect[], mode: "move" | "resize", pitch: { x: number; y: number }, limits: SizeLimits): GridRect {
  const nearest = (value: number, candidates: number[], scale: number, min: number, max: number) => {
    let result = value;
    let distance = ALIGN_DISTANCE_PX + 1e-9;
    for (const candidate of candidates) {
      const delta = Math.abs(candidate - value) * scale;
      if (candidate >= min && candidate <= max && delta < distance) {
        result = candidate;
        distance = delta;
      }
    }
    return result;
  };
  if (mode === "move") {
    return {
      ...rect,
      x: nearest(rect.x, [0, GRID_COLUMNS - rect.w, ...others.flatMap((o) => [o.x, o.x + o.w - rect.w, o.x + o.w, o.x - rect.w])], pitch.x, 0, GRID_COLUMNS - rect.w),
      y: nearest(rect.y, [0, ...others.flatMap((o) => [o.y, o.y + o.h - rect.h, o.y + o.h, o.y - rect.h])], pitch.y, 0, Infinity),
    };
  }
  return {
    ...rect,
    w: nearest(rect.w, [GRID_COLUMNS - rect.x, ...others.flatMap((o) => [o.x + o.w - rect.x, o.x - rect.x])], pitch.x, limits.min.w, Math.min(limits.max.w, GRID_COLUMNS - rect.x)),
    h: nearest(rect.h, others.flatMap((o) => [o.y + o.h - rect.y, o.y - rect.y]), pitch.y, limits.min.h, limits.max.h),
  };
}

/** Fractional layout units for a pixel distance, never NaN or infinite. */
function cells(distance: number, step: number): number {
  if (!Number.isFinite(distance) || !Number.isFinite(step) || step <= 0) return 0;
  return distance / step;
}

/**
 * Converts pointer distances without snapping.
 * `cellWidth` is the full distance from one column to the next (cell plus gap).
 * The component includes the trailing gap in the canvas width before dividing by 12.
 * Editing uses taller rows to leave room for the widget controls.
 * Results are not clamped; moveItem and resizeItem do that.
 * A zero or negative cell width means "no change" for columns.
 */
export function cellFromPointer(dx: number, dy: number, cellWidth: number, start: GridRect, mode: "move" | "resize", rowHeight = ROW_HEIGHT_PX): { x: number; y: number } | GridSize {
  const columns = cells(dx, cellWidth);
  const rows = cells(dy, rowHeight + GAP_PX);
  if (mode === "move") return { x: start.x + columns, y: start.y + rows };
  return { w: start.w + columns, h: start.h + rows };
}

const ARROWS: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
};

/** Arrow keys nudge; Shift with an arrow resizes. The component supplies pixel-based steps. */
export function keyboardChange(key: string, shift: boolean, item: GridRect, amount = { x: 0.1, y: 0.1 }): { move?: { x: number; y: number }; size?: GridSize } | null {
  const step = ARROWS[key];
  if (!step) return null;
  if (shift) return { size: { w: item.w + step.dx * amount.x, h: item.h + step.dy * amount.y } };
  return { move: { x: item.x + step.dx * amount.x, y: item.y + step.dy * amount.y } };
}
