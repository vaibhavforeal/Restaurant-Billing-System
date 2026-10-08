import { describe, expect, it } from "vitest";
import type { IntegrationInfo } from "@forkflow/domain/integrations";
import { canToggle, isEnabled, navTabVisible, nextList, statusLabel } from "./integrations-model";

const zomato: IntegrationInfo = { id: "zomato", name: "Zomato", description: "", category: "delivery", status: "available", setupPage: "zomato", enabled: true, licensed: true, updatedAt: 1 };
const swiggy: IntegrationInfo = { id: "swiggy", name: "Swiggy", description: "", category: "delivery", status: "coming_soon", setupPage: null, enabled: false, licensed: true, updatedAt: null };
const kds: IntegrationInfo = { id: "kds", name: "Kitchen Display (KDS)", description: "", category: "kitchen", status: "available", setupPage: null, feature: "kds", enabled: false, licensed: true, updatedAt: null };

describe("integrations model", () => {
  it("isEnabled is true only for an enabled entry", () => {
    expect(isEnabled([zomato, swiggy], "zomato")).toBe(true);
    expect(isEnabled([{ ...zomato, enabled: false }, swiggy], "zomato")).toBe(false);
    expect(isEnabled([zomato], "swiggy")).toBe(false);
    expect(isEnabled([], "zomato")).toBe(false);
  });

  it("statusLabel reports coming soon regardless of the stored flag", () => {
    expect(statusLabel(swiggy)).toBe("Coming soon");
    expect(statusLabel({ ...swiggy, enabled: true })).toBe("Coming soon");
    expect(statusLabel(zomato)).toBe("Enabled");
    expect(statusLabel({ ...zomato, enabled: false })).toBe("Disabled");
  });

  it("canToggle needs an admin and an available integration", () => {
    expect(canToggle(zomato, "admin")).toBe(true);
    expect(canToggle(zomato, "cashier")).toBe(false);
    expect(canToggle(zomato, "waiter")).toBe(false);
    expect(canToggle(swiggy, "admin")).toBe(false);
  });

  it("treats an unlicensed integration as off and labels it with the plan it needs", () => {
    expect(isEnabled([{ ...kds, enabled: true, licensed: false }], "kds")).toBe(false);
    expect(isEnabled([{ ...kds, enabled: true }], "kds")).toBe(true);
    expect(statusLabel({ ...kds, licensed: false })).toBe("Pro plan");
    expect(statusLabel({ ...kds, enabled: true, licensed: false })).toBe("Pro plan");
  });

  it("lets an admin turn an unlicensed integration off but never on", () => {
    expect(canToggle({ ...kds, licensed: false }, "admin")).toBe(false);
    expect(canToggle({ ...kds, enabled: true, licensed: false }, "admin")).toBe(true);
    expect(canToggle({ ...kds, enabled: true, licensed: false }, "cashier")).toBe(false);
    expect(canToggle(kds, "admin")).toBe(true);
  });

  it("navTabVisible gates Zomato and Kitchen tabs but never the kitchen role's own tab", () => {
    expect(navTabVisible("kitchen", "admin", () => false)).toBe(false);
    expect(navTabVisible("kitchen", "kitchen", () => false)).toBe(true);
    expect(navTabVisible("kitchen", "cashier", (id) => id === "kds")).toBe(true);
    expect(navTabVisible("zomato", "admin", () => false)).toBe(false);
    expect(navTabVisible("zomato", "admin", (id) => id === "zomato")).toBe(true);
    expect(navTabVisible("tables", "admin", () => false)).toBe(true);
  });

  it("nextList fails closed before the first load but keeps the last list after a failed refetch", () => {
    expect(nextList([], null, false)).toEqual([]);
    expect(nextList([zomato], null, false)).toEqual([]);
    expect(nextList([zomato], null, true)).toEqual([zomato]);
    expect(nextList([zomato], [{ ...zomato, enabled: false }], true)).toEqual([{ ...zomato, enabled: false }]);
    expect(nextList([zomato], [], true)).toEqual([]);
  });
});
