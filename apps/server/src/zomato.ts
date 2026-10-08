import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Database } from "@forkflow/domain";
import { parseZomatoCsv, ZOMATO_STATUSES, type ZomatoImportKind, type ZomatoImportPreview, type ZomatoOrder,
  type ZomatoReconciliation, type ZomatoReconciliationRow, type ZomatoSettings } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";
import { integrationEnabled } from "./integrations.js";
import { reportRange } from "./sales-reports.js";

const identifier = z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/);
const paise = z.number().int().min(0).max(1_000_000_000);
const status = z.enum(ZOMATO_STATUSES);
const paymentMode = z.enum(["prepaid", "cod", "unknown"]);
const timestamp = z.number().int().min(946684800000).max(4102444800000);
const orderSnapshot = z.object({ placedAt: timestamp, totalPaise: paise, paymentMode,
  items: z.array(z.object({ name: z.string().trim().min(1).max(200), quantity: z.number().positive().max(10000), note: z.string().max(500).default("") })).max(500) });
export const ZomatoEvent = z.object({ eventId: identifier, restaurantId: identifier, orderId: identifier,
  occurredAt: timestamp, status, order: orderSnapshot.optional() });

/** Implement only against the organization-gated reference and registered authentication.
 * Verification must reject unauthorized requests BEFORE returning any decoded events.
 * The adapter owns Zomato's wire fields and acknowledgement format; no guessed payloads.
 * Credentials stay in the adapter's server-side secret store, never in settings or responses.
 */
export interface ZomatoProvider {
  verifyAndDecode(request: { headers: IncomingHttpHeaders; rawBody: Buffer }): Promise<{
    events: z.input<typeof ZomatoEvent>[];
    acknowledgement: { statusCode: 200 | 201 | 202 | 204; body: unknown };
  }>;
}
interface ConfigRow {
  restaurant_id: string; restaurant_name: string; pos_id: string; webhook_base_url: string;
  enabled: number; version: number; last_event_at: number | null;
}
interface OrderRow {
  restaurant_id: string; order_id: string; placed_at: number; status: ZomatoOrder["status"];
  total_paise: number; payment_mode: ZomatoOrder["paymentMode"]; items_json: string;
  source: ZomatoOrder["source"]; status_at: number; updated_at: number; import_json: string | null;
}
const config = (db: Database) => db.prepare("SELECT * FROM zomato_settings WHERE id=1").get() as ConfigRow;
const findOrder = (db: Database, restaurant: string, order: string) => db.prepare("SELECT * FROM zomato_orders WHERE restaurant_id=? AND order_id=?").get(restaurant, order) as OrderRow | undefined;
const orderJson = (row: OrderRow): ZomatoOrder => ({ restaurantId: row.restaurant_id, orderId: row.order_id,
  placedAt: row.placed_at, status: row.status, totalPaise: row.total_paise, paymentMode: row.payment_mode,
  items: JSON.parse(row.items_json), source: row.source, updatedAt: row.updated_at });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const finalStatuses = new Set(["delivered", "cancelled", "rejected"]);
const rank: Record<ZomatoOrder["status"], number> = { received: 0, confirmed: 1, preparing: 2, ready: 3, picked_up: 4, delivered: 5, rejected: 5, cancelled: 5 };

