import { describe, expect, it } from "vitest";
import { hasUnprintable } from "./printable";

describe("hasUnprintable", () => {
  it.each([["Masala Chai", false], ["Café", true], ["चाय", true], ["Tea ☕", true], ["Tea (Large) - 250ml", false]])("hasUnprintable(%s) is %s", (t, e) => expect(hasUnprintable(t)).toBe(e));
});
