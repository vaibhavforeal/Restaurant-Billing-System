/** ForkFlow's internal contract. These are NOT Zomato's private wire schemas. */
export const ZOMATO_STATUSES = ["received", "confirmed", "preparing", "ready", "picked_up", "delivered", "rejected", "cancelled"] as const;
export type ZomatoOrderStatus = typeof ZOMATO_STATUSES[number];
export interface ZomatoSettings {
  restaurantId: string; restaurantName: string; posId: string; webhookBaseUrl: string;
  enabled: boolean; version: number; adapterConfigured: boolean; lastEventAt: number | null;
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

/** Strict RFC 4180 reader; bounded before parsing by the server. */
export function parseZomatoCsv(source: string, kind: ZomatoImportKind): Record<string, string>[] {
  const input = source.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let cells: string[] = [], field = "", quoted = false, closed = false;
  const endField = () => { cells.push(field); field = ""; closed = false; };
  const endRow = () => {
    endField(); if (cells.some(cell => cell.trim() !== "")) rows.push(cells); cells = [];
    if (rows.length > 1001) throw new Error("Import up to 1,000 rows at a time.");
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; }
      } else field += ch;
    } else if (ch === ",") endField();
    else if (ch === "\r" || ch === "\n") { if (ch === "\r" && input[i + 1] === "\n") i++; endRow(); }
    else if (closed) throw new Error("Unexpected text after a closing CSV quote.");
    else if (ch === '"') { if (field) throw new Error("CSV quotes must start at the beginning of a field."); quoted = true; }
    else field += ch;
  }
  if (quoted) throw new Error("Unclosed CSV quote.");
  if (field || cells.length || closed) endRow();
  const headers = rows.shift()?.map(cell => cell.trim().toLowerCase());
  if (!headers || !rows.length) throw new Error("The CSV has no data rows. Use the downloaded template.");
  const expected: readonly string[] = ZOMATO_CSV_COLUMNS[kind];
  if (headers.length !== expected.length || new Set(headers).size !== headers.length || expected.some(key => !headers.includes(key)))
    throw new Error(`Use these exact CSV columns: ${expected.join(", ")}.`);
  return rows.map((row, index) => {
    if (row.length !== headers.length) throw new Error(`Data row ${index + 1}: incorrect number of columns.`);
    return Object.fromEntries(headers.map((key, i) => {
      let value = row[i]!.trim();
      // Undo only the spreadsheet escaping used by our own export.
      if (/^'(?:\s*[=+\-@]|[\t\r\n'])/.test(value)) value = value.slice(1);
      return [key, value];
    }));
  });
}

export function zomatoCsv(rows: readonly (readonly (string | number | null)[])[]): string {
  return "\uFEFF" + rows.map(row => row.map(cell => {
    const value = String(cell ?? "");
    const safe = typeof cell === "string" && /^(?:\s*[=+\-@]|[\t\r\n'])/.test(value) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  }).join(",")).join("\r\n") + "\r\n";
}