/** Called inside a transaction. Unknown-order status events are retained for later relay. */
function ingestEvent(db: Database, event: z.output<typeof ZomatoEvent>) {
  const json = JSON.stringify(event);
  const old = db.prepare("SELECT payload_json FROM zomato_events WHERE restaurant_id=? AND event_id=?").get(event.restaurantId, event.eventId) as { payload_json: string } | undefined;
  if (old) {
    if (old.payload_json !== json) throw httpError(409, "Conflicting replay of a Zomato event");
    return;
  }
  db.prepare("INSERT INTO zomato_events (restaurant_id,event_id,order_id,occurred_at,payload_json,received_at) VALUES (?,?,?,?,?,?)")
    .run(event.restaurantId, event.eventId, event.orderId, event.occurredAt, json, Date.now());
  let row = findOrder(db, event.restaurantId, event.orderId);
  if (!row && event.order) {
    const o = event.order;
    db.prepare(`INSERT INTO zomato_orders (restaurant_id,order_id,placed_at,status,total_paise,payment_mode,items_json,source,status_at,updated_at)
      VALUES (?,?,?,'received',?,?,?,'webhook',0,?)`).run(event.restaurantId, event.orderId, o.placedAt, o.totalPaise, o.paymentMode, JSON.stringify(o.items), Date.now());
    row = findOrder(db, event.restaurantId, event.orderId)!;
  }
  if (!row) return;
  // Do not silently rewrite imported financial history or a previous relay snapshot.
  if (event.order && (row.total_paise !== event.order.totalPaise || row.placed_at !== event.order.placedAt || row.payment_mode !== event.order.paymentMode))
    throw httpError(409, "Order snapshot differs from the stored Zomato order; review the provider mapping");
  const events = db.prepare("SELECT payload_json FROM zomato_events WHERE restaurant_id=? AND order_id=? ORDER BY occurred_at,event_id").all(event.restaurantId, event.orderId) as { payload_json: string }[];
  let next = row.status, statusAt = row.status_at;
  for (const saved of events) {
    const e = JSON.parse(saved.payload_json) as z.output<typeof ZomatoEvent>;
    if (e.occurredAt < statusAt || finalStatuses.has(next) || rank[e.status] < rank[next]) continue;
    next = e.status; statusAt = e.occurredAt;
  }
  db.prepare("UPDATE zomato_orders SET status=?,status_at=?,source='webhook',items_json=?,updated_at=? WHERE restaurant_id=? AND order_id=?")
    .run(next, statusAt, event.order ? JSON.stringify(event.order.items) : row.items_json, Date.now(), event.restaurantId, event.orderId);
}

function rupees(value: string | undefined, signed = false): number {
  if (!value || !(signed ? /^-?\d{1,8}(?:\.\d{1,2})?$/ : /^\d{1,8}(?:\.\d{1,2})?$/).test(value)) throw new Error("Amounts must be rupees with up to two decimals (no commas or currency symbols).");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (amount > 1_000_000_000) throw new Error("Amount exceeds the per-entry limit.");
  return negative ? -amount : amount;
}
function dateOnly(value: string | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Use a valid date in YYYY-MM-DD format.");
  return value;
}
interface ImportRow { orderId: string; json: string; reference: string; amountPaise: number; values: (string | number)[] }
function importRows(csv: string, kind: ZomatoImportKind, restaurant: string): ImportRow[] {
  if (!restaurant) throw httpError(409, "Save your Zomato restaurant ID in Connection first.");
  let input: Record<string, string>[];
  try { input = parseZomatoCsv(csv, kind); } catch (error) { throw httpError(400, (error as Error).message); }
  const keys = new Set<string>();
  return input.map((r, index) => {
    try {
      if (r.restaurant_id !== restaurant) throw new Error("Restaurant ID does not match the saved connection.");
      const orderId = identifier.parse(r.order_id);
      if (kind === "orders") {
        if (!r.ordered_at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(r.ordered_at)) throw new Error("ordered_at must be an ISO timestamp with Z or an explicit timezone offset.");
        dateOnly(r.ordered_at.slice(0, 10));
        const placed = timestamp.parse(Date.parse(r.ordered_at)), state = status.parse(r.status), mode = paymentMode.parse(r.payment_mode), amount = rupees(r.order_total);
        if (keys.has(orderId)) throw new Error("Duplicate order ID within this file."); keys.add(orderId);
        const values = [restaurant, orderId, placed, state, amount, mode];
        return { orderId, json: JSON.stringify(values), reference: "", amountPaise: amount, values };
      }
      const entry = identifier.parse(r.entry_id), reference = identifier.parse(r.settlement_reference), date = dateOnly(r.settlement_date);
      if (keys.has(entry)) throw new Error("Duplicate entry ID within this file."); keys.add(entry);
      const gross = rupees(r.gross_amount), deductions = rupees(r.deductions), additions = rupees(r.additions), paid = rupees(r.net_paid, true);
      const values = [restaurant, entry, orderId, reference, date, gross, deductions, additions, paid];
      return { orderId, json: JSON.stringify(values), reference, amountPaise: paid, values };
    } catch (error) {
      const message = error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid field" : (error as Error).message;
      throw httpError(400, `Data row ${index + 1}: ${message}`);
    }
  });
}

