import { describe, expect, it } from "vitest";
import { pressKey, type KeypadKey } from "./keypad-input";

const type = (keys: KeypadKey[]) => keys.reduce(pressKey, "");

describe("typing an amount on the keypad", () => {
  it("builds rupees and up to two decimals", () => {
    expect(type(["4", "0"])).toBe("40");
    expect(type(["1", "2", ".", "5", "0", "9"])).toBe("12.50");
  });
  it("starts a decimal with 0 and allows one point", () => {
    expect(type([".", "5", "."])).toBe("0.5");
  });
  it("drops a leading zero and stops at seven digits", () => {
    expect(type(["0", "7"])).toBe("7");
    expect(type(["1", "2", "3", "4", "5", "6", "7", "8"])).toBe("1234567");
  });
  it("deletes the last character", () => {
    expect(type(["1", "2", "back"])).toBe("1");
    expect(type(["back"])).toBe("");
  });
});
