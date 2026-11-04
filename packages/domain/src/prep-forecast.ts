import type { Database } from "./db.js";

/** Expected plates for one day and the ingredients they use, from the same weekday in recent weeks. */
export interface PrepForecast {
  /** The day forecast, YYYY-MM-DD. */
  date: string;
  /** The past days averaged, most recent first: up to 4 same weekdays that are over, since the first bill. */
  basedOn: string[];
  /** Dishes sold on at least 2 of those days (or on the only one), by category, then most plates. */
  dishes: Array<{ productId: string; variantId: string | null; name: string; category: string; average: number; days: number[] }>;
  /** Active stock items the expected sales use (current recipes, items inside combos included), by name. */
  ingredients: Array<{ stockItemId: string; name: string; unit: string; need: number; onHand: number }>;
  /** Listed dishes that are not combos and have no stock links, so their ingredients are not counted. */
  unlinkedDishes: string[];
}

export const PREP_WEEKS = 4;

const DAY_MS = 24 * 60 * 60 * 1000;
const BILL_DAY = "strftime('%Y-%m-%d', b.created_at / 1000, 'unixepoch', 'localtime')";
/** Calendar arithmetic on YYYY-MM-DD in UTC, so daylight-saving changes never shift a day. */
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** Local midnight at the start of a YYYY-MM-DD day (SQLite's 'localtime' uses the same zone). */
const localStart = (day: string) => { const [y, m, d] = day.split("-").map(Number) as [number, number, number]; return new Date(y, m - 1, d).getTime(); };
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The prep forecast for `date`: each dish's average plates over the last 4 same weekdays before `today` (zero days
 * included; fewer days for a restaurant newer than that), from non-void bills by bill date. Ingredients multiply every
 * product's average (including items sold inside combos, without the 2-day rule) by its current stock links.
 */
export function prepForecast(db: Database, date: string, today: string): PrepForecast {
  const first = db.prepare(`SELECT MIN(${BILL_DAY}) AS day FROM bills b WHERE b.status <> 'void'`).get() as { day: string | null };
  const basedOn: string[] = [];
  for (let day = shiftDay(date, -7); first.day && day >= first.day && basedOn.length < PREP_WEEKS; day = shiftDay(day, -7)) {
    if (day < today) basedOn.push(day);
  }
  if (!basedOn.length) return { date, basedOn, dishes: [], ingredients: [], unlinkedDishes: [] };

  const oldest = basedOn[basedOn.length - 1]!, newest = basedOn[0]!;
  const lines = db.prepare(`SELECT ${BILL_DAY} AS day, l.product_id AS productId, l.variant_id AS variantId, l.qty, l.parent_order_item_id AS parent
    FROM bill_report_lines l JOIN bills b ON b.id = l.bill_id
    WHERE b.status <> 'void' AND b.created_at >= ? AND b.created_at < ? AND ${BILL_DAY} IN (${basedOn.map(() => "?").join(", ")})`)
    .all(localStart(oldest) - DAY_MS, localStart(shiftDay(newest, 1)) + DAY_MS, ...basedOn) as Array<{ day: string; productId: string; variantId: string | null; qty: number; parent: string | null }>;

  // Dishes: lines sold on their own (a combo counts as the combo), per product and size, per day.
  const perDish = new Map<string, { productId: string; variantId: string | null; days: number[] }>();
  // Ingredients: every product sold, including items inside combos.
  const used = new Map<string, number>();
  for (const line of lines) {
    const at = basedOn.indexOf(line.day);
    used.set(line.productId, (used.get(line.productId) ?? 0) + line.qty);
    if (line.parent) continue;
    const key = `${line.productId}\u0000${line.variantId ?? ""}`;
    const entry = perDish.get(key) ?? { productId: line.productId, variantId: line.variantId, days: basedOn.map(() => 0) };
    entry.days[at]! += line.qty;
    perDish.set(key, entry);
  }

  const productRow = db.prepare(`SELECT p.name, p.kind, p.is_active AS active, c.name AS category,
    (SELECT COUNT(*) FROM product_stock_links k WHERE k.product_id = p.id) AS links FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ?`);
  const variantName = db.prepare("SELECT name FROM variants WHERE id = ?");
  const needDays = Math.min(2, basedOn.length);
  const dishes: PrepForecast["dishes"] = [];
  const unlinked: string[] = [];
  for (const entry of perDish.values()) {
    if (entry.days.filter((qty) => qty > 0).length < needDays) continue;
    const product = productRow.get(entry.productId) as { name: string; kind: string; active: number; category: string; links: number } | undefined;
    if (!product || product.active !== 1) continue;
    const size = entry.variantId ? (variantName.get(entry.variantId) as { name: string } | undefined)?.name : undefined;
    const name = size ? `${product.name} (${size})` : product.name;
    const average = round3(entry.days.reduce((sum, qty) => sum + qty, 0) / basedOn.length);
    if (average <= 0) continue;
    dishes.push({ productId: entry.productId, variantId: entry.variantId, name, category: product.category, average, days: entry.days });
    if (product.kind !== "combo" && product.links === 0 && !unlinked.includes(name)) unlinked.push(name);
  }
  dishes.sort((a, b) => a.category.localeCompare(b.category) || b.average - a.average || a.name.localeCompare(b.name));

  const links = db.prepare(`SELECT k.product_id AS productId, k.qty_per_sale AS perPlate, s.id, s.name, s.unit, s.qty
    FROM product_stock_links k JOIN stock_items s ON s.id = k.stock_item_id WHERE s.is_active = 1`).all() as Array<{ productId: string; perPlate: number; id: string; name: string; unit: string; qty: number }>;
  const needs = new Map<string, PrepForecast["ingredients"][number]>();
  for (const link of links) {
    const plates = (used.get(link.productId) ?? 0) / basedOn.length;
    if (plates <= 0) continue;
    const entry = needs.get(link.id) ?? { stockItemId: link.id, name: link.name, unit: link.unit, need: 0, onHand: link.qty };
    entry.need += plates * link.perPlate;
    needs.set(link.id, entry);
  }
  const ingredients = [...needs.values()].map((item) => ({ ...item, need: round3(item.need) })).filter((item) => item.need > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { date, basedOn, dishes, ingredients, unlinkedDishes: unlinked.sort((a, b) => a.localeCompare(b)) };
}
