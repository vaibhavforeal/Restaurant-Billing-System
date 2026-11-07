import { priceForTier, type PriceTier } from "@masalapos/domain/pricing";
import type { AddonGroup, AddonPickerGroup, AddonSnapshot, Product } from "./types";

export const activeAddonGroups = <T extends { isActive?: boolean }>(groups: T[]): T[] => groups.filter((group) => group.isActive !== false);
export const addonHint = (group: { minPicks: number; maxPicks: number }) => group.minPicks === group.maxPicks ? `Choose ${group.minPicks}` : group.minPicks === 0 ? `Up to ${group.maxPicks}` : `Choose ${group.minPicks} to ${group.maxPicks}`;

/** Join the staff catalog to options before tier prices replace the base prices. */
export function pricedAddonGroups(product: Product, groups: AddonGroup[], catalog: Product[], tier: PriceTier): AddonPickerGroup[] {
  if (product.addonOnly || product.kind === "combo") return [];
  return (product.addonGroupIds ?? []).flatMap<AddonPickerGroup>((id) => {
    const group = groups.find((value) => value.id === id);
    if (!group) return [{ id, name: "Add-ons (reconnect to load)", minPicks: 1, maxPicks: 1, options: [] }];
    if (!group.isActive) return [];
    return [{ ...group, options: group.options.map((option) => {
      const item = catalog.find((value) => value.id === option.productId);
      const variant = item?.variants.find((value) => value.id === option.variantId);
      const priced = option.variantId ? variant : item;
      return { ...option, pricePaise: priced ? priceForTier(priced, tier) : 0,
        unavailable: !!option.unavailable || !item?.isActive || !!item.isSoldOut || (option.variantId ? !variant?.isActive : !!item.variants.length) };
    }) }];
  });
}

export function addonPickProblem(groups: AddonPickerGroup[], picks: string[]): string | null {
  const active = activeAddonGroups(groups);
  if (picks.length > 40) return "Choose at most 40 add-ons.";
  if (new Set(picks).size !== picks.length) return "Choose each add-on only once.";
  const options = active.flatMap((group) => group.options);
  if (picks.some((id) => !options.some((option) => option.id === id))) return "An add-on is no longer available. Choose again.";
  for (const group of active) {
    if (group.options.filter((option) => !option.unavailable).length < group.minPicks) return `${group.name}: not enough options are available.`;
    const chosen = group.options.filter((option) => picks.includes(option.id));
    if (chosen.some((option) => option.unavailable)) return `${group.name}: a chosen add-on is unavailable.`;
    if (chosen.length < group.minPicks) return `${group.name}: choose at least ${group.minPicks}.`;
    if (chosen.length > group.maxPicks) return `${group.name}: choose at most ${group.maxPicks}.`;
  }
  return null;
}
export function pickedAddons(groups: AddonPickerGroup[], picks: string[]): AddonSnapshot[] {
  const options = activeAddonGroups(groups).flatMap((group) => group.options);
  return picks.flatMap((id) => { const option = options.find((value) => value.id === id); return option ? [option] : []; });
}
export const addonTotal = (addons: AddonSnapshot[] = []) => addons.reduce((sum, option) => sum + option.pricePaise, 0);

/** Keep every priced line, including cancelled lines and children whose dish is at another station. */
export function groupAddonLines<T extends { id: string; addonOfItemId?: string | null }>(items: T[]): T[] {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string, T[]>();
  for (const item of items) if (item.addonOfItemId && ids.has(item.addonOfItemId) && item.addonOfItemId !== item.id) {
    children.set(item.addonOfItemId, [...children.get(item.addonOfItemId) ?? [], item]);
  }
  const seen = new Set<string>();
  const result: T[] = [];
  const append = (item: T) => { if (seen.has(item.id)) return; seen.add(item.id); result.push(item); children.get(item.id)?.forEach(append); };
  items.filter((item) => !item.addonOfItemId || !ids.has(item.addonOfItemId)).forEach(append);
  items.forEach(append);
  return result;
}
