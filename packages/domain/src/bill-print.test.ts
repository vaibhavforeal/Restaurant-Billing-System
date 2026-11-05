import { describe, expect, it } from "vitest";
import { BillTextLines, billShowOf, billTextLines, DEFAULT_BILL_SHOW } from "./bill-print.js";

describe("billTextLines", () => {
  it("splits, trims and drops blank lines", () => {
    expect(billTextLines("  A \n\n B ")).toEqual(["A", "B"]);
    expect(billTextLines("A\r\nB")).toEqual(["A", "B"]);
  });
});

describe("BillTextLines", () => {
  const msg = "Use up to 3 lines of 48 characters each";
  it("accepts 3 lines of 48 characters", () => {
    const line = "x".repeat(48);
    expect(BillTextLines.safeParse(`${line}\n${line}\n${line}`).success).toBe(true);
  });
  it("rejects 4 lines and a 49-character line", () => {
    for (const text of ["a\nb\nc\nd", "x".repeat(49)]) {
      const r = BillTextLines.safeParse(text);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.message).toBe(msg);
    }
  });
});

describe("billShowOf", () => {
  it("defaults when the snapshot has no billShow", () => {
    expect(billShowOf({})).toEqual(DEFAULT_BILL_SHOW);
  });
  it("overrides defaults with the snapshot's values", () => {
    expect(billShowOf({ billShow: { ...DEFAULT_BILL_SHOW, fssai: false } }).fssai).toBe(false);
  });
});
