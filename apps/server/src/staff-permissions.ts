import type { FastifyInstance, FastifyRequest } from "fastify";
import { can } from "@forkflow/core";
import { roleFor, type RoleName } from "@forkflow/domain";
import { effectiveStaffPermissions, type StaffOverrides } from "@forkflow/domain/staff-permissions";

export function userPermissions(app: FastifyInstance, user: { id: string; role: RoleName }): StaffOverrides {
  return effectiveStaffPermissions(user.role, permissionOverrides(app, user));
}
function permissionOverrides(app: FastifyInstance, user: { id: string; role: RoleName }): StaffOverrides {
  if (user.role === 'admin') return app.licensing.featurePolicy()?.staffPermissions?.[user.id] ?? {};
  const local = app.db.prepare("SELECT overrides FROM cloud_staff_policy WHERE id=?").get(user.id) as { overrides: string } | undefined;
  return local ? JSON.parse(local.overrides) : app.licensing.featurePolicy()?.staffPermissions?.[user.id] ?? {};
}
function actionPermission(req: FastifyRequest, slug: string): string | null {
  const url = req.routeOptions.url ?? "";
  const body = req.body as Record<string, unknown> | undefined;
  const reading = req.method === "GET" || req.method === "HEAD";
  let resource: string | undefined;
  if (slug.startsWith("bills.") && /^\/api\/orders\/:id\/bill/.test(url)) resource = "bills";
  else if (/^\/api\/(categories)(\/|$)/.test(url)) resource = "categories";
  else if (/^\/api\/products/.test(url)) resource = /\/(recipe|stock-links)$/.test(url) ? "recipes" : url.endsWith("/variants") ? "variants" : "products";
  else if (url.startsWith("/api/variants")) resource = "variants";
  else if (url.startsWith("/api/stock-items")) resource = url.endsWith("/unit-cost") ? "costs" : "stock";
  else if (url.startsWith("/api/costing")) resource = "costs";
  else if (url.startsWith("/api/tables") || url.startsWith("/api/qr/tables")) resource = "tables";
  else if (url.startsWith("/api/reservations")) resource = "reservations";
  else if (url.startsWith("/api/orders") || url.startsWith("/api/order-items") || url.startsWith("/api/qr/requests") || url.startsWith("/api/qr/service-requests")) resource = "orders";
  else if (url.startsWith("/api/kots")) resource = "kots";
  else if (url.startsWith("/api/bills") || url.startsWith("/api/credit-notes")) resource = "bills";
  else if (url.startsWith("/api/users")) resource = "users";
  else if (url.startsWith("/api/reports")) resource = "reports";
  else if (url.startsWith("/api/printers") || url.startsWith("/api/kot-stations") || url.startsWith("/api/print-jobs")) resource = "printers";
  else if (url.startsWith("/api/settings")) resource = "settings";
  else if (url.startsWith("/api/zomato") || url === "/api/integrations") resource = "integrations";
  // Preserve independent checks such as order creation during reservation seating,
  // cost visibility, cancel-sent approval and licence/recovery privileges.
  const expected = resource === "categories" || resource === "products" || resource === "variants" ? "catalog" : resource === "recipes" ? "stock" : resource === "printers" && url.startsWith("/api/kot-stations") ? "catalog" : resource === "integrations" && slug.startsWith("zomato.") ? "zomato" : resource;
  if (!resource || slug.split(".")[0] !== expected || slug.endsWith("cancel_sent")) return null;
  const deleting = req.method === "DELETE" || body?.isActive === false || /\/(cancel|void|refund)$/.test(url) || body?.status === "cancelled";
  const action = reading || slug.endsWith(".print") ? "read" : deleting || url.endsWith("/credit-preview") ? "delete" : url.endsWith("/bill-preview") ? "create" : resource === "recipes" || resource === "settings" || resource === "integrations" || /\/(settle|done|send|accept|reject|resolve|seat|status|captain|items|transfer|split|merge|test-print|retry|confirm-printed)$/.test(url) || url.startsWith("/api/order-items") ? "update"
    : req.method === "POST" ? "create" : "update";
  return `${resource}.${action}`;
}
export function staffCan(app: FastifyInstance, user: { id: string; role: RoleName }, slug: string, req?: FastifyRequest): boolean {
  const overrides = permissionOverrides(app, user);
  if (req?.routeOptions.url?.startsWith("/api/catalog/")) {
    const keys = req.method === "GET" ? ["categories.read", "products.read", "variants.read"] : ["categories.create", "categories.update", "products.create", "products.update", "variants.create", "variants.update"];
    return keys.every(key => Object.hasOwn(overrides, key) ? overrides[key] : can(roleFor(user.role), slug));
  }
  const action = req ? actionPermission(req, slug) : slug;
  if (req && action?.endsWith(".delete") && req.body && typeof req.body === "object") {
    const fields = Object.keys(req.body);
    // Archiving may share a PATCH schema with editing. A delete-only grant must
    // not permit unrelated field edits smuggled into the same request.
    if ((req.body as { isActive?: unknown }).isActive === false && fields.some(field => !["isActive", "expectedVersion", "version"].includes(field))) {
      const update = action.replace(/\.delete$/, ".update");
      if (!(Object.hasOwn(overrides, update) ? overrides[update] : can(roleFor(user.role), slug))) return false;
    }
  }
  if (action && Object.hasOwn(overrides, action)) return overrides[action]!;
  return can(roleFor(user.role), slug);
}
