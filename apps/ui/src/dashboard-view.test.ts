import { describe, expect, it } from "vitest";
import { slotBars } from "./dashboard-data";
import { DASHBOARD_MIN_DATE, alertBadge, pickedDate, slotScale, statusText, updatedLabel } from "./dashboard-view";

describe("dashboard date picker", () => {
  it("ignores the partial years a browser emits while the year is being typed", () => {
    for (const partial of ["0002-10-06", "0020-10-06", "0202-10-06"]) expect(pickedDate(partial, "2026-10-06")).toBeNull();
    expect(pickedDate("2025-10-06", "2026-10-06")).toBe("2025-10-06");
  });
  it("accepts today and the minimum, rejects the future and malformed values", () => {
    expect(pickedDate("2026-10-06", "2026-10-06")).toBe("2026-10-06");
    expect(pickedDate(DASHBOARD_MIN_DATE, "2026-10-06")).toBe(DASHBOARD_MIN_DATE);
    expect(pickedDate("2026-10-07", "2026-10-06")).toBeNull();
    expect(pickedDate("", "2026-10-06")).toBeNull();
    expect(pickedDate("20261-10-06", "2026-10-06")).toBeNull();
  });
});

const bar = (dineInPaise: number, takeawayPaise: number) => ({ label: "x", dineInPaise, takeawayPaise, totalPaise: dineInPaise + takeawayPaise });

describe("slot chart scale", () => {
  it("gives an all-zero day a finite positive range with zero at the bottom", () => {
    expect(slotScale(slotBars([], []))).toEqual({ min: 0, max: 100 });
    expect(slotScale([])).toEqual({ min: 0, max: 100 });
  });

  it("includes zero and negative net values", () => {
    expect(slotScale([bar(500, -200), bar(0, 0)])).toEqual({ min: -200, max: 500 });
    expect(slotScale([bar(-300, -100)])).toEqual({ min: -300, max: 0 });
    expect(slotScale([bar(800, 50)])).toEqual({ min: 0, max: 800 });
  });
});

describe("dashboard labels", () => {
  it("marks a truncated alert count as a lower bound", () => {
    expect(alertBadge(500, true)).toBe("500+");
    expect(alertBadge(3, false)).toBe("3");
    expect(alertBadge(0, false)).toBe("0");
  });

  it("describes how long ago the data was refreshed", () => {
    const now = 10 * 60 * 60_000;
    expect(updatedLabel(null, now)).toBe("Not updated yet");
    expect(updatedLabel(now - 20_000, now)).toBe("Updated just now");
    expect(updatedLabel(now - 60_000, now)).toBe("Updated 1 min ago");
    expect(updatedLabel(now - 5 * 60_000, now)).toBe("Updated 5 mins ago");
    expect(updatedLabel(now - 125 * 60_000, now)).toBe("Updated 2 h ago");
    expect(updatedLabel(now + 5_000, now)).toBe("Updated just now");
  });

  it("formats aggregator statuses", () => {
    expect(statusText("picked_up")).toBe("Picked up");
    expect(statusText("received")).toBe("Received");
    expect(statusText("")).toBe("Unknown");
  });
});
