import { parseCsv, unescapeCsvField } from "./csv.js";

/** MasalaPOS's internal contract. These are NOT Zomato's private wire schemas. */
export const ZOMATO_STATUSES = ["received", "confirmed", "preparing", "ready", "picked_up", "delivered", "rejected", "cancelled"] as const;
export type ZomatoOrderStatus = typeof ZOMATO_STATUSES[number];
export interface ZomatoSettings {
  restaurantId: string; restaurantName: string; posId: string; webhookBaseUrl: string;
  enabled: boolean; version: number; adapterConfigured: boolean; lastEventAt: number | null;
  /** Minutes since punch-in after which a Zomato order card turns amber, then red (1 to 240, red later than amber). */
  warnMinutes: number; lateMinutes: number;
}
export interface ZomatoOrder {
  orderId: string; restaurantId: string; placedAt: number; status: ZomatoOrderStatus;
  totalPaise: number; paymentMode: "prepaid" | "cod" | "unknown";
  items: { name: string; quantity: number; note: string }[];
  source: "import" | "webhook"; updatedAt: number;
}
export type ZomatoReconciliationState = "matched" | "mismatch" | "missing_order" | "awaiting_statement" | "review_cancellation";
export interface ZomatoReconciliationRow {
  orderId: string; placedAt: number | null; orderStatus: ZomatoOrderStatus | null;
  orderTotalPaise: number | null; statementGrossPaise: number; deductionsPaise: number;
  additionsPaise: number; expectedNetPaise: number; paidPaise: number;
  orderDifferencePaise: number | null; payoutDifferencePaise: number;
  entries: number; references: string[]; state: ZomatoReconciliationState;
}
export interface ZomatoReconciliation {
  from: string; to: string; timezone: string; generatedAt: number; restaurantId: string;
  rows: ZomatoReconciliationRow[];
  totals: { orderTotalPaise: number; statementGrossPaise: number; deductionsPaise: number; additionsPaise: number;
    expectedNetPaise: number; paidPaise: number; payoutDifferencePaise: number; matched: number; needsReview: number };
}
export type ZomatoImportKind = "orders" | "settlements";
export interface ZomatoImportPreview {
  revision: string; kind: ZomatoImportKind; added: number; skipped: number;
  rows: { orderId: string; reference: string; amountPaise: number; action: "Add" | "Skip duplicate" }[];
}
export const ZOMATO_CSV_COLUMNS = {
  orders: ["restaurant_id", "order_id", "ordered_at", "status", "order_total", "payment_mode"],
  settlements: ["restaurant_id", "order_id", "entry_id", "settlement_reference", "settlement_date", "gross_amount", "deductions", "additions", "net_paid"],
} as const;

/** The Zomato import's rows, by column name; bounded before parsing by the server. */
export function parseZomatoCsv(source: string, kind: ZomatoImportKind): Record<string, string>[] {
  const rows = parseCsv(source, 1000, "Import up to 1,000 rows at a time.").map((row) => row.cells);
  const headers = rows.shift()?.map(cell => cell.trim().toLowerCase());
  if (!headers || !rows.length) throw new Error("The CSV has no data rows. Use the downloaded template.");
  const expected: readonly string[] = ZOMATO_CSV_COLUMNS[kind];
  if (headers.length !== expected.length || new Set(headers).size !== headers.length || expected.some(key => !headers.includes(key)))
    throw new Error(`Use these exact CSV columns: ${expected.join(", ")}.`);
  return rows.map((row, index) => {
    if (row.length !== headers.length) throw new Error(`Data row ${index + 1}: incorrect number of columns.`);
    return Object.fromEntries(headers.map((key, i) => [key, unescapeCsvField(row[i]!.trim())]));
  });
}
