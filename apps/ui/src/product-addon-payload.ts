import type { AddonGroup, Product } from "./types";

/** Add-on fields for the same product create or update request. */
export function productAddonPayload({ product, isCombo, addonOnly, addonGroupIds, groups }: {
  product: Pick<Product, "addonOnly" | "addonGroupIds"> | null;
  isCombo: boolean;
  addonOnly: boolean;
  addonGroupIds: string[];
  groups: Pick<AddonGroup, "id" | "isActive">[];
}): { addonOnly?: boolean; addonGroupIds?: string[] } {
  if (isCombo) return {};
  // The server requires attachments to be cleared in the same request.
  if (addonOnly) return { addonOnly: true, addonGroupIds: [] };
  const changed = !product || product.addonOnly === true
    || JSON.stringify(addonGroupIds) !== JSON.stringify(product.addonGroupIds ?? []);
  return {
    addonOnly: false,
    ...(changed ? { addonGroupIds: addonGroupIds.filter((id) => groups.some((group) => group.id === id && group.isActive)) } : {}),
  };
}
