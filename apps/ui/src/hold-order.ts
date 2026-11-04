import { cartRowForKitchen, kitchenLines } from "./combo-cart";
import type { OrderItem, Product } from "./types";

/** The parts of a cart row the hold-order helpers read (OrderScreen's DraftItem has these and more). */
export interface HoldDraftRow { clientRef: string; productId: string; variantId: string | null; qty: number; note: string; comboPicks?: string[]; held?: boolean }

/** A punch request's items for these cart rows. `held` goes only when set, so older hubs see the same body as before. */
export function punchItems(rows: HoldDraftRow[]) {
  return rows.map((row) => ({
    clientRef: row.clientRef,
    productId: row.productId,
    variantId: row.variantId,
    qty: row.qty,
    ...(row.note ? { note: row.note } : {}),
    ...(row.comboPicks ? { comboPicks: row.comboPicks } : {}),
    ...(row.held ? { held: true as const } : {}),
  }));
}

/** Order lines held back from the kitchen: pending, held, and not an item inside a combo (the combo's line holds them). */
export const heldLines = (items: OrderItem[]): OrderItem[] => items.filter((item) => item.status === "pending" && !item.parentItemId && item.held);

/** Order lines a KOT should send now: the kitchen lines that are not held. */
export function sendableLines(items: OrderItem[], catalog: Product[]): OrderItem[] {
  return kitchenLines(items, catalog).filter((item) => !item.held);
}

/** What Fire should name: held lines (by reference when they have one) and held kitchen rows still in the cart. */
export function heldTargets(items: OrderItem[], cart: HoldDraftRow[], catalog: Product[]): { itemIds: string[]; itemRefs: string[]; count: number } {
  const lines = heldLines(items);
  const itemIds = lines.filter((item) => !item.clientRef).map((item) => item.id);
  const itemRefs = lines.flatMap((item) => item.clientRef ? [item.clientRef] : []);
  const named = new Set([...itemRefs, ...items.flatMap((item) => item.clientRef ? [item.clientRef] : [])]);
  for (const row of cart) if (row.held && !named.has(row.clientRef) && cartRowForKitchen(row, catalog)) { itemRefs.push(row.clientRef); named.add(row.clientRef); }
  return { itemIds, itemRefs, count: itemIds.length + itemRefs.length };
}

export const holdPrompt = (n: number) => `Send ${n} held ${n === 1 ? "item" : "items"} to the kitchen and continue?`;

/** Hold controls follow the setting; Fire stays while anything is held, so nothing held before it was turned off is stuck. */
export const holdControls = (enabled: boolean, heldCount: number) => ({ showHold: enabled, showFire: heldCount > 0 });
