import type { ModuleId } from "../modules.js";
import type { GridSize, SizeLimits } from "./grid.js";

export const DASHBOARD_WIDGET_IDS = [
  "netSales", "billCount", "averageBill", "discounts", "gstCollected", "creditNotes", "outstanding", "cashCollected", "upiCollected", "cardCollected", "cancellations",
  "hourlySales", "dailyTrend", "paymentMix", "orderTypeSplit", "topItems", "topCategories",
  "openTables", "runningKots", "pendingQr", "lowStock", "unsettledBills",
] as const;
export type DashboardWidgetId = typeof DASHBOARD_WIDGET_IDS[number];

export type WidgetKind = "kpi" | "chart" | "status";

export interface WidgetDef {
  id: DashboardWidgetId;
  title: string;
  description: string;
  kind: WidgetKind;
  defaultSize: GridSize;
  limits: SizeLimits;
  requires: { permissions: readonly string[]; modules: readonly ModuleId[] };
  options: { period: boolean; compare: boolean; orderType: boolean; topN: boolean };
}

const KPI_LIMITS: SizeLimits = { min: { w: 2, h: 2 }, max: { w: 6, h: 3 } };
const WIDE_CHART_LIMITS: SizeLimits = { min: { w: 4, h: 3 }, max: { w: 12, h: 8 } };
const SHORT_CHART_LIMITS: SizeLimits = { min: { w: 4, h: 3 }, max: { w: 12, h: 6 } };
const STATUS_LIMITS: SizeLimits = { min: { w: 2, h: 2 }, max: { w: 6, h: 4 } };

const REPORTS: WidgetDef["requires"] = { permissions: ["reports.read"], modules: ["reports"] };

function kpi(id: DashboardWidgetId, title: string, description: string): WidgetDef {
  return {
    id, title, description, kind: "kpi",
    defaultSize: { w: 3, h: 2 }, limits: KPI_LIMITS, requires: REPORTS,
    options: { period: true, compare: true, orderType: false, topN: false },
  };
}

function chart(
  id: DashboardWidgetId, title: string, description: string, limits: SizeLimits,
  options: Partial<WidgetDef["options"]>,
): WidgetDef {
  return {
    id, title, description, kind: "chart",
    defaultSize: { w: 6, h: 4 }, limits, requires: REPORTS,
    options: { period: true, compare: false, orderType: false, topN: false, ...options },
  };
}

function status(
  id: DashboardWidgetId, title: string, description: string,
  requires: WidgetDef["requires"],
): WidgetDef {
  return {
    id, title, description, kind: "status",
    defaultSize: { w: 3, h: 2 }, limits: STATUS_LIMITS, requires,
    options: { period: false, compare: false, orderType: false, topN: false },
  };
}

export const DASHBOARD_WIDGETS: readonly WidgetDef[] = [
  kpi("netSales", "Net sales", "Sales after discounts and credit notes."),
  kpi("billCount", "Bills", "Number of bills settled."),
  kpi("averageBill", "Average bill", "Net sales divided by the number of bills."),
  kpi("discounts", "Discounts", "Total discount given on bills."),
  kpi("gstCollected", "GST collected", "Tax collected on settled bills."),
  kpi("creditNotes", "Credit notes", "Value of refunds issued through credit notes."),
  kpi("outstanding", "Outstanding", "Amount still owed on unpaid bills."),
  kpi("cashCollected", "Cash collected", "Payments received in cash."),
  kpi("upiCollected", "UPI collected", "Payments received through UPI."),
  kpi("cardCollected", "Card collected", "Payments received by card."),
  kpi("cancellations", "Cancellations", "Number of bills and orders cancelled."),
  chart("hourlySales", "Sales by hour", "Sales for each hour of the day.", WIDE_CHART_LIMITS, { compare: true, orderType: true }),
  chart("dailyTrend", "Daily trend", "Sales for each day in the period.", WIDE_CHART_LIMITS, { compare: true, orderType: true }),
  chart("paymentMix", "Payment mix", "How much was paid by each payment method.", SHORT_CHART_LIMITS, { compare: true }),
  chart("orderTypeSplit", "Order types", "Sales split between dine-in, parcel and Zomato.", SHORT_CHART_LIMITS, { compare: true }),
  chart("topItems", "Top items", "Best selling items by sales.", WIDE_CHART_LIMITS, { orderType: true, topN: true }),
  chart("topCategories", "Top categories", "Best selling categories by sales.", WIDE_CHART_LIMITS, { orderType: true, topN: true }),
  status("openTables", "Open tables", "Tables with a running order right now.", { permissions: ["tables.read"], modules: [] }),
  status("runningKots", "Running KOTs", "Kitchen tickets still being cooked.", { permissions: ["kots.read"], modules: ["kds"] }),
  status("pendingQr", "Pending QR orders", "QR orders waiting to be accepted.", { permissions: ["orders.read"], modules: ["qrOrdering"] }),
  status("lowStock", "Low stock", "Ingredients at or below their reorder level.", { permissions: ["stock.read"], modules: ["inventory"] }),
  status("unsettledBills", "Unsettled bills", "Bills raised but not yet paid.", { permissions: ["bills.read"], modules: [] }),
];

export function widgetDef(id: DashboardWidgetId): WidgetDef {
  const def = DASHBOARD_WIDGETS.find((w) => w.id === id);
  if (!def) throw new Error(`Unknown dashboard widget: ${id}`);
  return def;
}

/** A widget shows only when the user has every permission it needs and every module it needs is active. */
export function widgetVisible(
  def: WidgetDef,
  can: (permission: string) => boolean,
  active: (module: ModuleId) => boolean,
): boolean {
  return def.requires.permissions.every(can) && def.requires.modules.every(active);
}
