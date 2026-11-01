import { ComboPickError, effectiveGstRate, resolveComboPicks, uuidv7, type Database, type PriceTier } from "@masalapos/domain";
import { httpError } from "./http-error.js";
import { rowPrice, type PriceRow } from "./pricing.js";
import { readGstSettings } from "./gst-settings.js";
import { comboGroups } from "./combos.js";

export interface ItemRequest {
  productId: string;
  variantId: string | null;
  qty: number;
  note?: string | undefined;
  comboPicks?: string[] | undefined;
}

/** An order line ready to save. A combo's `components` become its ₹0 item lines, each for one combo. */
export interface PricedItem {
  productId: string;
  variantId: string | null;
  name: string;
  pricePaise: number;
  gstRate: number;
  qty: number;
  note: string | null;
  components: Array<{ productId: string; variantId: string | null; name: string; qty: number }>;
}

interface ProductRow extends PriceRow { id: string; name: string; gst_rate: number | null; is_active: number; is_sold_out: number; kind: "item" | "combo" }
interface VariantRow extends PriceRow { id: string; product_id: string; name: string; is_active: number }

/** Checks a requested item against the catalog and prices it for the order's price tier. Throws an HTTP error to show staff. */
export function priceOrderItem(db: Database, tier: PriceTier, item: ItemRequest): PricedItem {
  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(item.productId) as ProductRow | undefined;
  if (!product) throw httpError(400, "unknown product");

  let variant: VariantRow | undefined;
  if (item.variantId) {
    variant = db.prepare("SELECT * FROM variants WHERE id = ?").get(item.variantId) as VariantRow | undefined;
    if (!variant) throw httpError(400, "unknown variant");
    if (variant.is_active !== 1) throw httpError(400, "variant is not active");
    if (variant.product_id !== item.productId) throw httpError(400, "variant does not belong to product");
  }

  if (product.is_active !== 1) throw httpError(400, "product is not active");
  if (product.is_sold_out === 1) throw httpError(409, `${product.name} is sold out. Review the order before adding it.`);
  if (product.kind !== "combo" && item.comboPicks) throw httpError(400, "Only a combo has items to choose");

  const gstRate = effectiveGstRate(product.gst_rate, readGstSettings(db).gstRate);
  const base = { productId: item.productId, variantId: item.variantId, qty: item.qty, note: item.note || null, gstRate };
  if (product.kind !== "combo") {
    return { ...base, name: variant ? `${product.name} (${variant.name})` : product.name, pricePaise: rowPrice(variant ?? product, tier), components: [] };
  }
  let chosen;
  try { chosen = resolveComboPicks(comboGroups(db, product.id), item.comboPicks ?? []); }
  catch (err) { if (err instanceof ComboPickError) throw httpError(409, `${product.name}: ${err.message}`, "combo_picks"); throw err; }
  return { ...base, name: product.name, pricePaise: rowPrice(product, tier) + chosen.extraPaise,
    components: chosen.items.map(({ productId, variantId, name, qty }) => ({ productId, variantId, name, qty })) };
}

/**
 * Saves a priced line on an order, and a combo's items as ₹0 lines under it with the combo's GST rate and note, so each
 * goes to its own kitchen station. Returns the line's id. Call inside a transaction.
 */
export function insertOrderItem(db: Database, orderId: string, item: PricedItem, ref: { clientRef: string | null; guestRequestId?: string | null }): string {
  const insert = db.prepare(`INSERT INTO order_items (id, order_id, client_ref, product_id, variant_id, name_snapshot, price_paise_snapshot,
    gst_rate_snapshot, qty, note, guest_request_id, parent_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const id = uuidv7();
  insert.run(id, orderId, ref.clientRef, item.productId, item.variantId, item.name, item.pricePaise, item.gstRate, item.qty, item.note, ref.guestRequestId ?? null, null);
  for (const component of item.components) {
    insert.run(uuidv7(), orderId, null, component.productId, component.variantId, component.name, 0, item.gstRate, component.qty * item.qty, item.note, null, id);
  }
  return id;
}
