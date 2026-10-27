/**
 * Points expiry over the append-only loyalty ledger.
 *
 * Every positive row (earned points, a positive adjustment, redeemed points returned on a void) is a lot. Rows that take
 * points away (redeem, reverse, negative adjust) use the oldest lot that had not yet expired at that moment, so points
 * that are about to expire are spent first. An `expire` row names the lot it closes through its `client_ref`
 * (`expire:<lotId>`). When points are taken away and no lot is left, the balance goes below zero; the next lots pay
 * that off before anything else.
 *
 * Lots without `expiresAt` (all points from before expiry was turned on) never expire.
 */
export interface LedgerEntry {
  id: string;
  kind: "earn" | "redeem" | "reverse" | "adjust" | "expire";
  points: number;
  createdAt: number;
  expiresAt: number | null;
  clientRef: string | null;
}
export interface PointsLot { id: string; points: number; remaining: number; createdAt: number; expiresAt: number | null }

export const expireRef = (lotId: string) => `expire:${lotId}`;
const lotOf = (entry: LedgerEntry) => entry.kind === "expire" && entry.clientRef?.startsWith("expire:") ? entry.clientRef.slice(7) : null;

/** The lots still holding points, oldest first, after replaying the ledger. */
export function openLots(entries: LedgerEntry[]): PointsLot[] {
  const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lots: PointsLot[] = [];
  let debt = 0;
  for (const entry of sorted) {
    if (entry.points > 0) {
      const paid = Math.min(debt, entry.points);
      debt -= paid;
      lots.push({ id: entry.id, points: entry.points, remaining: entry.points - paid, createdAt: entry.createdAt, expiresAt: entry.expiresAt });
      continue;
    }
    let owed = -entry.points;
    const named = lotOf(entry);
    if (named) {
      const lot = lots.find((l) => l.id === named);
      if (lot) { const used = Math.min(lot.remaining, owed); lot.remaining -= used; owed -= used; }
    }
    for (const lot of lots) {
      if (!owed) break;
      if (lot.remaining <= 0 || (lot.expiresAt !== null && lot.expiresAt <= entry.createdAt)) continue;
      const used = Math.min(lot.remaining, owed);
      lot.remaining -= used; owed -= used;
    }
    debt += owed;
  }
  return lots.filter((l) => l.remaining > 0);
}

/** The points each lot still holds after its expiry date: what a sweep writes as `expire` rows. */
export function expiryDue(entries: LedgerEntry[], now: number): Array<{ lotId: string; points: number; expiredAt: number }> {
  return openLots(entries).filter((l) => l.expiresAt !== null && l.expiresAt <= now).map((l) => ({ lotId: l.id, points: l.remaining, expiredAt: l.expiresAt! }));
}

/** Points that will expire after `now` and up to `now + withinMs`, and when the first of them goes. */
export function expiringSoon(entries: LedgerEntry[], now: number, withinMs: number): { points: number; firstAt: number | null } {
  let points = 0, firstAt: number | null = null;
  for (const lot of openLots(entries)) {
    if (lot.expiresAt === null || lot.expiresAt <= now || lot.expiresAt > now + withinMs) continue;
    points += lot.remaining;
    firstAt = firstAt === null ? lot.expiresAt : Math.min(firstAt, lot.expiresAt);
  }
  return { points, firstAt };
}
