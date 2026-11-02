import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardGrid } from "./DashboardGrid";
import { cellFromPointer, keyboardChange } from "./grid-pointer";

describe("grid pointer maths", () => {
  it("snaps a drag to the nearest cell", () => {
    expect(cellFromPointer(160, -70, 100, { x: 2, y: 1, w: 3, h: 2 }, "move")).toEqual({ x: 4, y: 0 });
  });

  it("snaps a resize from the corner", () => {
    expect(cellFromPointer(210, 140, 100, { x: 0, y: 0, w: 3, h: 2 }, "resize")).toEqual({ w: 5, h: 4 });
  });

  it("returns no change when the cell width is not usable", () => {
    expect(cellFromPointer(50, 0, 0, { x: 2, y: 1, w: 3, h: 2 }, "move")).toEqual({ x: 2, y: 1 });
    expect(cellFromPointer(Number.NaN, 50, 100, { x: 2, y: 1, w: 3, h: 2 }, "resize")).toEqual({ w: 3, h: 3 });
  });

  it("maps arrows to moves and shift-arrows to resizes", () => {
    const item = { x: 2, y: 0, w: 4, h: 2 };
    expect(keyboardChange("ArrowLeft", true, item)).toEqual({ size: { w: 3, h: 2 } });
    expect(keyboardChange("ArrowRight", false, item)).toEqual({ move: { x: 3, y: 0 } });
    expect(keyboardChange("ArrowDown", true, item)).toEqual({ size: { w: 4, h: 3 } });
    expect(keyboardChange("a", false, item)).toBeNull();
  });
});

const item = (key: string, x: number, y: number, w: number, h: number) => ({ key, widget: "netSales", x, y, w, h, options: {} }) as never;

describe("DashboardGrid", () => {
  const items = [item("b", 6, 0, 3, 2), item("a", 0, 0, 3, 2)];
  const base = { items, editing: false, onChange: () => {}, renderItem: (i: { key: string }) => `item-${i.key}`, renderTools: () => "tools" };

  it("places items by grid column and row, and stacks them on narrow screens", () => {
    const wide = renderToStaticMarkup(createElement(DashboardGrid, { ...base, narrow: false }));
    expect(wide).toContain("grid-column:1 / span 3");
    expect(wide).toContain("grid-row:1 / span 2");
    const narrow = renderToStaticMarkup(createElement(DashboardGrid, { ...base, narrow: true, editing: true }));
    expect(narrow.indexOf("item-a")).toBeGreaterThan(-1);
    expect(narrow.indexOf("item-a")).toBeLessThan(narrow.indexOf("item-b"));
    expect(narrow).not.toContain("tools");
    expect(narrow).not.toContain("grid-column");
  });
});
