import { can } from "@forkflow/core";
import { z } from "zod";
import { roleFor, type RoleName } from "./roles.js";

/**
 * Per-person permissions on top of roles. A role gives a staff member their default permissions; an admin can grant or
 * remove individual permissions for one person. Admins always have everything and cannot be restricted, and managing
 * staff or settings stays admin-only, so nobody can give themselves more power.
 */
export interface PermissionAction { slug: string; label: string }
export interface PermissionArea { id: string; name: string; actions: readonly PermissionAction[] }

export const PERMISSION_AREAS: readonly PermissionArea[] = [
  { id: "orders", name: "Orders", actions: [
    { slug: "orders.read", label: "View" }, { slug: "orders.create", label: "Start orders" },
    { slug: "orders.update", label: "Add and change items" }, { slug: "orders.cancel_sent", label: "Cancel items sent to the kitchen" },
  ] },
  { id: "kots", name: "Kitchen tickets", actions: [
    { slug: "kots.read", label: "View" }, { slug: "kots.create", label: "Send to kitchen" }, { slug: "kots.update", label: "Mark done" },
  ] },
  { id: "bills", name: "Bills & payments", actions: [
    { slug: "bills.read", label: "View" }, { slug: "bills.create", label: "Issue bills" }, { slug: "bills.settle", label: "Take payment" },
    { slug: "bills.print", label: "Print" }, { slug: "bills.refund", label: "Void and refund" },
  ] },
  { id: "tables", name: "Tables", actions: [
    { slug: "tables.read", label: "View" }, { slug: "tables.manage", label: "Manage tables and QR codes" },
  ] },
  { id: "reservations", name: "Reservations", actions: [
    { slug: "reservations.read", label: "View" }, { slug: "reservations.manage", label: "Book, change and seat" },
  ] },
  { id: "customers", name: "Customers", actions: [
    { slug: "customers.read", label: "View" }, { slug: "customers.manage", label: "Add and edit" }, { slug: "crm.export", label: "Export lists" },
  ] },
  { id: "catalog", name: "Menu catalogue", actions: [
    { slug: "catalog.read", label: "View" }, { slug: "catalog.manage", label: "Edit items and prices" },
  ] },
  { id: "stock", name: "Inventory", actions: [
    { slug: "stock.read", label: "View" }, { slug: "stock.manage", label: "Edit stock and recipes" }, { slug: "costs.read", label: "See and enter costs" },
  ] },
  { id: "reports", name: "Reports", actions: [
    { slug: "reports.read", label: "View" }, { slug: "reports.manage", label: "Save custom reports" }, { slug: "reports.close_day", label: "Close the day" },
  ] },
  { id: "zomato", name: "Zomato", actions: [
    { slug: "zomato.read", label: "View" }, { slug: "zomato.import", label: "Import" }, { slug: "zomato.configure", label: "Settings" },
  ] },
  { id: "printers", name: "Printers", actions: [
    { slug: "printers.read", label: "View" }, { slug: "printers.manage", label: "Manage" },
  ] },
  { id: "integrations", name: "Marketplace", actions: [
    { slug: "integrations.read", label: "View" }, { slug: "integrations.configure", label: "Switch add-ons and modules" },
  ] },
];

/** Only an admin holds these: anyone who could manage staff or settings could hand themselves everything else. */
export const ADMIN_ONLY_PERMISSIONS = ["users.manage", "settings.manage"] as const;

export const GRANTABLE_PERMISSIONS: readonly string[] = PERMISSION_AREAS.flatMap((area) => area.actions.map((a) => a.slug));
/** Every permission the screens ask about: the grantable ones plus the admin-only ones. */
export const KNOWN_PERMISSIONS: readonly string[] = [...GRANTABLE_PERMISSIONS, ...ADMIN_ONLY_PERMISSIONS];
export const isGrantable = (slug: string) => GRANTABLE_PERMISSIONS.includes(slug);

/** One person's changes from their role: slug → true (added) or false (removed). */
export type PermissionOverrides = Record<string, boolean>;
export const PermissionOverridesSchema = z.record(
  z.string().refine(isGrantable, "That permission cannot be changed for one person"),
  z.boolean(),
).refine((o) => Object.keys(o).length <= GRANTABLE_PERMISSIONS.length, "Too many permissions");

/**
 * Whether a person may do something. Admins may do everything. Otherwise the person's own change for that permission
 * wins, then their role decides (including its `orders.*`-style wildcards). Admin-only permissions ignore any change.
 */
export function staffCan(role: RoleName, overrides: PermissionOverrides, slug: string): boolean {
  if (role === "admin") return true;
  if ((ADMIN_ONLY_PERMISSIONS as readonly string[]).includes(slug)) return false;
  const own = overrides[slug];
  if (own !== undefined) return own;
  return can(roleFor(role), slug);
}

/** The known permissions a person holds, for screens to show or hide what they can use. */
export const effectivePermissions = (role: RoleName, overrides: PermissionOverrides): string[] =>
  KNOWN_PERMISSIONS.filter((slug) => staffCan(role, overrides, slug));

/** The role's own defaults for each grantable permission, before any change for one person. */
export const roleDefaults = (role: RoleName): Record<string, boolean> =>
  Object.fromEntries(GRANTABLE_PERMISSIONS.map((slug) => [slug, staffCan(role, {}, slug)]));

/** Drops changes that match the role's default, so only real differences are stored. */
export function normaliseOverrides(role: RoleName, overrides: PermissionOverrides): PermissionOverrides {
  const defaults = roleDefaults(role);
  return Object.fromEntries(Object.entries(overrides).filter(([slug, allowed]) => isGrantable(slug) && defaults[slug] !== allowed));
}
