import type { Database } from "./db.js";

export interface PopularOptions {
  /** How far back sales count. */
  days?: number;
  /** How many products each category can badge. */
  perCategory?: number;
  /** Net quantity a product must have sold in the window to be badged. */
  minQty?: number;
  /**
   * Follow the clock: only count bills issued within this many hours either side of `now`'s hour (hub local time,
   * wrapping past midnight). A category with nothing that qualifies in that band falls back to its all-day best-seller.
   */
  aroundHour?: number;
}

export const POPULAR_DEFAULTS: Required<Omit<PopularOptions, "aroundHour">> = { days: 30, perCategory: 1, minQty: 3 };
/** Hours either side of now that "Match the time of day" counts. */
export const POPULAR_HOUR_WINDOW = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A bill's hour on the hub's clock; JavaScript's `getHours()` uses the same local time zone. */
const BILL_HOUR = "CAST(strftime('%H', b.created_at / 1000, 'unixepoch', 'localtime') AS INTEGER)";

/**
 * The best-selling products of each category, by net quantity billed in the window (credit notes subtract; items sold
 * inside combos do not count). A product counts in its current category, and only active, in-stock products in active
 * categories with at least two active products are badged. Ties go to higher revenue, then name.
 */
export function popularProductIds(db: Database, now: number, options: PopularOptions = {}): string[] {
  const { days, perCategory, minQty, aroundHour } = { ...POPULAR_DEFAULTS, ...options };
  const from = now - days * DAY_MS;
  const allDay = rankPopular(db, from, now, minQty, perCategory);
  let chosen = allDay;
  if (aroundHour !== undefined) {
    const hour = new Date(now).getHours();
    const hours = [...new Set(Array.from({ length: 2 * aroundHour + 1 }, (_, i) => (((hour - aroundHour + i) % 24) + 24) % 24))];
    const nearNow = rankPopular(db, from, now, minQty, perCategory, hours);
    chosen = new Map([...allDay, ...nearNow]);
  }
  return [...chosen.values()].flat().sort();
}

/** Each category's best-sellers between `from` and `now`, optionally only from bills issued in the given local hours. */
function rankPopular(db: Database, from: number, now: number, minQty: number, perCategory: number, hours?: number[]): Map<string, string[]> {
  const inHours = hours ? ` AND ${BILL_HOUR} IN (${hours.map(() => "?").join(", ")})` : "";
  const hourParams = hours ?? [];
  const rows = db.prepare(`
    WITH sold AS (
      SELECT l.product_id, l.qty, l.total_paise AS total
        FROM bill_report_lines l JOIN bills b ON b.id = l.bill_id
        WHERE b.created_at >= ? AND b.created_at <= ? AND l.parent_order_item_id IS NULL${inHours}
      UNION ALL
      SELECT l.product_id, -cl.qty, -cl.total_paise
        FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id
        JOIN bill_report_lines l ON l.bill_id = c.bill_id AND l.order_item_id = cl.order_item_id
        JOIN bills b ON b.id = c.bill_id
        WHERE b.created_at >= ? AND b.created_at <= ?${inHours}
    ), totals AS (
      SELECT product_id, SUM(qty) AS qty, SUM(total) AS total FROM sold GROUP BY product_id
    ), ranked AS (
      SELECT p.id, p.category_id,
        ROW_NUMBER() OVER (PARTITION BY p.category_id ORDER BY t.qty DESC, t.total DESC, p.name, p.id) AS rank
        FROM totals t JOIN products p ON p.id = t.product_id JOIN categories c ON c.id = p.category_id
        WHERE p.is_active = 1 AND p.is_sold_out = 0 AND c.is_active = 1 AND t.qty >= ?
          AND (SELECT COUNT(*) FROM products o WHERE o.category_id = p.category_id AND o.is_active = 1) >= 2
    )
    SELECT id, category_id FROM ranked WHERE rank <= ? ORDER BY category_id, rank`)
    .all(from, now, ...hourParams, from, now, ...hourParams, minQty, perCategory) as Array<{ id: string; category_id: string }>;
  const byCategory = new Map<string, string[]>();
  for (const row of rows) byCategory.set(row.category_id, [...(byCategory.get(row.category_id) ?? []), row.id]);
  return byCategory;
}

