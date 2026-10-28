import { describe, expect, it } from "vitest";
import { STAFF_TABS, staffTabVisible } from "./integrations-model";
import { userCan } from "./permissions";
import { overridesFor } from "./screens/StaffPermissions";

describe("permissions in the UI", () => {
  it("answers from the person's resolved permissions and fails closed without them", () => {
    expect(userCan({ permissions: ["catalog.manage"] }, "catalog.manage")).toBe(true);
    expect(userCan({ permissions: ["catalog.manage"] }, "users.manage")).toBe(false);
    expect(userCan(null, "orders.read")).toBe(false);
  });

  it("opens each sidebar tab with its permission; Home is always there", () => {
    const cashierPlusCatalog = new Set(["tables.read", "reports.read", "customers.read", "stock.read", "kots.read", "integrations.read", "catalog.manage"]);
    expect(STAFF_TABS.filter((t) => staffTabVisible(t, (s) => cashierPlusCatalog.has(s))))
      .toEqual(["home", "tables", "reports", "customers", "inventory", "kitchen", "catalog", "marketplace"]);
    expect(STAFF_TABS.filter((t) => staffTabVisible(t, () => false))).toEqual(["home"]);
  });

  it("saves only the permissions that differ from the role", () => {
    const defaults = { "catalog.manage": false, "bills.refund": true, "bills.settle": true };
    expect(overridesFor(defaults, { "catalog.manage": true, "bills.refund": false, "bills.settle": true })).toEqual({ "catalog.manage": true, "bills.refund": false });
    expect(overridesFor(defaults, { "catalog.manage": false, "bills.refund": true, "bills.settle": true })).toEqual({});
  });
});
