import { describe, expect, it } from "vitest";
import {
  CreditHistoryError, CreditPreview, RefundBill, VoidBill, creditFor, refundState, refundableByMode, validateCreditHistory, voidRemainder,
  type BillLine, type Credited,
} from "./credit-notes.js";
import { calculateBill } from "./billing.js";

type MoneyFields = Pick<BillLine, "taxablePaise" | "cgstPaise" | "sgstPaise" | "roundingPaise" | "totalPaise">;
const FIELDS = ["taxablePaise", "cgstPaise", "sgstPaise", "roundingPaise", "totalPaise"] as const;

const line = (over: Partial<BillLine> & { orderItemId: string }): BillLine => ({
  qty: 1, name: "Dosa", categoryId: "cat", categoryName: "Mains", gstRate: 5,
  taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, totalPaise: 0, ...over,
});
const money = (l: MoneyFields): MoneyFields =>
  ({ taxablePaise: l.taxablePaise, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, roundingPaise: l.roundingPaise, totalPaise: l.totalPaise });
const addCredit = (credited: Record<string, Credited>, draft: ReturnType<typeof creditFor>) => {
  for (const l of draft.lines) {
    const c = credited[l.orderItemId] ?? { qty: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, totalPaise: 0 };
    credited[l.orderItemId] = {
      qty: c.qty + l.qty, taxablePaise: c.taxablePaise + l.taxablePaise, cgstPaise: c.cgstPaise + l.cgstPaise,
      sgstPaise: c.sgstPaise + l.sgstPaise, roundingPaise: c.roundingPaise + l.roundingPaise, totalPaise: c.totalPaise + l.totalPaise,
    };
  }
};

