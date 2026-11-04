import { ComboPickError, resolveComboPicks } from "@masalapos/domain/combos";
import type { Product, Variant } from "./types";

/** A dish this customer orders regularly (from `/api/customers/:id/usual`). */
export interface UsualDish { productId: string; variantId: string | null; bills: number }
/** The customer's latest bill that was not voided. */
export interface LastOrder {
  billNo: number;
  createdAt: number;
  items: Array<{ productId: string; variantId: string | null; name: string; qty: number }>;
}
/** A cart row Repeat last order adds; a combo carries its (empty) picks and what it holds. */
export interface RepeatRow {
  productId: string; variantId: string | null; name: string; pricePaise: number; qty: number;
  comboPicks?: string[]; contents?: string[];
}

const activeSizes = (product: Product) => product.variants.filter((v) => v.isActive);

/**
 * The "Usual for …" buttons: the customer's usual dishes that are on the menu, in stock and not already on this order,
 * each in their usual size (or the first size still offered). Combos stay; tapping one asks for its items.
 */
export function usualChips(dishes: UsualDish[], onOrder: ReadonlySet<string>, products: Product[], limit = 4): Array<{ product: Product; variant: Variant | null }> {
  const chips: Array<{ product: Product; variant: Variant | null }> = [];
  for (const dish of dishes) {
    const product = products.find((p) => p.id === dish.productId);
    if (!product || !product.isActive || product.isSoldOut || onOrder.has(product.id)) continue;
    const sizes = activeSizes(product);
    if (product.variants.length && !sizes.length) continue;
    chips.push({ product, variant: sizes.find((v) => v.id === dish.variantId) ?? sizes[0] ?? null });
    if (chips.length === limit) break;
  }
  return chips;
}

/**
 * Repeat last order: the last bill's dishes as cart rows at today's prices (`products` are already priced for this
 * order). Dishes that cannot go back in as they were are named in `skipped`, with why: off the menu, sold out, a size
 * no longer offered, or a combo whose items must be chosen again.
 */
export function repeatPlan(last: LastOrder, products: Product[]): { rows: RepeatRow[]; skipped: string[] } {
  const rows: RepeatRow[] = [], skipped: string[] = [];
  for (const item of last.items) {
    const product = products.find((p) => p.id === item.productId);
    if (!product || !product.isActive) { skipped.push(`${item.name} (no longer on the menu)`); continue; }
    if (product.isSoldOut) { skipped.push(`${item.name} (sold out)`); continue; }
    if (product.kind === "combo") {
      try {
        const chosen = resolveComboPicks(product.combo ?? [], []);
        rows.push({ productId: product.id, variantId: null, name: product.name, pricePaise: product.pricePaise + chosen.extraPaise, qty: item.qty,
          comboPicks: [], contents: chosen.items.map((choice) => choice.qty > 1 ? `${choice.qty} × ${choice.name}` : choice.name) });
      } catch (error) {
        if (!(error instanceof ComboPickError)) throw error;
        skipped.push(`${item.name} (choose its items from the menu)`);
      }
      continue;
    }
    const sizes = activeSizes(product);
    if (item.variantId) {
      const size = sizes.find((v) => v.id === item.variantId);
      if (!size) { skipped.push(`${item.name} (size no longer on the menu)`); continue; }
      rows.push({ productId: product.id, variantId: size.id, name: `${product.name} (${size.name})`, pricePaise: size.pricePaise, qty: item.qty });
    } else if (product.variants.length) {
      skipped.push(`${item.name} (choose a size from the menu)`);
    } else {
      rows.push({ productId: product.id, variantId: null, name: product.name, pricePaise: product.pricePaise, qty: item.qty });
    }
  }
  return { rows, skipped };
}
