import { describe, expect, it } from "vitest";
import { slotBars } from "./dashboard-data";
import { DASHBOARD_MIN_DATE, alertBadge, perBarLabelsFit, pickedDate, slotChartFrame, slotScale, statusText, updatedLabel } from "./dashboard-view";

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

const bar = (dineInPaise: number, takeawayPaise: number, zomatoPaise = 0) => ({ label: "x", dineInPaise, takeawayPaise, zomatoPaise, totalPaise: dineInPaise + takeawayPaise + zomatoPaise });

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

  it("includes Zomato values", () => {
    expect(slotScale([bar(100, 50, 900), bar(0, 0, 0)])).toEqual({ min: 0, max: 900 });
    expect(slotScale([bar(100, 50, -400)])).toEqual({ min: -400, max: 100 });
  });
});

describe("slot chart per-bar labels", () => {
  it("fit when the longest label plus a 2px gap is no wider than the bar pitch", () => {
    // "₹12.3K" is 6 characters: 6 × 6.8 + 2 = 42.8
    expect(perBarLabelsFit(43, ["₹450", "₹12.3K"])).toBe(true);
    expect(perBarLabelsFit(42, ["₹450", "₹12.3K"])).toBe(false);
  });

  it("measures negative values with their sign", () => {
    expect(perBarLabelsFit(35, ["₹450"])).toBe(true);
    expect(perBarLabelsFit(35, ["-₹450"])).toBe(false);
  });

  it("always fit when every bar is zero", () => {
    expect(perBarLabelsFit(10, [])).toBe(true);
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

describe("slotChartFrame", () => {
  it("reproduces the fixed layout at the default 236px height", () => {
    expect(slotChartFrame(236)).toEqual({ height: 236, top: 28, bottom: 192 });
  });

  it("keeps a fixed band under the plot for the slot labels as the height changes", () => {
    for (const height of [180, 236, 420, 700]) {
      const frame = slotChartFrame(height);
      expect(frame.height).toBe(height);
      expect(frame.height - frame.bottom).toBe(44);
      expect(frame.bottom).toBeGreaterThan(frame.top);
    }
  });

  it("never shrinks below a readable minimum, and rounds a fractional measurement", () => {
    expect(slotChartFrame(40).height).toBe(150);
    expect(slotChartFrame(0).height).toBe(150);
    expect(slotChartFrame(Number.NaN).height).toBe(236);
    expect(slotChartFrame(300.6).height).toBe(301);
  });
});
