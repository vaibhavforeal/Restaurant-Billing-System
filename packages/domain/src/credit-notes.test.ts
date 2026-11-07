import { describe, expect, it } from "vitest";
import {
  CreditPreview, RefundBill, VoidBill, creditFor, packagingCredit, refundState, refundableByMode, voidRemainder,
  type BillChargeCredit, type BillLine, type Credited, type CreditedCharges,
} from "./credit-notes.js";

type MoneyFields = Pick<BillLine, "taxablePaise" | "cgstPaise" | "sgstPaise" | "roundingPaise" | "totalPaise">;
const FIELDS = ["taxablePaise", "cgstPaise", "sgstPaise", "roundingPaise", "totalPaise"] as const;

const line = (over: Partial<BillLine> & { orderItemId: string }): BillLine => ({
  qty: 1, name: "Dosa", categoryId: "cat", categoryName: "Mains", gstRate: 5, packagingPaise: 0,
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

  it("credits proportional shares and gives the last units the remainder", () => {
    const credited: Record<string, Credited> = {};
    const first = creditFor([dosa], credited, [{ orderItemId: "i1", qty: 1 }]);
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]).toMatchObject({ orderItemId: "i1", qty: 1, name: "Dosa", gstRate: 5 });
    expect(money(first.lines[0]!)).toEqual({ taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, roundingPaise: 0, totalPaise: 10500 });
    addCredit(credited, first);
    const second = creditFor([dosa], credited, [{ orderItemId: "i1", qty: 1 }]);
    expect(money(second.lines[0]!)).toEqual({ taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, roundingPaise: 0, totalPaise: 10500 });
    addCredit(credited, second);
    const third = creditFor([dosa], credited, [{ orderItemId: "i1", qty: 1 }]);
    expect(money(third.lines[0]!)).toEqual({ taxablePaise: 10001, cgstPaise: 250, sgstPaise: 250, roundingPaise: -1, totalPaise: 10500 });
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

  it("rounds half away from zero", () => {
    const l = line({ orderItemId: "x", qty: 2, taxablePaise: 5, cgstPaise: -5, sgstPaise: 0, roundingPaise: 0, totalPaise: 0 });
    const d = creditFor([l], {}, [{ orderItemId: "x", qty: 1 }]);
    expect(d.lines[0]).toMatchObject({ taxablePaise: 3, cgstPaise: -3 });
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
    expect(CreditPreview.parse({ kind: "void" })).toEqual({ kind: "void", refundPackaging: true });
    expect(CreditPreview.parse({ kind: "refund", lines: [{ orderItemId: "i1", qty: 1 }], refundPackaging: false }).refundPackaging).toBe(false);
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
    expect(RefundBill.parse({ clientRef: "abcdefgh", reason: "x", lines: [{ orderItemId: "i1", qty: 2 }] }).refundPackaging).toBe(true);
    expect(() => RefundBill.parse({ clientRef: "abcdefgh", reason: "x", lines: [{ orderItemId: "i1", qty: 2 }], refundPackaging: "no" })).toThrow();
  });
});

const addCharges = (creditedCharges: CreditedCharges, draft: ReturnType<typeof creditFor>) => {
  for (const c of draft.charges) {
    const was = creditedCharges[c.kind] ?? { amountPaise: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, totalPaise: 0 };
    creditedCharges[c.kind] = {
      amountPaise: was.amountPaise + c.amountPaise, taxablePaise: was.taxablePaise + c.taxablePaise, cgstPaise: was.cgstPaise + c.cgstPaise,
      sgstPaise: was.sgstPaise + c.sgstPaise, roundingPaise: was.roundingPaise + c.roundingPaise, totalPaise: was.totalPaise + c.totalPaise,
    };
  }
};

