import { describe, expect, it } from "vitest";
import { REFUND_REASONS, billStatusLabel, clampRefundQty, creditReason, defaultRefundRows, refundRowsError, refundableQty } from "./credit-note-form";

describe("defaultRefundRows", () => {
  it("refunds a single payment method in full", () => {
    expect(defaultRefundRows([{ mode: "upi", amountPaise: 10000 }], { cash: 0, upi: 10000, card: 0 }, 4200)).toEqual([{ mode: "upi", amountPaise: 4200 }]);
  });
  it("splits proportionally to what each method still holds, remainder to the largest", () => {
    const paid = [{ mode: "cash" as const, amountPaise: 3000 }, { mode: "card" as const, amountPaise: 7000 }];
    expect(defaultRefundRows(paid, { cash: 3000, upi: 0, card: 7000 }, 1001)).toEqual([{ mode: "cash", amountPaise: 300 }, { mode: "card", amountPaise: 701 }]);
  });
  it("uses what is still held, not what was originally paid", () => {
    const paid = [{ mode: "cash" as const, amountPaise: 5000 }, { mode: "upi" as const, amountPaise: 5000 }];
    expect(defaultRefundRows(paid, { cash: 1000, upi: 5000, card: 0 }, 3000)).toEqual([{ mode: "cash", amountPaise: 500 }, { mode: "upi", amountPaise: 2500 }]);
  });
  it("never exceeds a method's cap and omits zero rows", () => {
    const paid = [{ mode: "cash" as const, amountPaise: 100 }, { mode: "upi" as const, amountPaise: 9900 }];
    expect(defaultRefundRows(paid, { cash: 100, upi: 9900, card: 0 }, 50)).toEqual([{ mode: "upi", amountPaise: 50 }]);
    expect(defaultRefundRows(paid, { cash: 100, upi: 0, card: 0 }, 5000)).toEqual([{ mode: "cash", amountPaise: 100 }]);
  });
  it("returns no rows for a zero total or an unpaid bill", () => {
    expect(defaultRefundRows([{ mode: "cash", amountPaise: 100 }], { cash: 100, upi: 0, card: 0 }, 0)).toEqual([]);
    expect(defaultRefundRows([], { cash: 0, upi: 0, card: 0 }, 500)).toEqual([]);
  });
  it("totals always match the credit when the methods hold enough", () => {
    const paid = [{ mode: "cash" as const, amountPaise: 3333 }, { mode: "upi" as const, amountPaise: 3333 }, { mode: "card" as const, amountPaise: 3334 }];
    const rows = defaultRefundRows(paid, { cash: 3333, upi: 3333, card: 3334 }, 7777);
    expect(rows.reduce((sum, r) => sum + r.amountPaise, 0)).toBe(7777);
  });
});

describe("refundRowsError", () => {
  const held = { cash: 5000, upi: 2000, card: 0 };
  it("is null for rows that match the total within each limit", () => {
    expect(refundRowsError([{ mode: "cash", amountPaise: 1000 }, { mode: "upi", amountPaise: 500 }], 1500, held)).toBeNull();
    expect(refundRowsError([], 0, held)).toBeNull();
  });
  it("uses the server's total-mismatch message", () => {
    expect(refundRowsError([{ mode: "cash", amountPaise: 1000 }], 1500, held)).toBe("Refund amounts must equal the credit note total");
    expect(refundRowsError([], 1500, held)).toBe("Refund amounts must equal the credit note total");
  });
  it("uses the server's per-method message, summing repeated methods", () => {
    expect(refundRowsError([{ mode: "upi", amountPaise: 2500 }], 2500, held)).toBe("Refund by upi cannot exceed what was paid by upi");
    expect(refundRowsError([{ mode: "upi", amountPaise: 1500 }, { mode: "upi", amountPaise: 1000 }], 2500, held)).toBe("Refund by upi cannot exceed what was paid by upi");
    expect(refundRowsError([{ mode: "card", amountPaise: 1 }], 1, held)).toBe("Refund by card cannot exceed what was paid by card");
  });
});

describe("REFUND_REASONS", () => {
  it("lists the quick picks", () => {
    expect(REFUND_REASONS).toEqual(["Wrong item", "Quality complaint", "Long wait", "Guest changed mind", "Other"]);
  });
});

describe("refund quantities", () => {
  it("bounds a line by billed minus already refunded", () => {
    expect(refundableQty(5, undefined)).toBe(5);
    expect(refundableQty(5, 2)).toBe(3);
    expect(refundableQty(2, 2)).toBe(0);
    expect(refundableQty(2, 9)).toBe(0);
  });
  it("clamps typed quantities to whole numbers within the limit", () => {
    expect(clampRefundQty(2, 5, 2)).toBe(2);
    expect(clampRefundQty(-1, 5, 0)).toBe(0);
    expect(clampRefundQty(9, 5, 2)).toBe(3);
    expect(clampRefundQty(1.7, 5, 0)).toBe(1);
    expect(clampRefundQty(Number.NaN, 5, 0)).toBe(0);
  });
});

describe("creditReason", () => {
  it("combines a quick pick with optional detail and needs text for Other", () => {
    expect(creditReason("Wrong item", "")).toBe("Wrong item");
    expect(creditReason("Long wait", " 40 min ")).toBe("Long wait: 40 min");
    expect(creditReason("Other", "Spilled")).toBe("Spilled");
    expect(creditReason("Other", "  ")).toBe("");
    expect(creditReason("", "Custom")).toBe("Custom");
    expect(creditReason("", "")).toBe("");
  });
});

describe("billStatusLabel", () => {
  it("shows the bill status or the refund state", () => {
    expect(billStatusLabel({ status: "unpaid", refundState: "none" })).toBe("Unpaid");
    expect(billStatusLabel({ status: "paid", refundState: "none" })).toBe("Paid");
    expect(billStatusLabel({ status: "paid", refundState: "partly_refunded" })).toBe("Partly refunded");
    expect(billStatusLabel({ status: "paid", refundState: "refunded" })).toBe("Refunded");
    expect(billStatusLabel({ status: "void", refundState: "refunded" })).toBe("VOID");
  });
});
