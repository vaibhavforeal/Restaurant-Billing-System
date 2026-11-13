import { describe, expect, it } from "vitest";
import { clearErrors, listErrors, logError } from "./error-log.js";
import { memoryCafeDb } from "./testing/sqlite-driver.js";

describe("error log", () => {
  it("keeps errors newest first with their context", () => {
    const db = memoryCafeDb();
    logError(db, { at: 1000, message: "first", stack: "at a", context: "payment" });
    logError(db, { at: 2000, message: "second", stack: null, context: null });
    expect(listErrors(db).map((e) => [e.message, e.context])).toEqual([["second", null], ["first", "payment"]]);
    expect(listErrors(db)[1]).toMatchObject({ at: 1000, stack: "at a" });
  });
  it("keeps only the newest 50 and can be cleared", () => {
    const db = memoryCafeDb();
    for (let i = 0; i < 55; i++) logError(db, { at: i, message: `e${i}`, stack: null, context: null });
    const kept = listErrors(db);
    expect(kept).toHaveLength(50);
    expect(kept[0]!.message).toBe("e54");
    expect(kept.at(-1)!.message).toBe("e5");
    clearErrors(db);
    expect(listErrors(db)).toEqual([]);
  });
  it("cuts a very long message or stack so one error cannot fill the phone", () => {
    const db = memoryCafeDb();
    logError(db, { at: 1, message: "m".repeat(5000), stack: "s".repeat(50000), context: null });
    const [e] = listErrors(db);
    expect(e!.message.length).toBe(2000);
    expect(e!.stack!.length).toBe(8000);
  });
});
