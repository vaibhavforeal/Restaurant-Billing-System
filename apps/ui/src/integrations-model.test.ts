import { describe, expect, it } from "vitest";
import type { IntegrationInfo } from "@forkflow/domain/integrations";
import { canToggle, isEnabled, nextList, statusLabel } from "./integrations-model";

const zomato: IntegrationInfo = { id: "zomato", name: "Zomato", description: "", category: "delivery", status: "available", setupPage: "zomato", enabled: true, updatedAt: 1 };
const swiggy: IntegrationInfo = { id: "swiggy", name: "Swiggy", description: "", category: "delivery", status: "coming_soon", setupPage: null, enabled: false, updatedAt: null };

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

  it("nextList fails closed before the first load but keeps the last list after a failed refetch", () => {
    expect(nextList([], null, false)).toEqual([]);
    expect(nextList([zomato], null, false)).toEqual([]);
    expect(nextList([zomato], null, true)).toEqual([zomato]);
    expect(nextList([zomato], [{ ...zomato, enabled: false }], true)).toEqual([{ ...zomato, enabled: false }]);
    expect(nextList([zomato], [], true)).toEqual([]);
  });
});
