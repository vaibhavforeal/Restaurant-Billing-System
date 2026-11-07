import { describe, expect, it } from "vitest";
import { AddonGroupCreate, AddonGroupUpdate, AddonPickError, addonsAvailable, resolveAddonPicks, type AddonGroup } from "./addons.js";

const groups = (overrides: { panUnavailable?: boolean; baseArchived?: boolean; thinUnavailable?: boolean } = {}): AddonGroup[] => [
  { id: "toppings", name: "Toppings", minPicks: 0, maxPicks: 2, isActive: true, options: [
    { id: "cheese", productId: "p-cheese", variantId: null, name: "Cheese" },
    { id: "olives", productId: "p-olives", variantId: null, name: "Olives" },
    { id: "jal", productId: "p-jal", variantId: null, name: "Jalapeño" },
  ] },
  { id: "base", name: "Base", minPicks: 1, maxPicks: 1, isActive: !overrides.baseArchived, options: [
    { id: "thin", productId: "p-thin", variantId: null, name: "Thin", ...(overrides.thinUnavailable ? { unavailable: true } : {}) },
    { id: "pan", productId: "p-pan", variantId: null, name: "Pan", ...(overrides.panUnavailable ? { unavailable: true } : {}) },
  ] },
];

const pickError = (fn: () => unknown) => {
  try { fn(); } catch (err) { expect(err).toBeInstanceOf(AddonPickError); return (err as Error).message; }
  throw new Error("expected an AddonPickError");
};

describe("resolveAddonPicks", () => {
  it("returns the picked add-ons in group order with their group names", () => {
    const chosen = resolveAddonPicks(groups(), ["thin", "cheese"]);
    expect(chosen.map((c) => [c.name, c.groupName])).toEqual([["Cheese", "Toppings"], ["Thin", "Base"]]);
  });

  it("enforces each group's minimum and maximum", () => {
    expect(pickError(() => resolveAddonPicks(groups(), []))).toBe("Choose 1 from Base");
    expect(pickError(() => resolveAddonPicks(groups(), ["cheese", "olives", "jal", "thin"]))).toBe("Choose at most 2 from Toppings");
    const atLeast = [{ ...groups()[0]!, minPicks: 1 }];
    expect(pickError(() => resolveAddonPicks(atLeast, []))).toBe("Choose at least 1 from Toppings");
  });

  it("refuses repeated, unknown and unavailable picks", () => {
    expect(pickError(() => resolveAddonPicks(groups(), ["thin", "thin"]))).toBe("An add-on was picked twice");
    expect(pickError(() => resolveAddonPicks(groups(), ["nope", "thin"]))).toBe("The add-ons changed. Choose them again.");
    expect(pickError(() => resolveAddonPicks(groups({ panUnavailable: true }), ["pan"]))).toBe("Pan is not available");
  });

  it("skips an archived group: no minimum, and its options cannot be picked", () => {
    expect(resolveAddonPicks(groups({ baseArchived: true }), [])).toEqual([]);
    expect(pickError(() => resolveAddonPicks(groups({ baseArchived: true }), ["thin"]))).toBe("The add-ons changed. Choose them again.");
  });

  it("allows no picks when a dish has no groups", () => {
    expect(resolveAddonPicks([], [])).toEqual([]);
    expect(pickError(() => resolveAddonPicks([], ["cheese"]))).toBe("The add-ons changed. Choose them again.");
  });
});

describe("addonsAvailable", () => {
  it("is false when a required group cannot be filled, ignoring archived groups", () => {
    expect(addonsAvailable(groups())).toBe(true);
    expect(addonsAvailable(groups({ thinUnavailable: true, panUnavailable: true }))).toBe(false);
    expect(addonsAvailable(groups({ thinUnavailable: true, panUnavailable: true, baseArchived: true }))).toBe(true);
  });
});

describe("AddonGroupCreate / AddonGroupUpdate", () => {
  const two = [{ productId: "a" }, { productId: "b" }];
  it("accepts a valid group and defaults variantId to null", () => {
    const parsed = AddonGroupCreate.parse({ name: " Toppings ", minPicks: 0, maxPicks: 2, options: two });
    expect(parsed.name).toBe("Toppings");
    expect(parsed.options[0]).toEqual({ productId: "a", variantId: null });
  });

  it("rejects bounds that cannot work and duplicate items", () => {
    const inverted = AddonGroupCreate.safeParse({ name: "T", minPicks: 3, maxPicks: 2, options: two });
    expect(inverted.success).toBe(false);
    expect(inverted.error!.issues.some((i) => i.path[0] === "minPicks")).toBe(true);
    const tooMany = AddonGroupCreate.safeParse({ name: "T", minPicks: 2, maxPicks: 2, options: [{ productId: "a" }] });
    expect(tooMany.success).toBe(false);
    const dup = AddonGroupCreate.safeParse({ name: "T", minPicks: 0, maxPicks: 1, options: [{ productId: "a" }, { productId: "a", variantId: null }] });
    expect(dup.error!.issues.map((i) => i.message)).toContain("T: an item is listed twice");
  });

  it("checks an update only for the fields it sends", () => {
    expect(AddonGroupUpdate.safeParse({ isActive: false }).success).toBe(true);
    expect(AddonGroupUpdate.safeParse({ minPicks: 3, maxPicks: 2 }).success).toBe(false);
  });
});
