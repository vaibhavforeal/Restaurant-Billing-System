import { describe, expect, it } from "vitest";
import { createPinAttempts } from "./pin-attempts";

describe("owner PIN attempts", () => {
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
});
