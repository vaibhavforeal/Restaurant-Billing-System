import { parseVendorCode } from "@forkflow/domain/vendor-codes";
import type { SearchHit } from "./api-types.js";
import { path, type Route } from "./context.js";
import { json } from "./http.js";
import { ownedBy } from "./scope.js";
import { roleCan } from "./shared.js";

/** The top bar's search: customers by name, phone, email, GSTIN or Customer ID, and orders by Order ID, within what the person may see. */
export const searchRoutes: Route[] = [
  { method: "GET", path: path("/search"), handler: async (ctx) => {
    const text = ctx.url.searchParams.get("q")?.trim() ?? "";
    if (text.length < 2) return json({ hits: [] });
    const like = `%${text.replace(/[%_]/g, "")}%`, { db } = ctx.deps, hits: SearchHit[] = [];
    const scope = ownedBy(ctx.user, "c.owner_id");
    if (roleCan(ctx.user.role, "customers.read")) {
      const { results } = await db.prepare(`SELECT c.id, c.business_name AS title, c.code || COALESCE(' · ' || c.city, '') AS detail FROM customers c
        WHERE ${scope.sql} AND (c.code = ? OR c.business_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.gstin LIKE ? OR c.contact_name LIKE ?)
        ORDER BY c.business_name LIMIT 6`).bind(...scope.binds, parseVendorCode("customer", text) ?? "", like, like, like, like, like).all<Omit<SearchHit, "kind">>();
      hits.push(...results.map((r) => ({ kind: "customer" as const, ...r })));
    }
    const order = parseVendorCode("order", text);
    if (order && roleCan(ctx.user.role, "orders.read")) {
      const { results } = await db.prepare(`SELECT o.id, o.code AS title, c.business_name AS detail FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE ${scope.sql} AND o.code = ?`).bind(...scope.binds, order).all<Omit<SearchHit, "kind">>();
      hits.push(...results.map((r) => ({ kind: "order" as const, ...r })));
    }
    return json({ hits });
  } },
];
