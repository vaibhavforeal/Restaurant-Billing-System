import type { Database } from "./db.js";

export interface UsualOptions {
  /** How far back the customer's bills count. */
  days?: number;
  /** Bills a dish must be on to count as usual. */
  minBills?: number;
  /** Most dishes returned; the order screen shows fewer once dishes already on the order are left out. */
  limit?: number;
}

export const USUAL_DEFAULTS: Required<UsualOptions> = { days: 183, minBills: 2, limit: 8 };

/** A dish this customer orders regularly, in the size they order most. */
export interface UsualDish { productId: string; variantId: string | null; bills: number }

/** The dishes on the customer's latest bill, ready to put back in a cart. */
export interface LastOrder {
  billNo: number;
  createdAt: number;
  items: Array<{ productId: string; variantId: string | null; name: string; qty: number }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The customer's usual: dishes on at least `minBills` of their bills in the window (void bills, items inside combos and
 * add-ons do not count), most bills first, then the most recently ordered. Only active, in-stock dishes in active categories;
 * combos are kept (the order screen asks for their items). A dish with sizes comes in the active size this customer
 * ordered most, else its first active size.
 */
export function customerUsual(db: Database, customerId: string, now: number, options: UsualOptions = {}): UsualDish[] {
  const { days, minBills, limit } = { ...USUAL_DEFAULTS, ...options };
  const dishes = db.prepare(`
    WITH lines AS (
      SELECT l.bill_id, l.product_id, b.created_at FROM bill_report_lines l JOIN bills b ON b.id = l.bill_id
        WHERE b.customer_id = ? AND b.status <> 'void' AND b.created_at >= ? AND b.created_at <= ? AND l.parent_order_item_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.id = l.order_item_id AND oi.addon_of_item_id IS NOT NULL)
    ), dishes AS (
      SELECT product_id, COUNT(DISTINCT bill_id) AS bills, MAX(created_at) AS last_at FROM lines GROUP BY product_id HAVING COUNT(DISTINCT bill_id) >= ?
    )
    SELECT d.product_id AS productId, d.bills FROM dishes d JOIN products p ON p.id = d.product_id JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = 1 AND p.is_sold_out = 0 AND p.addon_only = 0 AND c.is_active = 1
      ORDER BY d.bills DESC, d.last_at DESC, p.name, p.id LIMIT ?`).all(customerId, now - days * DAY_MS, now, minBills, limit) as Array<{ productId: string; bills: number }>;
  if (!dishes.length) return [];
  const sizes = db.prepare(`
    SELECT v.id FROM variants v LEFT JOIN (
      SELECT l.variant_id, SUM(l.qty) AS qty FROM bill_report_lines l JOIN bills b ON b.id = l.bill_id
        WHERE b.customer_id = ? AND b.status <> 'void' AND b.created_at >= ? AND b.created_at <= ? AND l.variant_id IS NOT NULL GROUP BY l.variant_id
    ) s ON s.variant_id = v.id
    WHERE v.product_id = ? AND v.is_active = 1 ORDER BY COALESCE(s.qty, 0) DESC, v.name, v.id LIMIT 1`);
  return dishes.map(({ productId, bills }) => {
    const size = sizes.get(customerId, now - days * DAY_MS, now, productId) as { id: string } | undefined;
    return { productId, variantId: size?.id ?? null, bills };
  });
}

/**
 * The customer's latest bill that was not voided, with each dish and size once (quantities added together) in the
 * order first billed. Items inside combos are left out (the combo line stands for them), and so are add-ons, which
 * are picked again under their dish.
 */
export function customerLastOrder(db: Database, customerId: string): LastOrder | null {
  const bill = db.prepare(`SELECT id, bill_no AS billNo, created_at AS createdAt FROM bills
    WHERE customer_id = ? AND status <> 'void' ORDER BY created_at DESC, bill_no DESC LIMIT 1`).get(customerId) as { id: string; billNo: number; createdAt: number } | undefined;
  if (!bill) return null;
  const items = db.prepare(`SELECT product_id AS productId, variant_id AS variantId, MIN(name) AS name, SUM(qty) AS qty
    FROM bill_report_lines WHERE bill_id = ? AND parent_order_item_id IS NULL AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.id = bill_report_lines.order_item_id AND oi.addon_of_item_id IS NOT NULL)
    GROUP BY product_id, variant_id ORDER BY MIN(rowid)`).all(bill.id) as LastOrder["items"];
  return { billNo: bill.billNo, createdAt: bill.createdAt, items };
}
