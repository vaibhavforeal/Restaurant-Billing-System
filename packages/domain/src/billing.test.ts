import { describe, expect, it } from "vitest";
import { calculateBill, BillCreate, BillSettle } from "./billing.js";
import type { RoundOff } from "./round-off.js";

describe("GST billing", () => {
  it("included: one rate", () => {
    const bill = calculateBill([{ pricePaise: 10500, qty: 1, gstRate: 5 }]);
    expect(bill).toMatchObject({ subtotalPaise: 10500, cgstPaise: 250, sgstPaise: 250, totalPaise: 10500, roundingPaise: 0 });
    expect(bill.taxes).toEqual([{ gstRate: 5, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250 }]);
  });
  it("included: mixed rates share the discount", () => {
    const bill = calculateBill([{ pricePaise: 20000, qty: 1, gstRate: 5 }, { pricePaise: 10000, qty: 1, gstRate: 18 }], 3000);
    expect(bill.taxes).toEqual([
      { gstRate: 5, taxablePaise: 17144, cgstPaise: 428, sgstPaise: 428 },
      { gstRate: 18, taxablePaise: 7628, cgstPaise: 686, sgstPaise: 686 },
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
      expect(bill.taxes.every((t) => t.taxablePaise >= 0 && t.cgstPaise === t.sgstPaise)).toBe(true);
    }
  });
  it("splits GST into equal CGST and SGST, each within a paisa of the taxable value times half the rate", () => {
    // ₹100.10 at 5%: taxable 9533 would leave 477 of tax, which can't halve; the odd paisa stays in the taxable value.
    const bill = calculateBill([{ pricePaise: 10010, qty: 1, gstRate: 5 }]);
    expect(bill.taxes).toEqual([{ gstRate: 5, taxablePaise: 9534, cgstPaise: 238, sgstPaise: 238 }]);
    for (const rate of [5, 12, 18, 28]) for (let gross = 1; gross < 5000; gross += 13) {
      const [t] = calculateBill([{ pricePaise: gross, qty: 1, gstRate: rate }]).taxes;
      expect(t!.cgstPaise).toBe(t!.sgstPaise);
      expect(t!.taxablePaise + t!.cgstPaise + t!.sgstPaise).toBe(gross);
      expect(Math.abs(t!.cgstPaise - (t!.taxablePaise * rate) / 200)).toBeLessThanOrEqual(1);
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

describe("round-off", () => {
  it.each([
    [12325, "rupee", 12300, -25], [12350, "rupee", 12400, 50], [12375, "rupee", 12400, 25],
    [12325, "half", 12350, 25], [12350, "half", 12350, 0], [12375, "half", 12400, 25], [12310, "half", 12300, -10],
    [12345, "off", 12345, 0],
  ])("%i paise with %s rounds to %i (rounding %i)", (price, mode, total, rounding) => {
    const t = calculateBill([{ pricePaise: price, qty: 1, gstRate: 5 }], 0, "none", mode as RoundOff);
    expect(t.totalPaise).toBe(total);
    expect(t.roundingPaise).toBe(rounding);
  });
  it("defaults to nearest rupee", () => {
    expect(calculateBill([{ pricePaise: 12350, qty: 1, gstRate: 5 }]).totalPaise).toBe(12400);
  });
});

describe("calculateBill exclusive", () => {
  const halfTax = (taxable: number, rate: number) => Number((BigInt(taxable) * BigInt(rate) + 100n) / 200n);

  it("adds CGST and SGST on top of a single-rate item", () => {
    const bill = calculateBill([{ pricePaise: 10000, qty: 1, gstRate: 5 }], 0, "exclusive");
    expect(bill.taxes).toEqual([{ gstRate: 5, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250 }]);
    expect(bill).toMatchObject({ subtotalPaise: 10000, cgstPaise: 250, sgstPaise: 250, totalPaise: 10500, roundingPaise: 0 });
  });

  it("taxes each rate group on its amount less the same discount share as included", () => {
    const items = [{ pricePaise: 28000, qty: 1, gstRate: 5 }, { pricePaise: 9013, qty: 2, gstRate: 18 }];
    const amounts = new Map([[5, 28000], [18, 18026]]);
    const included = calculateBill(items, 4603, "included");
    const bill = calculateBill(items, 4603, "exclusive");
    expect(bill.taxes.map((t) => t.gstRate)).toEqual([5, 18]);
    for (const t of bill.taxes) {
      const inc = included.taxes.find((x) => x.gstRate === t.gstRate)!;
      const allocated = amounts.get(t.gstRate)! - (inc.taxablePaise + inc.cgstPaise + inc.sgstPaise);
      expect(t.taxablePaise).toBe(amounts.get(t.gstRate)! - allocated);
      expect(t.cgstPaise).toBe(halfTax(t.taxablePaise, t.gstRate));
      expect(t.sgstPaise).toBe(t.cgstPaise);
    }
    const taxable = bill.taxes.reduce((s, t) => s + t.taxablePaise, 0);
    expect(taxable).toBe(46026 - 4603);
    expect(bill.totalPaise - bill.roundingPaise).toBe(taxable + bill.cgstPaise + bill.sgstPaise);
    expect(bill.subtotalPaise).toBe(46026);
  });

  it("rounds an odd half paisa of tax up", () => {
    const bill = calculateBill([{ pricePaise: 101, qty: 1, gstRate: 5 }], 0, "exclusive", "off");
    expect(bill.taxes[0]).toEqual({ gstRate: 5, taxablePaise: 101, cgstPaise: 3, sgstPaise: 3 });
    expect(bill.totalPaise).toBe(107);
  });

  it("applies each round-off mode to the total including tax", () => {
    const items = [{ pricePaise: 10050, qty: 1, gstRate: 5 }];
    const cases: Array<[RoundOff, number, number]> = [["rupee", 10600, 48], ["half", 10550, -2], ["off", 10552, 0]];
    for (const [mode, total, rounding] of cases) {
      const bill = calculateBill(items, 0, "exclusive", mode);
      expect(bill.cgstPaise).toBe(251);
      expect(bill.sgstPaise).toBe(251);
      expect({ total: bill.totalPaise, rounding: bill.roundingPaise }, mode).toEqual({ total, rounding });
    }
  });

  it("charges nothing when the discount covers the whole subtotal", () => {
    const bill = calculateBill([{ pricePaise: 10000, qty: 1, gstRate: 5 }], 10000, "exclusive");
    expect(bill.taxes).toEqual([{ gstRate: 5, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 }]);
    expect(bill.totalPaise).toBe(0);
  });

  it("adds nothing for a 0% group", () => {
    const bill = calculateBill([{ pricePaise: 5000, qty: 1, gstRate: 0 }, { pricePaise: 10000, qty: 1, gstRate: 5 }], 0, "exclusive");
    expect(bill.taxes[0]).toEqual({ gstRate: 0, taxablePaise: 5000, cgstPaise: 0, sgstPaise: 0 });
    expect(bill.totalPaise).toBe(15500);
  });
});

describe("calculateBill charges", () => {
  const items = [{ pricePaise: 100000, qty: 1, gstRate: 5 }];
  const service = { kind: "service" as const, label: "Service charge", gstRate: 5, bp: 1000 };
  const sumTaxes = (taxes: Array<{ taxablePaise: number; cgstPaise: number; sgstPaise: number }>) =>
    taxes.reduce((s, t) => s + t.taxablePaise + t.cgstPaise + t.sgstPaise, 0);

  it("included: service on the discounted subtotal joins its rate group", () => {
    const bill = calculateBill(items, 10000, "included", "rupee", [service]);
    expect(bill.charges).toHaveLength(1);
    expect(bill.charges![0]).toMatchObject({ kind: "service", label: "Service charge", percentBp: 1000, gstRate: 5, amountPaise: 9000 });
    const c = bill.charges![0]!;
    expect(c.taxablePaise + c.cgstPaise + c.sgstPaise).toBe(9000);
    expect(bill.taxes).toHaveLength(1);
    expect(sumTaxes(bill.taxes)).toBe(90000 + 9000);
    expect(bill.subtotalPaise).toBe(100000);
    expect(bill.totalPaise).toBe(99000);
    expect(bill.cgstPaise).toBe(bill.taxes[0]!.cgstPaise);
  });

  it("exclusive: charge tax is added on top", () => {
    const bill = calculateBill(items, 10000, "exclusive", "off", [service]);
    expect(bill.charges![0]).toMatchObject({ amountPaise: 9000, taxablePaise: 9000, cgstPaise: 225, sgstPaise: 225 });
    expect(bill.taxes).toEqual([{ gstRate: 5, taxablePaise: 99000, cgstPaise: 2475, sgstPaise: 2475 }]);
    expect(bill.cgstPaise).toBe(2475);
    expect(bill.sgstPaise).toBe(2475);
    expect(bill.totalPaise).toBe(90000 + 9000 + 2475 + 2475);
    expect(bill.roundingPaise).toBe(0);
  });

  it("exclusive: rounds the total after charges", () => {
    const bill = calculateBill(items, 10000, "exclusive", "rupee", [service]);
    expect(bill.totalPaise - bill.roundingPaise).toBe(103950);
    expect(bill.totalPaise).toBe(104000);
  });

  it("none: no tax anywhere", () => {
    const bill = calculateBill(items, 10000, "none", "rupee", [service]);
    expect(bill.totalPaise).toBe(99000);
    expect(bill.cgstPaise + bill.sgstPaise).toBe(0);
    expect(bill.charges![0]).toMatchObject({ amountPaise: 9000, taxablePaise: 9000, cgstPaise: 0, sgstPaise: 0 });
    expect(bill.taxes.every((t) => t.cgstPaise === 0 && t.sgstPaise === 0)).toBe(true);
  });

  it("a charge at a new rate gets its own row, sorted by rate", () => {
    const bill = calculateBill(items, 0, "exclusive", "off", [{ kind: "packaging", label: "Packaging", gstRate: 18, amountPaise: 2000 }]);
    expect(bill.taxes.map((t) => t.gstRate)).toEqual([5, 18]);
    expect(bill.taxes[1]).toEqual({ gstRate: 18, taxablePaise: 2000, cgstPaise: 180, sgstPaise: 180 });
    expect(bill.charges![0]).toMatchObject({ kind: "packaging", amountPaise: 2000 });
    expect(bill.charges![0]!.percentBp).toBeUndefined();
    expect(bill.totalPaise).toBe(100000 + 2000 + 2500 + 2500 + 360);
  });

  it("a low-rate item group sorts after a charge-only lower rate", () => {
    const bill = calculateBill([{ pricePaise: 10000, qty: 1, gstRate: 18 }], 0, "exclusive", "off", [{ kind: "packaging", label: "Packaging", gstRate: 5, amountPaise: 2000 }]);
    expect(bill.taxes.map((t) => t.gstRate)).toEqual([5, 18]);
  });

  it("rounds the service charge half up to the paisa", () => {
    const bill = calculateBill([{ pricePaise: 1001, qty: 1, gstRate: 5 }], 0, "none", "off", [{ ...service, bp: 1250 }]);
    expect(bill.charges![0]!.amountPaise).toBe(125);
    expect(bill.totalPaise).toBe(1001 + 125);
  });

  it("leaves a zero charge off the bill", () => {
    const full = calculateBill(items, 100000, "included", "rupee", [service, { kind: "packaging", label: "Packaging", gstRate: 5, amountPaise: 2000 }]);
    expect(full.charges!.map((c) => c.kind)).toEqual(["packaging"]);
    expect(full.totalPaise).toBe(2000);
    expect(calculateBill(items, 0, "included", "rupee", [{ kind: "packaging", label: "Packaging", gstRate: 5, amountPaise: 0 }]).charges).toEqual([]);
  });

  it("has an empty charges list when none are passed", () => {
    expect(calculateBill(items).charges).toEqual([]);
  });

  it("applies each round-off mode after the charges", () => {
    const pack = { kind: "packaging" as const, label: "Packaging", gstRate: 0, amountPaise: 50 };
    const cases: Array<[RoundOff, number, number]> = [["rupee", 10100, 50], ["half", 10050, 0], ["off", 10050, 0]];
    for (const [mode, total, rounding] of cases) {
      const bill = calculateBill([{ pricePaise: 10000, qty: 1, gstRate: 0 }], 0, "none", mode, [pack]);
      expect({ total: bill.totalPaise, rounding: bill.roundingPaise }, mode).toEqual({ total, rounding });
    }
  });
});
