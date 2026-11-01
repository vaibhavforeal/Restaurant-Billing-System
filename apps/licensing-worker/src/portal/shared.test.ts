import { describe, expect, it } from "vitest";
import { PLANS } from "@masalapos/domain/licensing";
import { buyerState, computeTotals, draftLines, formatPaise, parseRupees, PLAN_DEVICES, roleCan, seesOnlyOwn } from "./shared.js";

const settings = { invoice: { sac: "997331", gstRateBp: 1800 }, extraDevicePaise: 50_000 };

describe("portal shared rules", () => {
  it("keeps the plans' device counts in step with the licence plans", () => {
    expect(PLAN_DEVICES).toEqual({ basic: PLANS.basic.maxDevices, pro: PLANS.pro.maxDevices });
  });

  it("splits GST into CGST and SGST within the state and IGST across states, half up per line, totals from the lines", () => {
    const lines = [{ quantity: 1, unitPricePaise: 99_999, discountPaise: 0, gstRateBp: 1800 }, { quantity: 3, unitPricePaise: 333, discountPaise: 0, gstRateBp: 1800 }];
    const intra = computeTotals(lines, true);
    // 99,999 x 9% = 8,999.91 -> 9,000 each; 999 x 9% = 89.91 -> 90 each.
    expect(intra.lines).toEqual([{ taxablePaise: 99_999, cgstPaise: 9_000, sgstPaise: 9_000, igstPaise: 0 }, { taxablePaise: 999, cgstPaise: 90, sgstPaise: 90, igstPaise: 0 }]);
    expect(intra).toMatchObject({ subtotalPaise: 100_998, taxPaise: 18_180, totalPaise: 119_178 });
    const inter = computeTotals(lines, false);
    expect(inter.lines.map((l) => l.igstPaise)).toEqual([18_000, 180]);
    expect(inter).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 18_180, totalPaise: 119_178 });
    expect(computeTotals([{ quantity: 2, unitPricePaise: 1000, discountPaise: 5000, gstRateBp: 1800 }], true).lines[0]!.taxablePaise).toBe(0);
  });

  it("drafts an order's lines: licence per outlet or renewed counter, extra devices, extras; a trial has none", () => {
    const base = { kind: "new" as const, plan: "basic" as const, termMonths: 12, outlets: 2, maxDevices: 3, pricePerOutletPaise: 900_000, discountPaise: 10_000, extras: [], installationIds: [] };
    expect(draftLines(base, settings).map((l) => [l.description, l.quantity, l.unitPricePaise, l.discountPaise])).toEqual([
      ["MasalaPOS Basic licence, 1 year, per outlet", 2, 900_000, 10_000], ["Extra devices beyond the plan's 2, 1 year", 2, 50_000, 0],
    ]);
    expect(draftLines({ ...base, kind: "renewal", outlets: 0, maxDevices: 2, installationIds: ["a", "b", "c"] }, settings)[0]).toMatchObject({ description: "MasalaPOS Basic licence renewal, 1 year, per outlet", quantity: 3 });
    expect(draftLines({ ...base, kind: "trial" }, settings)).toEqual([]);
  });

  it("formats rupees with Indian grouping and reads what staff type", () => {
    expect(formatPaise(12_345_678_90)).toBe("Rs. 1,23,45,678.90");
    expect(formatPaise(99_900, "₹")).toBe("₹999.00");
    expect(formatPaise(-500)).toBe("-Rs. 5.00");
    expect([parseRupees("1,499.5"), parseRupees("₹ 12000"), parseRupees("Rs.10.25"), parseRupees("1.234"), parseRupees("abc")]).toEqual([149_950, 1_200_000, 1025, null, null]);
  });

  it("takes the buyer's state from the GSTIN first; only sales reps are limited to their own customers", () => {
    expect(buyerState({ gstin: "29AAPFU0939F1ZV", stateCode: "27" })).toBe("29");
    expect(buyerState({ gstin: null, stateCode: "27" })).toBe("27");
    expect(buyerState({ gstin: null, stateCode: null })).toBeNull();
    expect(["admin", "sales", "accounts", "support"].map((r) => seesOnlyOwn(r as never))).toEqual([false, true, false, false]);
    expect(roleCan("accounts", "payments.record") && !roleCan("sales", "payments.record") && !roleCan("support", "licences.manage")).toBe(true);
  });
});
