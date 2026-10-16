import { z } from "zod";
import { roleFor, type RoleName } from "./roles.js";

export const STAFF_ACTIONS = ["read", "create", "update", "delete"] as const;
export type StaffAction = typeof STAFF_ACTIONS[number];
export const STAFF_RESOURCES = [
  { id: "categories", name: "Categories", namespace: "catalog", actions: STAFF_ACTIONS },
  { id: "products", name: "Products", namespace: "catalog", actions: STAFF_ACTIONS },
  { id: "variants", name: "Product variants", namespace: "catalog", actions: STAFF_ACTIONS },
  { id: "tables", name: "Tables", namespace: "tables", actions: STAFF_ACTIONS },
  { id: "reservations", name: "Reservations", namespace: "reservations", actions: STAFF_ACTIONS },
  { id: "orders", name: "Orders & order items", namespace: "orders", actions: STAFF_ACTIONS },
  { id: "kots", name: "Kitchen tickets", namespace: "kots", actions: ["read", "create", "update"] },
  { id: "bills", name: "Bills & payments", namespace: "bills", actions: ["read", "create", "update", "delete"] },
  { id: "stock", name: "Stock items & movements", namespace: "stock", actions: STAFF_ACTIONS },
  { id: "recipes", name: "Recipes & stock links", namespace: "stock", actions: ["read", "update"] },
  { id: "costs", name: "Ingredient costs", namespace: "costs", actions: ["read", "create"] },
  { id: "users", name: "Staff accounts", namespace: "users", actions: STAFF_ACTIONS },
  { id: "settings", name: "Restaurant settings", namespace: "settings", actions: ["read", "update"] },
  { id: "reports", name: "Reports", namespace: "reports", actions: ["read"] },
  { id: "printers", name: "Printers & kitchen stations", namespace: "printers", actions: STAFF_ACTIONS },
  { id: "integrations", name: "Integration connections", namespace: "integrations", actions: ["read", "update"] },
] as const;
export const StaffOverrides = z.record(z.string(), z.boolean()).refine(values => Object.keys(values).every(key => {
  const [resource, action, extra] = key.split(".");
  return !extra && STAFF_RESOURCES.some(row => row.id === resource && (row.actions as readonly string[]).includes(action!));
}), "Unknown or unsupported permission");
export type StaffOverrides = z.infer<typeof StaffOverrides>;
export const StaffRoster = z.array(z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(120), role: z.enum(["admin", "cashier", "waiter", "kitchen"]), isActive: z.boolean() }).strict()).max(500).refine(rows => new Set(rows.map(row => row.id)).size === rows.length, "Duplicate staff IDs");
export type StaffMember = z.infer<typeof StaffRoster>[number];
function roleCan(role: RoleName, permission: string) {
  return roleFor(role).permissions.some(grant => grant === "*" || grant === permission || grant.endsWith(".*") && permission.startsWith(grant.slice(0, -1)));
}
export function staffDefaults(role: RoleName): StaffOverrides {
  const result: StaffOverrides = {};
  for (const row of STAFF_RESOURCES) for (const action of row.actions) {
    const actual = action === "delete" ? "update" : action;
    const permission = row.id === "costs" ? "costs.read" : row.id === "recipes" ? `stock.${action === "read" ? "read" : "manage"}`
      : ["catalog", "stock", "tables", "reservations", "users", "settings", "printers"].includes(row.namespace) && action !== "read" ? `${row.namespace}.manage`
      : row.id === "users" || row.id === "settings" ? `${row.namespace}.manage`
      : row.id === "integrations" && action === "update" ? "zomato.configure" : row.id === "bills" && action === "update" ? "bills.settle"
      : row.id === "bills" && action === "delete" ? "bills.refund" : `${row.namespace}.${actual}`;
    result[`${row.id}.${action}`] = roleCan(role, permission);
  }
  return result;
}
export function effectiveStaffPermissions(role: RoleName, overrides: StaffOverrides = {}): StaffOverrides { return { ...staffDefaults(role), ...overrides }; }
