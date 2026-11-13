import { describe, expect, it } from "vitest";
import { renderBytes } from "@masalapos/print";
import { testSlip } from "./test-slip";

const T0 = Date.UTC(2026, 10, 13, 6, 0);

describe("testSlip", () => {
  it("prints the cafe name, a ruler as wide as the paper and the time", () => {
    const text = renderBytes(testSlip("Chai Point", 58, T0));
    expect(text).toContain("Chai Point"); expect(text).toContain("Printer test");
    expect(text).toContain("12345678901234567890123456789012"); // 32 characters on 58 mm
    expect(text).not.toContain("123456789012345678901234567890123");
    expect(renderBytes(testSlip("Chai Point", 80, T0))).toContain("123456789012345678901234567890123456789012345678");
    expect(text).toContain("2026");
  });
});
