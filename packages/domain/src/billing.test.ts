import { describe, expect, it } from "vitest";
import { calculateBill, BillCreate, BillSettle } from "./billing.js";

describe("GST billing", () => {
  it("included: one rate", () => {
    const bill = calculateBill([{ pricePaise: 10500, qty: 1, gstRate: 5 }]);
    expect(bill).toMatchObject({ subtotalPaise: 10500, cgstPaise: 250, sgstPaise: 250, totalPaise: 10500, roundingPaise: 0 });
    expect(bill.taxes).toEqual([{ gstRate: 5, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250 }]);
  });
  it("included: mixed rates share the discount", () => {
    const bill = calculateBill([{ pricePaise: 20000, qty: 1, gstRate: 5 }, { pricePaise: 10000, qty: 1, gstRate: 18 }], 3000);
    expect(bill.taxes).toEqual([
      { gstRate: 5, taxablePaise: 17143, cgstPaise: 429, sgstPaise: 428 },
      { gstRate: 18, taxablePaise: 7627, cgstPaise: 687, sgstPaise: 686 },
    ]);
    expect(bill.totalPaise).toBe(27000);
    expect(bill.taxes.reduce((sum, t) => sum + t.taxablePaise + t.cgstPaise + t.sgstPaise, 0)).toBe(27000);
  });
  it("none: no GST, menu price less discount", () => {
    const bill = calculateBill([{ pricePaise: 20000, qty: 1, gstRate: 5 }, { pricePaise: 10000, qty: 1, gstRate: 18 }], 3000, "none");
    expect(bill.cgstPaise).toBe(0);
    expect(bill.sgstPaise).toBe(0);
    expect(bill.taxes.every((t) => t.cgstPaise === 0 && t.sgstPaise === 0)).toBe(true);
    expect(bill.taxes.map((t) => t.taxablePaise)).toEqual([18000, 9000]);
    expect(bill.totalPaise).toBe(27000);
  });
  it("rounds to the rupee", () => {
    expect(calculateBill([{ pricePaise: 10050, qty: 1, gstRate: 5 }], 0, "none")).toMatchObject({ totalPaise: 10100, roundingPaise: 50 });
    expect(calculateBill([{ pricePaise: 1049, qty: 1, gstRate: 0 }]).totalPaise).toBe(1000);
    expect(calculateBill([{ pricePaise: 1050, qty: 1, gstRate: 0 }]).totalPaise).toBe(1100);
  });
  it("a full discount gives a zero bill", () => {
    const bill = calculateBill([{ pricePaise: 10000, qty: 1, gstRate: 5 }], 10000);
    expect(bill.totalPaise).toBe(0);
    expect(bill.taxes).toEqual([{ gstRate: 5, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 }]);
  });
  it("allocates discount proportionally across rates with deterministic paise remainders", () => {
    const bill = calculateBill([{ pricePaise: 100, qty: 1, gstRate: 18 }, { pricePaise: 100, qty: 1, gstRate: 5 }], 1, "none");
    expect(bill.taxes.map((t) => [t.gstRate, t.taxablePaise])).toEqual([[5, 99], [18, 100]]);
  });
  it("handles free items", () => {
    expect(calculateBill([{ pricePaise: 0, qty: 2, gstRate: 18 }]).totalPaise).toBe(0);
  });
  it("rejects unsafe values, empty bills, negative or excessive discounts", () => {
    for (const items of [[], [{ pricePaise: Number.MAX_SAFE_INTEGER, qty: 2, gstRate: 5 }], [{ pricePaise: 0.1, qty: 1, gstRate: 5 }], [{ pricePaise: 100, qty: 0, gstRate: 5 }], [{ pricePaise: 100, qty: 1, gstRate: 7 }]]) expect(() => calculateBill(items)).toThrow();
    for (const discount of [-1, 101, 0.1]) expect(() => calculateBill([{ pricePaise: 100, qty: 1, gstRate: 5 }], discount)).toThrow();
  });
  it("conserves money in both modes, across rates and discount remainders", () => {
    for (const mode of ["included", "none"] as const) for (let price = 0; price < 400; price += 7) {
      const bill = calculateBill([{ pricePaise: price, qty: 3, gstRate: 5 }, { pricePaise: price + 5, qty: 2, gstRate: 18 }], Math.floor(price / 3), mode);
      const taxable = bill.taxes.reduce((sum, t) => sum + t.taxablePaise, 0);
      expect(taxable + bill.cgstPaise + bill.sgstPaise + bill.roundingPaise).toBe(bill.totalPaise);
      expect(bill.roundingPaise).toBeGreaterThanOrEqual(-49);
      expect(bill.roundingPaise).toBeLessThanOrEqual(50);
      expect(bill.taxes.every((t) => t.taxablePaise >= 0 && Math.abs(t.cgstPaise - t.sgstPaise) <= 1)).toBe(true);
    }
  });
  it("validates reasons, references, positive payment rows and empty zero settlements", () => {
    expect(BillCreate.safeParse({ clientRef: "test-ref-1", previewKey: "abc", discountPaise: 1 }).success).toBe(false);
    expect(BillCreate.safeParse({ clientRef: "test-ref-1", previewKey: "abc", discountPaise: 1, discountNote: "Staff" }).success).toBe(true);
    expect(BillSettle.safeParse({ clientRef: "test-ref-1", payments: [] }).success).toBe(true);
    expect(BillSettle.safeParse({ clientRef: "test-ref-1", payments: [{ mode: "cash", amountPaise: 0 }] }).success).toBe(false);
  });
  it("still settles only cash, UPI or card", () => {
    expect(BillSettle.safeParse({ clientRef: "test-ref-1", payments: [{ mode: "zomato", amountPaise: 100 }] }).success).toBe(false);
  });
});
