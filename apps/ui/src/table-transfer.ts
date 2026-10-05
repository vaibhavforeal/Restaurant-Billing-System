import { paiseToRupees } from "./money";
import type { Order, TableInfo } from "./types";

export type MoveNote = "occupied — merge instead" | "reserved now";

export interface MoveTarget {
  table: TableInfo;
  selectable: boolean;
  note: MoveNote | null;
}

export interface MergeGroup {
  tableLabel: string;
  options: Array<{ orderId: string; label: string }>;
}

/** Active tables other than the current one; only free tables can receive a moved order. */
export function moveTargets(tables: TableInfo[], currentTableId: string): MoveTarget[] {
  return tables
    .filter((table) => table.isActive && table.id !== currentTableId)
    .map((table) => {
      if (table.status === "free") return { table, selectable: true, note: null };
      return { table, selectable: false, note: table.status === "reserved" ? "reserved now" : "occupied — merge instead" };
    });
}

/** Other open dine-in orders, grouped by table label, that this order could be merged with. */
export function mergeTargets(orders: Order[], currentOrderId: string): MergeGroup[] {
  const groups = new Map<string, MergeGroup>();
  for (const order of orders) {
    if (order.id === currentOrderId || order.type !== "dine_in" || order.status !== "open" || order.mergedInto) continue;
    const tableLabel = order.tableLabel ?? order.tableName ?? "Table";
    const active = order.items.filter((item) => item.status !== "cancelled");
    const count = active.reduce((sum, item) => sum + item.qty, 0);
    const total = active.reduce((sum, item) => sum + item.pricePaise * item.qty, 0);
    const group = groups.get(tableLabel) ?? { tableLabel, options: [] };
    group.options.push({ orderId: order.id, label: `${order.tableName ?? "Table"} (${order.splitLabel ?? "A"}) · ${count} items · ₹${paiseToRupees(total)}` });
    groups.set(tableLabel, group);
  }
  return [...groups.values()];
}

/** Cart drafts are stored per order, so merging an order away would orphan any unsaved items. */
export function mergeBlockedReason(draftCount: number): string | null {
  return draftCount > 0 ? "Save or discard the cart items before merging." : null;
}
