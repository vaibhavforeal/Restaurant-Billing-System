import type { Database } from "./db.js";

export interface PopularOptions {
  /** How far back sales count. */
  days?: number;
  /** How many products each category can badge. */
  perCategory?: number;
  /** Net quantity a product must have sold in the window to be badged. */
  minQty?: number;
}

export const POPULAR_DEFAULTS: Required<PopularOptions> = { days: 30, perCategory: 1, minQty: 3 };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The best-selling products of each category, by net quantity billed in the window (credit notes subtract; items sold
 * inside combos do not count). A product counts in its current category, and only active, in-stock products in active
 * categories with at least two active products are badged. Ties go to higher revenue, then name.
 */
export function popularProductIds(db: Database, now: number, options: PopularOptions = {}): string[] {
  const { days, perCategory, minQty } = { ...POPULAR_DEFAULTS, ...options };
  const from = now - days * DAY_MS;
  const rows = db.prepare(`
    WITH sold AS (
      SELECT l.product_id, l.qty, l.total_paise AS total
        FROM bill_report_lines l JOIN bills b ON b.id = l.bill_id
        WHERE b.created_at >= ? AND b.created_at <= ? AND l.parent_order_item_id IS NULL
      UNION ALL
      SELECT l.product_id, -cl.qty, -cl.total_paise
        FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id
        JOIN bill_report_lines l ON l.bill_id = c.bill_id AND l.order_item_id = cl.order_item_id
        JOIN bills b ON b.id = c.bill_id
        WHERE b.created_at >= ? AND b.created_at <= ?
    ), totals AS (
      SELECT product_id, SUM(qty) AS qty, SUM(total) AS total FROM sold GROUP BY product_id
    ), ranked AS (
      SELECT p.id, p.category_id,
        ROW_NUMBER() OVER (PARTITION BY p.category_id ORDER BY t.qty DESC, t.total DESC, p.name, p.id) AS rank
        FROM totals t JOIN products p ON p.id = t.product_id JOIN categories c ON c.id = p.category_id
        WHERE p.is_active = 1 AND p.is_sold_out = 0 AND c.is_active = 1 AND t.qty >= ?
          AND (SELECT COUNT(*) FROM products o WHERE o.category_id = p.category_id AND o.is_active = 1) >= 2
    )
    SELECT id FROM ranked WHERE rank <= ? ORDER BY id`).all(from, now, from, now, minQty, perCategory) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}
