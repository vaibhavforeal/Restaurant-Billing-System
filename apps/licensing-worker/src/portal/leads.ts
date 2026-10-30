import { z } from "zod";
import { activityPage } from "./activity.js";
import { LEAD_STAGES, type FollowUp, type LeadDetail, type LeadSummary } from "./api-types.js";
import { withFreshCode } from "./codes.js";
import { assertCan, logBy, path, queryInt, type Ctx, type Route } from "./context.js";
import { followUpsWhere } from "./followups.js";
import { conflict, HttpError, json, notFound, readBody } from "./http.js";
import { ownedBy } from "./scope.js";
import { GST_STATES, seesOnlyOwn } from "./shared.js";

const PAGE = 50;
const STAGE_NAMES: Record<string, string> = { new: "New", contacted: "Contacted", demo_scheduled: "Demo booked", demo_done: "Demo given", proposal: "Proposal sent", won: "Won", lost: "Lost" };
const text = (max: number) => z.string().trim().max(max).transform((v) => v || null);
const LeadFields = z.object({
  businessName: z.string().trim().min(1, "Enter the business name").max(120), contactName: text(80),
  phone: z.string().trim().regex(/^([+0-9][0-9 -]{5,18})?$/, "Enter a phone number").transform((v) => v || null),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email("Enter a valid email").max(254)]).transform((v) => v || null),
  city: text(80), stateCode: z.string().refine((v) => v === "" || v in GST_STATES, "Choose a state").transform((v) => v || null),
  source: z.enum(["walk_in", "referral", "website", "call", "partner", "event", "other"]),
  expectedPlan: z.enum(["basic", "pro"]).nullable(), expectedOutlets: z.number().int().min(1).max(500).nullable(),
  estimatedValuePaise: z.number().int().min(0).max(10_000_000_000).nullable(), notes: text(2000),
  ownerId: z.string().uuid().nullable().optional(),
}).strict();

const SUMMARY = `l.id, l.business_name AS businessName, l.contact_name AS contactName, l.phone, l.city, l.source, l.stage, l.expected_plan AS expectedPlan,
  l.expected_outlets AS expectedOutlets, l.estimated_value_paise AS estimatedValuePaise, l.owner_id AS ownerId, u.name AS ownerName,
  (SELECT MIN(f.due_at) FROM follow_ups f WHERE f.lead_id = l.id AND f.status = 'open') AS nextFollowUpAt,
  l.created_at AS createdAt, l.stage_changed_at AS stageChangedAt, l.customer_id AS customerId`;
type Row = Omit<LeadSummary, "owner"> & { ownerId: string | null; ownerName: string | null };
const toSummary = ({ ownerId, ownerName, ...r }: Row): LeadSummary => ({ ...r, owner: ownerId ? { id: ownerId, name: ownerName ?? "Former staff" } : null });

/** The lead when the staff member may see it: reps see the leads assigned to them. */
export async function visibleLead(ctx: Ctx, id: string) {
  assertCan(ctx.user, "leads.read");
  const scope = ownedBy(ctx.user, "l.owner_id");
  const row = await ctx.deps.db.prepare(`SELECT ${SUMMARY}, l.email, l.state_code AS stateCode, l.lost_reason AS lostReason, l.notes, l.closed_at AS closedAt
    FROM leads l LEFT JOIN staff_users u ON u.id = l.owner_id WHERE l.id = ? AND ${scope.sql}`).bind(id, ...scope.binds)
    .first<Row & { email: string | null; stateCode: string | null; lostReason: string | null; notes: string | null; closedAt: number | null }>();
  if (!row) throw notFound("That lead");
  return row;
}

async function leadDetail(ctx: Ctx, id: string): Promise<LeadDetail> {
  const { email, stateCode, lostReason, notes, closedAt, ...row } = await visibleLead(ctx, id);
  const followUps: FollowUp[] = await followUpsWhere(ctx, "f.lead_id = ?", [id], "f.status = 'open' DESC, f.due_at");
  return { ...toSummary(row), email, stateCode, lostReason, notes, closedAt, followUps };
}

async function checkOwner(ctx: Ctx, ownerId: string | null | undefined) {
  if (!ownerId) return;
  if (!(await ctx.deps.db.prepare(`SELECT 1 AS hit FROM staff_users WHERE id = ? AND active = 1 AND role IN ('admin', 'sales')`).bind(ownerId).first())) {
    throw new HttpError(400, "Assign the lead to an active admin or sales rep");
  }
}

