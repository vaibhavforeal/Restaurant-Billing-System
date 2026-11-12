import { describe, expect, it } from "vitest";
import { daySummary } from "./reports.js";
import { threeBillDay } from "./testing/fixtures.js";

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
});
