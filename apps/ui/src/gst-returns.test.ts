import { describe, expect, it } from "vitest";
import { defaultGstMonth, gstReturnsCsvName, gstr1JsonName } from "./gst-returns";

describe("GST returns screen helpers", () => {
  it("opens on last month, across a year end", () => {
    expect(defaultGstMonth("2026-11-05")).toBe("2026-10");
    expect(defaultGstMonth("2027-01-10")).toBe("2026-12");
  });
  it("names the downloads by period", () => {
    expect(gstReturnsCsvName({ from: "2026-10-01", to: "2026-12-31" })).toBe("masalapos-gst-returns-2026-10-01-to-2026-12-31.csv");
    expect(gstr1JsonName("29AAPFU0939F1ZR", "102026")).toBe("GSTR1_29AAPFU0939F1ZR_102026.json");
  });
});
