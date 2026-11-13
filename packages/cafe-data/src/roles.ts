import { can, withinDiscountCap, type Role } from "@masalapos/core/rbac";

export type CafeRole = "owner" | "manager" | "cashier";
export const CAFE_ROLES: readonly CafeRole[] = ["owner", "manager", "cashier"];
export type CafePermission = "bills.create" | "bills.print" | "bills.discount" | "bills.refund" | "customers.manage"
  | "reports.read" | "catalog.manage" | "printers.manage" | "staff.manage" | "settings.manage";

/** The three fixed roles, exactly as the Phase 2 spec's table. The owner holds everything. */
const PERMISSIONS: Record<CafeRole, string[]> = {
  owner: ["*"],
  manager: ["bills.create", "bills.print", "bills.discount", "bills.refund", "customers.manage", "reports.read",
    "catalog.manage", "printers.manage"],
  cashier: ["bills.create", "bills.print", "customers.manage"],
};

function role(name: CafeRole, cashierDiscountBp = 0): Role {
  return { name, permissions: PERMISSIONS[name], limits: { max_discount_percent: cashierDiscountBp / 100 } };
}

export function cafeCan(r: CafeRole, permission: CafePermission): boolean {
  return can(role(r), permission);
}

/** May this role give this discount without approval? Roles with `bills.discount` may give any; others up to the cafe's limit. */
export function discountAllowed(r: CafeRole, discountPaise: number, subtotalPaise: number, cashierDiscountBp: number): boolean {
  if (discountPaise <= 0 || cafeCan(r, "bills.discount")) return true;
  if (subtotalPaise <= 0) return false;
  return withinDiscountCap(role(r, cashierDiscountBp), (discountPaise * 100) / subtotalPaise);
}
