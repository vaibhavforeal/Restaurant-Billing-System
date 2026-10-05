import { paiseToRupees } from "./money";
import type { Order, TableInfo } from "./types";

export type MoveNote = "occupied — merge instead" | "reserved now" | "linked to this bill";

export interface MoveTarget {
  table: TableInfo;
  selectable: boolean;
  note: MoveNote | null;
}

export interface MergeGroup {
  tableLabel: string;
  options: Array<{ orderId: string; label: string }>;
}

/**
 * Active tables other than the current one. Free tables can receive a moved order, and so can a table whose
 * only occupancy is a link to this very order (part of the party already sits there) unless it is reserved now.
 */
export function moveTargets(tables: TableInfo[], currentTableId: string, currentOrderId: string, now = Date.now()): MoveTarget[] {
  return tables
    .filter((table) => table.isActive && table.id !== currentTableId)
    .map((table): MoveTarget => {
      if (table.status === "free") return { table, selectable: true, note: null };
      if (table.link?.orderId === currentOrderId && table.activeOrders.length === 0) {
        const reservedNow = table.reservation != null && table.reservation.startsAt <= now;
        return reservedNow ? { table, selectable: false, note: "reserved now" } : { table, selectable: true, note: "linked to this bill" };
      }
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

/** "Bill at this table" keeps the bill on the current order and folds the other one away, and vice versa. */
export function mergeRoles(currentOrderId: string, choice: { billAt: "this" | "other"; otherOrderId: string }): { keepsBill: string; foldedIn: string } {
  return choice.billAt === "this"
    ? { keepsBill: currentOrderId, foldedIn: choice.otherOrderId }
    : { keepsBill: choice.otherOrderId, foldedIn: currentOrderId };
}

/**
 * Cart drafts and queued item saves are stored per order, so folding an order away would orphan them.
 * Pass the counts for the order being folded in (see `mergeRoles`); the receiving order's cart is safe.
 */
export function mergeBlockedReason({ foldedDraftCount, foldedQueuedCount }: { foldedDraftCount: number; foldedQueuedCount: number }): string | null {
  return foldedDraftCount > 0 || foldedQueuedCount > 0 ? "Save or discard the cart items before merging." : null;
}

/** Bill groups a guest QR request from this table can join: its open groups, then the open combined order it is linked to. */
export function qrBillGroupOptions(table: TableInfo | undefined): Array<{ value: string; label: string }> {
  if (!table) return [];
  const options = table.activeOrders.filter((order) => order.status === "open").map((order) => ({ value: order.id, label: `Existing group ${order.splitLabel ?? "?"}` }));
  if (table.link?.status === "open") options.push({ value: table.link.orderId, label: table.link.label });
  return options;
}

/** Note shown on a card whose table is billed together with another table's order. */
export function tableCardNote(table: TableInfo): string | null {
  return table.link ? `with ${table.link.tableName}` : null;
}

/** Everything a table card can open: its own bill groups, then the combined order it is linked to. */
export function tableOpenTargets(table: TableInfo): Array<{ orderId: string; label: string }> {
  const targets = table.activeOrders.map((order) => ({ orderId: order.id, label: `Split ${order.splitLabel ?? "?"}` }));
  if (table.link) targets.push({ orderId: table.link.orderId, label: table.link.label });
  return targets;
}

/** Combined label (e.g. "T3, T4") for a table that owns an order other tables are linked to. */
export function receivingLabel(table: TableInfo, tables: TableInfo[]): string | null {
  const own = new Set(table.activeOrders.map((order) => order.id));
  return tables.find((other) => other.link && own.has(other.link.orderId))?.link?.label ?? null;
}