describe("credit math", () => {
  const dosa = line({ orderItemId: "i1", qty: 3, taxablePaise: 30001, cgstPaise: 750, sgstPaise: 750, roundingPaise: -1, totalPaise: 31500 });

  it("returns ten heavily discounted units without exhausting tax or payment before the last unit", () => {
    const billed = line({ orderItemId: "tiny", qty: 10, gstRate: 18, taxablePaise: 55, cgstPaise: 5, sgstPaise: 5, roundingPaise: 35, totalPaise: 100 });
    const credited: Record<string, Credited> = {};
    for (let n = 0; n < 10; n++) {
      const draft = creditFor([billed], credited, [{ orderItemId: "tiny", qty: 1 }]);
      expect(draft.totals.totalPaise).toBe(10);
      for (const field of ["taxablePaise", "cgstPaise", "sgstPaise", "totalPaise"] as const) expect(draft.totals[field]).toBeGreaterThanOrEqual(0);
      addCredit(credited, draft);
      expect(credited.tiny!.cgstPaise).toBeLessThanOrEqual(5);
      expect(credited.tiny!.totalPaise).toBeLessThanOrEqual(100);
    }
    expect(credited.tiny).toEqual({ qty: 10, ...money(billed) });
  });

  it("keeps both one-unit returns at zero when negative rounding offsets all taxable and tax amounts", () => {
    const billed = line({ orderItemId: "zero", qty: 2, taxablePaise: 12, cgstPaise: 1, sgstPaise: 1, roundingPaise: -14, totalPaise: 0 });
    const credited: Record<string, Credited> = {};
    for (let n = 0; n < 2; n++) {
      const draft = creditFor([billed], credited, [{ orderItemId: "zero", qty: 1 }]);
      expect(draft.totals.totalPaise).toBe(0);
      addCredit(credited, draft);
    }
    expect(credited.zero).toEqual({ qty: 2, ...money(billed) });
  });

  it.each([
    { qty: 0.5 }, { qty: -1 }, { qty: 11 }, { taxablePaise: 1.5 }, { taxablePaise: -1 },
    { cgstPaise: 8 }, { sgstPaise: -1 }, { totalPaise: -1 }, { totalPaise: 101 },
    { roundingPaise: 0.5 }, { roundingPaise: 1 }, { qty: 10 }, { qty: 0 },
  ])("refuses inconsistent history before allocating a new credit: %j", (invalid) => {
    const billed = line({ orderItemId: "tiny", qty: 10, taxablePaise: 55, cgstPaise: 5, sgstPaise: 5, roundingPaise: 35, totalPaise: 100 });
    const prior: Credited = { qty: 1, taxablePaise: 6, cgstPaise: 1, sgstPaise: 1, roundingPaise: 4, totalPaise: 12, ...invalid };
    expect(() => voidRemainder([billed], { tiny: prior })).toThrow(/earlier refunds require review/i);
    expect(() => creditFor([billed], { tiny: prior }, [{ orderItemId: "tiny", qty: 1 }])).toThrow(CreditHistoryError);
  });

  it("continues a valid older allocation ahead of the cumulative schedule without reversing earlier amounts", () => {
    const billed = line({ orderItemId: "tiny", qty: 10, taxablePaise: 55, cgstPaise: 5, sgstPaise: 5, roundingPaise: 35, totalPaise: 100 });
    const previous = Object.freeze({ qty: 4, taxablePaise: 36, cgstPaise: 5, sgstPaise: 5, roundingPaise: 26, totalPaise: 72 });
    const credited = { tiny: previous };
    const first = creditFor([billed], credited, [{ orderItemId: "tiny", qty: 1 }]);
    expect(money(first.totals)).toEqual({ taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, totalPaise: 0 });
    addCredit(credited, first);
    const next = creditFor([billed], credited, [{ orderItemId: "tiny", qty: 4 }]);
    expect(next.totals).toEqual({ taxablePaise: 14, cgstPaise: 0, sgstPaise: 0, roundingPaise: 4, totalPaise: 18 });
    addCredit(credited, next);
    addCredit(credited, voidRemainder([billed], credited));
    expect(credited.tiny).toEqual({ qty: 10, ...money(billed) });
    expect(previous).toEqual({ qty: 4, taxablePaise: 36, cgstPaise: 5, sgstPaise: 5, roundingPaise: 26, totalPaise: 72 });
  });

  it.each(Array.from({ length: 99 }, (_, n) => n + 1))("conserves every field for quantity %i across deterministic partitions, grouped requests and final voids", (qty) => {
    const bills = (["included", "none"] as const).map((mode, i) => {
      const totals = calculateBill([{ pricePaise: i ? 1000 : 7, gstRate: i ? 5 : 18, qty }], i ? qty * 973 : qty % 3, mode);
      return line({ orderItemId: mode, qty, ...totals.taxes[0]!, roundingPaise: totals.roundingPaise, totalPaise: totals.totalPaise });
    });
    // Saved exclusive invoices already contain their tax calculation; credits must use those immutable amounts.
    const taxablePaise = qty * 103 - 17, cgstPaise = Math.round(taxablePaise * 0.06), sgstPaise = cgstPaise;
    const beforeRounding = taxablePaise + cgstPaise + sgstPaise;
    const totalPaise = Math.round(beforeRounding / 100) * 100;
    bills.push(line({ orderItemId: "legacy-exclusive", qty, gstRate: 12, taxablePaise, cgstPaise, sgstPaise, roundingPaise: totalPaise - beforeRounding, totalPaise }));
    const originals = structuredClone(bills);
    for (const singles of [true, false]) {
      const credited: Record<string, Credited> = {};
      let left = qty, step = 0;
      while (left > 1) {
        const q = singles ? 1 : Math.min(left - 1, 1 + (qty * 17 + step * 11) % 7);
        const requested = bills.flatMap((b) => q === 1 ? [{ orderItemId: b.orderItemId, qty: 1 }]
          : [{ orderItemId: b.orderItemId, qty: 1 }, { orderItemId: b.orderItemId, qty: q - 1 }]);
        const draft = creditFor(bills, credited, requested);
        for (const l of draft.lines) {
          expect(l.qty).toBe(q);
          for (const f of ["taxablePaise", "cgstPaise", "sgstPaise", "totalPaise"] as const) expect(l[f]).toBeGreaterThanOrEqual(0);
          expect(l.totalPaise).toBe(l.taxablePaise + l.cgstPaise + l.sgstPaise + l.roundingPaise);
        }
        addCredit(credited, draft);
        expect(() => validateCreditHistory(bills, credited)).not.toThrow();
        left -= q;
        step++;
      }
      const last = voidRemainder(bills, credited);
      for (const l of last.lines) for (const f of ["taxablePaise", "cgstPaise", "sgstPaise", "totalPaise"] as const) expect(l[f]).toBeGreaterThanOrEqual(0);
      expect(last.taxes.map((t) => t.gstRate)).toEqual([5, 12, 18]);
      addCredit(credited, last);
      for (const b of bills) expect(credited[b.orderItemId]).toEqual({ qty, ...money(b) });
      expect(bills).toEqual(originals);
    }
  });

  it("credits proportional shares and gives the last units the remainder", () => {
    const credited: Record<string, Credited> = {};
    const first = creditFor([dosa], credited, [{ orderItemId: "i1", qty: 1 }]);
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]).toMatchObject({ orderItemId: "i1", qty: 1, name: "Dosa", gstRate: 5 });
    expect(money(first.lines[0]!)).toEqual({ taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, roundingPaise: 0, totalPaise: 10500 });
    addCredit(credited, first);
    const second = creditFor([dosa], credited, [{ orderItemId: "i1", qty: 1 }]);
    expect(money(second.lines[0]!)).toEqual({ taxablePaise: 10001, cgstPaise: 250, sgstPaise: 250, roundingPaise: -1, totalPaise: 10500 });
    addCredit(credited, second);
    const third = creditFor([dosa], credited, [{ orderItemId: "i1", qty: 1 }]);
    expect(money(third.lines[0]!)).toEqual({ taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, roundingPaise: 0, totalPaise: 10500 });
    addCredit(credited, third);
    expect(money(credited["i1"]!)).toEqual(money(dosa));
  });

  it("keeps a discounted multi-rate bill exact across three partial refunds", () => {
    const lines = [
      line({ orderItemId: "a", qty: 7, gstRate: 5, taxablePaise: 66667, cgstPaise: 1667, sgstPaise: 1667, roundingPaise: 3, totalPaise: 70004 }),
      line({ orderItemId: "b", qty: 3, gstRate: 18, taxablePaise: 44999, cgstPaise: 4050, sgstPaise: 4050, roundingPaise: -2, totalPaise: 53097 }),
      line({ orderItemId: "c", qty: 5, gstRate: 5, taxablePaise: 12345, cgstPaise: 309, sgstPaise: 309, roundingPaise: 1, totalPaise: 12964 }),
    ];
    const credited: Record<string, Credited> = {};
    const steps = [
      [{ orderItemId: "a", qty: 3 }, { orderItemId: "b", qty: 1 }],
      [{ orderItemId: "a", qty: 2 }, { orderItemId: "c", qty: 4 }],
    ];
    const drafts: Array<ReturnType<typeof creditFor>> = [];
    for (const step of steps) {
      const d = creditFor(lines, credited, step);
      drafts.push(d);
      addCredit(credited, d);
    }
    const last = voidRemainder(lines, credited);
    drafts.push(last);
    addCredit(credited, last);

    for (const field of FIELDS) {
      const credits = drafts.reduce((sum, d) => sum + d.totals[field], 0);
      const bill = lines.reduce((sum, l) => sum + l[field], 0);
      expect(credits).toBe(bill);
    }
    expect(drafts.reduce((sum, d) => sum + d.totals.totalPaise, 0)).toBe(70004 + 53097 + 12964);
    for (const d of drafts) {
      for (const l of d.lines) expect(l.totalPaise).toBe(l.taxablePaise + l.cgstPaise + l.sgstPaise + l.roundingPaise);
      expect(d.totals.totalPaise).toBe(d.totals.taxablePaise + d.totals.cgstPaise + d.totals.sgstPaise + d.totals.roundingPaise);
    }
    for (const l of lines) expect(credited[l.orderItemId]).toMatchObject({ qty: l.qty, ...money(l) });
  });

  it("groups credit taxes by GST rate", () => {
    const lines = [
      line({ orderItemId: "a", qty: 1, gstRate: 5, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, totalPaise: 10500 }),
      line({ orderItemId: "b", qty: 1, gstRate: 18, taxablePaise: 20000, cgstPaise: 1800, sgstPaise: 1800, totalPaise: 23600 }),
      line({ orderItemId: "c", qty: 1, gstRate: 5, taxablePaise: 5000, cgstPaise: 125, sgstPaise: 125, totalPaise: 5250 }),
    ];
    const draft = voidRemainder(lines, {});
    expect(draft.taxes).toEqual([
      { gstRate: 5, taxablePaise: 15000, cgstPaise: 375, sgstPaise: 375 },
      { gstRate: 18, taxablePaise: 20000, cgstPaise: 1800, sgstPaise: 1800 },
    ]);
    expect(draft.totals).toEqual({ taxablePaise: 35000, cgstPaise: 2175, sgstPaise: 2175, roundingPaise: 0, totalPaise: 39350 });
  });

  it("voids only what remains after partial refunds", () => {
    const credited: Record<string, Credited> = {};
    addCredit(credited, creditFor([dosa], credited, [{ orderItemId: "i1", qty: 2 }]));
    const other = line({ orderItemId: "i2", qty: 1, taxablePaise: 1000, cgstPaise: 25, sgstPaise: 25, totalPaise: 1050 });
    const draft = voidRemainder([dosa, other], credited);
    expect(draft.lines.map((l) => [l.orderItemId, l.qty])).toEqual([["i1", 1], ["i2", 1]]);
    expect(money(draft.lines[0]!)).toEqual({ taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, roundingPaise: 0, totalPaise: 10500 });
    expect(draft.totals.totalPaise).toBe(31500 + 1050 - 21000);
  });

  it("refuses over-refund, unknown items and empty refunds", () => {
    const credited: Record<string, Credited> = {};
    expect(() => creditFor([dosa], credited, [{ orderItemId: "i1", qty: 4 }])).toThrow(/Dosa/);
    expect(() => creditFor([dosa], credited, [{ orderItemId: "zzz", qty: 1 }])).toThrow(/zzz/);
    expect(() => creditFor([dosa], credited, [])).toThrow("Nothing left to refund on this bill");
    addCredit(credited, voidRemainder([dosa], credited));
    expect(() => voidRemainder([dosa], credited)).toThrow("Nothing left to refund on this bill");
    expect(() => creditFor([dosa], credited, [{ orderItemId: "i1", qty: 1 }])).toThrow(/Dosa/);
  });

  it("rounds positive half paise upwards and balances the credit with a negative rounding residual", () => {
    const l = line({ orderItemId: "x", qty: 2, taxablePaise: 5, cgstPaise: 5, sgstPaise: 0, roundingPaise: -10, totalPaise: 0 });
    const d = creditFor([l], {}, [{ orderItemId: "x", qty: 1 }]);
    expect(d.lines[0]).toMatchObject({ taxablePaise: 3, cgstPaise: 3, roundingPaise: -6, totalPaise: 0 });
  });
});