export interface TogetherOptions {
  /** How far back bills count. */
  days?: number;
  /** Bills two dishes must share before one suggests the other. */
  minBills?: number;
  /** Most partners kept per dish; screens show fewer once the cart's own dishes and categories are left out. */
  perProduct?: number;
}

export const TOGETHER_DEFAULTS: Required<TogetherOptions> = { days: 30, minBills: 3, perProduct: 5 };

/** A dish to suggest, with the size to add when it has sizes. */
export interface PairedDish { productId: string; variantId: string | null }

/**
 * For each dish, the dishes from other categories most often on the same bill (each bill counts once per pair; items
 * inside combos do not count). Partners must be active, in stock, in an active category, and not combos (those need
 * choices). A partner with sizes is suggested in its most ordered active size. Credit notes are ignored: a refunded dish
 * was still ordered with the rest.
 */
export function orderedTogether(db: Database, now: number, options: TogetherOptions = {}): Record<string, PairedDish[]> {
  const { days, minBills, perProduct } = { ...TOGETHER_DEFAULTS, ...options };
  const from = now - days * DAY_MS;
  const rows = db.prepare(`
    WITH lines AS (
      SELECT DISTINCT l.bill_id, l.product_id FROM bill_report_lines l JOIN bills b ON b.id = l.bill_id
        WHERE b.created_at >= ? AND b.created_at <= ? AND l.parent_order_item_id IS NULL
    ), pairs AS (
      SELECT a.product_id AS a, c.product_id AS b, COUNT(*) AS bills
        FROM lines a JOIN lines c ON c.bill_id = a.bill_id AND c.product_id <> a.product_id
        GROUP BY a.product_id, c.product_id HAVING COUNT(*) >= ?
    ), ranked AS (
      SELECT pr.a, pr.b, ROW_NUMBER() OVER (PARTITION BY pr.a ORDER BY pr.bills DESC, pb.name, pb.id) AS rank
        FROM pairs pr JOIN products pa ON pa.id = pr.a JOIN products pb ON pb.id = pr.b JOIN categories cb ON cb.id = pb.category_id
        WHERE pb.category_id <> pa.category_id AND pb.is_active = 1 AND pb.is_sold_out = 0 AND pb.kind = 'item' AND cb.is_active = 1
    )
    SELECT a, b FROM ranked WHERE rank <= ? ORDER BY a, rank`).all(from, now, minBills, perProduct) as Array<{ a: string; b: string }>;
  if (!rows.length) return {};
  // Each partner's most ordered active size over the same window; a size not sold lately still beats none.
  const sizes = new Map<string, string>();
  const sizeRows = db.prepare(`
    SELECT v.product_id, v.id FROM variants v LEFT JOIN (
      SELECT l.variant_id, SUM(l.qty) AS qty FROM bill_report_lines l JOIN bills b ON b.id = l.bill_id
        WHERE b.created_at >= ? AND b.created_at <= ? AND l.variant_id IS NOT NULL GROUP BY l.variant_id
    ) s ON s.variant_id = v.id
    WHERE v.is_active = 1 ORDER BY v.product_id, COALESCE(s.qty, 0) DESC, v.name, v.id`).all(from, now) as Array<{ product_id: string; id: string }>;
  for (const row of sizeRows) if (!sizes.has(row.product_id)) sizes.set(row.product_id, row.id);
  const result: Record<string, PairedDish[]> = {};
  for (const { a, b } of rows) (result[a] ??= []).push({ productId: b, variantId: sizes.get(b) ?? null });
  return result;
}
