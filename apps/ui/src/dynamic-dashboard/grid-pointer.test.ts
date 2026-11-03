import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardGrid } from "./DashboardGrid";
import { moveItem } from "@masalapos/domain/dashboard";
import { EDIT_ROW_HEIGHT_PX, alignRect, cellFromPointer, keyboardChange } from "./grid-pointer";

describe("nearby widget alignment", () => {
  const limits = { min: { w: 2, h: 2 }, max: { w: 6, h: 6 } };
  const pitch = { x: 100, y: 100 };
  const peer = { key: "peer", x: 6, y: 1, w: 3, h: 2 };

  it("settles a card beside its neighbour without pushing the neighbour down", () => {
    const start = { key: "moving", x: 0, y: 4, w: 3, h: 2 };
    const aligned = alignRect({ ...start, x: 3.09, y: 1.07 }, [peer], "move", pitch, limits);
    expect(aligned).toMatchObject({ x: 3, y: 1 });
    const placed = moveItem([start, peer], start.key, aligned, limits);
    expect(placed[1]).toEqual(peer);
    expect((peer.x - aligned.x - aligned.w) * pitch.x + 12).toBe(12);
  });

  it("aligns right and bottom edges for differently sized cards", () => {
    expect(alignRect({ x: 4.93, y: 0.93, w: 4, h: 2 }, [peer], "move", pitch, limits)).toMatchObject({ x: 5, y: 1 });
    expect(alignRect({ x: 2.5, y: 0.95, w: 2, h: 3 }, [{ x: 6, y: 2, w: 2, h: 2 }], "move", pitch, limits).y).toBe(1);
  });

  it("keeps free movement beyond the pixel threshold at different widths", () => {
    const raw = { x: 2.5, y: 4.5, w: 3, h: 2 };
    expect(alignRect(raw, [peer], "move", pitch, limits)).toEqual(raw);
    const near = { ...raw, x: 3.1 };
    expect(alignRect(near, [peer], "move", pitch, limits).x).toBe(3);
    expect(alignRect(near, [peer], "move", { x: 200, y: 100 }, limits).x).toBe(3.1);
  });

  it("aligns resize edges and gaps while respecting size limits", () => {
    expect(alignRect({ x: 3, y: 0, w: 5.92, h: 2.93 }, [peer], "resize", pitch, limits)).toMatchObject({ w: 6, h: 3 });
    expect(alignRect({ x: 3, y: 0, w: 3.09, h: 2 }, [peer], "resize", pitch, limits).w).toBe(3);
    expect(alignRect({ x: 3, y: 0, w: 2.05, h: 2 }, [{ x: 4.95, y: 1, w: 3, h: 2 }], "resize", pitch, limits).w).toBe(2.05);
  });
});

describe("grid pointer maths", () => {
  it("preserves sub-cell pointer movement", () => {
    expect(cellFromPointer(13, 17, 100, { x: 2, y: 1, w: 3, h: 2 }, "move")).toEqual({ x: 2.13, y: 1.25 });
  });

  it("preserves sub-cell resize distances", () => {
    expect(cellFromPointer(13, 17, 100, { x: 0, y: 0, w: 3, h: 2 }, "resize")).toEqual({ w: 3.13, h: 2.25 });
  });

  it("uses the taller editor rows when moving and resizing", () => {
    const start = { x: 0, y: 0, w: 3, h: 2 };
    expect(cellFromPointer(0, 140, 100, start, "move", EDIT_ROW_HEIGHT_PX)).toEqual({ x: 0, y: 1.4 });
    expect(cellFromPointer(0, 200, 100, start, "resize", EDIT_ROW_HEIGHT_PX)).toEqual({ w: 3, h: 4 });
  });

  it("returns no change when the cell width is not usable", () => {
    expect(cellFromPointer(50, 0, 0, { x: 2, y: 1, w: 3, h: 2 }, "move")).toEqual({ x: 2, y: 1 });
    expect(cellFromPointer(Number.NaN, 17, 100, { x: 2, y: 1, w: 3, h: 2 }, "resize")).toEqual({ w: 3, h: 2.25 });
  });

  it("maps arrows to moves and shift-arrows to resizes", () => {
    const item = { x: 2, y: 0, w: 4, h: 2 };
    expect(keyboardChange("ArrowLeft", true, item, { x: 0.08, y: 0.08 })).toEqual({ size: { w: 3.92, h: 2 } });
    expect(keyboardChange("ArrowRight", false, item, { x: 0.01, y: 0.01 })).toEqual({ move: { x: 2.01, y: 0 } });
    expect(keyboardChange("ArrowDown", true, item, { x: 0.08, y: 0.08 })).toEqual({ size: { w: 4, h: 2.08 } });
    expect(keyboardChange("a", false, item)).toBeNull();
  });
});

const item = (key: string, x: number, y: number, w: number, h: number) => ({ key, widget: "netSales", x, y, w, h, options: {} }) as never;

describe("DashboardGrid", () => {
  const items = [item("b", 6, 0, 3, 2), item("a", 0, 0, 3, 2)];
  const base = { items, editing: false, onChange: () => {}, renderItem: (i: { key: string }) => `item-${i.key}`, renderTools: () => "tools" };

  it("places items proportionally on a free canvas and stacks them on narrow screens", () => {
    const wide = renderToStaticMarkup(createElement(DashboardGrid, { ...base, narrow: false }));
    expect(wide).toContain("left:calc(0% + 0px)");
    expect(wide).toContain("width:calc(25% - 9px)");
    expect(wide).toContain("height:124px");
    expect(wide).not.toContain("grid-column");
    const narrow = renderToStaticMarkup(createElement(DashboardGrid, { ...base, narrow: true, editing: true }));
    expect(narrow.indexOf("item-a")).toBeGreaterThan(-1);
    expect(narrow.indexOf("item-a")).toBeLessThan(narrow.indexOf("item-b"));
    expect(narrow).not.toContain("tools");
    expect(narrow).not.toContain("grid-column");
  });
});