describe("credit math with charges", () => {
  const thali = line({ orderItemId: "i1", qty: 2, gstRate: 5, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, totalPaise: 10500 });
  const service: BillChargeCredit = { kind: "service", label: "Service charge", gstRate: 18, amountPaise: 1000, taxablePaise: 1000, cgstPaise: 90, sgstPaise: 90, roundingPaise: 0, totalPaise: 1180 };
  const packaging: BillChargeCredit = { kind: "packaging", label: "Packaging", gstRate: 5, amountPaise: 2000, taxablePaise: 2000, cgstPaise: 50, sgstPaise: 50, roundingPaise: 0, totalPaise: 2100 };
  const charges = [service, packaging];
  const serviceCredited: CreditedCharges = { service: { amountPaise: 1000, taxablePaise: 1000, cgstPaise: 90, sgstPaise: 90, roundingPaise: 0, totalPaise: 1180 } };
  const bothCredited: CreditedCharges = { ...serviceCredited, packaging: { amountPaise: 2000, taxablePaise: 2000, cgstPaise: 50, sgstPaise: 50, roundingPaise: 0, totalPaise: 2100 } };

  it("leaves the charges on the bill for a partial refund", () => {
    const d = creditFor([thali], {}, [{ orderItemId: "i1", qty: 1 }], charges);
    expect(d.charges).toEqual([]);
    expect(d.totals.totalPaise).toBe(5250);
    expect(d.taxes).toEqual([{ gstRate: 5, taxablePaise: 5000, cgstPaise: 125, sgstPaise: 125 }]);
  });

  it("credits every charge not yet credited when the last items are refunded", () => {
    const d = creditFor([thali], {}, [{ orderItemId: "i1", qty: 2 }], charges);
    expect(d.charges).toEqual(charges);
    expect(d.totals.totalPaise).toBe(10500 + 1180 + 2100);
    expect(d.totals.taxablePaise).toBe(10000 + 1000 + 2000);
    expect(d.taxes).toEqual([
      { gstRate: 5, taxablePaise: 12000, cgstPaise: 300, sgstPaise: 300 },
      { gstRate: 18, taxablePaise: 1000, cgstPaise: 90, sgstPaise: 90 },
    ]);
  });

  it("credits the remaining items and the charges on a void after a partial refund", () => {
    const credited: Record<string, Credited> = {};
    addCredit(credited, creditFor([thali], credited, [{ orderItemId: "i1", qty: 1 }], charges));
    const d = voidRemainder([thali], credited, charges);
    expect(d.lines).toHaveLength(1);
    expect(d.charges.map((c) => c.kind)).toEqual(["service", "packaging"]);
    expect(d.totals.totalPaise).toBe(5250 + 3280);
  });

  it("never credits a charge twice", () => {
    const d = creditFor([thali], {}, [{ orderItemId: "i1", qty: 2 }], charges, serviceCredited);
    expect(d.charges).toEqual([packaging]);
    expect(d.totals.totalPaise).toBe(10500 + 2100);
    const done = voidRemainder([thali], { i1: { qty: 2, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, roundingPaise: 0, totalPaise: 10500 } }, charges, serviceCredited);
    expect(done.lines).toEqual([]);
    expect(done.charges).toEqual([packaging]);
    expect(() => voidRemainder([thali], { i1: { qty: 2, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, roundingPaise: 0, totalPaise: 10500 } }, charges, bothCredited)).toThrow("Nothing left to refund");
  });
});

