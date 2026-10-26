import type { Role } from "@forkflow/core";

export type RoleName = "admin" | "cashier" | "waiter" | "kitchen";

/**
 * Permission namespaces (fixed vocabulary for the whole app):
 * orders, kots, bills (bills.refund = void or refund an issued bill; bills.settle also opens and closes the cash drawer shift), tables, reservations, customers (customers.manage = add and edit customers; loyalty and customer types are settings.manage), catalog, stock, costs, users, settings, reports (reports.close_day = close a business date, reports.manage = save, edit and delete custom reports; both admin only), printers, integrations (integrations.read = see the Marketplace, integrations.configure = turn integrations on/off; admin only).
 * Discount limits are data (`discount_caps`, `users.max_discount_percent`); permissions are code. Roles are code, not data — a restaurant picks a role per staff member and
 * that's the whole model (spec: fewer things to learn).
 */
const ROLES: Record<RoleName, Role> = {
  admin: { name: "admin", permissions: ["*"] },
  cashier: {
    name: "cashier",
    permissions: [
      "orders.*", "kots.*", "bills.*", "tables.read",
      "catalog.read", "stock.read", "reports.read",
      "reservations.*", "customers.*",
      "zomato.read", "zomato.import",
      "integrations.read",
    ],
  },
  waiter: {
    name: "waiter",
    permissions: ["orders.create", "orders.update", "orders.read", "kots.create", "kots.read", "tables.read", "catalog.read", "reservations.read", "customers.read"],
  },
  kitchen: {
    name: "kitchen",
    permissions: ["kots.read", "kots.update"],
  },
};

export function roleFor(name: RoleName): Role {
  return ROLES[name] ?? { name, permissions: [] };
}
