import { z } from "zod";
import type { OperationalReport } from "./operational-reports.js";

/**
 * Custom report builder: the fixed catalogue of what a saved report may select, filter and group by.
 * The server maps each field id to a SQL expression it owns; clients only ever send field ids, never SQL.
 * Money fields are paise everywhere (filters included); the UI converts to and from rupees.
 */
export type CustomFieldType = "text" | "date" | "time" | "number" | "money" | "quantity";
/** A dimension describes a row (and can be grouped by); a measure is a number that sums, averages or takes the latest when grouped. */
export type CustomFieldRole = "dimension" | "measure";
export type CustomAggregate = "sum" | "avg" | "max";
export interface CustomReportField {
  id: string; label: string; type: CustomFieldType; role: CustomFieldRole;
  /** Measures only: how the value combines when rows are grouped. */
  agg?: CustomAggregate;
  /** Dimensions only: false for values that are unique per row (timestamps), which make no useful group. */
  groupable?: boolean;
}
export interface CustomReportSource { id: string; title: string; description: string; /** Whether the report's date range filters the rows by this source's date. */ dateLabel: string; fields: CustomReportField[] }

const dim = (id: string, label: string, type: CustomFieldType = "text", groupable = true): CustomReportField => ({ id, label, type, role: "dimension", ...(groupable ? {} : { groupable: false }) });
const sum = (id: string, label: string, type: CustomFieldType = "money"): CustomReportField => ({ id, label, type, role: "measure", agg: "sum" });
const stat = (id: string, label: string, type: CustomFieldType, agg: CustomAggregate): CustomReportField => ({ id, label, type, role: "measure", agg });

const billWhen = [dim("date", "Date", "date"), dim("month", "Month"), dim("hour", "Hour"), dim("time", "Date and time", "time", false)];
const billWho = [dim("orderType", "Order type"), dim("table", "Table / takeaway"), dim("issuedBy", "Billed by"), dim("customer", "Customer"), dim("customerPhone", "Customer phone")];

export const CUSTOM_REPORT_SOURCES: CustomReportSource[] = [
  {
    id: "bills", title: "Bills", dateLabel: "bill date",
    description: "One row per bill issued, including void and unpaid ones. Filter on Status to leave them out.",
    fields: [
      ...billWhen, dim("billNo", "Bill no.", "number"), ...billWho, dim("status", "Status"), dim("paymentModes", "Payment modes"),
      sum("bills", "Bills", "quantity"), sum("subtotal", "Subtotal"), sum("discount", "Discount"), sum("customerDiscount", "Customer discount"), sum("pointsValue", "Loyalty points value"),
      sum("taxable", "Taxable value"), sum("cgst", "CGST"), sum("sgst", "SGST"), sum("gst", "GST"), sum("rounding", "Round off"), sum("total", "Total"), stat("averageBill", "Average bill", "money", "avg"),
    ],
  },
  {
    id: "bill_items", title: "Bill items", dateLabel: "bill date",
    description: "One row per item line on an issued bill, as saved at billing. Credit notes are not subtracted; use the Item / category sales report for net figures.",
    fields: [
      ...billWhen, dim("billNo", "Bill no.", "number"), dim("item", "Item"), dim("category", "Category"), ...billWho, dim("status", "Bill status"),
      sum("lines", "Lines", "quantity"), sum("qty", "Quantity", "quantity"), sum("subtotal", "Subtotal"), sum("discount", "Discount"), sum("taxable", "Taxable value"), sum("gst", "GST"), sum("rounding", "Round off"), sum("total", "Total"),
    ],
  },
  {
    id: "payments", title: "Payments", dateLabel: "payment date",
    description: "One row per payment received, by the date it was taken (which can be later than the bill date). Zomato settlements are left out, as in Collections, because Zomato owes that money; refunds paid out are not subtracted.",
    fields: [
      ...billWhen, dim("billNo", "Bill no.", "number"), dim("mode", "Payment mode"), dim("collectedBy", "Collected by"), dim("reference", "Reference note"), dim("orderType", "Order type"), dim("customer", "Customer"),
      sum("payments", "Payments", "quantity"), sum("amount", "Amount"),
    ],
  },
  {
    id: "customers", title: "Customers", dateLabel: "activity date",
    description: "One row per customer. Visits, spend and points earned, redeemed, reversed or adjusted count only the selected dates (void bills excluded); points balance is the current balance, whatever the dates.",
    fields: [
      dim("name", "Customer"), dim("phone", "Phone"), dim("email", "Email"), dim("type", "Customer type"), dim("tags", "Tags"),
      dim("birthday", "Birthday"), dim("anniversary", "Anniversary"), dim("optIn", "Marketing opt-in"), dim("active", "Active"),
      dim("joined", "Added on", "time", false),
      sum("visits", "Visits", "quantity"), sum("spend", "Spend"), stat("lastVisit", "Last visit", "time", "max"),
      sum("pointsEarned", "Points earned", "quantity"), sum("pointsRedeemed", "Points redeemed", "quantity"),
      sum("pointsExpired", "Points expired", "quantity"),
      sum("pointsOther", "Points reversed / adjusted", "quantity"), sum("pointsBalance", "Points balance now", "quantity"),
      stat("rating", "Average rating", "number", "avg"),
    ],
  },
  {
    id: "loyalty", title: "Loyalty points", dateLabel: "entry date",
    description: "One row per points entry: earned, redeemed, reversed by a void or refund, adjusted by an admin, or expired.",
    fields: [
      dim("date", "Date", "date"), dim("month", "Month"), dim("time", "Date and time", "time", false),
      dim("customer", "Customer"), dim("customerPhone", "Customer phone"), dim("entry", "Entry"), dim("billNo", "Bill no.", "number"),
      dim("note", "Note"), dim("recordedBy", "Recorded by"),
      sum("entries", "Entries", "quantity"), sum("points", "Points", "quantity"),
    ],
  },
  {
    id: "feedback", title: "Feedback", dateLabel: "rating date",
    description: "One row per rating of a visit, from the receipt's QR code or entered by staff. Ratings are 1 to 5.",
    fields: [
      dim("date", "Date", "date"), dim("month", "Month"), dim("time", "Date and time", "time", false),
      dim("billNo", "Bill no.", "number"), dim("customer", "Customer"), dim("source", "Source"), dim("comment", "Comment", "text", false),
      sum("responses", "Responses", "quantity"), stat("overall", "Overall", "number", "avg"), stat("food", "Food", "number", "avg"),
      stat("service", "Service", "number", "avg"), stat("ambience", "Ambience", "number", "avg"),
    ],
  },
];

