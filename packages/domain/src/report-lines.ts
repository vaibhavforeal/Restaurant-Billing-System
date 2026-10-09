import type { Database } from "./db.js";

/** Largest-remainder allocation keeps every stored paise, including negative round-off. */
export function allocatePaise(total: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map((_, i) => i === 0 ? total : 0);
  const sign = total < 0 ? -1 : 1;
  const denominator = BigInt(sum);
  const parts = weights.map((weight, index) => {
    const numerator = BigInt(Math.abs(total)) * BigInt(weight);
    return { index, value: Number(numerator / denominator), remainder: numerator % denominator };
  });
  let remaining = Math.abs(total) - parts.reduce((sum, part) => sum + part.value, 0);
  for (const part of [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (remaining-- > 0) part.value++;
  }
  return parts.map((part) => sign * part.value);
}

/** Called inside bill creation's transaction; reports never reprice historical sales. */
export function saveReportLines(db: Database, billId: string, legacy = false) {
  const bill = db.prepare("SELECT order_id, receipt_json, rounding_paise FROM bills WHERE id = ?").get(billId) as {
    order_id: string; receipt_json: string | null; rounding_paise: number;
  };
  // Legacy exclusive bills (taxInclusive === false, or no snapshot at all as migration 017 backfills) have a discount that excludes GST.
  const exclusive = bill.receipt_json ? JSON.parse(bill.receipt_json).taxInclusive === false : true;
  const items = db.prepare(`SELECT oi.id, oi.product_id, oi.variant_id, oi.name_snapshot, oi.qty,
    oi.price_paise_snapshot * oi.qty AS subtotal, oi.gst_rate_snapshot AS rate,
    c.id AS category_id, c.name AS category_name
    FROM order_items oi JOIN products p ON p.id = oi.product_id JOIN categories c ON c.id = p.category_id
    WHERE oi.order_id = ? AND oi.status != 'cancelled' ORDER BY oi.id`).all(bill.order_id) as Array<{
      id: string; product_id: string; variant_id: string | null; name_snapshot: string; qty: number;
      subtotal: number; rate: number; category_id: string; category_name: string;
    }>;
  const lines = items.map((item) => ({ ...item, discount: 0, taxable: 0, cgst: 0, sgst: 0, rounding: 0 }));
  const taxes = db.prepare("SELECT gst_rate, taxable_paise, cgst_paise, sgst_paise FROM bill_taxes WHERE bill_id = ?").all(billId) as Array<{
    gst_rate: number; taxable_paise: number; cgst_paise: number; sgst_paise: number;
  }>;
  for (const tax of taxes) {
    const group = lines.filter((line) => line.rate === tax.gst_rate);
    const weights = group.map((line) => line.subtotal);
    const discount = weights.reduce((sum, n) => sum + n, 0) - tax.taxable_paise - (exclusive ? 0 : tax.cgst_paise + tax.sgst_paise);
    const discounts = allocatePaise(discount, weights);
    const netWeights = weights.map((n, i) => n - discounts[i]!);
    const taxable = allocatePaise(tax.taxable_paise, netWeights);
    const cgst = allocatePaise(tax.cgst_paise, netWeights), sgst = allocatePaise(tax.sgst_paise, netWeights);
    group.forEach((line, i) => Object.assign(line, { discount: discounts[i]!, taxable: taxable[i]!, cgst: cgst[i]!, sgst: sgst[i]! }));
  }
  const rounding = allocatePaise(bill.rounding_paise, lines.map((line) => line.taxable + line.cgst + line.sgst));
  const insert = db.prepare(`INSERT INTO bill_report_lines (bill_id, order_item_id, product_id, variant_id, name,
    category_id, category_name, qty, subtotal_paise, discount_paise, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  lines.forEach((line, i) => insert.run(billId, line.id, line.product_id, line.variant_id, line.name_snapshot,
    legacy ? null : line.category_id, legacy ? "Historical category unavailable" : line.category_name,
    line.qty, line.subtotal, line.discount, line.taxable, line.cgst, line.sgst, rounding[i]!, line.taxable + line.cgst + line.sgst + rounding[i]!));
}
