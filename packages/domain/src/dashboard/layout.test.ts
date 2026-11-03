import { describe, expect, it } from "vitest";
import { DashboardLayout, defaultLayout, percentChange } from "./layout.js";
import { widgetDef, widgetVisible } from "./widgets.js";

const item = (key: string, x: number, y: number, w = 3, h = 2, widget = "netSales") => ({ key, widget, x, y, w, h, options: {} });
const layout = (items: unknown[]) => ({ version: 1, items });

describe("dashboard layout", () => {
  it("the default layout is valid and fits the grid", () => {
    expect(() => DashboardLayout.parse(defaultLayout())).not.toThrow();
  });

  it("fills option defaults", () => {
    const parsed = DashboardLayout.parse(layout([item("a", 0, 0)]));
    expect(parsed.items[0]!.options).toEqual({ period: "today", compare: "previous", orderType: "all", topN: 5 });
  });

  it("accepts fractional positions and sizes without changing them", () => {
    const value = item("free", 1.125, 3.375, 3.625, 2.125);
    expect(DashboardLayout.parse(layout([value])).items[0]).toMatchObject({ x: 1.125, y: 3.375, w: 3.625, h: 2.125 });
    expect(() => DashboardLayout.parse(layout([{ ...value, y: Infinity }]))).toThrow();
  });

  it("rejects overlaps, duplicate keys, items off the grid, sizes outside a widget's limits, unknown widgets and more than 30 items", () => {
    expect(() => DashboardLayout.parse(layout([item("a", 0, 0), item("b", 2, 0)]))).toThrow();
    expect(() => DashboardLayout.parse(layout([item("a", 0, 0), item("a", 3, 0)]))).toThrow();
    expect(() => DashboardLayout.parse(layout([item("a", 10, 0)]))).toThrow();
    expect(() => DashboardLayout.parse(layout([item("a", 0, 0, 1, 2)]))).toThrow();
    expect(() => DashboardLayout.parse(layout([item("a", 0, 0, 7, 2)]))).toThrow();
    expect(() => DashboardLayout.parse(layout([item("a", 0, 0, 3, 2, "nope")]))).toThrow();
    const many = Array.from({ length: 31 }, (_, i) => item(`k${i}`, (i % 4) * 3, Math.floor(i / 4) * 2));
    expect(() => DashboardLayout.parse(layout(many))).toThrow();
  });

  it("percentChange handles a zero or negative base", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(0, 0)).toBeNull();
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(-50, -100)).toBe(50);
    expect(percentChange(1, 3)).toBe(-66.7);
  });

  it("hides widgets whose permission or module is missing", () => {
    const def = widgetDef("lowStock");
    expect(widgetVisible(def, () => true, (m) => m !== "inventory")).toBe(false);
    expect(widgetVisible(def, () => false, () => true)).toBe(false);
    expect(widgetVisible(def, () => true, () => true)).toBe(true);
  });
});
