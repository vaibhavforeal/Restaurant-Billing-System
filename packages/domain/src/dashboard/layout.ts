import { z } from "zod";
import { DASHBOARD_COMPARES, DASHBOARD_PERIODS } from "./periods.js";
import { GRID_COLUMNS, collides } from "./grid.js";
import { DASHBOARD_WIDGET_IDS, widgetDef } from "./widgets.js";

export const DASHBOARD_LIMITS = { items: 30 } as const;

export const WidgetOptions = z.object({
  period: z.enum(DASHBOARD_PERIODS).default("today"),
  compare: z.enum(DASHBOARD_COMPARES).default("previous"),
  orderType: z.enum(["all", "parcel", "dine_in", "zomato"]).default("all"),
  topN: z.number().int().min(3).max(20).default(5),
}).strict();
export type WidgetOptionsValue = z.output<typeof WidgetOptions>;

export const DashboardItem = z.object({
  key: z.string().min(1).max(40),
  widget: z.enum(DASHBOARD_WIDGET_IDS),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(0),
  h: z.number().int().min(0),
  options: WidgetOptions,
});
export type DashboardItemValue = z.output<typeof DashboardItem>;

export const DashboardLayout = z.object({
  version: z.literal(1),
  items: z.array(DashboardItem).max(DASHBOARD_LIMITS.items),
}).superRefine((layout, ctx) => {
  const seen = new Set<string>();
  layout.items.forEach((item, i) => {
    if (seen.has(item.key)) ctx.addIssue({ code: "custom", path: ["items", i, "key"], message: "Duplicate widget key" });
    seen.add(item.key);

    if (item.x + item.w > GRID_COLUMNS) {
      ctx.addIssue({ code: "custom", path: ["items", i, "x"], message: `Widget goes past column ${GRID_COLUMNS}` });
    }
    const { min, max } = widgetDef(item.widget).limits;
    if (item.w < min.w || item.w > max.w) {
      ctx.addIssue({ code: "custom", path: ["items", i, "w"], message: `Width must be ${min.w} to ${max.w}` });
    }
    if (item.h < min.h || item.h > max.h) {
      ctx.addIssue({ code: "custom", path: ["items", i, "h"], message: `Height must be ${min.h} to ${max.h}` });
    }
    for (let j = 0; j < i; j++) {
      if (collides(item, layout.items[j]!)) {
        ctx.addIssue({ code: "custom", path: ["items", i], message: "Widget overlaps another widget" });
        break;
      }
    }
  });
});
export type DashboardLayoutValue = z.output<typeof DashboardLayout>;

/** The layout a new install starts with. It mirrors the old fixed dashboard. */
export function defaultLayout(): DashboardLayoutValue {
  const options = WidgetOptions.parse({});
  const places = [
    ["netSales", 0, 0, 3, 2], ["billCount", 3, 0, 3, 2], ["averageBill", 6, 0, 3, 2], ["discounts", 9, 0, 3, 2],
    ["hourlySales", 0, 2, 6, 4], ["paymentMix", 6, 2, 6, 4],
    ["orderTypeSplit", 0, 6, 6, 4], ["topItems", 6, 6, 6, 4],
    ["openTables", 0, 10, 3, 2], ["unsettledBills", 3, 10, 3, 2],
  ] as const;
  return {
    version: 1,
    items: places.map(([widget, x, y, w, h], i) => ({ key: `default-${i + 1}`, widget, x, y, w, h, options: { ...options } })),
  };
}

/** Change from the previous value as a percentage with one decimal. Null when there is no base to compare against. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  const rounded = Math.round(((current - previous) / Math.abs(previous)) * 100 * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}
