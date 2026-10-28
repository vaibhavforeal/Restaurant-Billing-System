import { describe, expect, it } from "vitest";
import { MODULES, MODULE_IDS, ModuleMapSchema, allModules, planModules, resolveModuleStates, resolveModules } from "./modules.js";
import { PLANS, featuresFromModules } from "./licensing.js";

describe("modules", () => {
  it("lists every module once, with dependencies that exist", () => {
    expect(MODULES.map((m) => m.id)).toEqual([...MODULE_IDS]);
    for (const m of MODULES) for (const dep of m.dependsOn) expect(MODULE_IDS).toContain(dep);
  });

  it("follows the plan and applies the owner's choices", () => {
    expect(planModules("basic")).toMatchObject({ kds: false, recipes: false, qrOrdering: false, crm: true, reservations: true });
    expect(Object.values(planModules("pro")).every(Boolean)).toBe(true);
    expect(resolveModules("basic", { kds: true, reservations: false })).toMatchObject({ kds: true, reservations: false, crm: true });
    // The old plan flags still agree with the plans.
    expect(featuresFromModules(planModules("basic"))).toEqual(PLANS.basic.features);
    expect(featuresFromModules(planModules("pro"))).toEqual(PLANS.pro.features);
  });

  it("is active only when allowed, switched on and its dependencies are active", () => {
    const allowed = resolveModules("pro", { inventory: false });
    const states = resolveModuleStates(allowed, (id) => id !== "takeaway");
    const by = (id: string) => states.find((s) => s.id === id)!;
    expect(by("inventory")).toMatchObject({ allowed: false, active: false, reason: "Not included for this restaurant" });
    expect(by("recipes")).toMatchObject({ allowed: true, enabled: true, active: false, reason: "Needs Inventory" });
    expect(by("costing")).toMatchObject({ active: false, reason: "Needs Recipes" });
    expect(by("takeaway")).toMatchObject({ allowed: true, enabled: false, active: false, reason: "Turned off" });
    expect(by("kds")).toMatchObject({ active: true, reason: null });
  });

  it("requires a complete module map in the licence", () => {
    expect(ModuleMapSchema.parse(allModules())).toEqual(allModules());
    const { crm: _missing, ...partial } = allModules();
    expect(() => ModuleMapSchema.parse(partial)).toThrow();
    expect(() => ModuleMapSchema.parse({ ...allModules(), payroll: true })).toThrow();
  });
});
