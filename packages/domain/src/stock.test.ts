import { describe, expect, it } from "vitest";
import { stockMilli, StockCreate, StockAdjust, StockLinkUpdate } from "./stock-schemas.js";

describe("stock quantities", () => {
  it("uses integer thousandths without accumulating decimal noise", () => {
    expect(stockMilli(0.1 + 0.2)).toBe(300);
    expect(stockMilli(-1.125)).toBe(-1125);
    expect((stockMilli(1) - stockMilli(0.1) * 10) / 1000).toBe(0);
    expect(stockMilli(1_000_000_000)).toBe(1_000_000_000_000);
  });
  it("rejects non-finite, excessive and over-precise quantities", () => {
    for (const n of [NaN, Infinity, -Infinity, 1e10, 0.0001, -1.2345]) expect(() => stockMilli(n)).toThrow();
  });
  it("validates units, opening balances, reasons and positive sale quantities", () => {
    expect(StockCreate.safeParse({ clientRef: "stock-ref-1", name: "Rice", unit: "kg", openingQty: 2.125 }).success).toBe(true);
    expect(StockCreate.safeParse({ clientRef: "stock-ref-1", name: "Rice", unit: "bag" }).success).toBe(false);
    expect(StockCreate.safeParse({ clientRef: "stock-ref-1", name: "Rice", unit: "kg", openingQty: -1 }).success).toBe(false);
    expect(StockAdjust.safeParse({ clientRef: "movement1", expectedVersion: 0, reason: "purchase", quantity: 1, note: "" }).success).toBe(false);
    expect(StockAdjust.safeParse({ clientRef: "movement1", expectedVersion: 0, reason: "adjustment", quantity: 0, note: "Count" }).success).toBe(true);
    expect(StockAdjust.safeParse({ clientRef: "movement1", expectedVersion: 0, reason: "wastage", quantity: 0, note: "Waste" }).success).toBe(false);
    expect(StockLinkUpdate.safeParse({ expectedVersion: 0, stockItemId: "rice", qtyPerSale: 0.125 }).success).toBe(true);
    expect(StockLinkUpdate.safeParse({ expectedVersion: 0, stockItemId: "rice", qtyPerSale: 0 }).success).toBe(false);
  });
});