describe("per-item packaging credits", () => {
  // A: 2 units with 2000 packaging on the line; B: no packaging. Packaging charge 2500 = 2000 per-item + 500 flat.
  const a = line({ orderItemId: "a", qty: 2, name: "Biryani", taxablePaise: 20000, cgstPaise: 500, sgstPaise: 500, totalPaise: 21000, packagingPaise: 2000 });
  const b = line({ orderItemId: "b", qty: 1, name: "Raita", taxablePaise: 5000, cgstPaise: 125, sgstPaise: 125, totalPaise: 5250 });
  const lines = [a, b];
  const packaging: BillChargeCredit = { kind: "packaging", label: "Packaging", gstRate: 5, amountPaise: 2500, taxablePaise: 2500, cgstPaise: 63, sgstPaise: 62, roundingPaise: 0, totalPaise: 2625 };
  const service: BillChargeCredit = { kind: "service", label: "Service charge", gstRate: 18, amountPaise: 1000, taxablePaise: 1000, cgstPaise: 90, sgstPaise: 90, roundingPaise: 0, totalPaise: 1180 };
  const oneA = [{ orderItemId: "a", qty: 1 }];
  const everything = [{ orderItemId: "a", qty: 2 }, { orderItemId: "b", qty: 1 }];

  it("credits a refunded item's packaging", () => {
    const d = creditFor(lines, {}, oneA, [packaging]);
    expect(d.charges).toHaveLength(1);
    expect(d.charges[0]).toMatchObject({ kind: "packaging", amountPaise: 1000, taxablePaise: 1000, cgstPaise: 25, sgstPaise: 25, roundingPaise: 0, totalPaise: 1050 });
    expect(d.totals.totalPaise).toBe(10500 + 1050);
  });

  it("credits no packaging when unticked", () => {
    const d = creditFor(lines, {}, oneA, [packaging], {}, { refundPackaging: false });
    expect(d.charges).toEqual([]);
    expect(d.totals.totalPaise).toBe(10500);
  });

  it("adds the flat part on a refund that clears the bill", () => {
    const d = creditFor(lines, {}, everything, [packaging]);
    expect(d.charges).toEqual([packaging]);
  });

  it("keeps partial credits and a void summing exactly to the bill", () => {
    const odd: BillChargeCredit = { ...packaging, amountPaise: 2333, taxablePaise: 2333, cgstPaise: 58, sgstPaise: 58, roundingPaise: 1, totalPaise: 2450 };
    const credited: Record<string, Credited> = {};
    const creditedCharges: CreditedCharges = {};
    const first = creditFor(lines, credited, oneA, [odd], creditedCharges);
    expect(first.charges[0]!.amountPaise).toBe(1000);
    addCredit(credited, first);
    addCharges(creditedCharges, first);
    const last = voidRemainder(lines, credited, [odd], creditedCharges);
    expect(last.charges[0]!.amountPaise).toBe(1333);
    addCharges(creditedCharges, last);
    expect(creditedCharges.packaging).toEqual({ amountPaise: 2333, taxablePaise: 2333, cgstPaise: 58, sgstPaise: 58, roundingPaise: 1, totalPaise: 2450 });
    for (const d of [first, last]) for (const c of d.charges) expect(c.totalPaise).toBe(c.taxablePaise + c.cgstPaise + c.sgstPaise + c.roundingPaise);
  });

  it("voids the packaging a refund kept", () => {
    const credited: Record<string, Credited> = {};
    const kept = creditFor(lines, credited, everything, [packaging], {}, { refundPackaging: false });
    expect(kept.charges).toEqual([]);
    addCredit(credited, kept);
    const d = voidRemainder(lines, credited, [packaging], {});
    expect(d.lines).toEqual([]);
    expect(d.charges).toEqual([packaging]);
    expect(() => creditFor(lines, credited, [], [packaging])).toThrow("Nothing left to refund on this bill");
  });

  it("leaves the service charge rules unchanged", () => {
    expect(creditFor(lines, {}, oneA, [service, packaging]).charges.map((c) => c.kind)).toEqual(["packaging"]);
    const clearing = creditFor(lines, {}, everything, [service, packaging], {}, { refundPackaging: false });
    expect(clearing.charges).toEqual([service]);
    expect(creditFor(lines, {}, everything, [service, packaging]).charges).toEqual([service, packaging]);
  });

  it("reports the packaging a refund would credit", () => {
    expect(packagingCredit(lines, {}, oneA, [packaging], {})).toBe(1000);
    expect(packagingCredit(lines, {}, [{ orderItemId: "b", qty: 1 }], [packaging], {})).toBe(0);
    expect(packagingCredit(lines, {}, everything, [packaging], {})).toBe(2500);
    const full: CreditedCharges = { packaging: { amountPaise: 2500, taxablePaise: 2500, cgstPaise: 63, sgstPaise: 62, roundingPaise: 0, totalPaise: 2625 } };
    expect(packagingCredit(lines, {}, oneA, [packaging], full)).toBe(0);
    expect(packagingCredit(lines, {}, oneA, [], {})).toBe(0);
  });
});
