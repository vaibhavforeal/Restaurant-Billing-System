import type { GridRect, GridSize } from "@masalapos/domain/dashboard";

export const ROW_HEIGHT_PX = 56;
export const GAP_PX = 12;

const ROW_STEP_PX = ROW_HEIGHT_PX + GAP_PX;

/** Whole number of cells for a pixel distance, never NaN or infinite. */
function cells(distance: number, step: number): number {
  if (!Number.isFinite(distance) || !Number.isFinite(step) || step <= 0) return 0;
  return Math.round(distance / step);
}

/**
 * Turns a pointer drag into a grid cell.
 * `cellWidth` is the full distance from one column to the next (cell plus gap).
 * The component measures it as the grid width divided by 12, so no extra gap is added here.
 * Rows are a fixed height, so their step is the row height plus the gap.
 * Results are not clamped; moveItem and resizeItem do that.
 * A zero or negative cell width means "no change" for columns.
 */
export function cellFromPointer(dx: number, dy: number, cellWidth: number, start: GridRect, mode: "move" | "resize"): { x: number; y: number } | GridSize {
  const columns = cells(dx, cellWidth);
  const rows = cells(dy, ROW_STEP_PX);
  if (mode === "move") return { x: start.x + columns, y: start.y + rows };
  return { w: start.w + columns, h: start.h + rows };
}

const ARROWS: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
};

/** Arrow keys move by one cell; Shift with an arrow resizes by one cell; any other key means nothing. */
export function keyboardChange(key: string, shift: boolean, item: GridRect): { move?: { x: number; y: number }; size?: GridSize } | null {
  const step = ARROWS[key];
  if (!step) return null;
  if (shift) return { size: { w: item.w + step.dx, h: item.h + step.dy } };
  return { move: { x: item.x + step.dx, y: item.y + step.dy } };
}
