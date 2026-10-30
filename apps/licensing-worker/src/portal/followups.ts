import { z } from "zod";
import type { FollowUp } from "./api-types.js";
import { logBy, path, type Ctx, type Route } from "./context.js";
import { conflict, HttpError, json, notFound, readBody } from "./http.js";
import { visibleLead } from "./leads.js";
import { visibleCustomer } from "./scope.js";
import { roleCan } from "./shared.js";

interface Row {
  id: string; kind: FollowUp["kind"]; dueAt: number; note: string; status: FollowUp["status"]; outcome: string | null; doneAt: number | null;
  ownerId: string; ownerName: string; leadId: string | null; leadName: string | null; customerId: string | null; customerName: string | null; phone: string | null;
}

/** Follow-ups matching `where` (columns of `f`), with whose they are and what they are about. The caller has checked scope. */
export async function followUpsWhere(ctx: Ctx, where: string, binds: unknown[], order = "f.due_at", limit = 200): Promise<FollowUp[]> {
  const { results } = await ctx.deps.db.prepare(`SELECT f.id, f.kind, f.due_at AS dueAt, f.note, f.status, f.outcome, f.done_at AS doneAt, f.owner_id AS ownerId, u.name AS ownerName,
      f.lead_id AS leadId, l.business_name AS leadName, f.customer_id AS customerId, c.business_name AS customerName, COALESCE(c.phone, l.phone) AS phone
    FROM follow_ups f JOIN staff_users u ON u.id = f.owner_id LEFT JOIN leads l ON l.id = f.lead_id LEFT JOIN customers c ON c.id = f.customer_id
    WHERE ${where} ORDER BY ${order} LIMIT ?`).bind(...binds, limit).all<Row>();
  return results.map((r) => ({
    id: r.id, kind: r.kind, dueAt: r.dueAt, note: r.note, status: r.status, outcome: r.outcome, doneAt: r.doneAt, phone: r.phone,
    owner: { id: r.ownerId, name: r.ownerName }, lead: r.leadId ? { id: r.leadId, name: r.leadName ?? "" } : null, customer: r.customerId ? { id: r.customerId, name: r.customerName ?? "" } : null,
  }));
}

const NewFollowUp = z.object({
  leadId: z.string().uuid().optional(), customerId: z.string().uuid().optional(),
  kind: z.enum(["call", "visit", "demo", "whatsapp", "email", "renewal", "payment", "other"]),
  dueAt: z.number().int().positive(), note: z.string().trim().min(1, "Say what to do").max(500), ownerId: z.string().uuid().optional(),
}).strict().refine((f) => (f.leadId === undefined) !== (f.customerId === undefined), "A follow-up is about one lead or one customer");
const FollowUpChange = z.object({
  status: z.enum(["open", "done", "cancelled"]).optional(), outcome: z.string().trim().max(500).optional(),
  dueAt: z.number().int().positive().optional(), note: z.string().trim().min(1).max(500).optional(),
}).strict();

/** A follow-up its owner works on, or one on a record the staff member may see (an admin sees all). */
async function visibleFollowUp(ctx: Ctx, id: string) {
  const [row] = await followUpsWhere(ctx, "f.id = ?", [id]);
  if (!row) throw notFound("That follow-up");
  if (row.owner.id === ctx.user.id || ctx.user.role === "admin") return row;
  try {
    if (row.lead) await visibleLead(ctx, row.lead.id);
    else await visibleCustomer(ctx, row.customer!.id);
  } catch { throw notFound("That follow-up"); }
  return row;
}

