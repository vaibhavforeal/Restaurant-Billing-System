import { describe, expect, it } from "vitest";
import { activeAddonGroups, addonHint, addonPickProblem, addonTotal, groupAddonLines, pickedAddons, pricedAddonGroups } from "./addon-cart";
import type { AddonGroup, AddonPickerGroup, Product } from "./types";
const group: AddonPickerGroup = { id: "g", name: "Toppings", minPicks: 1, maxPicks: 2, options: [
  { id: "a", productId: "cheese", variantId: null, name: "Cheese", pricePaise: 3000 },
  { id: "b", productId: "olive", variantId: null, name: "Olives", pricePaise: 2000 },
  { id: "c", productId: "corn", variantId: null, name: "Corn", pricePaise: 1000, unavailable: true },
] };
describe("add-on choices", () => {
  it("enforces minimum and maximum", () => {
    expect(addonPickProblem([group], [])).toContain("at least 1");
    expect(addonPickProblem([group], ["a", "b"])).toBeNull();
    expect(addonPickProblem([{ ...group, maxPicks: 1 }], ["a", "b"])).toContain("at most 1");
  });
  it("rejects duplicate, foreign, unavailable, and excessive picks", () => {
    expect(addonPickProblem([group], ["a", "a"])).toContain("once");
    expect(addonPickProblem([group], ["other"])).toContain("no longer available");
    expect(addonPickProblem([group], ["c"])).toContain("unavailable");
    expect(addonPickProblem([group], Array.from({ length: 41 }, (_, i) => String(i)))).toContain("40");
  });
  it("blocks an unfillable required group", () => {
    expect(addonPickProblem([{ ...group, minPicks: 3, maxPicks: 3 }], [])).toContain("not enough");
  });
  it("skips archived groups and their minimums", () => {
    const archived = { ...group, isActive: false };
    expect(activeAddonGroups([archived])).toEqual([]);
    expect(addonPickProblem([archived], [])).toBeNull();
    expect(addonPickProblem([archived], ["a"])).not.toBeNull();
  });
  it("allows an empty optional group and describes limits", () => {
    expect(addonPickProblem([{ ...group, minPicks: 0 }], [])).toBeNull();
    expect(addonHint({ minPicks: 1, maxPicks: 1 })).toBe("Choose 1");
    expect(addonHint({ minPicks: 0, maxPicks: 3 })).toBe("Up to 3");
    expect(addonHint(group)).toBe("Choose 1 to 2");
  });
  it("keeps pick order and prices each add-on separately", () => {
    const chosen = pickedAddons([group], ["b", "a"]);
    expect(chosen.map((option) => option.name)).toEqual(["Olives", "Cheese"]);
    expect(addonTotal(chosen)).toBe(5000);
  });
});
describe("add-on line grouping", () => {
  it("keeps children immediately under their dish in source order", () => {
    const rows = [{ id: "b", addonOfItemId: "dish" }, { id: "other" }, { id: "dish" }, { id: "a", addonOfItemId: "dish" }];
    expect(groupAddonLines(rows).map((row) => row.id)).toEqual(["other", "dish", "b", "a"]);
    expect(rows[0]!.id).toBe("b");
  });
  it("retains cancelled children and lines at a different station", () => {
    const rows = [{ id: "a", addonOfItemId: "missing", status: "sent" }, { id: "dish", status: "cancelled" }, { id: "b", addonOfItemId: "dish", status: "cancelled" }];
    expect(groupAddonLines(rows)).toEqual(rows);
  });
});
describe("staff option pricing", () => {
  const product = { id: "dish", kind: "item", addonGroupIds: ["g"] } as Product;
  const catalog = [{ id: "cheese", isActive: true, isSoldOut: false, pricePaise: 3000, acPricePaise: 4000, variants: [{ id: "large", isActive: true, pricePaise: 5000, takeawayPricePaise: 6000 }] }] as Product[];
  const groups = [{ ...group, isActive: true, productIds: ["dish"], options: [{ ...group.options[0]!, variantId: "large" }] }] as AddonGroup[];
  it("uses the selected variant's tier and fallback prices", () => {
    expect(pricedAddonGroups(product, groups, catalog, "takeaway")[0]?.options[0]?.pricePaise).toBe(6000);
    expect(pricedAddonGroups(product, groups, catalog, "ac")[0]?.options[0]?.pricePaise).toBe(5000);
  });
  it("marks missing or inactive variants and sold-out products unavailable", () => {
    expect(pricedAddonGroups(product, groups, [], "non_ac")[0]?.options[0]?.unavailable).toBe(true);
    expect(pricedAddonGroups(product, groups, [{ ...catalog[0]!, isSoldOut: true }], "non_ac")[0]?.options[0]?.unavailable).toBe(true);
    expect(pricedAddonGroups(product, groups, [{ ...catalog[0]!, variants: [] }], "non_ac")[0]?.options[0]?.unavailable).toBe(true);
  });
  it("requires a connection when attached group details are missing from an older cache", () => {
    const missing = pricedAddonGroups(product, [], catalog, "non_ac");
    expect(addonPickProblem(missing, [])).toContain("reconnect");
  });
  it("skips archived groups, combos, and add-on-only products", () => {
    expect(pricedAddonGroups(product, [{ ...groups[0]!, isActive: false }], catalog, "non_ac")).toEqual([]);
    expect(pricedAddonGroups({ ...product, addonOnly: true }, groups, catalog, "non_ac")).toEqual([]);
    expect(pricedAddonGroups({ ...product, kind: "combo" }, groups, catalog, "non_ac")).toEqual([]);
  });
});
