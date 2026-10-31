import { parseVendorCode } from "@forkflow/domain/vendor-codes";
import { z } from "zod";
import { activityPage } from "./activity.js";
import type { CustomerDetail, CustomerSummary } from "./api-types.js";
import { withFreshCode } from "./codes.js";
import { logBy, path, queryInt, type Ctx, type Route } from "./context.js";
import { HttpError, json, readBody } from "./http.js";
import { installationsWhere } from "./installations.js";
import { ownedBy, visibleCustomer } from "./scope.js";
import { GST_STATES, GSTIN_PATTERN, seesOnlyOwn } from "./shared.js";

const PAGE = 50;
const text = (max: number) => z.string().trim().max(max).transform((v) => v || null);
const CustomerFields = z.object({
  businessName: z.string().trim().min(1, "Enter the business name").max(120),
  contactName: text(80), phone: z.string().trim().regex(/^([+0-9][0-9 -]{5,18})?$/, "Enter a phone number").transform((v) => v || null),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email("Enter a valid email").max(254)]).transform((v) => v || null),
  gstin: z.string().trim().toUpperCase().refine((v) => v === "" || GSTIN_PATTERN.test(v), "Enter a 15-character GSTIN").transform((v) => v || null),
  address: text(300), city: text(80),
  stateCode: z.string().refine((v) => v === "" || v in GST_STATES, "Choose a state").transform((v) => v || null),
  pincode: z.string().trim().regex(/^(\d{6})?$/, "Enter a 6-digit PIN code").transform((v) => v || null),
  notes: text(2000),
  ownerId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "inactive"]).optional(),
}).strict().superRefine((c, issue) => {
  // The GSTIN starts with the state code, and the invoice's place of supply comes from it.
  if (c.gstin && c.stateCode && c.gstin.slice(0, 2) !== c.stateCode) issue.addIssue({ code: "custom", path: ["stateCode"], message: "The state doesn't match the GSTIN's first two digits" });
});

const SUMMARY = `c.id, c.code, c.business_name AS businessName, c.contact_name AS contactName, c.phone, c.email, c.city, c.state_code AS stateCode,
  c.status, c.owner_id AS ownerId, u.name AS ownerName, c.created_at AS createdAt,
  (SELECT COUNT(*) FROM installations i WHERE i.customer_id = c.id AND i.order_id IS NOT NULL) AS outlets,
  (SELECT MIN(l.expires_at) FROM installations i JOIN licenses l ON l.installation_id = i.installation_id
    AND l.revision = (SELECT MAX(revision) FROM licenses WHERE installation_id = i.installation_id)
    WHERE i.customer_id = c.id AND i.order_id IS NOT NULL) AS nextRenewalAt`;
type SummaryRow = Omit<CustomerSummary, "owner"> & { ownerId: string | null; ownerName: string | null };
const toSummary = ({ ownerId, ownerName, ...r }: SummaryRow): CustomerSummary => ({ ...r, owner: ownerId ? { id: ownerId, name: ownerName ?? "Former staff" } : null });

/** A customer's owner must be an active staff member who can hold customers (an admin or a sales rep). */
async function checkOwner(ctx: Ctx, ownerId: string | null | undefined): Promise<void> {
  if (!ownerId) return;
  const row = await ctx.deps.db.prepare(`SELECT 1 AS hit FROM staff_users WHERE id = ? AND active = 1 AND role IN ('admin', 'sales')`).bind(ownerId).first();
  if (!row) throw new HttpError(400, "Assign the customer to an active admin or sales rep");
}

export async function customerDetail(ctx: Ctx, id: string): Promise<CustomerDetail> {
  await visibleCustomer(ctx, id);
  const row = await ctx.deps.db.prepare(`SELECT ${SUMMARY}, c.gstin, c.address, c.pincode, c.notes, c.updated_at AS updatedAt,
      (SELECT COALESCE(SUM(p.amount_paise), 0) FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.customer_id = c.id AND p.status = 'cleared') AS paidPaise,
      (SELECT COALESCE(SUM(MAX(0, o.total_paise - (SELECT COALESCE(SUM(p.amount_paise), 0) FROM payments p WHERE p.order_id = o.id AND p.status = 'cleared'))), 0)
        FROM orders o WHERE o.customer_id = c.id AND o.status = 'confirmed') AS outstandingPaise,
      (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status <> 'cancelled') AS orders
    FROM customers c LEFT JOIN staff_users u ON u.id = c.owner_id WHERE c.id = ?`).bind(id).first<SummaryRow & Omit<CustomerDetail, keyof CustomerSummary>>();
  const { ownerId, ownerName, ...rest } = row!;
  return { ...rest, owner: ownerId ? { id: ownerId, name: ownerName ?? "Former staff" } : null };
}

