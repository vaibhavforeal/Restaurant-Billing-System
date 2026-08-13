import { expect, test } from "vitest";
import { resolveConflict } from "./resolve.js";

const stampAt = (millis: number, counter: number, node: string) =>
  `${millis.toString(16).padStart(12, "0")}-${counter.toString(16).padStart(4, "0")}-${node}`;

test("the later write wins", () => {
  const local = stampAt(1_000, 0, "term-1");
  const remote = stampAt(2_000, 0, "term-2");

  expect(resolveConflict(local, remote)).toBe("remote");
  expect(resolveConflict(remote, local)).toBe("local");
});

test("an unseen row is always accepted", () => {
  expect(resolveConflict(null, stampAt(1_000, 0, "term-2"))).toBe("remote");
});

test("truly concurrent writes converge on the same winner from either side", () => {
  const onTerminal1 = stampAt(1_000, 0, "term-1");
  const onTerminal2 = stampAt(1_000, 0, "term-2");

  // Terminal 1 receives terminal 2's write, and vice versa — they must agree.
  expect(resolveConflict(onTerminal1, onTerminal2)).toBe("remote");
  expect(resolveConflict(onTerminal2, onTerminal1)).toBe("local");
});
