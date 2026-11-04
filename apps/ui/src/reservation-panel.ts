import type { Reservation } from "@masalapos/domain";

/** The side panel shows reservations in half-hour slots: the one under way and the next. */
export const SLOT_MS = 30 * 60000;

export interface ReservationSlot { start: number; end: number; reservations: Reservation[] }

/** Start of the half-hour slot holding `now`, on the restaurant's clock (zones such as UTC+5:45 are not whole half-hours). */
export function slotStart(now: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(now);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const second = Number(parts.find((p) => p.type === "second")?.value ?? 0);
  return now - ((minute % 30) * 60 + second) * 1000 - (now % 1000);
}

/**
 * The current slot holds every open booking that has started or starts before the slot ends and has not run out,
 * so a party running late stays visible; the upcoming slot holds the bookings starting in the next half hour.
 * Seated, cancelled and no-show bookings drop out.
 */
export function reservationSlots(list: Reservation[], now: number, timeZone?: string): { current: ReservationSlot; upcoming: ReservationSlot } {
  const start = slotStart(now, timeZone), mid = start + SLOT_MS, end = mid + SLOT_MS;
  const open = list.filter((r) => r.status === "booked" && r.endsAt > now).sort((a, b) => a.startsAt - b.startsAt);
  return {
    current: { start, end: mid, reservations: open.filter((r) => r.startsAt < mid) },
    upcoming: { start: mid, end, reservations: open.filter((r) => r.startsAt >= mid && r.startsAt < end) },
  };
}
