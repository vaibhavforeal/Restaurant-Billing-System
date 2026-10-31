import { describe, expect, it } from "vitest";
import { parseInput, pointOn } from "./input.js";
import { scanKey } from "./keys.js";

describe("remote input", () => {
  it("accepts only the known message shapes with sane values", () => {
    expect(parseInput({ t: "move", x: 0.5, y: 1 })).toEqual({ t: "move", x: 0.5, y: 1 });
    expect(parseInput({ t: "move", x: 1.2, y: 0 })).toBeNull();
    expect(parseInput({ t: "move", x: Number.NaN, y: 0 })).toBeNull();
    expect(parseInput({ t: "button", button: 2, down: true, x: 0, y: 0 })).toEqual({ t: "button", button: 2, down: true, x: 0, y: 0 });
    expect(parseInput({ t: "button", button: 3, down: true, x: 0, y: 0 })).toBeNull();
    expect(parseInput({ t: "wheel", dx: 0, dy: -1 })).toEqual({ t: "wheel", dx: 0, dy: -1 });
    expect(parseInput({ t: "wheel", dx: 0, dy: -40 })).toBeNull();
    expect(parseInput({ t: "key", code: "KeyA", down: true })).toEqual({ t: "key", code: "KeyA", down: true });
    expect(parseInput({ t: "key", code: "Pause", down: true })).toBeNull();
    expect(parseInput({ t: "key", code: "toString", down: true })).toBeNull();
    expect(parseInput({ t: "screen", index: 1 })).toEqual({ t: "screen", index: 1 });
    expect(parseInput({ t: "exec", command: "calc" })).toBeNull();
    expect(parseInput("move")).toBeNull();
  });

  it("maps a fraction of the shared screen into that screen, never past its edge", () => {
    const second = { x: 1920, y: 0, width: 1280, height: 1024 };
    expect(pointOn(second, 0, 0)).toEqual({ x: 1920, y: 0 });
    expect(pointOn(second, 0.5, 0.5)).toEqual({ x: 2560, y: 512 });
    expect(pointOn(second, 1, 1)).toEqual({ x: 3199, y: 1023 });
    expect(pointOn({ x: -1280, y: 0, width: 1280, height: 720 }, 0.25, 0)).toEqual({ x: -960, y: 0 });
  });

  it("sends scan codes, marking the extended keys", () => {
    expect(scanKey("KeyA")).toEqual({ scan: 0x1e, extended: false });
    expect(scanKey("Enter")).toEqual({ scan: 0x1c, extended: false });
    expect(scanKey("NumpadEnter")).toEqual({ scan: 0x1c, extended: true });
    expect(scanKey("ArrowLeft")).toEqual({ scan: 0x4b, extended: true });
    expect(scanKey("MetaLeft")).toEqual({ scan: 0x5b, extended: true });
    expect(scanKey("Unknown")).toBeNull();
  });
});
