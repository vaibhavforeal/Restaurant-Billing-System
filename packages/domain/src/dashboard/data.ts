import { z } from "zod";
import type { DateRange } from "./periods.js";
import { DASHBOARD_LIMITS, WidgetOptions } from "./layout.js";
import { DASHBOARD_WIDGET_IDS } from "./widgets.js";

export const DashboardDataRequest = z.object({
  widgets: z.array(z.object({
    key: z.string().min(1).max(40),
    widget: z.enum(DASHBOARD_WIDGET_IDS),
    options: WidgetOptions,
  })).max(DASHBOARD_LIMITS.items),
}).strict();
export type DashboardDataRequestValue = z.output<typeof DashboardDataRequest>;

/** Money values are integer paise. */
export type ValueFormat = "money" | "count";

export type WidgetValue =
  | { kind: "number"; value: number; format: ValueFormat }
  | { kind: "series"; format: ValueFormat; points: Array<{ label: string; value: number }> }
  | { kind: "ranking"; rows: Array<{ label: string; value: number; qty: number }> }
  | { kind: "status"; count: number; amountPaise?: number; detail: string[] };

export type WidgetResult =
  | { ok: true; range: DateRange | null; current: WidgetValue; compareRange: DateRange | null; compare: WidgetValue | null }
  | { ok: false; error: string };

export interface DashboardData {
  results: Record<string, WidgetResult>;
  today: string;
  timezone: string;
  generatedAt: number;
}
