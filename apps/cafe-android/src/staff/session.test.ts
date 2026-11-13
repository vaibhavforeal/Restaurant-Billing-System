import { describe, expect, it } from "vitest";
import type { Staff } from "@masalapos/cafe-data";
import { createSessionStore } from "./session";

const ravi: Staff = { id: "s1", name: "Ravi", role: "cashier", active: true, sort: 1 };
const MIN = 60_000;

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("staff session", () => {
  it("locks only after the idle time and only when someone is signed in", () => {
    const c = clock();
    const s = createSessionStore(c.now);
    expect(s.shouldLock(5)).toBe(false);
    s.signIn(ravi);
    c.advance(5 * MIN - 1000);
    expect(s.shouldLock(5)).toBe(false);
    c.advance(1000);
    expect(s.shouldLock(5)).toBe(true);
    expect(s.shouldLock(0)).toBe(false);
    c.advance(24 * 60 * MIN);
    expect(s.shouldLock(0)).toBe(false);
  });

  it("touch restarts the idle time", () => {
    const c = clock();
    const s = createSessionStore(c.now);
    s.signIn(ravi);
    c.advance(4 * MIN);
    s.touch();
    c.advance(4 * MIN);
    expect(s.shouldLock(5)).toBe(false);
  });

  it("signOut clears the staff and notifies subscribers", () => {
    const s = createSessionStore(clock().now);
    let calls = 0;
    const off = s.subscribe(() => { calls += 1; });
    s.signIn(ravi);
    expect(s.get().staff).toEqual(ravi);
    s.signOut();
    expect(s.get().staff).toBeNull();
    expect(calls).toBe(2);
    off();
    s.signIn(ravi);
    expect(calls).toBe(2);
  });

  it("gives a new snapshot object only when something changed", () => {
    const s = createSessionStore(clock().now);
    const before = s.get();
    expect(s.get()).toBe(before);
    s.signIn(ravi);
    expect(s.get()).not.toBe(before);
  });
});
