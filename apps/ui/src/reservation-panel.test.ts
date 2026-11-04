import { describe, expect, it } from "vitest";
import type { Reservation } from "@masalapos/domain";
import { reservationSlots, slotStart } from "./reservation-panel";

const min = 60000;
// 2026-11-04 17:10:20 in Kolkata (UTC+5:30).
const now = Date.UTC(2026, 10, 4, 11, 40, 20);
const tz = "Asia/Kolkata";
const slot = Date.UTC(2026, 10, 4, 11, 30); // 17:00 Kolkata
function booking(id: string, startMin: number, over: Partial<Reservation> = {}): Reservation {
  const startsAt = slot + startMin * min;
  return { id, tableId: "t1", tableName: "T1", area: null, customerName: id, phone: "", partySize: 2, startsAt, endsAt: startsAt + 90 * min,
    startsLocal: "", durationMinutes: 90, notes: "", status: "booked", orderId: null, orderStatus: null, version: 1, ...over };
}

describe("slotStart", () => {
  it("rounds down to the half hour on the restaurant's clock", () => {
    expect(slotStart(now, tz)).toBe(slot);
    // Kathmandu is UTC+5:45: 17:10 there starts its slot at 17:00 local, which is 11:15 UTC.
    expect(slotStart(Date.UTC(2026, 10, 4, 11, 25, 5), "Asia/Kathmandu")).toBe(Date.UTC(2026, 10, 4, 11, 15));
  });
});

describe("reservationSlots", () => {
  it("puts bookings under way or starting this half hour in current and the next half hour in upcoming, sorted by start", () => {
    const { current, upcoming } = reservationSlots([booking("17:45", 45), booking("17:20", 20), booking("late", -30), booking("17:30", 30), booking("18:00", 60)], now, tz);
    expect(current).toMatchObject({ start: slot, end: slot + 30 * min });
    expect(current.reservations.map((r) => r.id)).toEqual(["late", "17:20"]);
    expect(upcoming).toMatchObject({ start: slot + 30 * min, end: slot + 60 * min });
    expect(upcoming.reservations.map((r) => r.id)).toEqual(["17:30", "17:45"]);
  });

  it("drops ended, seated, cancelled and no-show bookings", () => {
    const { current, upcoming } = reservationSlots([
      booking("ended", -100), booking("seated", 0, { status: "seated" }), booking("cancelled", 40, { status: "cancelled" }), booking("noshow", -20, { status: "no_show" }),
    ], now, tz);
    expect(current.reservations).toEqual([]); expect(upcoming.reservations).toEqual([]);
  });
});
