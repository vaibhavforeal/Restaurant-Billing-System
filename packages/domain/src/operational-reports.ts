export const OPERATIONAL_REPORTS = [
  { id: "items", title: "Item / category sales" },
  { id: "cashiers", title: "Cashier collections" },
  { id: "hourly", title: "Hourly sales" },
  { id: "kots", title: "KOT performance" },
  { id: "cancellations", title: "Cancellation details" },
  { id: "stock", title: "Stock consumption / wastage" },
  { id: "credit-notes", title: "Credit notes" },
] as const;
export type OperationalReportKind = typeof OPERATIONAL_REPORTS[number]["id"];
export type ReportCell = string | number | null;
export interface ReportColumn { key: string; label: string; format?: "money" | "quantity" | "minutes" | "time" | "percent" }
export interface ReportTable { title: string; columns: ReportColumn[]; rows: Record<string, ReportCell>[]; totals?: Record<string, ReportCell> }
export interface OperationalReport {
  kind: OperationalReportKind; from: string; to: string; today: string; timezone: string; generatedAt: number;
  notes: string[]; tables: ReportTable[];
}

export type AnalyticsOrderType = "all" | "parcel" | "dine_in" | "zomato";
export interface OrderAnalyticsTotals { orderCount: number; totalPaise: number; qty: number }
export interface OrderTypeAnalytics extends OrderAnalyticsTotals { type: "parcel" | "dine_in" }
export interface ItemAnalytics extends OrderAnalyticsTotals {
  productId: string; variantId: string | null; categoryId: string | null; name: string; category: string;
  takeawayQty: number; tableQty: number;
}
export interface CategoryAnalytics extends OrderAnalyticsTotals { categoryId: string | null; name: string }
export interface AnalyticsDay { date: string; takeawayOrders: number; tableOrders: number; totalPaise: number }
export interface AnalyticsHour { hour: number; orderCount: number; totalPaise: number }
export interface OrderAnalyticsReport {
  from: string; to: string; today: string; timezone: string; generatedAt: number; orderType: AnalyticsOrderType;
  totals: OrderAnalyticsTotals; comparison: OrderTypeAnalytics[]; items: ItemAnalytics[];
  categories: CategoryAnalytics[]; daily: AnalyticsDay[]; hourly: AnalyticsHour[];
}
