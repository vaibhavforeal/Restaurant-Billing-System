import { describe, expect, it } from "vitest";
import { expireRef, expiringSoon, expiryDue, openLots, type LedgerEntry } from "./loyalty-expiry.js";

let seq = 0;
const row = (kind: LedgerEntry["kind"], points: number, createdAt: number, expiresAt: number | null = null, clientRef: string | null = null, billId: string | null = null): LedgerEntry =>
  ({ id: `l${String(++seq).padStart(3, "0")}`, kind, points, createdAt, expiresAt, clientRef, billId });

describe("points expiry", () => {
  it("spends the oldest points first and expires what is left of a lot", () => {
    const a = row("earn", 100, 1, 50), b = row("earn", 40, 2, 80);
    const entries = [a, b, row("redeem", -70, 10)];
    expect(openLots(entries).map((l) => [l.id, l.remaining])).toEqual([[a.id, 30], [b.id, 40]]);
    expect(expiryDue(entries, 49)).toEqual([]);
    expect(expiryDue(entries, 50)).toEqual([{ lotId: a.id, points: 30, expiredAt: 50 }]);
    expect(expiryDue(entries, 90)).toEqual([{ lotId: a.id, points: 30, expiredAt: 50 }, { lotId: b.id, points: 40, expiredAt: 80 }]);
  });

  it("is settled once the expire row is written, so a second sweep finds nothing", () => {
    const a = row("earn", 100, 1, 50);
    const entries = [a, row("redeem", -20, 10), row("expire", -80, 60, null, expireRef(a.id))];
    expect(expiryDue(entries, 100)).toEqual([]);
    expect(openLots(entries)).toEqual([]);
  });

  it("does not let points spent after a lot expired come out of that lot", () => {
    const a = row("earn", 50, 1, 20), b = row("earn", 50, 2, null);
    const entries = [a, b, row("redeem", -30, 30)];
    expect(expiryDue(entries, 40)).toEqual([{ lotId: a.id, points: 50, expiredAt: 20 }]);
    expect(openLots(entries).find((l) => l.id === b.id)!.remaining).toBe(20);
  });

  it("lets new points pay off a negative balance before they can expire", () => {
    const a = row("earn", 10, 1, 100);
    const entries = [a, row("redeem", -10, 2), row("reverse", -10, 3), row("earn", 25, 4, 100)];
    expect(expiryDue(entries, 200)).toEqual([{ lotId: entries[3]!.id, points: 15, expiredAt: 100 }]);
  });

  it("never expires points without an expiry date and reports points expiring soon", () => {
    const entries = [row("adjust", 30, 1), row("earn", 20, 2, 1_000), row("earn", 5, 3, 5_000)];
    expect(expiryDue(entries, 10_000).map((d) => d.points)).toEqual([20, 5]);
    expect(expiringSoon(entries, 500, 1_000)).toEqual({ points: 20, firstAt: 1_000 });
    expect(expiringSoon(entries, 2_000, 1_000)).toEqual({ points: 0, firstAt: null });
  });

  it("takes a voided bill's points back from the lot that bill earned, not the oldest lot", () => {
    const a = row("earn", 100, 0, 30, null, "b1"), b = row("earn", 50, 10, 400, null, "b2");
    const entries = [a, b, row("reverse", -50, 11, null, null, "b2")];
    expect(openLots(entries).map((l) => [l.id, l.remaining])).toEqual([[a.id, 100]]);
    expect(expiryDue(entries, 31)).toEqual([{ lotId: a.id, points: 100, expiredAt: 30 }]);
  });

  it("takes a voided bill's points back from its own lot even after that lot expired, so they are not lost twice", () => {
    const a = row("earn", 100, 0, 30, null, "b1");
    const entries = [a, row("reverse", -100, 31, null, null, "b1")];
    expect(expiryDue(entries, 40)).toEqual([]);
    // No debt is left behind for later points to pay off.
    expect(openLots([...entries, row("earn", 20, 50, null)]).map((l) => l.remaining)).toEqual([20]);
  });
});
