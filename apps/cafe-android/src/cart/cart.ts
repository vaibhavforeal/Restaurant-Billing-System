import { useEffect, useReducer } from "react";
import { BillError, previewBill, type SqlDriver } from "@masalapos/cafe-data";
import type { BillTotals } from "@masalapos/domain/billing";
import { createCartStore, type CartStore } from "./cart-store";

/** The counter's one cart. It lives in memory; a bill is only written when it is paid. */
export const cart: CartStore = createCartStore();

/** Re-renders whenever the cart changes. */
export function useCart(): CartStore {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => cart.subscribe(bump), []);
  return cart;
}

export type CartTotals =
  | { ok: true; totals: BillTotals; discountPaise: number }
  | { ok: false; error: BillError | Error; lineIndex: number | null };

/** The cart priced from the menu as it is now, with its discount; or the reason it cannot be billed. */
export function cartTotals(db: SqlDriver, store: CartStore = cart): CartTotals | null {
  const lines = store.toLines();
  if (!lines.length) return null;
  try {
    const subtotal = previewBill(db, { lines, discountPaise: 0 }).subtotalPaise;
    const discountPaise = store.discountPaise(subtotal);
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
    case "invalid_line": return `Check ${lineName ?? "this line"}: choose a size, and a quantity from 1 to 999.`;
    default: return "This bill could not be saved. Try again.";
  }
}
