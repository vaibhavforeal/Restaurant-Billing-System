import { z } from "zod";

/**
 * Item add-ons: products picked under a dish ("Extra cheese" on a pizza), each billed as its own line at its own price
 * and GST rate. Admins put add-ons into groups with a minimum and maximum pick and attach a group to any number of
 * dishes. An archived group is skipped when taking orders: its options cannot be picked and its minimum does not apply.
 */

const ADDON_MAX_OPTIONS = 40;

export const AddonOptionInput = z.object({
  /** An existing option's id keeps it, so a cart picked before an edit still matches. */
  id: z.string().min(1).optional(),
  productId: z.string().min(1),
  variantId: z.string().min(1).nullable().default(null),
});
export type AddonOptionInputValue = z.infer<typeof AddonOptionInput>;

const groupFields = {
  name: z.string().trim().min(1).max(60),
  minPicks: z.number().int().min(0).max(ADDON_MAX_OPTIONS),
  maxPicks: z.number().int().min(1).max(ADDON_MAX_OPTIONS),
  options: z.array(AddonOptionInput).min(1, "Add at least one add-on to the group").max(ADDON_MAX_OPTIONS),
};

type GroupCheck = { name?: string | undefined; minPicks?: number | undefined; maxPicks?: number | undefined; options?: AddonOptionInputValue[] | undefined };

/** The checks that need more than one field; each runs only when the fields it compares are present. */
function checkGroup(group: GroupCheck, ctx: z.RefinementCtx): void {
  const label = group.name ?? "This group";
  if (group.minPicks !== undefined && group.maxPicks !== undefined && group.minPicks > group.maxPicks) {
    ctx.addIssue({ code: "custom", path: ["minPicks"], message: `${label}: the minimum is more than the maximum` });
  }
  if (group.options && group.minPicks !== undefined && group.minPicks > group.options.length) {
    ctx.addIssue({ code: "custom", path: ["minPicks"], message: `${label}: the minimum is more than its ${group.options.length} add-ons` });
  }
  if (group.options) {
    const seen = new Set<string>();
    for (const option of group.options) {
      const key = `${option.productId}/${option.variantId ?? ""}`;
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["options"], message: `${label}: an item is listed twice` });
      seen.add(key);
    }
  }
}

export const AddonGroupCreate = z.object(groupFields).superRefine(checkGroup);
export type AddonGroupCreateValue = z.infer<typeof AddonGroupCreate>;

export const AddonGroupUpdate = z.object({
  name: groupFields.name.optional(),
  minPicks: groupFields.minPicks.optional(),
  maxPicks: groupFields.maxPicks.optional(),
  options: groupFields.options.optional(),
  isActive: z.boolean().optional(),
}).superRefine(checkGroup);
export type AddonGroupUpdateValue = z.infer<typeof AddonGroupUpdate>;

/** The add-on option ids chosen for one dish. */
export const AddonPicks = z.array(z.string().min(1)).max(ADDON_MAX_OPTIONS);

export interface AddonOption {
  id: string;
  productId: string;
  variantId: string | null;
  /** The add-on's name, with its portion: "Coke (Large)". */
  name: string;
  /** The product is sold out or switched off, or the variant is switched off, so it cannot be picked now. */
  unavailable?: boolean;
}

export interface AddonGroup {
  id: string;
  name: string;
  minPicks: number;
  maxPicks: number;
  isActive: boolean;
  options: AddonOption[];
}

/** A pick that does not fit the dish's add-on groups; the message is for staff or the guest. */
export class AddonPickError extends Error {}

/** One chosen add-on, with the group it came from. */
export interface AddonChoice extends AddonOption { groupId: string; groupName: string }

/**
 * Checks the picks against a dish's add-on groups and returns the chosen add-ons in group, then option, order.
 * Repeated or unknown picks, an unavailable add-on, and too few or too many in a group throw `AddonPickError`.
 */
export function resolveAddonPicks(groups: AddonGroup[], picks: string[]): AddonChoice[] {
  if (new Set(picks).size !== picks.length) throw new AddonPickError("An add-on was picked twice");
  const active = groups.filter((group) => group.isActive);
  const known = new Set(active.flatMap((group) => group.options.map((option) => option.id)));
  if (picks.some((id) => !known.has(id))) throw new AddonPickError("The add-ons changed. Choose them again.");
  const chosen = new Set(picks);
  const result: AddonChoice[] = [];
  for (const group of active) {
    const inGroup = group.options.filter((option) => chosen.has(option.id));
    if (inGroup.length < group.minPicks) {
      throw new AddonPickError(group.minPicks === group.maxPicks ? `Choose ${group.minPicks} from ${group.name}` : `Choose at least ${group.minPicks} from ${group.name}`);
    }
    if (inGroup.length > group.maxPicks) throw new AddonPickError(`Choose at most ${group.maxPicks} from ${group.name}`);
    for (const option of inGroup) {
      if (option.unavailable) throw new AddonPickError(`${option.name} is not available`);
      result.push({ ...option, groupId: group.id, groupName: group.name });
    }
  }
  return result;
}

/** A dish can be ordered when every active group has enough available add-ons to meet its minimum. */
export function addonsAvailable(groups: AddonGroup[]): boolean {
  return groups.every((group) => !group.isActive || group.options.filter((option) => !option.unavailable).length >= group.minPicks);
}
