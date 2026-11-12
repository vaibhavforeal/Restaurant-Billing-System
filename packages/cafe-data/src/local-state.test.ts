import { describe, expect, it } from "vitest";
import { getLocalState, setLocalState } from "./local-state.js";
import { memoryCafeDb } from "./testing/sqlite-driver.js";

describe("local state", () => {
  it("keeps named numbers on this device and reads a missing one as null", () => {
    const db = memoryCafeDb();
    expect(getLocalState(db, "pin.wrong")).toBeNull();
    setLocalState(db, { "pin.wrong": 3, "pin.lockedUntil": 1_800_000_000_000 });
    setLocalState(db, { "pin.wrong": 4 });
    expect(getLocalState(db, "pin.wrong")).toBe(4);
    expect(getLocalState(db, "pin.lockedUntil")).toBe(1_800_000_000_000);
  });
});
