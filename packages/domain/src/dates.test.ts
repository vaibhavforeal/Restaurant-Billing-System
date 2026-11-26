import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { businessDateKey, businessDateSql, businessDayBounds, localDateKey } from "./dates.js";

const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("business day", () => {
  it("is the calendar date when the day starts at midnight", () => {
    expect(businessDateKey(at(2026, 11, 9, 0, 30), 0)).toBe("2026-11-09");
    expect(businessDateKey(at(2026, 11, 9, 23, 59), 0)).toBe(localDateKey(at(2026, 11, 9, 23, 59)));
  });

  it("counts the hours after midnight, before the start hour, as the day before", () => {
    expect(businessDateKey(at(2026, 11, 10, 1, 45), 4)).toBe("2026-11-09");
    expect(businessDateKey(at(2026, 11, 10, 3, 59), 4)).toBe("2026-11-09");
    expect(businessDateKey(at(2026, 11, 10, 4, 0), 4)).toBe("2026-11-10");
    // Across a month and a year end.
    expect(businessDateKey(at(2026, 12, 1, 2, 0), 4)).toBe("2026-11-30");
    expect(businessDateKey(at(2027, 1, 1, 2, 0), 4)).toBe("2026-12-31");
  });

  it("bounds a business day from its start hour to the next day's", () => {
    expect(businessDayBounds("2026-11-09", 0)).toEqual([at(2026, 11, 9, 0), at(2026, 11, 10, 0)]);
    expect(businessDayBounds("2026-11-09", 4)).toEqual([at(2026, 11, 9, 4), at(2026, 11, 10, 4)]);
    expect(businessDayBounds("2026-12-31", 5)).toEqual([at(2026, 12, 31, 5), at(2027, 1, 1, 5)]);
  });

  it("refuses a date that does not exist", () => {
    expect(() => businessDayBounds("2026-02-30", 0)).toThrow(/Invalid date/);
    expect(() => businessDayBounds("not-a-date", 0)).toThrow(/Invalid date/);
  });

  it("groups rows by business day in SQL the same way", () => {
    const db = openDb(":memory:");
    const sql = (ms: number, hour: number) => (db.prepare(`SELECT ${businessDateSql("?", hour)} AS d`).get(ms) as { d: string }).d;
    for (const [ms, hour] of [[at(2026, 11, 10, 1, 45), 4], [at(2026, 11, 10, 4, 0), 4], [at(2026, 11, 10, 1, 45), 0], [at(2027, 1, 1, 2, 0), 6]] as const) {
      expect(sql(ms, hour)).toBe(businessDateKey(ms, hour));
    }
    db.close();
  });
});