function preview(db: Database, kind: ZomatoImportKind, rows: ImportRow[]): ZomatoImportPreview {
  const existing = rows.map(row => kind === "orders"
    ? findOrder(db, String(row.values[0]), row.orderId)
    : db.prepare("SELECT * FROM zomato_settlements WHERE restaurant_id=? AND entry_id=?").get(row.values[0]!, row.values[1]!) as { import_json: string } | undefined);
  const actions = rows.map((row, i) => {
    const old = existing[i];
    if (old && old.import_json !== row.json) throw httpError(409, `Order ${row.orderId}: this ${kind === "orders" ? "order" : "entry ID"} already exists with different data. Existing records are never overwritten; use a new entry ID for a settlement adjustment.`);
    return { orderId: row.orderId, reference: row.reference, amountPaise: row.amountPaise, action: old ? "Skip duplicate" as const : "Add" as const };
  });
  const added = actions.filter(row => row.action === "Add").length;
  return { kind, revision: digest({ kind, rows, existing, version: config(db).version }), added, skipped: rows.length - added, rows: actions };
}

function reconciliation(db: Database, query: unknown): ZomatoReconciliation {
  const { from, to, bounds } = reportRange(query), restaurantId = config(db).restaurant_id;
  // A cohort of orders placed OR settled in the range. Aggregate ALL statement entries
  // for each included order so split settlements across periods cannot create false mismatches.
  const ids = db.prepare(`SELECT order_id FROM zomato_orders WHERE restaurant_id=? AND placed_at>=? AND placed_at<?
    UNION SELECT order_id FROM zomato_settlements WHERE restaurant_id=? AND settlement_date>=? AND settlement_date<=? LIMIT 2001`)
    .all(restaurantId, ...bounds, restaurantId, from, to) as { order_id: string }[];
  if (ids.length > 2000) throw httpError(400, "More than 2,000 orders in this period. Choose a shorter date range.");
  const rows: ZomatoReconciliationRow[] = ids.map(({ order_id }) => {
    const order = findOrder(db, restaurantId, order_id);
    const s = db.prepare(`SELECT COUNT(*) AS entries, COALESCE(SUM(gross_paise),0) AS gross, COALESCE(SUM(deductions_paise),0) AS deductions,
      COALESCE(SUM(additions_paise),0) AS additions, COALESCE(SUM(paid_paise),0) AS paid FROM zomato_settlements WHERE restaurant_id=? AND order_id=?`).get(restaurantId, order_id) as { entries: number; gross: number; deductions: number; additions: number; paid: number };
    const references = (db.prepare("SELECT DISTINCT reference FROM zomato_settlements WHERE restaurant_id=? AND order_id=? ORDER BY reference").all(restaurantId, order_id) as { reference: string }[]).map(r => r.reference);
    const expected = s.gross - s.deductions + s.additions, orderDifference = order && s.entries ? s.gross - order.total_paise : null;
    const state = !order ? "missing_order" : !s.entries ? "awaiting_statement" : order.status === "cancelled" || order.status === "rejected" ? "review_cancellation"
      : orderDifference !== 0 || s.paid !== expected ? "mismatch" : "matched";
    return { orderId: order_id, placedAt: order?.placed_at ?? null, orderStatus: order?.status ?? null, orderTotalPaise: order?.total_paise ?? null,
      statementGrossPaise: s.gross, deductionsPaise: s.deductions, additionsPaise: s.additions, expectedNetPaise: expected, paidPaise: s.paid,
      orderDifferencePaise: orderDifference, payoutDifferencePaise: s.paid - expected, entries: s.entries, references, state };
  });
  rows.sort((a, b) => (b.placedAt ?? 0) - (a.placedAt ?? 0) || a.orderId.localeCompare(b.orderId));
  const totals: ZomatoReconciliation["totals"] = { orderTotalPaise: 0, statementGrossPaise: 0, deductionsPaise: 0, additionsPaise: 0, expectedNetPaise: 0, paidPaise: 0, payoutDifferencePaise: 0, matched: 0, needsReview: 0 };
  for (const row of rows) {
    for (const key of ["orderTotalPaise", "statementGrossPaise", "deductionsPaise", "additionsPaise", "expectedNetPaise", "paidPaise", "payoutDifferencePaise"] as const) totals[key] += row[key] ?? 0;
    if (row.state === "matched") totals.matched++; else totals.needsReview++;
  }
  return { from, to, restaurantId, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, generatedAt: Date.now(), rows, totals };
}

