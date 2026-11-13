import { describe, expect, it } from "vitest";
import { getCafe, getDevice, saveCafe } from "./cafe.js";
import { base } from "./testing/fixtures.js";
import { memoryCafeDb } from "./testing/sqlite-driver.js";

describe("cafe settings", () => {
  it("saves the cafe, trims and upper-cases, and creates the device once", () => {
    const db = memoryCafeDb();
    expect(getCafe(db)).toBeNull();
    expect(saveCafe(db, base, 1000)).toMatchObject({ name: "Chai Point", invoicePrefix: "CP" });
    const device = getDevice(db)!;
    expect(device).toMatchObject({ name: "Counter 1", seriesLetter: "A" });
    saveCafe(db, { ...base, name: "Chai Point 2" }, 2000);
    expect(getDevice(db)!.id).toBe(device.id);
    expect(getCafe(db)!.name).toBe("Chai Point 2");
  });
  it.each([["ABCD"], ["CN"], ["a-b"]])("rejects the invoice prefix %s", (invoicePrefix) => {
    expect(() => saveCafe(memoryCafeDb(), { ...base, invoicePrefix }, 1)).toThrow();
  });
});
