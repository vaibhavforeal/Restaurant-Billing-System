import type { CartLine } from "@masalapos/cafe-data";

export interface CartEntry { key: string; itemId: string | null; variantId: string | null; name: string; pricePaise: number; gstRate: number | null; qty: number }
/** A percent discount is in basis points: 1250 is 12.5%. */
export type Discount = { kind: "amount"; paise: number } | { kind: "percent"; bp: number };
/** Everything in the cart at one moment. A new object after every change, so screens can depend on it. */
export interface CartSnapshot { readonly lines: readonly CartEntry[]; readonly discount: Discount | null; readonly note: string }

const MAX_QTY = 999;

/** A discount in paise for a subtotal: a percent rounds half up, and it never exceeds the subtotal. */
export function discountPaiseFor(discount: Discount | null, subtotalPaise: number): number {
  if (!discount) return 0;
  const raw = discount.kind === "amount" ? discount.paise : Math.floor((subtotalPaise * discount.bp + 5000) / 10000);
  return Math.max(0, Math.min(subtotalPaise, Math.trunc(raw)));
}

/** Cart lines as createBill takes them. */
export function linesForBill(lines: readonly CartEntry[]): CartLine[] {
  return lines.map((l) => (l.itemId === null
    ? { itemId: null, variantId: null, qty: l.qty, custom: { name: l.name, pricePaise: l.pricePaise, gstRate: l.gstRate } }
    : { itemId: l.itemId, variantId: l.variantId, qty: l.qty }));
}

/** The cart lives in memory in one store. The bill's real prices come from the menu when it is saved. */
export function createCartStore() {
  let snap: CartSnapshot = { lines: [], discount: null, note: "" };
  let nextKey = 1;
  const listeners = new Set<() => void>();
  const change = (next: Partial<CartSnapshot>) => {
    snap = { ...snap, ...next };
    for (const fn of [...listeners]) fn();
  };

  return {
    /** The current state; the same object until something changes. */
    snapshot(): CartSnapshot { return snap; },
    entries(): readonly CartEntry[] { return snap.lines; },
    /** The same item and variant adds 1 to its line; custom lines never merge. */
    add(e: Omit<CartEntry, "key" | "qty">) {
      const same = e.itemId === null ? undefined : snap.lines.find((l) => l.itemId === e.itemId && l.variantId === e.variantId);
      change({ lines: same
        ? snap.lines.map((l) => (l === same ? { ...l, qty: Math.min(MAX_QTY, l.qty + 1) } : l))
        : [...snap.lines, { ...e, key: `line-${nextKey++}`, qty: 1 }] });
    },
    /** 0 removes the line; quantities stop at 999. */
    setQty(key: string, qty: number) {
      const q = Math.min(MAX_QTY, Math.max(0, Math.trunc(qty)));
      change({ lines: q === 0 ? snap.lines.filter((l) => l.key !== key) : snap.lines.map((l) => (l.key === key ? { ...l, qty: q } : l)) });
    },
    setDiscount(d: Discount | null, discountNote = "") {
      change({ discount: d, note: d ? discountNote : "" });
    },
    discount(): { value: Discount | null; note: string } { return { value: snap.discount, note: snap.note }; },
    discountPaise(subtotalPaise: number): number { return discountPaiseFor(snap.discount, subtotalPaise); },
    toLines(): CartLine[] { return linesForBill(snap.lines); },
    clear() { change({ lines: [], discount: null, note: "" }); },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export type CartStore = ReturnType<typeof createCartStore>;
