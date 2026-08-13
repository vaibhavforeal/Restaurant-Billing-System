import { expect, test } from "vitest";
import { can, withinDiscountCap, type Role } from "./rbac.js";

const cashier: Role = {
  name: "Cashier",
  permissions: ["order.create", "bill.settle", "discount.apply"],
  limits: { max_discount_percent: 10 },
};
const manager: Role = { name: "Manager", permissions: ["bill.*", "order.*", "discount.apply"] };
const owner: Role = { name: "Owner", permissions: ["*"] };

test("a role is granted only what it holds", () => {
  expect(can(cashier, "bill.settle")).toBe(true);
  expect(can(cashier, "bill.void")).toBe(false);
});

test("a namespace wildcard grants everything beneath it, but not other namespaces", () => {
  expect(can(manager, "bill.void")).toBe(true);
  expect(can(manager, "bill.reprint")).toBe(true);
  expect(can(manager, "settings.update")).toBe(false);
});

test("the owner wildcard grants everything", () => {
  expect(can(owner, "settings.update")).toBe(true);
  expect(can(owner, "bill.void")).toBe(true);
});

test("an unknown permission is denied, never assumed", () => {
  expect(can(cashier, "")).toBe(false);
  expect(can({ name: "New", permissions: [] }, "order.create")).toBe(false);
});

test("a discount beyond the role's cap is refused", () => {
  expect(withinDiscountCap(cashier, 10)).toBe(true);
  expect(withinDiscountCap(cashier, 10.5)).toBe(false);
});

test("a role with no cap set may not discount at all", () => {
  // Absent configuration must fail closed — an unset cap is not an open one.
  expect(withinDiscountCap(manager, 5)).toBe(false);
  expect(withinDiscountCap(owner, 100)).toBe(true); // except the full wildcard
});