export const followUpRoutes: Route[] = [
  { method: "GET", path: path("/customers/:id/follow-ups"), permission: "customers.read", handler: async (ctx) => {
    const customer = await visibleCustomer(ctx, ctx.params[0]!);
    return json({ followUps: await followUpsWhere(ctx, "f.customer_id = ?", [customer.id], "f.status = 'open' DESC, f.due_at") });
  } },

  // "Mine" by default: what this person has to do, overdue first. Admins may look at anyone's.
  { method: "GET", path: path("/follow-ups"), permission: "followups.write", handler: async (ctx) => {
    const q = ctx.url.searchParams, where: string[] = [], binds: unknown[] = [];
    const ownerId = q.get("ownerId");
    if (ownerId && ctx.user.role === "admin") { if (ownerId !== "all") { where.push("f.owner_id = ?"); binds.push(ownerId); } }
    else { where.push("f.owner_id = ?"); binds.push(ctx.user.id); }
    const status = q.get("status") ?? "open";
    if (status !== "all") { where.push("f.status = ?"); binds.push(status); }
    const before = q.get("before");
    if (before) { where.push("f.due_at < ?"); binds.push(Number(before)); }
    return json({ followUps: await followUpsWhere(ctx, where.join(" AND ") || "1 = 1", binds, status === "open" ? "f.due_at" : "f.updated_at DESC") });
  } },

  { method: "POST", path: path("/follow-ups"), permission: "followups.write", handler: async (ctx) => {
    const body = await readBody(ctx.request, NewFollowUp);
    let about: { id: string; name: string; customerId: string | null };
    if (body.leadId) {
      if (!roleCan(ctx.user.role, "leads.read")) throw notFound("That lead");
      const lead = await visibleLead(ctx, body.leadId);
      if (lead.stage === "won" || lead.stage === "lost") throw conflict("This lead is closed. Add the follow-up to the customer instead.", "closed");
      about = { id: lead.id, name: lead.businessName, customerId: null };
    } else {
      const customer = await visibleCustomer(ctx, body.customerId!);
      about = { id: customer.id, name: customer.name, customerId: customer.id };
    }
    const ownerId = body.ownerId && ctx.user.role === "admin" ? body.ownerId : ctx.user.id;
    if (ownerId !== ctx.user.id && !(await ctx.deps.db.prepare(`SELECT 1 AS hit FROM staff_users WHERE id = ? AND active = 1`).bind(ownerId).first())) {
      throw new HttpError(400, "Give the follow-up to an active colleague");
    }
    const { db } = ctx.deps, now = ctx.deps.now(), id = ctx.deps.uuid();
    await db.batch([
      db.prepare(`INSERT INTO follow_ups (id, lead_id, customer_id, kind, due_at, note, owner_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, body.leadId ?? null, body.customerId ?? null, body.kind, body.dueAt, body.note, ownerId, ctx.user.id, now, now),
      logBy(ctx, { action: "followup.created", entityType: body.leadId ? "lead" : "customer", entityId: about.id, customerId: about.customerId,
        summary: `Follow-up with ${about.name}: ${body.note}` }),
    ]);
    return json({ followUp: (await followUpsWhere(ctx, "f.id = ?", [id]))[0] }, 201);
  } },

  { method: "PATCH", path: path("/follow-ups/:id"), permission: "followups.write", handler: async (ctx) => {
    const before = await visibleFollowUp(ctx, ctx.params[0]!);
    const change = await readBody(ctx.request, FollowUpChange);
    const { db } = ctx.deps, now = ctx.deps.now();
    const status = change.status ?? before.status;
    const closing = status !== "open" && before.status === "open";
    await db.batch([
      db.prepare(`UPDATE follow_ups SET status = ?, outcome = COALESCE(?, outcome), due_at = ?, note = ?, done_at = ?, done_by = ?, updated_at = ? WHERE id = ?`)
        .bind(status, change.outcome ?? null, change.dueAt ?? before.dueAt, change.note ?? before.note, status === "done" ? (closing ? now : before.doneAt) : null,
          status === "done" ? ctx.user.id : null, now, before.id),
      ...(closing || change.dueAt ? [logBy(ctx, { action: closing ? `followup.${status}` : "followup.moved", entityType: before.lead ? "lead" : "customer",
        entityId: before.lead?.id ?? before.customer!.id, customerId: before.customer?.id ?? null,
        summary: closing ? `${status === "done" ? "Done" : "Dropped"}: ${before.note}${change.outcome ? ` (${change.outcome})` : ""}` : `Moved the follow-up "${before.note}"` })] : []),
    ]);
    return json({ followUp: (await followUpsWhere(ctx, "f.id = ?", [before.id]))[0] });
  } },
];
