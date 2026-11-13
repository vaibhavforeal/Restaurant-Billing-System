import { describe, expect, it } from "vitest";
import { memoryCafeDb } from "../../../../packages/cafe-data/src/testing/sqlite-driver";
import { createPinAttempts, memoryPinStore, staffPinAttempts } from "./pin-attempts";

describe("staff PIN attempts", () => {
  it("keeps each person's wrong tries apart", () => {
    const db = memoryCafeDb();
    const a = staffPinAttempts(db, "a");
    for (let i = 0; i < 5; i++) a.fail(1000);
    expect(a.waitMs(1000)).toBe(30_000);
    expect(staffPinAttempts(db, "b").waitMs(1000)).toBe(0);
    expect(staffPinAttempts(db, "a").waitMs(1000)).toBe(30_000); // a new instance reads the same rows, as after a restart
    expect(staffPinAttempts(db, "b").fail(1000)).toEqual({ locked: false, triesLeft: 4 });
  });
});

describe("PIN attempts", () => {
  it("allows five wrong tries, then locks for 30 seconds", () => {
    const a = createPinAttempts();
    for (let i = 0; i < 4; i++) expect(a.fail(1000)).toEqual({ locked: false, triesLeft: 4 - i });
    expect(a.fail(1000)).toEqual({ locked: true, triesLeft: 0 });
    expect(a.waitMs(1000)).toBe(30_000);
    expect(a.waitMs(31_000)).toBe(0);
  });
  it("keeps counting when the prompt is closed and opened again, and doubles each lock", () => {
    const a = createPinAttempts();
    for (let i = 0; i < 5; i++) a.fail(0);
    expect(a.waitMs(0)).toBe(30_000);
    for (let i = 0; i < 5; i++) a.fail(30_000);
    expect(a.waitMs(30_000)).toBe(60_000);
  });
  it("starts again after the right PIN", () => {
    const a = createPinAttempts();
    for (let i = 0; i < 4; i++) a.fail(0);
    a.succeed();
    expect(a.fail(0)).toEqual({ locked: false, triesLeft: 4 });
    expect(a.waitMs(0)).toBe(0);
  });
  it("survives an app restart when the count is kept in a store", () => {
    const store = memoryPinStore();
    const before = createPinAttempts(store);
    for (let i = 0; i < 5; i++) before.fail(0);
    const afterRestart = createPinAttempts(store);
    expect(afterRestart.waitMs(10_000)).toBe(20_000);
    expect(afterRestart.fail(40_000)).toEqual({ locked: false, triesLeft: 4 });
  });
  it("stays locked when the phone's clock is moved back", () => {
    const a = createPinAttempts();
    for (let i = 0; i < 5; i++) a.fail(1_000_000);
    expect(a.waitMs(500_000)).toBe(30_000);
  });
});
