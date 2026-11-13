import { describe, expect, it } from "vitest";
import { daySummary } from "./reports.js";
import { createBill, voidBill, type CreateBillInput } from "./bills.js";
import { menuCafe, T0, threeBillDay, walkIn } from "./testing/fixtures.js";

describe("daySummary", () => {
  it("sums the day without the voided bill", () => {
    const { db } = threeBillDay();
    const s = daySummary(db, "2026-11-13");
    expect(s).toMatchObject({ date: "2026-11-13", billCount: 2, voidCount: 1, grossPaise: 3600 + 6500, discountPaise: 500, netPaise: 3600 + 6000,
      byMode: { cash: 7600, upi: 2000, card: 0 } });
    expect(s.items).toEqual([{ name: "Cookie", qty: 1, amountPaise: 4000 }, { name: "Samosa", qty: 2, amountPaise: 3600 }, { name: "Masala Chai (Large)", qty: 1, amountPaise: 2500 }]);
    expect(s.voids).toEqual([{ invoiceNo: "CPA/26-27/0003", token: 3, totalPaise: 1800, reason: "x" }]);
    expect(s.taxes.reduce((n, t) => n + t.taxablePaise + t.cgstPaise + t.sgstPaise, 0)).toBe(s.netPaise - s.roundingPaise);
  });

  it("returns zeros for a day with no bills", () => {
    const { db } = threeBillDay();
    const s = daySummary(db, "2026-11-14");
    expect(s).toMatchObject({ date: "2026-11-14", billCount: 0, voidCount: 0, grossPaise: 0, discountPaise: 0, roundingPaise: 0, netPaise: 0,
      taxes: [], items: [], voids: [], byMode: { cash: 0, upi: 0, card: 0 } });
  });

  it("totals live bills by staff and by order kind", () => {
    const { db, samosa, owner, cashier } = menuCafe();
    const bill = (id: string, qty: number, extra: Partial<CreateBillInput>): CreateBillInput => ({ id, lines: [{ itemId: samosa.id, variantId: null, qty }],
      discountPaise: 0, discountNote: null, payments: [{ mode: "cash", amountPaise: 1800 * qty, refNote: null }], now: T0, tzOffsetMinutes: 330,
      ...walkIn(cashier.id), ...extra });
    createBill(db, bill("b1", 1, {}));
    createBill(db, bill("b2", 2, {}));
    createBill(db, bill("b3", 5, { ...walkIn(owner.id), orderKind: "delivery" }));
    createBill(db, bill("b4", 3, {}));
    voidBill(db, { billId: "b4", reason: "x", staffId: owner.id, now: T0, tzOffsetMinutes: 330 });
    const s = daySummary(db, "2026-11-13");
    expect(s.byStaff).toEqual([
      { staffId: owner.id, name: "Asha", billCount: 1, totalPaise: 9000 },
      { staffId: cashier.id, name: "Ravi", billCount: 2, totalPaise: 5400 },
    ]);
    expect(s.byOrderKind).toEqual({ takeaway: { billCount: 2, totalPaise: 5400 }, delivery: { billCount: 1, totalPaise: 9000 } });
  });
});
