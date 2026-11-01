import type { User } from "./api";
import type { Category, Order, Product, TableInfo } from "./types";

/**
 * Last-known copies of what a counter was looking at, so staff can keep working while the hub is unreachable. Each copy
 * is per signed-in person and replaced on every successful load; the hub stays the source of truth.
 */
const PREFIX = "masalapos.cache.v1.";
export interface CatalogCache { categories: Category[]; products: Product[]; captains: Array<{ id: string; name: string }>; at: number }

function write(key: string, value: unknown): void {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); }
  catch { /* storage full: the copy is a convenience, never required */ }
}
function read<T>(key: string): T | null {
  try { const raw = localStorage.getItem(PREFIX + key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}

export const saveOrderCopy = (userId: string, order: Order) => write(`${userId}.order.${order.id}`, { order, at: Date.now() });
export const readOrderCopy = (userId: string, orderId: string) => read<{ order: Order; at: number }>(`${userId}.order.${orderId}`);
export const saveCatalogCopy = (userId: string, catalog: Omit<CatalogCache, "at">) => write(`${userId}.catalog`, { ...catalog, at: Date.now() });
export const readCatalogCopy = (userId: string) => read<CatalogCache>(`${userId}.catalog`);
export const saveTablesCopy = (userId: string, data: { tables: TableInfo[]; orders: Order[] }) => write(`${userId}.tables`, { ...data, at: Date.now() });
export const readTablesCopy = (userId: string) => read<{ tables: TableInfo[]; orders: Order[]; at: number }>(`${userId}.tables`);

/** The person signed in with this session token, so a reload while the hub is unreachable keeps them working. */
export const saveSignedIn = (token: string, user: User) => write("signed-in", { token, user });
export function readSignedIn(token: string | null): User | null {
  const saved = read<{ token: string; user: User }>("signed-in");
  return token && saved?.token === token ? saved.user : null;
}

/** The last licence status the hub confirmed. */
export const saveLicenseCopy = (status: unknown) => write("license", status);
export const readLicenseCopy = <T>() => read<T>("license");

/** The last feature switches the hub reported. */
export const saveModulesCopy = (modules: unknown) => write("modules", modules);
export const readModulesCopy = <T>() => read<T>("modules");

/** True when a request failed because the hub could not be reached, not because it refused. */
export const isUnreachable = (error: unknown) => !(error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number");

/**
 * A new order started while offline: what the counter shows until the hub has it. Its id is the one the counter chose,
 * so the hub's copy replaces this one without any change of identity.
 */
export function placeholderOrder(input: { id: string; clientRef: string; userId: string; type: Order["type"]; table: Pick<TableInfo, "id" | "name" | "priceTier"> | null; captainId?: string | null; captainName?: string | null }): Order {
  return {
    id: input.id, clientRef: input.clientRef, type: input.type, orderTypeId: input.type, orderTypeName: null,
    zomatoOrderId: null, zomatoStatus: null, tableId: input.table?.id ?? null, splitLabel: null,
    tableName: input.table?.name ?? null, tableLabel: input.table?.name ?? null, mergedInto: null, customer: null,
    status: "open", openedBy: input.userId, openedAt: Date.now(), closedAt: null, items: [], kots: [], stockWarnings: [],
    priceTier: input.type === "parcel" ? "takeaway" : input.table?.priceTier ?? "non_ac",
    captainId: input.captainId ?? null, captainName: input.captainName ?? null,
  };
}

/**
 * Adds orders this device started while offline (not yet on the hub) to the tables view, so their tables show as taken
 * and tapping one opens that order instead of starting another.
 */
export function withOrdersStartedHere(userId: string, tables: TableInfo[], orders: Order[], saved: Array<{ path: string; lane: string }>): { tables: TableInfo[]; orders: Order[] } {
  const startedHere = saved.filter((r) => r.path === "/api/orders").flatMap((r) => {
    const order = readOrderCopy(userId, r.lane)?.order;
    return order && !orders.some((o) => o.id === order.id) ? [order] : [];
  });
  if (!startedHere.length) return { tables, orders };
  return {
    orders: [...orders, ...startedHere],
    tables: tables.map((t) => {
      const extra = startedHere.filter((o) => o.tableId === t.id && !t.activeOrders.some((a) => a.id === o.id));
      return extra.length ? { ...t, status: t.status === "free" ? "occupied" : t.status, activeOrders: [...t.activeOrders, ...extra.map((o) => ({ id: o.id, splitLabel: o.splitLabel, status: "open" as const }))] } : t;
    }),
  };
}
