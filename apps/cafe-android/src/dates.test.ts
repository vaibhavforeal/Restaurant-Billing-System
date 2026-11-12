import { describe, expect, it } from "vitest";
import { addDays, clockTime, monthGrid } from "./dates";

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
