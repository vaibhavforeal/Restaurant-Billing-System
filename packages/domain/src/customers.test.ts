import { describe, expect, it } from "vitest";
import { bestSlabPercent, CustomerCreate, normalizePhone, percentOf, pointsEarned } from "./customers.js";

describe("customers", () => {
  it("normalises Indian mobile numbers", () => {
    for (const input of ["9876543210", "+91 98765 43210", "919876543210", "09876543210", "98765-43210"]) expect(normalizePhone(input)).toBe("9876543210");
    for (const input of ["12345", "5876543210", "+1 9876543210", "98765432101"]) expect(normalizePhone(input)).toBeNull();
    expect(CustomerCreate.parse({ name: " Priya ", phone: "+91 98765 43210" })).toMatchObject({ name: "Priya", phone: "9876543210", typeId: null });
    expect(() => CustomerCreate.parse({ name: "Priya", phone: "123" })).toThrow(/10-digit/);
  });

  it("picks the best slab the bill qualifies for on the day", () => {
    const slabs = [
      { minBillPaise: 0, percent: 5, validFrom: null, validTo: null },
      { minBillPaise: 100_000, percent: 10, validFrom: null, validTo: null },
      { minBillPaise: 0, percent: 20, validFrom: "2026-12-24", validTo: "2026-12-26" },
    ];
    expect(bestSlabPercent(slabs, 50_000, "2026-10-25")).toBe(5);
    expect(bestSlabPercent(slabs, 100_000, "2026-10-25")).toBe(10);
    expect(bestSlabPercent(slabs, 50_000, "2026-12-25")).toBe(20);
    expect(bestSlabPercent(slabs, 50_000, "2026-12-27")).toBe(5);
    expect(bestSlabPercent([], 50_000, "2026-10-25")).toBe(0);
  });

  it("rounds discounts down and earns points per full ₹100", () => {
    expect(percentOf(33_333, 10)).toBe(3_333);
    expect(percentOf(10_000, 2.5)).toBe(250);
    expect(pointsEarned(19_999, 1)).toBe(1);
    expect(pointsEarned(20_000, 3)).toBe(6);
    expect(pointsEarned(9_999, 5)).toBe(0);
  });
});
