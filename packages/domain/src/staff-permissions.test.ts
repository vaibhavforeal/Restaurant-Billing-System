import { describe, expect, it } from "vitest";
import { GRANTABLE_PERMISSIONS, PermissionOverridesSchema, effectivePermissions, normaliseOverrides, roleDefaults, staffCan } from "./staff-permissions.js";

describe("staff permissions", () => {
  it("starts from the role and applies one person's changes", () => {
    expect(staffCan("cashier", {}, "catalog.manage")).toBe(false);
    expect(staffCan("cashier", { "catalog.manage": true }, "catalog.manage")).toBe(true);
    expect(staffCan("cashier", {}, "bills.refund")).toBe(true);
    expect(staffCan("cashier", { "bills.refund": false }, "bills.refund")).toBe(false);
    // A role wildcard still covers what nobody changed.
    expect(staffCan("cashier", { "bills.refund": false }, "bills.settle")).toBe(true);
  });

  it("never restricts an admin and keeps staff and settings admin-only", () => {
    expect(staffCan("admin", { "bills.refund": false }, "bills.refund")).toBe(true);
    expect(staffCan("cashier", { "users.manage": true }, "users.manage")).toBe(false);
    expect(staffCan("cashier", {}, "settings.manage")).toBe(false);
    expect(effectivePermissions("admin", {})).toContain("users.manage");
    expect(GRANTABLE_PERMISSIONS).not.toContain("users.manage");
  });

  it("accepts only grantable permissions and stores only real differences", () => {
    expect(() => PermissionOverridesSchema.parse({ "users.manage": true })).toThrow();
    expect(PermissionOverridesSchema.parse({ "catalog.manage": true })).toEqual({ "catalog.manage": true });
    expect(normaliseOverrides("cashier", { "catalog.manage": true, "bills.settle": true, "bills.refund": false })).toEqual({ "catalog.manage": true, "bills.refund": false });
    expect(roleDefaults("waiter")).toMatchObject({ "orders.create": true, "bills.settle": false });
    expect(effectivePermissions("waiter", { "bills.settle": true })).toContain("bills.settle");
  });
});