export function registerZomato(app: FastifyInstance, provider?: ZomatoProvider) {
  const read = app.requirePermission("zomato.read"), manage = app.requirePermission("zomato.configure"), importing = app.requirePermission("zomato.import");
  const settings = (): ZomatoSettings => {
    const c = config(app.db);
    return { restaurantId: c.restaurant_id, restaurantName: c.restaurant_name, posId: c.pos_id, webhookBaseUrl: c.webhook_base_url,
      enabled: !!c.enabled, version: c.version, adapterConfigured: !!provider, lastEventAt: c.last_event_at };
  };
  app.get("/api/zomato/settings", { preHandler: read }, async (_req, reply) => { reply.header("Cache-Control", "no-store"); return settings(); });
  app.patch("/api/zomato/settings", { preHandler: manage }, async (req) => {
    const body = z.object({ restaurantId: identifier, restaurantName: z.string().trim().max(160), posId: z.string().trim().max(160),
      webhookBaseUrl: z.string().trim().max(500), enabled: z.boolean(), version: z.number().int().positive() }).parse(req.body);
    if (body.webhookBaseUrl) {
      let url: URL; try { url = new URL(body.webhookBaseUrl); } catch { throw httpError(400, "Use a valid public HTTPS origin for the webhook service"); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "") || url.hostname === "localhost" || url.hostname.endsWith(".local") || /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith("["))
        throw httpError(400, "Use a public HTTPS origin without credentials, paths, query strings or IP addresses");
    }
    app.db.transaction(() => {
      const current = config(app.db);
      if (current.version !== body.version) throw httpError(409, "Connection settings changed. Refresh before saving.");
      if (body.enabled && (!provider || !body.posId || !body.webhookBaseUrl)) throw httpError(409, "Live activation needs an approved provider adapter, POS ID and registered HTTPS webhook service.");
      if (body.restaurantId !== current.restaurant_id) {
        const used = app.db.prepare("SELECT 1 FROM zomato_orders UNION ALL SELECT 1 FROM zomato_settlements UNION ALL SELECT 1 FROM zomato_events LIMIT 1").get();
        if (used) throw httpError(409, "This ledger already belongs to the saved restaurant ID and cannot be reassigned.");
      }
      app.db.prepare("UPDATE zomato_settings SET restaurant_id=?,restaurant_name=?,pos_id=?,webhook_base_url=?,enabled=?,version=version+1 WHERE id=1")
        .run(body.restaurantId, body.restaurantName, body.posId, body.webhookBaseUrl.replace(/\/$/, ""), body.enabled ? 1 : 0);
    })();
    app.broadcast("zomato.changed", {}); return settings();
  });
  app.get("/api/zomato/orders", { preHandler: read }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    const restaurant = config(app.db).restaurant_id;
    const rows = app.db.prepare("SELECT * FROM zomato_orders WHERE restaurant_id=? AND status NOT IN ('delivered','rejected','cancelled') ORDER BY placed_at LIMIT 501").all(restaurant) as OrderRow[];
    return { orders: rows.slice(0, 500).map(orderJson), truncated: rows.length > 500, generatedAt: Date.now() };
  });
  app.get("/api/zomato/reconciliation", { preHandler: read }, async (req, reply) => { reply.header("Cache-Control", "no-store"); return reconciliation(app.db, req.query); });
  app.get("/api/zomato/imports", { preHandler: read }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { imports: app.db.prepare(`SELECT i.id,i.kind,i.added,i.skipped,i.created_at AS createdAt,u.name AS actor FROM zomato_imports i JOIN users u ON u.id=i.actor_id
      WHERE i.restaurant_id=? ORDER BY i.created_at DESC LIMIT 30`).all(config(app.db).restaurant_id) };
  });
  const importBody = z.object({ kind: z.enum(["orders", "settlements"]), csv: z.string().min(1).max(2_000_000), revision: z.string().length(64).optional() });
  for (const action of ["preview", "commit"] as const) {
    app.post(`/api/zomato/import/${action}`, { preHandler: importing, bodyLimit: 2_100_000 }, async (req) => {
      const body = importBody.parse(req.body);
      const result = app.db.transaction(() => {
        const restaurant = config(app.db).restaurant_id, rows = importRows(body.csv, body.kind, restaurant), checked = preview(app.db, body.kind, rows);
        if (action === "preview") return checked;
        if (!body.revision) throw httpError(400, "Preview the CSV before importing.");
        if (body.revision !== checked.revision) {
          // A lost commit response is safe to replay only for the exact same request and actor.
          const id = digest({ actor: req.user.id, kind: body.kind, csv: body.csv, revision: body.revision, restaurant });
          if (app.db.prepare("SELECT 1 FROM zomato_imports WHERE id=?").get(id)) return checked;
          throw httpError(409, "The ledger changed after this preview. Preview the file again.");
        }
        for (const [i, row] of rows.entries()) {
          if (checked.rows[i]!.action !== "Add") continue;
          if (body.kind === "orders") {
            app.db.prepare(`INSERT INTO zomato_orders (restaurant_id,order_id,placed_at,status,total_paise,payment_mode,source,status_at,updated_at,import_json)
              VALUES (?,?,?,?,?,?,'import',?,?,?)`).run(...row.values, row.values[2]!, Date.now(), row.json);
          } else {
            app.db.prepare(`INSERT INTO zomato_settlements (restaurant_id,entry_id,order_id,reference,settlement_date,gross_paise,deductions_paise,additions_paise,paid_paise,import_json,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(...row.values, row.json, Date.now());
          }
        }
        const id = digest({ actor: req.user.id, kind: body.kind, csv: body.csv, revision: body.revision, restaurant });
        app.db.prepare("INSERT OR IGNORE INTO zomato_imports (id,kind,restaurant_id,added,skipped,actor_id,created_at) VALUES (?,?,?,?,?,?,?)")
          .run(id, body.kind, restaurant, checked.added, checked.skipped, req.user.id, Date.now());
        return checked;
      })();
      if (action === "commit") app.broadcast("zomato.changed", {});
      return result;
    });
  }
  // Raw bytes are preserved in this isolated parser for the eventual official signature verifier.
  app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.post("/api/integrations/zomato/webhook", { bodyLimit: 1_048_576 }, async (req, reply) => {
      const current = config(app.db);
      if (!integrationEnabled(app.db, "zomato")) return reply.code(503).send({ error: "Zomato is turned off in the Marketplace" });
      if (!provider || !current.enabled) return reply.code(503).send({ error: "Zomato live integration is not configured" });
      let decoded: Awaited<ReturnType<ZomatoProvider["verifyAndDecode"]>>;
      try { decoded = await provider.verifyAndDecode({ headers: req.headers, rawBody: req.body as Buffer }); }
      catch { return reply.code(401).send({ error: "Webhook authentication or decoding failed" }); }
      const events = z.array(ZomatoEvent).min(1).max(50).parse(decoded.events);
      app.db.transaction(() => {
        // Settings can change while signature verification is awaiting a remote key.
        const latest = config(app.db);
        if (!integrationEnabled(app.db, "zomato")) throw httpError(409, "Zomato was turned off in the Marketplace; retry the webhook");
        if (!latest.enabled || latest.version !== current.version) throw httpError(409, "Connection settings changed; retry the webhook");
        for (const event of events) {
          if (event.restaurantId !== latest.restaurant_id) throw httpError(403, "Webhook restaurant does not match this ledger");
          ingestEvent(app.db, event);
        }
        app.db.prepare("UPDATE zomato_settings SET last_event_at=? WHERE id=1").run(Date.now());
      })();
      app.broadcast("zomato.changed", {});
      return reply.code(decoded.acknowledgement.statusCode).send(decoded.acknowledgement.body);
    });
  });
}
