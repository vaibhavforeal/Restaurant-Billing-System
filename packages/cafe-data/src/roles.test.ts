import { describe, expect, it } from "vitest";
import { cafeCan, discountAllowed, type CafePermission, type CafeRole } from "./roles.js";

// The spec's role table: [permission, owner, manager, cashier].
const SPEC: Array<[CafePermission, boolean, boolean, boolean]> = [
  ["bills.create", true, true, true],
  ["bills.print", true, true, true],
  ["bills.discount", true, true, false],
  ["bills.refund", true, true, false],
  ["customers.manage", true, true, true],
  ["reports.read", true, true, false],
  ["catalog.manage", true, true, false],
  ["printers.manage", true, true, false],
  ["staff.manage", true, false, false],
  ["settings.manage", true, false, false],
];
const TABLE: Array<[CafeRole, CafePermission, boolean]> = SPEC.flatMap(([p, o, m, c]) => [
  ["owner", p, o], ["manager", p, m], ["cashier", p, c],
] as Array<[CafeRole, CafePermission, boolean]>);

describe("cafe roles", () => {
  it.each(TABLE)("%s %s %s", (role, permission, allowed) => {
    expect(cafeCan(role, permission)).toBe(allowed);
  });
  it("lets a cashier give a discount up to the cafe's limit and not above it", () => {
    expect(discountAllowed("cashier", 500, 10000, 500)).toBe(true);
    expect(discountAllowed("cashier", 501, 10000, 500)).toBe(false);
    expect(discountAllowed("cashier", 0, 10000, 0)).toBe(true);
    expect(discountAllowed("cashier", 1, 10000, 0)).toBe(false);
  });
  it("lets a manager and an owner give any discount", () => {
    expect(discountAllowed("manager", 10000, 10000, 0)).toBe(true);
    expect(discountAllowed("owner", 10000, 10000, 0)).toBe(true);
  });
});

describe("discount limit rounding", () => {
  it("lets a cashier give exactly their limit as the cart rounds it", () => {
    // 5% of ₹33.33 rounds half up to 167 paise in the cart, which is 5.01% as a float.
    expect(discountAllowed("cashier", 167, 3333, 500)).toBe(true);
    expect(discountAllowed("cashier", 168, 3333, 500)).toBe(false);
    expect(discountAllowed("cashier", 28, 1100, 250)).toBe(true);
  });
});
