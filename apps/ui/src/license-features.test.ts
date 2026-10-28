import { describe, expect, it } from "vitest";
import { allModules, planModules } from "@forkflow/domain/modules";
import { moduleSummary } from "./license-features";

describe("moduleSummary", () => {
  it("names the modules a licence includes and leaves out", () => {
    expect(moduleSummary(allModules())).toBe("Included: Takeaway, Reservations, QR guest ordering, Guest assistance, Inventory, Recipes, Dish costing, Reports & analytics, Sales dashboard, Zomato, Kitchen Display (KDS), CRM & Loyalty.");
    expect(moduleSummary(planModules("basic"))).toBe("Included: Takeaway, Reservations, Inventory, Reports & analytics, Sales dashboard, Zomato, CRM & Loyalty. Not included: QR guest ordering, Guest assistance, Recipes, Dish costing, Kitchen Display (KDS).");
  });
});
