import { describe, expect, it } from "vitest";
import { addDays, clockTime, heldAge, monthGrid, msUntilNextLocalMidnight } from "./dates";

describe("dates on screen", () => {
  it("moves a business date by whole days across months and years", () => {
    expect(addDays("2026-11-13", -1)).toBe("2026-11-12");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
  });
  it("shows a bill's time in the device's zone", () => {
    expect(clockTime(Date.UTC(2026, 10, 13, 6, 5), 330)).toBe("11:35");
    expect(clockTime(Date.UTC(2026, 10, 12, 18, 31), 330)).toBe("00:01");
  });
  it("lays out a month from Monday with blanks before the 1st", () => {
    const grid = monthGrid(2026, 11); // November 2026 starts on a Sunday
    expect(grid.slice(0, 7)).toEqual([null, null, null, null, null, null, "2026-11-01"]);
    expect(grid.filter(Boolean)).toHaveLength(30);
    expect(grid.length % 7).toBe(0);
  });
});

describe("heldAge", () => {
  const IST = 330;
  const at = (iso: string) => Date.parse(`${iso}+05:30`);
  it("shows minutes, then hours, then yesterday, then the date", () => {
    const now = at("2026-11-13T18:00:00");
    expect(heldAge(at("2026-11-13T17:59:40"), now, IST)).toBe("1 min");
    expect(heldAge(at("2026-11-13T17:48:00"), now, IST)).toBe("12 min");
    expect(heldAge(at("2026-11-13T15:30:00"), now, IST)).toBe("2 h");
    expect(heldAge(at("2026-11-13T00:10:00"), now, IST)).toBe("17 h");
    expect(heldAge(at("2026-11-12T23:50:00"), now, IST)).toBe("yesterday");
    expect(heldAge(at("2026-11-10T12:00:00"), now, IST)).toBe("10 Nov 2026");
  });
});

describe("midnight", () => {
  it("counts to the next local midnight in IST", () => {
    expect(msUntilNextLocalMidnight(Date.parse("2026-11-13T23:59:30+05:30"), 330)).toBe(30_000);
    expect(msUntilNextLocalMidnight(Date.parse("2026-11-14T00:00:00+05:30"), 330)).toBe(24 * 60 * 60 * 1000);
    expect(msUntilNextLocalMidnight(Date.parse("2026-11-13T12:00:00+05:30"), 330)).toBe(12 * 60 * 60 * 1000);
  });
});
