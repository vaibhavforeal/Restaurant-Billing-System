import { AddonPickError, ComboPickError, effectiveGstRate, resolveAddonPicks, resolveComboPicks, uuidv7, type Database, type PriceTier } from "@masalapos/domain";
import { httpError } from "./http-error.js";
import { rowPrice, type PriceRow } from "./pricing.js";
import { readGstSettings } from "./gst-settings.js";
import { comboGroups } from "./combos.js";
import { addonGroupsFor } from "./addon-groups.js";

export interface ItemRequest {
  productId: string;
  variantId: string | null;
  qty: number;
  note?: string | undefined;
  comboPicks?: string[] | undefined;
  /** The add-on option ids picked for this dish. */
  addonPicks?: string[] | undefined;
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
  /** Picked add-ons, each saved as its own priced line under the dish. */
  addons: Array<{ productId: string; variantId: string | null; name: string; pricePaise: number; gstRate: number }>;
}

interface ProductRow extends PriceRow { id: string; name: string; gst_rate: number | null; is_active: number; is_sold_out: number; kind: "item" | "combo"; addon_only: number }
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
  if (product.addon_only === 1) throw httpError(409, `${product.name} is an add-on. Add it under a dish.`, "addon_only");
  if (product.kind === "combo" && item.addonPicks?.length) throw httpError(400, "A combo has no add-ons");

  const defaultRate = readGstSettings(db).gstRate;
  const gstRate = effectiveGstRate(product.gst_rate, defaultRate);
  const base = { productId: item.productId, variantId: item.variantId, qty: item.qty, note: item.note || null, gstRate };
  if (product.kind !== "combo") {
    return { ...base, name: variant ? `${product.name} (${variant.name})` : product.name, pricePaise: rowPrice(variant ?? product, tier), components: [],
      addons: priceAddons(db, tier, product, item.addonPicks ?? [], defaultRate) };
  }
  let chosen;
  try { chosen = resolveComboPicks(comboGroups(db, product.id), item.comboPicks ?? []); }
  catch (err) { if (err instanceof ComboPickError) throw httpError(409, `${product.name}: ${err.message}`, "combo_picks"); throw err; }
  return { ...base, name: product.name, pricePaise: rowPrice(product, tier) + chosen.extraPaise,
    components: chosen.items.map(({ productId, variantId, name, qty }) => ({ productId, variantId, name, qty })), addons: [] };
}

/** Checks a dish's add-on picks and prices each add-on at its own price for the tier and its own GST rate. */
function priceAddons(db: Database, tier: PriceTier, dish: ProductRow, picks: string[], defaultRate: number): PricedItem["addons"] {
  let chosen;
  try { chosen = resolveAddonPicks(addonGroupsFor(db, dish.id), picks); }
  catch (err) { if (err instanceof AddonPickError) throw httpError(409, `${dish.name}: ${err.message}`, "addon_picks"); throw err; }
  return chosen.map((choice) => {
    const addon = db.prepare("SELECT * FROM products WHERE id = ?").get(choice.productId) as ProductRow;
    const variant = choice.variantId ? db.prepare("SELECT * FROM variants WHERE id = ?").get(choice.variantId) as VariantRow : undefined;
    if (addon.is_active !== 1 || addon.is_sold_out === 1 || (variant && variant.is_active !== 1)) {
      throw httpError(409, `${dish.name}: ${choice.name} is not available`, "addon_picks");
    }
    return { productId: choice.productId, variantId: choice.variantId, name: choice.name, pricePaise: rowPrice(variant ?? addon, tier),
      gstRate: effectiveGstRate(addon.gst_rate, defaultRate) };
  });
}

/**
 * Saves a priced line on an order, and a combo's items as ₹0 lines under it with the combo's GST rate and note, so each
 * goes to its own kitchen station. Returns the line's id. Call inside a transaction.
 */
export function insertOrderItem(db: Database, orderId: string, item: PricedItem, ref: { clientRef: string | null; guestRequestId?: string | null; held?: boolean }): string {
  const insert = db.prepare(`INSERT INTO order_items (id, order_id, client_ref, product_id, variant_id, name_snapshot, price_paise_snapshot,
    gst_rate_snapshot, qty, note, guest_request_id, parent_item_id, held, addon_of_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const id = uuidv7();
  insert.run(id, orderId, ref.clientRef, item.productId, item.variantId, item.name, item.pricePaise, item.gstRate, item.qty, item.note, ref.guestRequestId ?? null, null, ref.held ? 1 : 0, null);
  // A combo's items follow its line's hold; only the line carries the flag.
  for (const component of item.components) {
    insert.run(uuidv7(), orderId, null, component.productId, component.variantId, component.name, 0, item.gstRate, component.qty * item.qty, item.note, null, id, 0, null);
  }
  // An add-on is its own priced line, one per unit of the dish; it follows the dish's hold through the KOT query.
  for (const addon of item.addons) {
    insert.run(uuidv7(), orderId, null, addon.productId, addon.variantId, addon.name, addon.pricePaise, addon.gstRate, item.qty, null, null, null, 0, id);
  }
  return id;
}
