import { z } from "zod";
import type { SqlDriver } from "./driver.js";
import { dataChanged } from "./events.js";

export interface HeldLine {
  itemId: string | null; variantId: string | null; qty: number;
  custom?: { name: string; pricePaise: number; gstRate: number | null }; note?: string | null; addonOptionIds?: string[];
}
export interface HeldCart {
  lines: HeldLine[]; discount: { kind: "amount"; paise: number } | { kind: "percent"; bp: number } | null;
  discountNote: string; orderKind: "takeaway" | "delivery"; deliveryNote: string; customerId: string | null; removedOfferIds: string[];
}
export interface HeldSummary { id: string; note: string; staffName: string | null; lineCount: number; createdAt: number }

/** A held cart holds what was chosen, never prices: those are worked out again when it is opened. */
export const HeldCartSchema: z.ZodType<HeldCart> = z.object({
  lines: z.array(z.object({
    itemId: z.string().nullable(),
    variantId: z.string().nullable(),
    qty: z.number().int().positive(),
    custom: z.object({ name: z.string(), pricePaise: z.number().int(), gstRate: z.number().nullable() }).optional(),
    note: z.string().nullable().optional(),
    addonOptionIds: z.array(z.string()).default([]),
  })),
  discount: z.union([
    z.object({ kind: z.literal("amount"), paise: z.number().int() }),
    z.object({ kind: z.literal("percent"), bp: z.number().int() }),
  ]).nullable(),
  discountNote: z.string(),
  orderKind: z.enum(["takeaway", "delivery"]),
  deliveryNote: z.string(),
  customerId: z.string().nullable(),
  removedOfferIds: z.array(z.string()).default([]),
}) as z.ZodType<HeldCart>;

/** Saves a cart to open later. Held carts stay on this phone and are never synced. The note is cut to 40 characters. */
export function holdCart(db: SqlDriver, input: { id: string; cart: HeldCart; note: string; staffId: string | null; now: number }): void {
  const cart = HeldCartSchema.parse(input.cart);
  db.transaction(() => db.run("INSERT INTO held_carts (id, cart_json, note, staff_id, created_at) VALUES (?, ?, ?, ?, ?)",
    [input.id, JSON.stringify(cart), input.note.trim().slice(0, 40), input.staffId, input.now]));
  dataChanged();
}

/** Oldest first. A row whose cart no longer parses still lists, with 0 lines, so it can be deleted. */
export function listHeld(db: SqlDriver): HeldSummary[] {
  const rows = db.all<{ id: string; note: string; staff_name: string | null; cart_json: string; created_at: number }>(
    `SELECT h.id, h.note, s.name AS staff_name, h.cart_json, h.created_at FROM held_carts h
      LEFT JOIN staff s ON s.id = h.staff_id ORDER BY h.created_at, h.id`);
  return rows.map((r) => ({ id: r.id, note: r.note, staffName: r.staff_name, lineCount: parse(r.cart_json)?.lines.length ?? 0,
    createdAt: r.created_at }));
}

function parse(json: string): HeldCart | null {
  try {
    const r = HeldCartSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Reads, parses and deletes in one transaction. A cart that no longer parses is deleted and gives null. */
export function takeHeld(db: SqlDriver, id: string): HeldCart | null {
  const cart = db.transaction(() => {
    const row = db.get<{ cart_json: string }>("SELECT cart_json FROM held_carts WHERE id = ?", [id]);
    if (!row) return undefined;
    db.run("DELETE FROM held_carts WHERE id = ?", [id]);
    return parse(row.cart_json);
  });
  if (cart !== undefined) dataChanged();
  return cart ?? null;
}

export function deleteHeld(db: SqlDriver, id: string): void {
  db.transaction(() => db.run("DELETE FROM held_carts WHERE id = ?", [id]));
  dataChanged();
}
