import { can, type Role } from "@masalapos/core/rbac";

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

function role(name: CafeRole): Role {
  return { name, permissions: PERMISSIONS[name] };
}

export function cafeCan(r: CafeRole, permission: CafePermission): boolean {
  return can(role(r), permission);
}

/**
 * May this role give this discount without approval? Roles with `bills.discount` may give any; others up to the cafe's
 * limit. The limit is compared in paise, rounded half up exactly as the cart rounds a percent discount, so a cashier
 * giving exactly their limit on an odd price (5% of ₹33.33 is 167 paise) is never asked for a PIN.
 */
export function discountAllowed(r: CafeRole, discountPaise: number, subtotalPaise: number, cashierDiscountBp: number): boolean {
  if (discountPaise <= 0 || cafeCan(r, "bills.discount")) return true;
  if (subtotalPaise <= 0) return false;
  return discountPaise <= Math.floor((subtotalPaise * cashierDiscountBp + 5000) / 10000);
}
