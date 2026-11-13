import { describe, expect, it } from "vitest";
import { nextSequence } from "./sequences.js";
import { memoryCafeDb } from "./testing/sqlite-driver.js";

describe("nextSequence", () => {
  it("counts from 1 per name", () => {
    const db = memoryCafeDb();
    expect(db.transaction(() => [nextSequence(db, "a"), nextSequence(db, "a"), nextSequence(db, "b")])).toEqual([1, 2, 1]);
  });
});
