import { describe, expect, it } from "vitest";
import { WidgetOptions, defaultLayout, widgetDef, type DashboardItemValue } from "@masalapos/domain/dashboard";
import { addWidget, removeWidget, updateOptions } from "./editing";
import { ApiError } from "../api";
import { isUnavailable } from "./useDashboardLayout";

const base = (): DashboardItemValue[] => defaultLayout().items;

describe("dashboard editing", () => {
  it("adds a widget below the others with its default size and options", () => {
    const items = base();
    const bottom = Math.max(...items.map((i) => i.y + i.h));
    const next = addWidget(items, "netSales", "new-1");
    const added = next.find((i) => i.key === "new-1")!;
    expect(next).toHaveLength(items.length + 1);
    expect(added).toMatchObject({ widget: "netSales", x: 0, y: bottom, ...widgetDef("netSales").defaultSize });
    expect(added.options).toEqual(WidgetOptions.parse({}));
    expect(items).toHaveLength(10);
  });

  it("removes a widget and closes the gap", () => {
    const items: DashboardItemValue[] = [
      { key: "a", widget: "netSales", x: 0, y: 0, w: 3, h: 2, options: WidgetOptions.parse({}) },
      { key: "b", widget: "billCount", x: 0, y: 2, w: 3, h: 2, options: WidgetOptions.parse({}) },
    ];
    const next = removeWidget(items, "a");
    expect(next.map((i) => i.key)).toEqual(["b"]);
    expect(next[0]!.y).toBe(0);
  });

  it("changes one widget's options and leaves the rest alone", () => {
    const items = base();
    const before = JSON.stringify(items);
    const next = updateOptions(items, "default-1", { period: "last7", compare: "none" });
    expect(next.find((i) => i.key === "default-1")!.options).toMatchObject({ period: "last7", compare: "none", topN: 5 });
    expect(next.filter((i) => i.key !== "default-1")).toEqual(items.filter((i) => i.key !== "default-1"));
    expect(JSON.stringify(items)).toBe(before);
  });
});

describe("isUnavailable", () => {
  it("is true for a 409, a module_off 403 and a forbidden 403", () => {
    expect(isUnavailable(new ApiError(409, "Dynamic Reports is switched off"))).toBe(true);
    expect(isUnavailable(new ApiError(403, "Not licensed", "module_off"))).toBe(true);
    expect(isUnavailable(new ApiError(403, "forbidden"))).toBe(true);
  });
  it("is false for a widget 403, a 400 and non-API errors", () => {
    expect(isUnavailable(new ApiError(403, "That widget is not available to you."))).toBe(false);
    expect(isUnavailable(new ApiError(400, "Your dashboard is full"))).toBe(false);
    expect(isUnavailable(new Error("forbidden"))).toBe(false);
  });
});
