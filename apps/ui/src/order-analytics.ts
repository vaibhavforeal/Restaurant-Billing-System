import type { OrderAnalyticsReport } from "@forkflow/domain/operational-reports";
import { operationalCsv } from "./operational-report";
import { reportMoney } from "./sales-report";

export const orderTypeLabel = (type: "parcel" | "dine_in") => type === "parcel" ? "Quick takeaway" : "Table orders";
export const averageOrder = (totalPaise: number, count: number) => count ? Math.round(totalPaise / count) : 0;
/** The headline cards. Sales come from the server net of credit notes (voids and refunds). */
export function analyticsMetrics(report: OrderAnalyticsReport): Array<{ label: string; value: string; note: string }> {
  return [
    { label: "Billed orders", value: String(report.totals.orderCount), note: "Distinct orders with issued bills" },
    { label: "Net sales", value: reportMoney(report.totals.totalPaise), note: "After credit notes · incl. GST and rounding" },
    { label: "Items sold", value: String(report.totals.qty), note: "Net quantity across billed items" },
    { label: "Average order", value: reportMoney(averageOrder(report.totals.totalPaise, report.totals.orderCount)), note: "Net sales ÷ billed orders" },
  ];
}
export const orderShare = (count: number, total: number) => total ? count / total * 100 : 0;
export type ItemRanking = "quantity" | "sales";
export function rankedItems(report: OrderAnalyticsReport, ranking: ItemRanking) {
  return [...report.items].sort((a, b) => ranking === "sales"
    ? b.totalPaise - a.totalPaise || b.qty - a.qty || a.name.localeCompare(b.name)
    : b.qty - a.qty || b.totalPaise - a.totalPaise || a.name.localeCompare(b.name));
}

/** Export all rows from the displayed snapshot, including filtered data and the full comparison. */
export function analyticsCsv(report: OrderAnalyticsReport, ranking: ItemRanking): string {
  return operationalCsv({ ...report, kind: "analytics", notes: [
    "Order analytics. Issued bills by bill date; unpaid, complimentary and void bills included. Credit notes (voids and refunds) are taken off sales and quantities on the date they were made. Net sales include discounts, GST and rounding.",
    `Breakdown filter: ${report.orderType === "all" ? "All orders" : orderTypeLabel(report.orderType)}. Order comparison always includes both types.`,
    "Quick takeaway includes all parcel orders. Item/category order counts overlap. Item names, categories and prices are saved at billing.",
  ], tables: [
    { title: "Selected order type totals", columns: [{ key: "orderCount", label: "Billed orders" }, { key: "qty", label: "Items sold" }, { key: "totalPaise", label: "Net sales", format: "money" }, { key: "average", label: "Average order", format: "money" }], rows: [{ ...report.totals, average: averageOrder(report.totals.totalPaise, report.totals.orderCount) }] },
    { title: "Order comparison (all order types)", columns: [{ key: "name", label: "Order type" }, { key: "orderCount", label: "Billed orders" }, { key: "share", label: "Order share %" }, { key: "qty", label: "Items sold" }, { key: "totalPaise", label: "Net sales", format: "money" }, { key: "average", label: "Average order", format: "money" }], rows: report.comparison.map((row) => ({ ...row, name: orderTypeLabel(row.type), share: Number(orderShare(row.orderCount, report.comparison.reduce((sum, r) => sum + r.orderCount, 0)).toFixed(1)), average: averageOrder(row.totalPaise, row.orderCount) })) },
    { title: `Highest moving items (ranked by ${ranking})`, columns: [{ key: "name", label: "Item / variant" }, { key: "category", label: "Category" }, { key: "qty", label: "Quantity" }, { key: "takeawayQty", label: "Takeaway qty" }, { key: "tableQty", label: "Table qty" }, { key: "orderCount", label: "Billed orders" }, { key: "totalPaise", label: "Net sales", format: "money" }], rows: rankedItems(report, ranking).map((row) => ({ ...row })) },
    { title: "Category performance", columns: [{ key: "name", label: "Category" }, { key: "qty", label: "Quantity" }, { key: "orderCount", label: "Billed orders" }, { key: "totalPaise", label: "Net sales", format: "money" }], rows: report.categories.map((row) => ({ ...row })) },
    { title: "Daily order trend", columns: [{ key: "date", label: "Bill date" }, { key: "takeawayOrders", label: "Takeaway orders" }, { key: "tableOrders", label: "Table orders" }, { key: "totalPaise", label: "Net sales", format: "money" }], rows: report.daily.map((row) => ({ ...row })) },
    { title: "Busy hours", columns: [{ key: "hour", label: "Local hour" }, { key: "orderCount", label: "Billed orders" }, { key: "totalPaise", label: "Net sales", format: "money" }], rows: report.hourly.map((row) => ({ ...row, hour: `${String(row.hour).padStart(2, "0")}:00` })) },
  ] });
}
