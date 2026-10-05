import { describe, expect, it } from "vitest";
import type { StockCostChange, StockMove } from "@forkflow/domain";
import { amountPaidToPaise, formatMovementCost, formatUnitCost, mergeCostChanges, mergeHistory, perUnitHint, rupeesPerUnitToMilliPaise } from "./stock-costs";

describe("formatUnitCost", () => {
  it("shows two decimals from one rupee up", () => {
    expect(formatUnitCost(32_000_000, "kg")).toBe("₹320.00/kg");
    expect(formatUnitCost(100_000, "L")).toBe("₹1.00/L");
    expect(formatUnitCost(123_456_700, "kg")).toBe("₹1,234.57/kg");
  });
  it("shows up to four decimals below one rupee", () => {
    expect(formatUnitCost(2_340, "ml")).toBe("₹0.0234/ml");
    expect(formatUnitCost(50_000, "g")).toBe("₹0.50/g");
    expect(formatUnitCost(10, "g")).toBe("₹0.0001/g");
  });
  it("says so when no cost is set", () => {
    expect(formatUnitCost(null, "kg")).toBe("Cost not set");
  });
});

describe("rupeesPerUnitToMilliPaise", () => {
  it("converts rupees with up to four decimals", () => {
    expect(rupeesPerUnitToMilliPaise("320")).toBe(32_000_000);
    expect(rupeesPerUnitToMilliPaise(" 0.0234 ")).toBe(2_340);
    expect(rupeesPerUnitToMilliPaise("34.5")).toBe(3_450_000);
    expect(rupeesPerUnitToMilliPaise(".5")).toBe(50_000);
    expect(rupeesPerUnitToMilliPaise("0.0001")).toBe(10);
  });
  it("rejects blank, zero, negative, over-precise and non-numeric text", () => {
    for (const text of ["", "  ", "0", "0.0000", "-1", "1.00001", "abc", "1e3", "1,000", ".", "Infinity", "12.", "9007199254740993"]) {
      expect(rupeesPerUnitToMilliPaise(text), text).toBeNull();
    }
  });
});

describe("perUnitHint", () => {
  it("divides the amount paid by the quantity received", () => {
    expect(perUnitHint("340", "10", "kg")).toBe("= ₹34.00/kg");
    expect(perUnitHint("1", "1000", "ml")).toBe("= ₹0.001/ml");
    expect(perUnitHint("0", "5", "pcs")).toBe("= ₹0.00/pcs");
  });
  it("gives no hint until both inputs are usable", () => {
    expect(perUnitHint("340", "0", "kg")).toBeNull();
    expect(perUnitHint("", "10", "kg")).toBeNull();
    expect(perUnitHint("340", "", "kg")).toBeNull();
    expect(perUnitHint("abc", "10", "kg")).toBeNull();
    expect(perUnitHint("340", "-2", "kg")).toBeNull();
    expect(perUnitHint("-5", "2", "kg")).toBeNull();
  });
});

describe("amountPaidToPaise", () => {
  it("treats blank as not provided", () => {
    expect(amountPaidToPaise("")).toBeUndefined();
    expect(amountPaidToPaise("  ")).toBeUndefined();
  });
  it("converts rupees with up to two decimals, including zero", () => {
    expect(amountPaidToPaise("340")).toBe(34_000);
    expect(amountPaidToPaise("0")).toBe(0);
    expect(amountPaidToPaise("12.5")).toBe(1_250);
    expect(amountPaidToPaise("0.07")).toBe(7);
  });
  it("rejects negatives, extra decimals, junk and more than one crore", () => {
    for (const text of ["-1", "1.234", "abc", "1e2", "10000000.01"]) expect(() => amountPaidToPaise(text), text).toThrow();
    expect(amountPaidToPaise("10000000")).toBe(1_000_000_000);
  });
});

describe("formatMovementCost", () => {
  it("formats signed paise and marks unknown cost", () => {
    expect(formatMovementCost(34_000)).toBe("₹340.00");
    expect(formatMovementCost(-1_250)).toBe("-₹12.50");
    expect(formatMovementCost(0)).toBe("₹0.00");
    expect(formatMovementCost(null)).toBe("Cost unknown");
    expect(formatMovementCost(undefined)).toBe("Cost unknown");
  });
});

const move = (id: string, createdAt: number): StockMove => ({
  id, stockItemId: "s", delta: 1, reason: "purchase", note: null, orderItemId: null, orderId: null, reversalOf: null, createdAt, createdByName: null, balanceAfter: 1,
});
const change = (id: string, createdAt: number): StockCostChange => ({
  id, stockItemId: "s", oldCostMilliPaise: null, newCostMilliPaise: 100, note: "n", createdAt, createdByName: null,
});

describe("mergeCostChanges", () => {
  it("de-duplicates a boundary change that appears on two pages", () => {
    const merged = mergeCostChanges([change("c2", 20), change("c1", 10)], [change("c1", 10), change("c0", 5)]);
    expect(merged.map((c) => c.id)).toEqual(["c2", "c1", "c0"]);
  });
  it("keeps the already-loaded copy and works from nothing", () => {
    expect(mergeCostChanges([], [])).toEqual([]);
    expect(mergeCostChanges([change("c1", 10)], [{ ...change("c1", 10), note: "later" }])[0]!.note).toBe("n");
  });
});

describe("mergeHistory", () => {
  it("interleaves movements and cost changes newest first", () => {
    const rows = mergeHistory([move("m3", 30), move("m1", 10)], [change("c2", 20)]);
    expect(rows.map((r) => (r.kind === "move" ? r.move.id : r.change.id))).toEqual(["m3", "c2", "m1"]);
    expect(rows.map((r) => r.kind)).toEqual(["move", "cost", "move"]);
  });
  it("orders entries sharing a timestamp by id, newest first", () => {
    const rows = mergeHistory([move("b", 10)], [change("a", 10), change("c", 10)]);
    expect(rows.map((r) => (r.kind === "move" ? r.move.id : r.change.id))).toEqual(["c", "b", "a"]);
  });
  it("shows only movements when there are no cost changes", () => {
    expect(mergeHistory([move("m1", 10)], []).map((r) => r.kind)).toEqual(["move"]);
  });
});
