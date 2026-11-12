import type { CartLine } from "@masalapos/cafe-data";

export interface CartEntry { key: string; itemId: string | null; variantId: string | null; name: string; pricePaise: number; gstRate: number | null; qty: number }
/** A percent discount is in basis points: 1250 is 12.5%. */
export type Discount = { kind: "amount"; paise: number } | { kind: "percent"; bp: number };

const MAX_QTY = 999;

/** The cart lives in memory in one store. The bill's real prices come from the menu when it is saved. */
export function createCartStore() {
  let lines: CartEntry[] = [];
  let discount: Discount | null = null;
  let note = "";
  let nextKey = 1;
  const listeners = new Set<() => void>();
  const changed = () => { for (const fn of [...listeners]) fn(); };

  return {
    entries(): readonly CartEntry[] { return lines; },
    /** The same item and variant adds 1 to its line; custom lines never merge. */
    add(e: Omit<CartEntry, "key" | "qty">) {
      const same = e.itemId === null ? undefined : lines.find((l) => l.itemId === e.itemId && l.variantId === e.variantId);
      lines = same
        ? lines.map((l) => (l === same ? { ...l, qty: Math.min(MAX_QTY, l.qty + 1) } : l))
        : [...lines, { ...e, key: `line-${nextKey++}`, qty: 1 }];
      changed();
    },
    /** 0 removes the line; quantities stop at 999. */
    setQty(key: string, qty: number) {
      const q = Math.min(MAX_QTY, Math.max(0, Math.trunc(qty)));
      lines = q === 0 ? lines.filter((l) => l.key !== key) : lines.map((l) => (l.key === key ? { ...l, qty: q } : l));
      changed();
    },
    setDiscount(d: Discount | null, discountNote = "") {
      discount = d;
      note = d ? discountNote : "";
      changed();
    },
    discount(): { value: Discount | null; note: string } { return { value: discount, note }; },
    /** A percent rounds half up; the discount never exceeds the subtotal. */
    discountPaise(subtotalPaise: number): number {
      if (!discount) return 0;
      const raw = discount.kind === "amount" ? discount.paise : Math.floor((subtotalPaise * discount.bp + 5000) / 10000);
      return Math.max(0, Math.min(subtotalPaise, Math.trunc(raw)));
    },
    toLines(): CartLine[] {
      return lines.map((l) => (l.itemId === null
        ? { itemId: null, variantId: null, qty: l.qty, custom: { name: l.name, pricePaise: l.pricePaise, gstRate: l.gstRate } }
        : { itemId: l.itemId, variantId: l.variantId, qty: l.qty }));
    },
    clear() {
      lines = [];
      discount = null;
      note = "";
      changed();
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export type CartStore = ReturnType<typeof createCartStore>;
