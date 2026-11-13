import { describe, expect, it } from "vitest";
import { saveCafe } from "./cafe.js";
import { getCounterSettings, saveCounterSettings } from "./index.js";
import { base } from "./testing/fixtures.js";
import { memoryCafeDb } from "./testing/sqlite-driver.js";

describe("counter settings", () => {
  it("reads defaults before any save and round-trips counter settings", () => {
    const db = memoryCafeDb();
    const defaults = { cashierDiscountBp: 0, lockAfterMinutes: 5, kitchenSlip: "off", showServedBy: false };
    expect(getCounterSettings(db)).toEqual(defaults);
    saveCafe(db, base, 1);
    expect(getCounterSettings(db)).toEqual(defaults);
    const next = { cashierDiscountBp: 500, lockAfterMinutes: 10, kitchenSlip: "receipt", showServedBy: true };
    expect(saveCounterSettings(db, next, 2)).toEqual(next);
    expect(getCounterSettings(db)).toEqual(next);
  });
  it.each([[{ cashierDiscountBp: 10001 }], [{ lockAfterMinutes: 7 }], [{ kitchenSlip: "both" }]])("refuses counter settings %j", (change) => {
    const db = memoryCafeDb(); saveCafe(db, base, 1);
    expect(() => saveCounterSettings(db, { ...getCounterSettings(db), ...change }, 2)).toThrow();
  });
});