export const customersRoutes: Route[] = [
  { method: "GET", path: path("/customers"), permission: "customers.read", handler: async (ctx) => {
    const q = ctx.url.searchParams, scope = ownedBy(ctx.user, "c.owner_id");
    const where = [scope.sql], binds: unknown[] = [...scope.binds];
    const search = q.get("q")?.trim();
    if (search) {
      const code = parseVendorCode("customer", search);
      if (code) { where.push("c.code = ?"); binds.push(code); }
      else {
        where.push(`(c.business_name LIKE ? OR c.contact_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.gstin LIKE ? OR c.city LIKE ?)`);
        binds.push(...Array(6).fill(`%${search.replace(/[%_]/g, "")}%`));
      }
    }
    if (q.get("status") === "active" || q.get("status") === "inactive") { where.push("c.status = ?"); binds.push(q.get("status")); }
    if (q.get("ownerId") === "none") where.push("c.owner_id IS NULL");
    else if (q.get("ownerId")) { where.push("c.owner_id = ?"); binds.push(q.get("ownerId")); }
    const offset = Math.max(0, queryInt(ctx.url, "offset", 0)!);
    const sql = `FROM customers c LEFT JOIN staff_users u ON u.id = c.owner_id WHERE ${where.join(" AND ")}`;
    const [{ results }, total] = await Promise.all([
      ctx.deps.db.prepare(`SELECT ${SUMMARY} ${sql} ORDER BY c.business_name COLLATE NOCASE LIMIT ? OFFSET ?`).bind(...binds, PAGE, offset).all<SummaryRow>(),
      ctx.deps.db.prepare(`SELECT COUNT(*) AS n ${sql}`).bind(...binds).first<{ n: number }>(),
    ]);
    return json({ customers: results.map(toSummary), total: total!.n, offset, pageSize: PAGE });
  } },
  { method: "POST", path: path("/customers"), permission: "customers.write", handler: async (ctx) => {
    const body = await readBody(ctx.request, CustomerFields);
    // A sales rep's new customer is theirs; an admin may assign it to anyone who can hold customers.
    const ownerId = seesOnlyOwn(ctx.user.role) ? ctx.user.id : body.ownerId === undefined ? ctx.user.id : body.ownerId;
    await checkOwner(ctx, ownerId);
    const { db } = ctx.deps, now = ctx.deps.now(), id = ctx.deps.uuid();
    const code = await withFreshCode("customer", async (code) => {
      await db.batch([
        db.prepare(`INSERT INTO customers (id, code, business_name, contact_name, phone, email, gstin, address, city, state_code, pincode, owner_id, status, notes, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(id, code, body.businessName, body.contactName, body.phone, body.email, body.gstin, body.address, body.city, body.gstin?.slice(0, 2) ?? body.stateCode,
            body.pincode, ownerId, body.status ?? "active", body.notes, ctx.user.id, now, now),
        logBy(ctx, { action: "customer.created", entityType: "customer", entityId: id, customerId: id, summary: `Added customer ${body.businessName} (${code})` }),
      ]);
      return code;
    });
    return json({ customer: await customerDetail(ctx, id), code }, 201);
  } },
  { method: "GET", path: path("/customers/:id"), permission: "customers.read", handler: async (ctx) => json({ customer: await customerDetail(ctx, ctx.params[0]!) }) },
  { method: "PATCH", path: path("/customers/:id"), permission: "customers.write", handler: async (ctx) => {
    const id = ctx.params[0]!;
    const before = await customerDetail(ctx, id);
    const body = await readBody(ctx.request, CustomerFields);
    const ownerChange = body.ownerId !== undefined && body.ownerId !== (before.owner?.id ?? null);
    if (ownerChange && seesOnlyOwn(ctx.user.role)) throw new HttpError(403, "Only an admin can move a customer to another rep", "forbidden");
    if (ownerChange) await checkOwner(ctx, body.ownerId);
    const ownerId = ownerChange ? body.ownerId! : before.owner?.id ?? null;
    const { db } = ctx.deps, now = ctx.deps.now();
    await db.batch([
      db.prepare(`UPDATE customers SET business_name = ?, contact_name = ?, phone = ?, email = ?, gstin = ?, address = ?, city = ?, state_code = ?, pincode = ?,
        owner_id = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?`)
        .bind(body.businessName, body.contactName, body.phone, body.email, body.gstin, body.address, body.city, body.gstin?.slice(0, 2) ?? body.stateCode, body.pincode,
          ownerId, body.status ?? before.status, body.notes, now, id),
      logBy(ctx, { action: ownerChange ? "customer.reassigned" : "customer.changed", entityType: "customer", entityId: id, customerId: id,
        summary: ownerChange ? `Moved ${body.businessName} to another rep` : `Edited ${body.businessName}` }),
    ]);
    return json({ customer: await customerDetail(ctx, id) });
  } },
  { method: "GET", path: path("/customers/:id/installations"), permission: "customers.read", handler: async (ctx) => {
    const customer = await visibleCustomer(ctx, ctx.params[0]!);
    return json({ installations: await installationsWhere(ctx, "i.customer_id = ?", [customer.id]) });
  } },
  { method: "GET", path: path("/customers/:id/activity"), permission: "customers.read", handler: async (ctx) => {
    const customer = await visibleCustomer(ctx, ctx.params[0]!);
    return json(await activityPage(ctx.deps.db, ["a.customer_id = ?"], [customer.id], queryInt(ctx.url, "before")));
  } },
];
