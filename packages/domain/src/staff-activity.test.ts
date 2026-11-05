import { describe, expect, it } from "vitest";
import { buildStaffActivityReport, DEFAULT_ACTIVITY_THRESHOLDS, type ActivityEvent, type ActivityKind } from "./staff-activity.js";

const T0 = Date.UTC(2026, 10, 3, 6);
let n = 0;
function ev(kind: ActivityKind, staffName: string, extra: Partial<ActivityEvent> = {}): ActivityEvent {
  return { kind, at: T0 + ++n * 60_000, staffId: staffName.toLowerCase(), staffName, count: 1, amountPaise: null, detail: `${kind} detail`, reference: null, ...extra };
}
const many = (times: number, make: () => ActivityEvent) => Array.from({ length: times }, make);
const build = (events: ActivityEvent[], baseline: ActivityEvent[] = [], days = 2) => buildStaffActivityReport({
  from: "2026-11-03", to: "2026-11-04", today: "2026-11-04", timezone: "Asia/Kolkata", generatedAt: 0,
  days, baselineDays: 30, events, baseline, thresholds: DEFAULT_ACTIVITY_THRESHOLDS,
});
const flagged = (report: ReturnType<typeof build>) => report.tables.find((t) => t.title === "Flagged")!.rows;
const byStaff = (report: ReturnType<typeof build>) => Object.fromEntries(report.tables.find((t) => t.title === "By staff")!.rows.map((row) => [row.staff, row]));

describe("buildStaffActivityReport", () => {
  it("always flags a paid bill voided, cash short, a big discount and a big pay-out, at the thresholds", () => {
    const report = build([
      ev("credit_note", "Ravi", { paidBillVoid: true, amountPaise: 84_000, reference: "Bill #1042" }),
      ev("credit_note", "Ravi", { paidBillVoid: false, amountPaise: 10_000 }),
      ev("cash_short", "Meera", { amountPaise: 25_000 }), ev("cash_short", "Meera", { amountPaise: 15_000 }),
      ev("discount", "Ravi", { discountPercent: 20, amountPaise: 4_000 }), ev("discount", "Ravi", { discountPercent: 10, amountPaise: 1_000 }),
      ev("pay_out", "Meera", { amountPaise: 60_000 }), ev("pay_out", "Meera", { amountPaise: 50_000 }),
    ]);
    expect(report.kind).toBe("staff-activity");
    expect(flagged(report).map((row) => [row.staff, row.what, row.why, row.amount, row.reference])).toEqual([
      ["Meera", "Pay-out", "Pay-out over ₹500.00", 60_000, null],
      ["Ravi", "Discount", "Discount of 20% or more", 4_000, null],
      ["Meera", "Cash short", "Cash short by ₹200.00 or more", 25_000, null],
      ["Ravi", "Void or refund", "Paid bill voided", 84_000, "Bill #1042"],
    ]);
  });

  it("flags a count at least 2× the person's own usual daily rate, with at least 3 events", () => {
    const report = build(
      [...many(1, () => ev("cancelled_after_kot", "Ravi", { count: 9, amountPaise: 9 * 20_000 })), ...many(3, () => ev("cancelled_after_kot", "Meera"))],
      [ev("cancelled_after_kot", "Ravi", { count: 30 }), ev("cancelled_after_kot", "Meera", { count: 45 })],
    );
    const rows = flagged(report);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ staff: "Ravi", what: "Cancelled after KOT", why: "2× usual or more", amount: 180_000,
      detail: "9 items in 2 days; usually 1 a day over the 30 days before" });
  });

  it("needs at least 3 events before anything counts as unusual", () => {
    expect(flagged(build([ev("kot_cut", "Ravi", { count: 2 })]))).toEqual([]);
  });

  it("compares with the restaurant's usual per person when someone has no history", () => {
    const report = build(many(4, () => ev("credit_note", "Sam")), [ev("credit_note", "Ravi", { count: 1 }), ev("credit_note", "Ravi"), ev("credit_note", "Ravi"), ev("pay_out", "Meera")], 1);
    expect(flagged(report)[0]).toMatchObject({ staff: "Sam", what: "Void or refund", why: "2× usual or more",
      detail: "4 times in 1 day; the restaurant's usual is 0.05 a day per person over the 30 days before" });
    const fresh = build(many(3, () => ev("stock_correction", "Sam")), [], 1);
    expect(flagged(fresh)[0]).toMatchObject({ detail: "3 times in 1 day; none in the 30 days before" });
  });

  it("totals each person's activity, flagged or not", () => {
    const report = build([
      ev("cancelled_after_kot", "Ravi", { count: 2, amountPaise: 400 }), ev("kot_cut", "Ravi", { count: 1 }),
      ev("credit_note", "Ravi", { amountPaise: 1_000 }), ev("discount", "Ravi", { amountPaise: 500, discountPercent: 5 }),
      ev("cash_short", "Meera", { amountPaise: 30_000 }), ev("pay_out", "Meera", { amountPaise: 2_000 }), ev("stock_correction", "Meera", { amountPaise: 700 }),
    ]);
    expect(byStaff(report)).toEqual({
      Meera: { staff: "Meera", cancelled: 0, kotCuts: 0, creditNotes: 0, creditPaise: 0, discounts: 0, discountPaise: 0, cashShortPaise: 30_000, payOutPaise: 2_000, stockCorrections: 1, flags: 1 },
      Ravi: { staff: "Ravi", cancelled: 2, kotCuts: 1, creditNotes: 1, creditPaise: 1_000, discounts: 1, discountPaise: 500, cashShortPaise: 0, payOutPaise: 0, stockCorrections: 0, flags: 0 },
    });
    expect(report.tables.find((t) => t.title === "By staff")!.totals).toMatchObject({ staff: "All staff", cancelled: 2, cashShortPaise: 30_000, flags: 1 });
  });

  it("explains the thresholds, and says when there was nothing", () => {
    expect(build([ev("pay_out", "Meera", { amountPaise: 100 })]).notes.join(" ")).toMatch(/2× .*at least 3/);
    expect(build([]).notes).toContain("No cancellations, KOT cuts, voids, refunds, discounts, cash differences, pay-outs or stock corrections in these dates.");
  });
});