export const leadRoutes: Route[] = [
  { method: "GET", path: path("/leads"), permission: "leads.read", handler: async (ctx) => {
    const q = ctx.url.searchParams, scope = ownedBy(ctx.user, "l.owner_id");
    const base = [scope.sql], baseBinds: unknown[] = [...scope.binds];
    if (q.get("ownerId")) { base.push("l.owner_id = ?"); baseBinds.push(q.get("ownerId")); }
    const search = q.get("q")?.trim();
    if (search) { base.push("(l.business_name LIKE ? OR l.contact_name LIKE ? OR l.phone LIKE ? OR l.city LIKE ?)"); baseBinds.push(...Array(4).fill(`%${search.replace(/[%_]/g, "")}%`)); }
    const where = [...base], binds = [...baseBinds];
    const stage = q.get("stage");
    if (stage === "open") where.push("l.stage NOT IN ('won', 'lost')");
    else if (stage && (LEAD_STAGES as readonly string[]).includes(stage)) { where.push("l.stage = ?"); binds.push(stage); }
    if (q.get("source")) { where.push("l.source = ?"); binds.push(q.get("source")); }
    const offset = Math.max(0, queryInt(ctx.url, "offset", 0)!);
    const from = `FROM leads l LEFT JOIN staff_users u ON u.id = l.owner_id`;
    const [{ results }, total, counts] = await Promise.all([
      ctx.deps.db.prepare(`SELECT ${SUMMARY} ${from} WHERE ${where.join(" AND ")} ORDER BY nextFollowUpAt IS NULL, nextFollowUpAt, l.updated_at DESC LIMIT ? OFFSET ?`).bind(...binds, PAGE, offset).all<Row>(),
      ctx.deps.db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${where.join(" AND ")}`).bind(...binds).first<{ n: number }>(),
      ctx.deps.db.prepare(`SELECT l.stage, COUNT(*) AS n ${from} WHERE ${base.join(" AND ")} GROUP BY l.stage`).bind(...baseBinds).all<{ stage: string; n: number }>(),
    ]);
    return json({ leads: results.map(toSummary), total: total!.n, offset, pageSize: PAGE, counts: Object.fromEntries(counts.results.map((c) => [c.stage, c.n])) });
  } },

  { method: "POST", path: path("/leads"), permission: "leads.write", handler: async (ctx) => {
    const body = await readBody(ctx.request, LeadFields);
    const ownerId = seesOnlyOwn(ctx.user.role) ? ctx.user.id : body.ownerId === undefined ? ctx.user.id : body.ownerId;
    await checkOwner(ctx, ownerId);
    const { db } = ctx.deps, now = ctx.deps.now(), id = ctx.deps.uuid();
    await db.batch([
      db.prepare(`INSERT INTO leads (id, business_name, contact_name, phone, email, city, state_code, source, expected_plan, expected_outlets, estimated_value_paise, owner_id, notes,
          created_by, created_at, updated_at, stage_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, body.businessName, body.contactName, body.phone, body.email, body.city, body.stateCode, body.source, body.expectedPlan, body.expectedOutlets,
          body.estimatedValuePaise, ownerId, body.notes, ctx.user.id, now, now, now),
      logBy(ctx, { action: "lead.created", entityType: "lead", entityId: id, customerId: null, summary: `Added lead ${body.businessName}` }),
    ]);
    return json({ lead: await leadDetail(ctx, id) }, 201);
  } },

  { method: "GET", path: path("/leads/:id"), permission: "leads.read", handler: async (ctx) => json({ lead: await leadDetail(ctx, ctx.params[0]!) }) },

  { method: "PATCH", path: path("/leads/:id"), permission: "leads.write", handler: async (ctx) => {
    const before = await visibleLead(ctx, ctx.params[0]!);
    const body = await readBody(ctx.request, LeadFields);
    const ownerChange = body.ownerId !== undefined && body.ownerId !== before.ownerId;
    if (ownerChange && seesOnlyOwn(ctx.user.role)) throw new HttpError(403, "Only an admin can move a lead to another rep", "forbidden");
    if (ownerChange) await checkOwner(ctx, body.ownerId);
    const { db } = ctx.deps, now = ctx.deps.now();
    await db.batch([
      db.prepare(`UPDATE leads SET business_name = ?, contact_name = ?, phone = ?, email = ?, city = ?, state_code = ?, source = ?, expected_plan = ?, expected_outlets = ?,
          estimated_value_paise = ?, owner_id = ?, notes = ?, updated_at = ? WHERE id = ?`)
        .bind(body.businessName, body.contactName, body.phone, body.email, body.city, body.stateCode, body.source, body.expectedPlan, body.expectedOutlets,
          body.estimatedValuePaise, ownerChange ? body.ownerId! : before.ownerId, body.notes, now, before.id),
      logBy(ctx, { action: ownerChange ? "lead.reassigned" : "lead.changed", entityType: "lead", entityId: before.id, customerId: null,
        summary: ownerChange ? `Moved lead ${body.businessName} to another rep` : `Edited lead ${body.businessName}` }),
    ]);
    return json({ lead: await leadDetail(ctx, before.id) });
  } },

  // Moving through the pipeline. 'won' happens by converting the lead into a customer; 'lost' needs the reason.
  { method: "POST", path: path("/leads/:id/stage"), permission: "leads.write", handler: async (ctx) => {
    const before = await visibleLead(ctx, ctx.params[0]!);
    const { stage, lostReason } = await readBody(ctx.request, z.object({
      stage: z.enum(["new", "contacted", "demo_scheduled", "demo_done", "proposal", "lost"]), lostReason: z.string().trim().max(300).optional(),
    }).strict());
    if (before.stage === "won") throw conflict("This lead is already a customer.", "won");
    if (stage === "lost" && !lostReason) throw new HttpError(400, "Say why the lead was lost");
    if (stage === before.stage) return json({ lead: await leadDetail(ctx, before.id) });
    const { db } = ctx.deps, now = ctx.deps.now();
    await db.batch([
      db.prepare(`UPDATE leads SET stage = ?, lost_reason = ?, stage_changed_at = ?, closed_at = ?, updated_at = ? WHERE id = ?`)
        .bind(stage, stage === "lost" ? lostReason : null, now, stage === "lost" ? now : null, now, before.id),
      // A lost lead needs no more calls.
      ...(stage === "lost" ? [db.prepare(`UPDATE follow_ups SET status = 'cancelled', updated_at = ? WHERE lead_id = ? AND status = 'open'`).bind(now, before.id)] : []),
      logBy(ctx, { action: "lead.stage", entityType: "lead", entityId: before.id, customerId: null,
        summary: `${before.businessName}: ${STAGE_NAMES[before.stage]} → ${STAGE_NAMES[stage]}${stage === "lost" ? ` (${lostReason})` : ""}` }),
    ]);
    return json({ lead: await leadDetail(ctx, before.id) });
  } },

  // The lead becomes a customer with a Customer ID, keeping its rep; its open follow-ups move to the customer.
  { method: "POST", path: path("/leads/:id/convert"), permission: "leads.write", handler: async (ctx) => {
    assertCan(ctx.user, "customers.write");
    const lead = await visibleLead(ctx, ctx.params[0]!);
    if (lead.customerId) throw conflict("This lead is already a customer.", "won");
    const { db } = ctx.deps, now = ctx.deps.now(), id = ctx.deps.uuid();
    const code = await withFreshCode("customer", async (code) => {
      await db.batch([
        db.prepare(`INSERT INTO customers (id, code, business_name, contact_name, phone, email, city, state_code, owner_id, notes, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(id, code, lead.businessName, lead.contactName, lead.phone, lead.email, lead.city, lead.stateCode, lead.ownerId ?? ctx.user.id, lead.notes, ctx.user.id, now, now),
        db.prepare(`UPDATE leads SET stage = 'won', customer_id = ?, stage_changed_at = ?, closed_at = ?, updated_at = ? WHERE id = ?`).bind(id, now, now, now, lead.id),
        db.prepare(`UPDATE follow_ups SET lead_id = NULL, customer_id = ?, updated_at = ? WHERE lead_id = ? AND status = 'open'`).bind(id, now, lead.id),
        logBy(ctx, { action: "lead.converted", entityType: "customer", entityId: id, customerId: id, summary: `Converted lead ${lead.businessName} into customer ${code}` }),
      ]);
      return code;
    });
    return json({ customerId: id, code }, 201);
  } },

  { method: "GET", path: path("/leads/:id/activity"), permission: "leads.read", handler: async (ctx) => {
    const lead = await visibleLead(ctx, ctx.params[0]!);
    return json(await activityPage(ctx.deps.db, ["a.entity_type = 'lead'", "a.entity_id = ?"], [lead.id], queryInt(ctx.url, "before")));
  } },
];
