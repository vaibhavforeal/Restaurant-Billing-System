import { expect, test } from "vitest";
import { HybridLogicalClock } from "./hlc.js";

test("issues strictly increasing timestamps while the wall clock stands still", () => {
  const clock = new HybridLogicalClock({ nodeId: "term-1", now: () => 1_700_000_000_000 });

  const stamps = [clock.tick(), clock.tick(), clock.tick()];

  expect(stamps).toStrictEqual([...stamps].sort());
  expect(new Set(stamps).size).toBe(3);
});

test("adopts the wall clock and resets the counter when real time moves forward", () => {
  let wall = 1_000;
  const clock = new HybridLogicalClock({ nodeId: "term-1", now: () => wall });

  const before = clock.tick();
  wall = 2_000;
  const after = clock.tick();

  expect(after > before).toBe(true);
  expect(after).toBe("0000000007d0-0000-term-1"); // 2000ms, counter reset
});

test("a write that observed a remote event sorts after it despite a lagging local clock", () => {
  const local = new HybridLogicalClock({ nodeId: "term-1", now: () => 1_000 });
  const remoteStamp = new HybridLogicalClock({ nodeId: "term-2", now: () => 5_000 }).tick();

  const observed = local.receive(remoteStamp);
  const next = local.tick();

  expect(observed > remoteStamp).toBe(true);
  expect(next > observed).toBe(true);
});
