import { z } from "zod";

/**
 * Combos: a product sold as one bill line at one price, holding items chosen from its slots. A slot's minimum and
 * maximum say how many of its options a guest picks; a slot whose minimum equals its option count is fixed, so all its
 * options are always included and nobody is asked. An option can cost extra on top of the combo price.
 */

export const COMBO_MAX_GROUPS = 12;
export const COMBO_MAX_OPTIONS = 30;

export const ComboOptionInput = z.object({
  /** An existing option's id keeps it, so carts punched before an edit still match. */
  id: z.string().min(1).optional(),
  productId: z.string().min(1),
  variantId: z.string().min(1).nullable().default(null),
  qty: z.number().int().min(1).max(20).default(1),
  extraPricePaise: z.number().int().min(0).max(10_000_000).default(0),
});
export type ComboOptionInputValue = z.infer<typeof ComboOptionInput>;

export const ComboGroupInput = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(60),
  minPicks: z.number().int().min(0).max(COMBO_MAX_OPTIONS),
  maxPicks: z.number().int().min(1).max(COMBO_MAX_OPTIONS),
  options: z.array(ComboOptionInput).min(1, "Add at least one item to each slot").max(COMBO_MAX_OPTIONS),
}).superRefine((group, ctx) => {
  if (group.minPicks > group.maxPicks) ctx.addIssue({ code: "custom", path: ["minPicks"], message: `${group.name}: the minimum is more than the maximum` });
  if (group.maxPicks > group.options.length) ctx.addIssue({ code: "custom", path: ["maxPicks"], message: `${group.name}: the maximum is more than its ${group.options.length} items` });
  const seen = new Set<string>();
  for (const option of group.options) {
    const key = `${option.productId}/${option.variantId ?? ""}`;
    if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["options"], message: `${group.name}: an item is listed twice` });
    seen.add(key);
  }
});
export type ComboGroupInputValue = z.infer<typeof ComboGroupInput>;

export const ComboDefinition = z.array(ComboGroupInput).min(1, "Add at least one slot to the combo").max(COMBO_MAX_GROUPS);

/** The option ids staff or a guest chose; fixed slots need none. */
export const ComboPicks = z.array(z.string().min(1)).max(COMBO_MAX_GROUPS * COMBO_MAX_OPTIONS);

export interface ComboOption {
  id: string;
  productId: string;
  variantId: string | null;
  /** The item's name, with its portion: "Coke (Large)". */
  name: string;
  qty: number;
  extraPricePaise: number;
  /** The item is sold out or switched off, so it cannot be picked now. */
  unavailable?: boolean;
}

export interface ComboGroup {
  id: string;
  name: string;
  minPicks: number;
  maxPicks: number;
  options: ComboOption[];
}

/** Every option of a fixed slot is always included. */
export const isFixedGroup = (group: Pick<ComboGroup, "minPicks" | "options">) => group.minPicks >= group.options.length;

/** A pick that does not fit the combo; the message is for staff or the guest. */
export class ComboPickError extends Error {}

/** One item in a chosen combo, in slot order. */
export interface ComboChoice extends ComboOption { groupId: string; groupName: string }

/**
 * Checks the picks against the combo's slots and returns the items it holds and the extra charge for one combo.
 * Fixed slots are added on their own; repeated, unknown or unavailable picks, and too few or too many in a slot, throw.
 */
export function resolveComboPicks(groups: ComboGroup[], picks: string[]): { items: ComboChoice[]; extraPaise: number } {
  if (!groups.length) throw new ComboPickError("This combo has no items yet");
  if (new Set(picks).size !== picks.length) throw new ComboPickError("An item was picked twice");
  const known = new Set(groups.flatMap((group) => group.options.map((option) => option.id)));
  if (picks.some((id) => !known.has(id))) throw new ComboPickError("This combo changed. Choose its items again.");
  const chosen = new Set(picks);
  const items: ComboChoice[] = [];
  for (const group of groups) {
    const fixed = isFixedGroup(group);
    const inGroup = group.options.filter((option) => fixed || chosen.has(option.id));
    if (!fixed && inGroup.length < group.minPicks) throw new ComboPickError(group.minPicks === group.maxPicks ? `Choose ${group.minPicks} from ${group.name}` : `Choose at least ${group.minPicks} from ${group.name}`);
    if (!fixed && inGroup.length > group.maxPicks) throw new ComboPickError(`Choose at most ${group.maxPicks} from ${group.name}`);
    for (const option of inGroup) {
      if (option.unavailable) throw new ComboPickError(`${option.name} is not available`);
      items.push({ ...option, groupId: group.id, groupName: group.name });
    }
  }
  return { items, extraPaise: items.reduce((sum, item) => sum + item.extraPricePaise, 0) };
}

/** A combo can be ordered when every fixed item and enough options in each slot are available. */
export function comboAvailable(groups: ComboGroup[]): boolean {
  return groups.length > 0 && groups.every((group) => {
    const open = group.options.filter((option) => !option.unavailable).length;
    return isFixedGroup(group) ? open === group.options.length : open >= group.minPicks;
  });
}

/** A one-line list of a combo's items for carts and receipts: "Veg Burger, Fries, 2 × Coke". */
export function comboSummary(items: Array<Pick<ComboOption, "name" | "qty">>): string {
  return items.map((item) => item.qty > 1 ? `${item.qty} × ${item.name}` : item.name).join(", ");
}
