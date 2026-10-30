import { z } from "zod";
import type { TicketDetail, TicketSummary } from "./api-types.js";
import { logBy, path, queryInt, type Ctx, type Route } from "./context.js";
import { HttpError, json, notFound, readBody } from "./http.js";
import { ownedBy, visibleCustomer } from "./scope.js";

const PAGE = 50;
const STATUS_NAMES: Record<string, string> = { open: "Open", in_progress: "Working on it", waiting: "Waiting on the customer", resolved: "Resolved", closed: "Closed" };
const Status = z.enum(["open", "in_progress", "waiting", "resolved", "closed"]);
const Priority = z.enum(["low", "normal", "high", "urgent"]);
const Category = z.enum(["activation", "licence", "billing", "printing", "hardware", "training", "bug", "other"]);
const NewTicket = z.object({
  customerId: z.string().uuid(), installationId: z.string().uuid().nullable(), subject: z.string().trim().min(1, "Say what's wrong").max(160),
  description: z.string().trim().max(4000).transform((v) => v || null), category: Category, priority: Priority, assigneeId: z.string().uuid().nullable(),
}).strict();
const TicketChange = z.object({ status: Status.optional(), priority: Priority.optional(), category: Category.optional(), assigneeId: z.string().uuid().nullable().optional(),
  subject: z.string().trim().min(1).max(160).optional() }).strict();

const SUMMARY = `t.id, t.number, t.subject, t.category, t.priority, t.status, t.customer_id AS customerId, c.business_name AS customerName,
  t.assignee_id AS assigneeId, a.name AS assigneeName, t.created_at AS createdAt, t.updated_at AS updatedAt, t.resolved_at AS resolvedAt`;
type Row = Omit<TicketSummary, "customer" | "assignee"> & { customerId: string; customerName: string; assigneeId: string | null; assigneeName: string | null };
const toSummary = ({ customerId, customerName, assigneeId, assigneeName, ...r }: Row): TicketSummary =>
  ({ ...r, customer: { id: customerId, name: customerName }, assignee: assigneeId ? { id: assigneeId, name: assigneeName ?? "Former staff" } : null });
const FROM = `FROM tickets t JOIN customers c ON c.id = t.customer_id LEFT JOIN staff_users a ON a.id = t.assignee_id`;

