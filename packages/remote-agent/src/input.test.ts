import { describe, expect, it } from "vitest";
import { blockedByProtected } from "./input.js";

describe("blockedByProtected", () => {
  it("always lets a button-up or key-up through, so nothing stays held down", () => {
    expect(blockedByProtected({ t: "button", button: 0, down: false, x: 0, y: 0 }, true, true)).toBe(false);
    expect(blockedByProtected({ t: "key", code: "KeyA", down: false }, true, false)).toBe(false);
  });
  it("still blocks presses near protected windows", () => {
    expect(blockedByProtected({ t: "button", button: 0, down: true, x: 0, y: 0 }, false, true)).toBe(true);
    expect(blockedByProtected({ t: "key", code: "KeyA", down: true }, true, false)).toBe(true);
    expect(blockedByProtected({ t: "wheel", dx: 0, dy: 1 }, true, false)).toBe(true);
    expect(blockedByProtected({ t: "key", code: "KeyA", down: true }, false, false)).toBe(false);
  });
});
