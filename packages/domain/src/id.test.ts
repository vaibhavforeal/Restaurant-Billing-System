import { expect, test } from "vitest";
import { uuidv7 } from "./id.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("generates a well-formed RFC 9562 version-7 uuid", () => {
  expect(uuidv7()).toMatch(UUID_V7);
});

test("ids minted within the same millisecond still sort in creation order", () => {
  const ids = Array.from({ length: 1000 }, () => uuidv7());

  expect(ids).toStrictEqual([...ids].sort());
});
