import type { Role } from "@forkflow/core";

export type RoleName = "admin" | "cashier" | "waiter" | "kitchen";

/**
 * Permission namespaces (fixed vocabulary for the whole app):
 * orders, kots, bills, tables, catalog, stock, users, settings, reports, printers.
 * Roles are code, not data — a restaurant picks a role per staff member and
 * that's the whole model (spec: fewer things to learn).
 */
const ROLES: Record<RoleName, Role> = {
  admin: { name: "admin", permissions: ["*"] },
  cashier: {
    name: "cashier",
    permissions: [
      "orders.*", "kots.*", "bills.*", "tables.read",
      "catalog.read", "stock.read", "reports.read",
    ],
    limits: { max_discount_percent: 10 },
  },
  waiter: {
    name: "waiter",
    permissions: ["orders.create", "orders.update", "orders.read", "kots.create", "kots.read", "tables.read", "catalog.read"],
  },
  kitchen: {
    name: "kitchen",
    permissions: ["kots.read", "kots.update"],
  },
};

export function roleFor(name: RoleName): Role {
  return ROLES[name] ?? { name, permissions: [] };
}