/** Tickets matching `where`, within what the staff member may see: reps see their own customers' tickets. */
export async function ticketsWhere(ctx: Ctx, where: string[], binds: unknown[], order = "t.updated_at DESC", limit = PAGE, offset = 0): Promise<TicketSummary[]> {
  const scope = ownedBy(ctx.user, "c.owner_id");
  const { results } = await ctx.deps.db.prepare(`SELECT ${SUMMARY} ${FROM} WHERE ${[scope.sql, ...where].join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...scope.binds, ...binds, limit, offset).all<Row>();
  return results.map(toSummary);
}

async function ticketDetail(ctx: Ctx, id: string): Promise<TicketDetail> {
  const scope = ownedBy(ctx.user, "c.owner_id");
  const row = await ctx.deps.db.prepare(`SELECT ${SUMMARY}, t.description, t.installation_id AS installationId, i.outlet_name AS outletName, t.created_by AS createdById, cb.name AS createdByName
    ${FROM} LEFT JOIN installations i ON i.installation_id = t.installation_id LEFT JOIN staff_users cb ON cb.id = t.created_by WHERE t.id = ? AND ${scope.sql}`)
    .bind(id, ...scope.binds).first<Row & { description: string | null; installationId: string | null; outletName: string | null; createdById: string | null; createdByName: string | null }>();
  if (!row) throw notFound("That ticket");
  const { description, installationId, outletName, createdById, createdByName, ...summary } = row;
  const comments = await ctx.deps.db.prepare(`SELECT k.id, k.body, k.created_at AS createdAt, k.author_id AS authorId, u.name AS authorName FROM ticket_comments k
    LEFT JOIN staff_users u ON u.id = k.author_id WHERE k.ticket_id = ? ORDER BY k.id`).bind(id).all<{ id: number; body: string; createdAt: number; authorId: string | null; authorName: string | null }>();
  return {
    ...toSummary(summary), description, createdBy: createdById ? { id: createdById, name: createdByName ?? "" } : null,
    installation: installationId ? { id: installationId, name: outletName ?? `Counter ${installationId.slice(0, 8)}` } : null,
    comments: comments.results.map(({ authorId, authorName, ...c }) => ({ ...c, author: authorId ? { id: authorId, name: authorName ?? "" } : null })),
  };
}

async function checkAssignee(ctx: Ctx, assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  if (!(await ctx.deps.db.prepare(`SELECT 1 AS hit FROM staff_users WHERE id = ? AND active = 1 AND role IN ('admin', 'support')`).bind(assigneeId).first())) {
    throw new HttpError(400, "Assign the ticket to an active support person or admin");
  }
}

export const ticketRoutes: Route[] = [
  { method: "GET", path: path("/tickets"), permission: "tickets.read", handler: async (ctx) => {
    const q = ctx.url.searchParams, where: string[] = [], binds: unknown[] = [];
    const status = q.get("status") ?? "active";
    if (status === "active") where.push("t.status IN ('open', 'in_progress', 'waiting')");
    else if (status !== "all") { where.push("t.status = ?"); binds.push(status); }
    if (q.get("priority")) { where.push("t.priority = ?"); binds.push(q.get("priority")); }
    if (q.get("assigneeId") === "me") { where.push("t.assignee_id = ?"); binds.push(ctx.user.id); }
    else if (q.get("assigneeId") === "none") where.push("t.assignee_id IS NULL");
    else if (q.get("assigneeId")) { where.push("t.assignee_id = ?"); binds.push(q.get("assigneeId")); }
    if (q.get("customerId")) { where.push("t.customer_id = ?"); binds.push(q.get("customerId")); }
    const search = q.get("q")?.trim();
    if (search) {
      const number = Number(search.replace(/^T-?/i, ""));
      if (Number.isSafeInteger(number) && number > 0) { where.push("t.number = ?"); binds.push(number); }
      else { where.push("(t.subject LIKE ? OR c.business_name LIKE ?)"); binds.push(`%${search}%`, `%${search}%`); }
    }
    const offset = Math.max(0, queryInt(ctx.url, "offset", 0)!);
    // Urgent first, then by how long it has waited.
    const order = "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at";
    const tickets = await ticketsWhere(ctx, where, binds, status === "active" ? order : "t.updated_at DESC", PAGE, offset);
    const scope = ownedBy(ctx.user, "c.owner_id");
    const counts = await ctx.deps.db.prepare(`SELECT t.status, COUNT(*) AS n ${FROM} WHERE ${scope.sql} GROUP BY t.status`).bind(...scope.binds).all<{ status: string; n: number }>();
    return json({ tickets, offset, pageSize: PAGE, counts: Object.fromEntries(counts.results.map((c) => [c.status, c.n])) });
  } },

  { method: "POST", path: path("/tickets"), permission: "tickets.write", handler: async (ctx) => {
    const body = await readBody(ctx.request, NewTicket);
    const customer = await visibleCustomer(ctx, body.customerId);
    if (body.installationId && !(await ctx.deps.db.prepare(`SELECT 1 AS hit FROM installations WHERE installation_id = ? AND customer_id = ?`).bind(body.installationId, customer.id).first())) {
      throw new HttpError(400, "That counter isn't this customer's");
    }
    await checkAssignee(ctx, body.assigneeId);
    const { db } = ctx.deps, now = ctx.deps.now(), id = ctx.deps.uuid();
    await db.batch([
      db.prepare(`INSERT INTO tickets (id, number, customer_id, installation_id, subject, description, category, priority, assignee_id, created_by, created_at, updated_at)
        SELECT ?, COALESCE(MAX(number), 1000) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM tickets`)
        .bind(id, customer.id, body.installationId, body.subject, body.description, body.category, body.priority, body.assigneeId, ctx.user.id, now, now),
      logBy(ctx, { action: "ticket.opened", entityType: "ticket", entityId: id, customerId: customer.id, summary: `Opened a ticket: ${body.subject}` }),
    ]);
    return json({ ticket: await ticketDetail(ctx, id) }, 201);
  } },

  { method: "GET", path: path("/tickets/:id"), permission: "tickets.read", handler: async (ctx) => json({ ticket: await ticketDetail(ctx, ctx.params[0]!) }) },

  { method: "PATCH", path: path("/tickets/:id"), permission: "tickets.write", handler: async (ctx) => {
    const before = await ticketDetail(ctx, ctx.params[0]!);
    const change = await readBody(ctx.request, TicketChange);
    if (change.assigneeId !== undefined) await checkAssignee(ctx, change.assigneeId);
    const status = change.status ?? before.status;
    const resolved = (status === "resolved" || status === "closed") ? before.resolvedAt ?? ctx.deps.now() : null;
    const { db } = ctx.deps, now = ctx.deps.now();
    const what = [change.status && change.status !== before.status && `status ${STATUS_NAMES[before.status]} → ${STATUS_NAMES[change.status]}`,
      change.priority && change.priority !== before.priority && `priority ${change.priority}`,
      change.assigneeId !== undefined && change.assigneeId !== (before.assignee?.id ?? null) && (change.assigneeId ? "reassigned" : "unassigned")].filter(Boolean).join(", ");
    await db.batch([
      db.prepare(`UPDATE tickets SET status = ?, priority = ?, category = ?, assignee_id = ?, subject = ?, resolved_at = ?, updated_at = ? WHERE id = ?`)
        .bind(status, change.priority ?? before.priority, change.category ?? before.category, change.assigneeId === undefined ? before.assignee?.id ?? null : change.assigneeId,
          change.subject ?? before.subject, resolved, now, before.id),
      ...(what ? [logBy(ctx, { action: "ticket.changed", entityType: "ticket", entityId: before.id, customerId: before.customer.id, summary: `T-${before.number}: ${what}` })] : []),
    ]);
    return json({ ticket: await ticketDetail(ctx, before.id) });
  } },

  { method: "POST", path: path("/tickets/:id/comments"), permission: "tickets.write", handler: async (ctx) => {
    const ticket = await ticketDetail(ctx, ctx.params[0]!);
    const { body } = await readBody(ctx.request, z.object({ body: z.string().trim().min(1, "Write the note").max(4000) }).strict());
    const { db } = ctx.deps, now = ctx.deps.now();
    await db.batch([
      db.prepare(`INSERT INTO ticket_comments (ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?)`).bind(ticket.id, ctx.user.id, body, now),
      // A note on a new ticket means someone has picked it up.
      db.prepare(`UPDATE tickets SET updated_at = ?, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END WHERE id = ?`).bind(now, ticket.id),
    ]);
    return json({ ticket: await ticketDetail(ctx, ticket.id) }, 201);
  } },
];