describe("refund state and mode limits", () => {
  it("derives the refund state from credited totals", () => {
    expect(refundState(10000, 0)).toBe("none");
    expect(refundState(10000, 4000)).toBe("partly_refunded");
    expect(refundState(10000, 10000)).toBe("refunded");
  });

  it("limits refunds to what each mode still holds", () => {
    expect(refundableByMode(
      [{ mode: "cash", amountPaise: 6000 }, { mode: "upi", amountPaise: 4000 }],
      [{ mode: "cash", amountPaise: 1000 }],
    )).toEqual({ cash: 5000, upi: 4000, card: 0 });
  });
});

describe("credit schemas", () => {
  it("validates previews, voids and refunds strictly", () => {
    expect(CreditPreview.parse({ kind: "void" })).toEqual({ kind: "void" });
    expect(CreditPreview.parse({ kind: "refund", lines: [{ orderItemId: "i1", qty: 1 }] }).lines).toHaveLength(1);
    expect(() => CreditPreview.parse({ kind: "swap" })).toThrow();
    expect(() => CreditPreview.parse({ kind: "void", extra: 1 })).toThrow();
    expect(() => CreditPreview.parse({ kind: "refund", lines: [{ orderItemId: "i1", qty: 0 }] })).toThrow();

    expect(VoidBill.parse({ clientRef: "abcdefgh", reason: "  Duplicate  " })).toEqual({ clientRef: "abcdefgh", reason: "Duplicate", refunds: [] });
    expect(() => VoidBill.parse({ clientRef: "short", reason: "x" })).toThrow();
    expect(() => VoidBill.parse({ clientRef: "abcdefgh", reason: "   " })).toThrow();
    expect(() => VoidBill.parse({ clientRef: "abcdefgh", reason: "x", refunds: [{ mode: "cash", amountPaise: 0 }] })).toThrow();
    expect(() => VoidBill.parse({ clientRef: "abcdefgh", reason: "x", refunds: [{ mode: "cheque", amountPaise: 5 }] })).toThrow();
    expect(() => VoidBill.parse({ clientRef: "abcdefgh", reason: "x", approverPin: "12" })).toThrow();
    expect(VoidBill.parse({ clientRef: "abcdefgh", reason: "x", approverPin: "1234", refunds: [{ mode: "upi", amountPaise: 5, refNote: "ok" }] }).approverPin).toBe("1234");
    expect(() => VoidBill.parse({ clientRef: "abcdefgh", reason: "x", nope: true })).toThrow();

    expect(() => RefundBill.parse({ clientRef: "abcdefgh", reason: "x", lines: [] })).toThrow();
    expect(() => RefundBill.parse({ clientRef: "abcdefgh", reason: "x" })).toThrow();
    expect(RefundBill.parse({ clientRef: "abcdefgh", reason: "x", lines: [{ orderItemId: "i1", qty: 2 }] }).lines).toEqual([{ orderItemId: "i1", qty: 2 }]);
  });
});
