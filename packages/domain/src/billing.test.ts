import { describe, expect, it } from "vitest";
import { calculateBill, BillCreate, BillSettle } from "./billing.js";

describe("GST billing", () => {
  it("adds GST to tax-exclusive prices", () => {
    expect(calculateBill([{ pricePaise: 10000, qty: 2, gstRate: 5 }])).toMatchObject({ subtotalPaise: 20000, cgstPaise: 500, sgstPaise: 500, totalPaise: 21000, roundingPaise: 0 });
  });
  it("extracts GST from inclusive prices without adding it twice", () => {
    const bill = calculateBill([{ pricePaise: 10500, qty: 2, gstRate: 5 }], 0, true);
    expect(bill).toMatchObject({ subtotalPaise: 21000, cgstPaise: 500, sgstPaise: 500, totalPaise: 21000 });
    expect(bill.taxes[0]?.taxablePaise).toBe(20000);
  });
  it("allocates discount proportionally across rates with deterministic paise remainders", () => {
    const bill = calculateBill([{ pricePaise: 100, qty: 1, gstRate: 18 }, { pricePaise: 100, qty: 1, gstRate: 5 }], 1);
    expect(bill.taxes.map((t) => [t.gstRate, t.taxablePaise])).toEqual([[5, 99], [18, 100]]);
    expect(bill.taxes.reduce((sum, t) => sum + t.taxablePaise, 0)).toBe(199);
  });
  it("discounts inclusive amounts before extracting GST", () => {
    const b = calculateBill([{ pricePaise: 11800, qty: 1, gstRate: 18 }], 1180, true);
    expect(b.taxes).toEqual([{ gstRate: 18, taxablePaise: 9000, cgstPaise: 810, sgstPaise: 810 }]);
    expect(b.totalPaise).toBe(10600); expect(b.roundingPaise).toBe(-20);
  });
  it("rounds the final total to a rupee, half up", () => {
    expect(calculateBill([{ pricePaise: 1049, qty: 1, gstRate: 0 }]).totalPaise).toBe(1000);
    expect(calculateBill([{ pricePaise: 1050, qty: 1, gstRate: 0 }]).totalPaise).toBe(1100);
  });
  it("handles free items and a full discount", () => {
    expect(calculateBill([{ pricePaise: 0, qty: 2, gstRate: 18 }]).totalPaise).toBe(0);
    expect(calculateBill([{ pricePaise: 100, qty: 2, gstRate: 18 }], 200).totalPaise).toBe(0);
  });
  it("rejects unsafe values, empty bills, negative or excessive discounts", () => {
    for (const items of [[], [{ pricePaise: Number.MAX_SAFE_INTEGER, qty: 2, gstRate: 5 }], [{ pricePaise: 0.1, qty: 1, gstRate: 5 }], [{ pricePaise: 100, qty: 0, gstRate: 5 }]]) expect(() => calculateBill(items)).toThrow();
    for (const discount of [-1, 101, 0.1]) expect(() => calculateBill([{ pricePaise: 100, qty: 1, gstRate: 5 }], discount)).toThrow();
  });
  it("conserves money across both tax modes, rates, and discount remainders", () => {
    for (const inclusive of [true, false]) for (let price = 0; price < 400; price += 7) {
      const bill = calculateBill([{ pricePaise: price, qty: 3, gstRate: 5 }, { pricePaise: price + 5, qty: 2, gstRate: 18 }], Math.floor(price / 3), inclusive);
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
});

describe("operator-collected GST (Zomato, section 9(5))", () => {
  const items = [{ pricePaise: 29000, qty: 2, gstRate: 5 }];
  it("charges no CGST/SGST and totals the item value when tax inclusive", () => {
    const bill = calculateBill(items, 0, true, "operator");
    expect(bill).toMatchObject({ subtotalPaise: 58000, cgstPaise: 0, sgstPaise: 0, totalPaise: 58000, roundingPaise: 0 });
    expect(bill.taxes).toEqual([{ gstRate: 5, taxablePaise: 58000, cgstPaise: 0, sgstPaise: 0 }]);
  });
  it("charges no CGST/SGST and totals the item value when tax exclusive", () => {
    const bill = calculateBill(items, 0, false, "operator");
    expect(bill).toMatchObject({ cgstPaise: 0, sgstPaise: 0, totalPaise: 58000 });
    expect(bill.taxes[0]?.taxablePaise).toBe(58000);
  });
  it("keeps one tax line per rate and the existing rounding rule", () => {
    const bill = calculateBill([{ pricePaise: 10050, qty: 1, gstRate: 5 }, { pricePaise: 10000, qty: 1, gstRate: 18 }], 0, false, "operator");
    expect(bill.taxes.map((t) => [t.gstRate, t.taxablePaise])).toEqual([[5, 10050], [18, 10000]]);
    expect(bill.totalPaise).toBe(20100);
    expect(bill.roundingPaise).toBe(50);
  });
  it("shares a discount across lines when one is passed", () => {
    const bill = calculateBill([{ pricePaise: 10000, qty: 1, gstRate: 5 }, { pricePaise: 10000, qty: 1, gstRate: 18 }], 1000, true, "operator");
    expect(bill.taxes.map((t) => t.taxablePaise)).toEqual([9500, 9500]);
    expect(bill.totalPaise).toBe(19000);
  });
  it("defaults to the restaurant mode", () => {
    expect(calculateBill(items, 0, false)).toEqual(calculateBill(items, 0, false, "restaurant"));
    expect(calculateBill(items, 0, false).cgstPaise).toBeGreaterThan(0);
  });
  it("still settles only cash, UPI or card", () => {
    expect(BillSettle.safeParse({ clientRef: "test-ref-1", payments: [{ mode: "zomato", amountPaise: 100 }] }).success).toBe(false);
  });
});

describe("composition scheme (bill of supply)", () => {
  it("charges no GST: the menu price less any discount is the bill, whatever the inclusive flag", () => {
    const items = [{ pricePaise: 10050, qty: 1, gstRate: 5 }, { pricePaise: 10000, qty: 2, gstRate: 18 }];
    for (const inclusive of [false, true]) {
      const bill = calculateBill(items, 1000, inclusive, "composition");
      expect(bill).toMatchObject({ subtotalPaise: 30050, discountPaise: 1000, cgstPaise: 0, sgstPaise: 0, totalPaise: 29100, roundingPaise: 50 });
      expect(bill.taxes.every((t) => t.cgstPaise === 0 && t.sgstPaise === 0)).toBe(true);
      expect(bill.taxes.reduce((sum, t) => sum + t.taxablePaise, 0)).toBe(29050);
    }
  });
});
