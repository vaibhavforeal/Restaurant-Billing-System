import { isFixedGroup, type ComboGroup } from "@masalapos/domain/combos";
import type { OrderItem, Product } from "./types";

/** The catalog items a combo holds for these picks: every fixed item, and the picked options. */
export function comboProductIds(groups: ComboGroup[], picks: string[]): string[] {
  return groups.flatMap((group) => group.options.filter((option) => isFixedGroup(group) || picks.includes(option.id)).map((option) => option.productId));
}

/** What the picked options add to one combo's price, at the catalog's current extras. */
export function comboExtraPaise(groups: ComboGroup[], picks: string[]): number {
  return groups.flatMap((group) => group.options).filter((option) => picks.includes(option.id)).reduce((sum, option) => sum + option.extraPricePaise, 0);
}

const stationed = (catalog: Product[]) => new Set(catalog.filter((product) => product.kotStationId).map((product) => product.id));

/** A cart row goes to the kitchen when it is a kitchen dish, or a combo holding one. */
export function cartRowForKitchen(row: { productId: string; comboPicks?: string[] | undefined }, catalog: Product[]): boolean {
  const kitchen = stationed(catalog);
  if (kitchen.has(row.productId)) return true;
  const combo = catalog.find((product) => product.id === row.productId)?.combo;
  return !!combo && comboProductIds(combo, row.comboPicks ?? []).some((id) => kitchen.has(id));
}

/**
 * Order lines a kitchen send should name: pending kitchen dishes, and combos with a kitchen dish still waiting. A combo's
 * own items are never named; sending the combo sends them.
 */
export function kitchenLines(items: OrderItem[], catalog: Product[]): OrderItem[] {
  const kitchen = stationed(catalog);
  return items.filter((item) => item.status === "pending" && !item.parentItemId && (kitchen.has(item.productId)
    || items.some((held) => held.parentItemId === item.id && held.status === "pending" && kitchen.has(held.productId))));
}

/** The items inside a combo line, as "2 × Fries" for one combo. */
export function comboContents(items: OrderItem[], line: OrderItem): string[] {
  return items.filter((item) => item.parentItemId === line.id && item.status !== "cancelled")
    .map((item) => item.qty > line.qty ? `${item.qty / line.qty} × ${item.name}` : item.name);
}

/** Whether the line is a combo holding items on the order. */
export const isComboLine = (items: OrderItem[], line: OrderItem) => items.some((item) => item.parentItemId === line.id);
