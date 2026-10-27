import { describe, expect, it } from "vitest";
import { addMonths, bestSlabPercent, CustomerCreate, CustomerUpdate, daysUntilOccasion, normalizePhone, percentOf, pointsEarned, tierFor } from "./customers.js";

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

  it("multiplies earned points by the tier and picks the highest tier reached", () => {
    expect(pointsEarned(25_000, 2, 1.5)).toBe(6);
    expect(pointsEarned(25_000, 1, 1.25)).toBe(2);
    const tiers = [
      { id: "s", name: "Silver", minSpendPaise: 0, earnMultiplier: 1, isActive: true },
      { id: "g", name: "Gold", minSpendPaise: 1_000_000, earnMultiplier: 1.5, isActive: true },
      { id: "p", name: "Platinum", minSpendPaise: 5_000_000, earnMultiplier: 2, isActive: false },
    ];
    expect(tierFor(tiers, 999_999)?.name).toBe("Silver");
    expect(tierFor(tiers, 9_000_000)?.name).toBe("Gold");
    expect(tierFor([], 9_000_000)).toBeNull();
  });

  it("checks profile fields and de-duplicates tags", () => {
    expect(CustomerCreate.parse({ name: "Priya", phone: "9876543210", birthDate: "--02-29", email: " Priya@Example.com ", tags: ["Vegan", "vegan ", "VIP"] }))
      .toMatchObject({ birthDate: "--02-29", email: "priya@example.com", tags: ["Vegan", "VIP"], marketingOptIn: false });
    expect(CustomerUpdate.parse({ birthDate: "", email: "" })).toEqual({ birthDate: null, email: null });
    for (const bad of ["1990-02-30", "--13-01", "14/03/1990"]) expect(() => CustomerCreate.parse({ name: "P", phone: "9876543210", birthDate: bad })).toThrow(/1990-03-14/);
    expect(() => CustomerCreate.parse({ name: "P", phone: "9876543210", email: "nope" })).toThrow(/email/);
  });

  it("counts days to the next birthday and adds calendar months", () => {
    expect(daysUntilOccasion("1990-10-27", "2026-10-27")).toBe(0);
    expect(daysUntilOccasion("--10-30", "2026-10-27")).toBe(3);
    expect(daysUntilOccasion("--10-26", "2026-10-27")).toBe(364);
    expect(daysUntilOccasion("--02-29", "2026-02-27")).toBe(2);
    const jan31 = new Date(2026, 0, 31, 12).getTime();
    expect(new Date(addMonths(jan31, 1)).getDate()).toBe(28);
    expect(new Date(addMonths(jan31, 12)).getFullYear()).toBe(2027);
  });
});