/** Fields that hold numbers: they take numeric filters, typed as numbers (money in paise). */
export const isNumericField = (field: Pick<CustomReportField, "type">) => field.type === "number" || field.type === "money" || field.type === "quantity";

export const CUSTOM_REPORT_SOURCE_IDS = CUSTOM_REPORT_SOURCES.map((s) => s.id) as [string, ...string[]];
export const customReportSource = (id: string) => CUSTOM_REPORT_SOURCES.find((s) => s.id === id);
export const CUSTOM_REPORT_LIMITS = { columns: 30, filters: 10, groups: 5, rows: 5000 } as const;

export const CUSTOM_FILTER_OPS = ["eq", "ne", "contains", "gt", "gte", "lt", "lte"] as const;
export type CustomFilterOp = typeof CUSTOM_FILTER_OPS[number];
export const CUSTOM_FILTER_OP_LABELS: Record<CustomFilterOp, string> = { eq: "is", ne: "is not", contains: "contains", gt: "greater than", gte: "at least", lt: "less than", lte: "at most" };
const NUMERIC: CustomFilterOp[] = ["eq", "ne", "gt", "gte", "lt", "lte"];
/** The operators each field type allows. Timestamps are filtered by the report's date range, not by a filter. */
export function filterOpsFor(type: CustomFieldType): CustomFilterOp[] {
  if (type === "text") return ["eq", "ne", "contains"];
  if (type === "date") return ["eq", "gte", "lte"];
  if (type === "time") return [];
  return NUMERIC;
}

export const CustomReportConfig = z.object({
  source: z.enum(CUSTOM_REPORT_SOURCE_IDS),
  columns: z.array(z.object({ field: z.string().min(1).max(40), label: z.string().trim().max(60).optional() })).min(1).max(CUSTOM_REPORT_LIMITS.columns),
  filters: z.array(z.object({ field: z.string().min(1).max(40), op: z.enum(CUSTOM_FILTER_OPS), value: z.union([z.string().max(200), z.number().finite()]) })).max(CUSTOM_REPORT_LIMITS.filters).default([]),
  groupBy: z.array(z.string().min(1).max(40)).max(CUSTOM_REPORT_LIMITS.groups).default([]),
  sort: z.object({ field: z.string().min(1).max(40), dir: z.enum(["asc", "desc"]) }).optional(),
});
export type CustomReportConfigInput = z.input<typeof CustomReportConfig>;
export type CustomReportConfigValue = z.output<typeof CustomReportConfig>;

export const CustomReportSave = z.object({ name: z.string().trim().min(1, "Give the report a name").max(80), config: CustomReportConfig });
export type CustomReportSaveInput = z.input<typeof CustomReportSave>;
/** A run custom report: the operational report shape with a single table, so the same table and CSV code renders it. */
export type CustomReport = Omit<OperationalReport, "kind"> & { kind: "custom" };
export interface SavedCustomReport { id: string; name: string; config: CustomReportConfigValue; createdAt: number; updatedAt: number }

/** Checks a config against the catalogue; returns the first problem in plain words, or null when it can run. */
export function customReportProblem(config: CustomReportConfigValue): string | null {
  const source = customReportSource(config.source);
  if (!source) return "Unknown data source";
  const field = (id: string) => source.fields.find((f) => f.id === id);
  const seen = new Set<string>();
  for (const column of config.columns) {
    if (!field(column.field)) return `"${column.field}" is not a column of ${source.title}`;
    if (seen.has(column.field)) return `${field(column.field)!.label} is selected twice`;
    seen.add(column.field);
  }
  const grouped = new Set<string>();
  for (const id of config.groupBy) {
    const f = field(id);
    if (!f) return `Cannot group by unknown field "${id}"`;
    if (f.role !== "dimension" || f.groupable === false) return `Cannot group by ${f.label}`;
    if (grouped.has(id)) return `${f.label} is grouped twice`;
    grouped.add(id);
  }
  if (grouped.size) {
    const loose = config.columns.map((c) => field(c.field)!).find((f) => f.role === "dimension" && !grouped.has(f.id));
    if (loose) return `${loose.label} must be grouped by, or removed, because the report is grouped`;
  }
  for (const filter of config.filters) {
    const f = field(filter.field);
    if (!f) return `Cannot filter on unknown field "${filter.field}"`;
    if (!filterOpsFor(f.type).includes(filter.op)) return `${f.label} cannot be filtered with "${CUSTOM_FILTER_OP_LABELS[filter.op]}"`;
    if (f.type === "date" && !(typeof filter.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(filter.value))) return `${f.label} needs a date`;
    if (isNumericField(f) && typeof filter.value !== "number") return `${f.label} needs a number`;
    if (f.type === "text" && typeof filter.value !== "string") return `${f.label} needs text`;
  }
  if (config.sort && !seen.has(config.sort.field)) return "Sort by one of the selected columns";
  return null;
}
