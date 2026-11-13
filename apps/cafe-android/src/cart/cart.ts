import { useSyncExternalStore } from "react";
import { BillError, getCustomer, getItemName, listMenu, previewBill, type HeldCart, type SqlDriver } from "@masalapos/cafe-data";
import type { BillTotals } from "@masalapos/domain/billing";
import { createCartStore, discountPaiseFor, linesForBill, type CartEntry, type CartSnapshot, type CartStore } from "./cart-store";

/** The counter's one cart. It lives in memory; a bill is only written when it is paid. */
export const cart: CartStore = createCartStore();

/** The cart's current snapshot; the screen re-renders with a new one on every change. */
export function useCart(): CartSnapshot {
  return useSyncExternalStore(cart.subscribe, cart.snapshot);
}

export type CartTotals =
  | { ok: true; totals: BillTotals; discountPaise: number }
  | { ok: false; error: BillError | Error; lineIndex: number | null };

/** A cart snapshot priced from the menu as it is now, with its discount; or the reason it cannot be billed. */
export function cartTotals(db: SqlDriver, snap: CartSnapshot): CartTotals | null {
  const lines = linesForBill(snap.lines);
  if (!lines.length) return null;
  try {
    const subtotal = previewBill(db, { lines, discountPaise: 0 }).subtotalPaise;
    const discountPaise = discountPaiseFor(snap.discount, subtotal);
    return { ok: true, totals: previewBill(db, { lines, discountPaise }), discountPaise };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return { ok: false, error, lineIndex: e instanceof BillError ? e.lineIndex ?? null : null };
  }
}

/** What the cashier reads when a bill is refused. `lineName` names the cart line it is about, when there is one. */
export function billErrorMessage(e: unknown, lineName?: string): string {
  if (!(e instanceof BillError)) return "This bill could not be saved. Try again.";
  switch (e.code) {
    case "item_unavailable": return `${lineName ?? "An item"} is no longer available. Remove it to continue.`;
    case "payments_mismatch": return "The payments do not add up to the total.";
    case "counter_exhausted": return "This year's bill numbers are used up. Change the bill prefix in More, Receipt.";
    case "discount_too_large": return "The discount is more than the bill.";
    case "unknown_staff": return "Sign in again: this person is no longer on the staff list.";
    case "unknown_customer": return "The customer was deleted. Remove them from the bill or choose another.";
    case "approval_needed": return "A manager or the owner must approve this discount. Apply it again to ask.";
    case "invalid_line": return `Check ${lineName ?? "this line"}: choose a size, and a quantity from 1 to 999.`;
    default: return "This bill could not be saved. Try again.";
  }
}

/**
 * Turns a held cart back into cart lines priced from the menu as it is now. Lines whose item or variant was deleted
 * are left out and named in `missing`; an unavailable item stays in, so the cart names it as it would any line.
 */
export function entriesFromHeld(db: SqlDriver, held: HeldCart): {
  entries: CartEntry[]; missing: string[]; customer: CartSnapshot["customer"]; customerMissing: boolean;
} {
  const items = new Map(listMenu(db).items.map((i) => [i.id, i]));
  const entries: CartEntry[] = [];
  const missing: string[] = [];
  held.lines.forEach((line, i) => {
    const key = `held-${i}`;
    const note = line.note?.trim() || null;
    if (line.itemId === null) {
      const c = line.custom;
      if (c) entries.push({ key, itemId: null, variantId: null, name: c.name, pricePaise: c.pricePaise, gstRate: c.gstRate, qty: line.qty, note });
      return;
    }
    const item = items.get(line.itemId);
    const variant = line.variantId === null ? null : item?.variants.find((v) => v.id === line.variantId);
    if (!item || variant === undefined) {
      missing.push(item?.name ?? getItemName(db, line.itemId) ?? "An item");
      return;
    }
    entries.push({ key, itemId: item.id, variantId: variant?.id ?? null, name: variant ? `${item.name} (${variant.name})` : item.name,
      pricePaise: variant?.pricePaise ?? item.pricePaise, gstRate: item.gstRate, qty: line.qty, note });
  });
  const found = held.customerId ? getCustomer(db, held.customerId) : null;
  return {
    entries, missing,
    customer: found ? { id: found.id, name: found.name, phone: found.phone } : null,
    customerMissing: held.customerId !== null && !found,
  };
}
