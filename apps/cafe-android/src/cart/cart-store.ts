import type { CartLine, HeldCart, OrderKind } from "@masalapos/cafe-data";

/** A cart line. `note` is for the kitchen ("less sugar"); it never prints on the receipt. */
export interface CartEntry {
  key: string; itemId: string | null; variantId: string | null; name: string; pricePaise: number; gstRate: number | null; qty: number;
  note: string | null;
}
/** A percent discount is in basis points: 1250 is 12.5%. */
export type Discount = { kind: "amount"; paise: number } | { kind: "percent"; bp: number };
export interface CartCustomer { id: string; name: string; phone: string }
/** Everything in the cart at one moment. A new object after every change, so screens can depend on it. */
export interface CartSnapshot {
  readonly lines: readonly CartEntry[]; readonly discount: Discount | null; readonly note: string;
  readonly orderKind: OrderKind; readonly deliveryNote: string; readonly customer: CartCustomer | null;
  /** Who approved the discount above the cashier's limit; cleared whenever the discount changes. */
  readonly approvedBy: string | null;
}

const MAX_QTY = 999;
const EMPTY: CartSnapshot = { lines: [], discount: null, note: "", orderKind: "takeaway", deliveryNote: "", customer: null, approvedBy: null };
const cleanLineNote = (note: string | null) => note?.trim().slice(0, 60) || null;

/** A discount in paise for a subtotal: a percent rounds half up. An amount above the subtotal is not capped; see discountProblem. */
export function discountPaiseFor(discount: Discount | null, subtotalPaise: number): number {
  if (!discount) return 0;
  const raw = discount.kind === "amount" ? discount.paise : Math.floor((subtotalPaise * discount.bp + 5000) / 10000);
  return Math.max(0, Math.trunc(raw));
}

/** Why a discount cannot apply to this subtotal, or null. While it stands the cart is priced without the discount. */
export function discountProblem(discount: Discount | null, subtotalPaise: number): string | null {
  return discountPaiseFor(discount, subtotalPaise) > subtotalPaise ? "The discount is more than the bill" : null;
}

/** Cart lines as createBill takes them. */
export function linesForBill(lines: readonly CartEntry[]): CartLine[] {
  return lines.map((l) => {
    const note = l.note ? { note: l.note } : {};
    return l.itemId === null
      ? { itemId: null, variantId: null, qty: l.qty, custom: { name: l.name, pricePaise: l.pricePaise, gstRate: l.gstRate }, ...note }
      : { itemId: l.itemId, variantId: l.variantId, qty: l.qty, ...note };
  });
}

/** The cart lives in memory in one store. The bill's real prices come from the menu when it is saved. */
export function createCartStore() {
  let snap: CartSnapshot = EMPTY;
  /** The chosen customer's address, kept to fill an empty delivery note when the order becomes Delivery. */
  let customerAddress = "";
  let nextKey = 1;
  const listeners = new Set<() => void>();
  const change = (next: Partial<CartSnapshot>) => {
    snap = { ...snap, ...next };
    for (const fn of [...listeners]) fn();
  };
  /**
   * New lines for the cart. An approved amount discount is a different share of a different subtotal, so its approval
   * goes; a percent discount keeps its share, so its approval stays.
   */
  const changeLines = (lines: CartEntry[]) =>
    change(snap.discount?.kind === "amount" ? { lines, approvedBy: null } : { lines });
  const filledNote = (kind: OrderKind, note: string) => (kind === "delivery" && !note.trim() ? customerAddress.slice(0, 200) : note);

  return {
    /** The current state; the same object until something changes. */
    snapshot(): CartSnapshot { return snap; },
    entries(): readonly CartEntry[] { return snap.lines; },
    /** The same item and variant adds 1 to its line, unless that line has a note; custom lines never merge. */
    add(e: Omit<CartEntry, "key" | "qty" | "note">) {
      const same = e.itemId === null ? undefined
        : snap.lines.find((l) => l.itemId === e.itemId && l.variantId === e.variantId && l.note === null);
      changeLines(same
        ? snap.lines.map((l) => (l === same ? { ...l, qty: Math.min(MAX_QTY, l.qty + 1) } : l))
        : [...snap.lines, { ...e, key: `line-${nextKey++}`, qty: 1, note: null }]);
    },
    /** 0 removes the line; quantities stop at 999. */
    setQty(key: string, qty: number) {
      const q = Math.min(MAX_QTY, Math.max(0, Math.trunc(qty)));
      changeLines(q === 0 ? snap.lines.filter((l) => l.key !== key) : snap.lines.map((l) => (l.key === key ? { ...l, qty: q } : l)));
    },
    /** Up to 60 characters; blank removes it. */
    setLineNote(key: string, note: string | null) {
      change({ lines: snap.lines.map((l) => (l.key === key ? { ...l, note: cleanLineNote(note) } : l)) });
    },
    /** Any change of discount drops an earlier approval: the new amount needs its own. */
    setDiscount(d: Discount | null, discountNote = "") {
      change({ discount: d, note: d ? discountNote : "", approvedBy: null });
    },
    setApproval(staffId: string | null) { change({ approvedBy: staffId }); },
    discount(): { value: Discount | null; note: string } { return { value: snap.discount, note: snap.note }; },
    discountPaise(subtotalPaise: number): number { return discountPaiseFor(snap.discount, subtotalPaise); },
    setOrderKind(kind: OrderKind) { change({ orderKind: kind, deliveryNote: filledNote(kind, snap.deliveryNote) }); },
    setDeliveryNote(text: string) { change({ deliveryNote: text.slice(0, 200) }); },
    /** Choosing a customer on a Delivery order with no note fills the note from their address. */
    setCustomer(c: (CartCustomer & { addressNote: string }) | null) {
      customerAddress = c?.addressNote ?? "";
      change({ customer: c ? { id: c.id, name: c.name, phone: c.phone } : null, deliveryNote: filledNote(snap.orderKind, snap.deliveryNote) });
    },
    toLines(): CartLine[] { return linesForBill(snap.lines); },
    /** What a held cart keeps: choices, never prices. */
    toHeld(): HeldCart {
      return {
        lines: snap.lines.map((l) => (l.itemId === null
          ? { itemId: null, variantId: null, qty: l.qty, custom: { name: l.name, pricePaise: l.pricePaise, gstRate: l.gstRate }, note: l.note, addonOptionIds: [] }
          : { itemId: l.itemId, variantId: l.variantId, qty: l.qty, note: l.note, addonOptionIds: [] })),
        discount: snap.discount, discountNote: snap.note, orderKind: snap.orderKind, deliveryNote: snap.deliveryNote,
        customerId: snap.customer?.id ?? null, removedOfferIds: [],
      };
    },
    /** Replaces the cart with a held one, its lines already priced from the menu as it is now. An approval is never carried over. */
    load(held: HeldCart, entries: readonly CartEntry[], customer: CartCustomer | null) {
      customerAddress = "";
      change({
        lines: entries.map((e) => ({ ...e, key: `line-${nextKey++}` })), discount: held.discount, note: held.discount ? held.discountNote : "",
        orderKind: held.orderKind, deliveryNote: held.deliveryNote.slice(0, 200), customer, approvedBy: null,
      });
    },
    clear() { customerAddress = ""; change(EMPTY); },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export type CartStore = ReturnType<typeof createCartStore>;
