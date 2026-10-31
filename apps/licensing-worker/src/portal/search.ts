import { parseVendorCode } from "@forkflow/domain/vendor-codes";
import type { SearchHit } from "./api-types.js";
import { path, type Route } from "./context.js";
import { json } from "./http.js";
import { ownedBy } from "./scope.js";
import { roleCan } from "./shared.js";

/** The top bar's search: customers by name, phone, email, GSTIN or Customer ID, orders by Order ID, open leads, and tickets by number, within what the person may see. */
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
    if (roleCan(ctx.user.role, "leads.read")) {
      const leadScope = ownedBy(ctx.user, "l.owner_id");
      const { results } = await db.prepare(`SELECT l.id, l.business_name AS title, 'Lead' || COALESCE(' · ' || l.city, '') AS detail FROM leads l
        WHERE ${leadScope.sql} AND l.customer_id IS NULL AND (l.business_name LIKE ? OR l.phone LIKE ? OR l.contact_name LIKE ?) ORDER BY l.updated_at DESC LIMIT 4`)
        .bind(...leadScope.binds, like, like, like).all<Omit<SearchHit, "kind">>();
      hits.push(...results.map((r) => ({ kind: "lead" as const, ...r })));
    }
    const ticket = text.match(/^T-?(\d{4,7})$/i);
    if (ticket && roleCan(ctx.user.role, "tickets.read")) {
      const { results } = await db.prepare(`SELECT t.id, 'T-' || t.number || ' ' || t.subject AS title, c.business_name AS detail FROM tickets t JOIN customers c ON c.id = t.customer_id
        WHERE ${scope.sql} AND t.number = ?`).bind(...scope.binds, Number(ticket[1])).all<Omit<SearchHit, "kind">>();
      hits.push(...results.map((r) => ({ kind: "ticket" as const, ...r })));
    }
    return json({ hits });
  } },
];
