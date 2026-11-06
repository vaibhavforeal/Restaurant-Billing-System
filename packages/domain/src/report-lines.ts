import type { Database } from "./db.js";
import { orderItemPackaging } from "./packaging.js";

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
export function saveReportLines(db: Database, billId: string) {
  const bill = db.prepare("SELECT order_id, receipt_json, rounding_paise, json_extract(receipt_json, '$.gstMode') AS gst_mode FROM bills WHERE id = ?").get(billId) as {
    order_id: string; receipt_json: string | null; rounding_paise: number; gst_mode: string | null;
  };
  // With GST added on top the taxable value is the amount after discount; otherwise (a missing mode is "included") the tax is inside it.
  const taxOnTop = bill.gst_mode === "exclusive";
  const rows = db.prepare(`SELECT oi.id, oi.product_id, oi.variant_id, oi.name_snapshot, oi.qty, oi.parent_item_id AS parent_item_id,
    oi.price_paise_snapshot * oi.qty AS subtotal, oi.gst_rate_snapshot AS rate,
    c.id AS category_id, c.name AS category_name
    FROM order_items oi JOIN products p ON p.id = oi.product_id JOIN categories c ON c.id = p.category_id
    WHERE oi.order_id = ? AND oi.status != 'cancelled' ORDER BY oi.id`).all(bill.order_id) as Array<{
      id: string; product_id: string; variant_id: string | null; name_snapshot: string; qty: number; parent_item_id: string | null;
      subtotal: number; rate: number; category_id: string; category_name: string;
    }>;
  // The money is spread over billed lines only. A combo's items are kept as ₹0 lines that name the combo, so item
  // reports can count what was sold inside combos without counting the money twice.
  const items = rows.filter((row) => !row.parent_item_id);
  const lines = items.map((item) => ({ ...item, discount: 0, taxable: 0, cgst: 0, sgst: 0, rounding: 0 }));
  const taxes = db.prepare("SELECT gst_rate, taxable_paise, cgst_paise, sgst_paise FROM bill_taxes WHERE bill_id = ?").all(billId) as Array<{
    gst_rate: number; taxable_paise: number; cgst_paise: number; sgst_paise: number;
  }>;
  // Charges carry their own tax (and round-off only when no item has value): take it out of the rate's row so only the items' share is spread over item lines.
  const charges = db.prepare("SELECT gst_rate, taxable_paise, cgst_paise, sgst_paise, rounding_paise FROM bill_charges WHERE bill_id = ?").all(billId) as Array<(typeof taxes)[number] & { rounding_paise: number }>;
  for (const charge of charges) {
    const row = taxes.find((tax) => tax.gst_rate === charge.gst_rate);
    if (row) { row.taxable_paise -= charge.taxable_paise; row.cgst_paise -= charge.cgst_paise; row.sgst_paise -= charge.sgst_paise; }
  }
  for (const tax of taxes) {
    const group = lines.filter((line) => line.rate === tax.gst_rate);
    if (!group.length) continue;
    const weights = group.map((line) => line.subtotal);
    const discount = weights.reduce((sum, n) => sum + n, 0) - tax.taxable_paise - (taxOnTop ? 0 : tax.cgst_paise + tax.sgst_paise);
    const discounts = allocatePaise(discount, weights);
    const netWeights = weights.map((n, i) => n - discounts[i]!);
    const taxable = allocatePaise(tax.taxable_paise, netWeights);
    const cgst = allocatePaise(tax.cgst_paise, netWeights), sgst = allocatePaise(tax.sgst_paise, netWeights);
    group.forEach((line, i) => Object.assign(line, { discount: discounts[i]!, taxable: taxable[i]!, cgst: cgst[i]!, sgst: sgst[i]! }));
  }
  // Each line keeps its share of the packaging charge, so a refund can credit it item by item.
  const packaging = orderItemPackaging(db, bill.order_id);
  const rounding = allocatePaise(bill.rounding_paise - charges.reduce((sum, c) => sum + c.rounding_paise, 0), lines.map((line) => line.taxable + line.cgst + line.sgst));
  const insert = db.prepare(`INSERT INTO bill_report_lines (bill_id, order_item_id, product_id, variant_id, name,
    category_id, category_name, qty, subtotal_paise, discount_paise, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, parent_order_item_id, packaging_paise)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  lines.forEach((line, i) => insert.run(billId, line.id, line.product_id, line.variant_id, line.name_snapshot,
    line.category_id, line.category_name,
    line.qty, line.subtotal, line.discount, line.taxable, line.cgst, line.sgst, rounding[i]!, line.taxable + line.cgst + line.sgst + rounding[i]!, null, packaging.get(line.id) ?? 0));
  for (const item of rows.filter((row) => row.parent_item_id)) insert.run(billId, item.id, item.product_id, item.variant_id, item.name_snapshot,
    item.category_id, item.category_name, item.qty, 0, 0, 0, 0, 0, 0, 0, item.parent_item_id, 0);
}
