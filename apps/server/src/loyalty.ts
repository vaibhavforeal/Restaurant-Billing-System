import {
  LoyaltyTierCreate, LoyaltyTierUpdate, addMonths, expireRef, expiringSoon, expiryDue, tierFor, uuidv7,
  type Database, type LedgerEntry, type TierRule,
} from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { requireIntegration } from "./integrations.js";

export interface LoyaltySettings {
  enabled: boolean; pointsPer100: number; pointValuePaise: number; minRedeemPoints: number;
  /** Months after earning that points expire; 0 = never. */
  expiryMonths: number;
  tiersEnabled: boolean; tierWindowMonths: number;
  /** The most of a bill's total, in percent, that points may pay. */
  maxRedeemPercent: number;
  feedbackEnabled: boolean;
}

export function loyaltySettings(db: Database): LoyaltySettings {
  const r = db.prepare(`SELECT enabled, points_per_100, point_value_paise, min_redeem_points, expiry_months, tiers_enabled, tier_window_months,
    max_redeem_percent, feedback_enabled FROM loyalty_settings WHERE id = 1`).get() as {
      enabled: number; points_per_100: number; point_value_paise: number; min_redeem_points: number; expiry_months: number;
      tiers_enabled: number; tier_window_months: number; max_redeem_percent: number; feedback_enabled: number;
    };
  return {
    enabled: r.enabled === 1, pointsPer100: r.points_per_100, pointValuePaise: r.point_value_paise, minRedeemPoints: r.min_redeem_points,
    expiryMonths: r.expiry_months, tiersEnabled: r.tiers_enabled === 1, tierWindowMonths: r.tier_window_months,
    maxRedeemPercent: r.max_redeem_percent, feedbackEnabled: r.feedback_enabled === 1,
  };
}

export type LoyaltyTier = TierRule;
export const loyaltyTiers = (db: Database): LoyaltyTier[] =>
  (db.prepare("SELECT id, name, min_spend_paise, earn_multiplier, is_active FROM loyalty_tiers ORDER BY min_spend_paise, name COLLATE NOCASE").all() as
    Array<{ id: string; name: string; min_spend_paise: number; earn_multiplier: number; is_active: number }>)
    .map((r) => ({ id: r.id, name: r.name, minSpendPaise: r.min_spend_paise, earnMultiplier: r.earn_multiplier, isActive: r.is_active === 1 }));

/** What a customer spent since `since`: bill totals less refunds, leaving out void bills. */
export function customerSpend(db: Database, customerId: string, since = 0): number {
  return (db.prepare(`SELECT COALESCE(SUM(b.total_paise), 0)
      - COALESCE((SELECT SUM(cn.total_paise) FROM credit_notes cn JOIN bills x ON x.id = cn.bill_id
          WHERE x.customer_id = ? AND x.status <> 'void' AND x.created_at >= ?), 0) AS n
    FROM bills b WHERE b.customer_id = ? AND b.status <> 'void' AND b.created_at >= ?`).get(customerId, since, customerId, since) as { n: number }).n;
}

export interface CustomerTier { id: string; name: string; earnMultiplier: number; windowSpendPaise: number; next: { name: string; minSpendPaise: number } | null }

/** The customer's tier from their spend over the tier window, or null when tiers are off or no tier is reached. Never stored. */
export function currentTier(db: Database, customerId: string, now = Date.now(), settings = loyaltySettings(db)): CustomerTier | null {
  if (!settings.tiersEnabled) return null;
  const tiers = loyaltyTiers(db).filter((t) => t.isActive);
  if (!tiers.length) return null;
  const spend = customerSpend(db, customerId, addMonths(now, -settings.tierWindowMonths));
  const tier = tierFor(tiers, spend);
  const next = tiers.find((t) => t.minSpendPaise > spend) ?? null;
  return tier ? { id: tier.id, name: tier.name, earnMultiplier: tier.earnMultiplier, windowSpendPaise: spend, next: next && { name: next.name, minSpendPaise: next.minSpendPaise } } : null;
}

const ledgerOf = (db: Database, customerId: string) =>
  db.prepare(`SELECT id, kind, points, created_at AS createdAt, expires_at AS expiresAt, client_ref AS clientRef FROM loyalty_ledger WHERE customer_id = ?`).all(customerId) as LedgerEntry[];

/**
 * Writes an `expire` row for each lot of the customer's points that has passed its expiry date. The row's `client_ref`
 * names the lot, so running it again (or from two places at once) writes nothing new. Call inside a transaction when
 * the caller reads the balance straight after.
 */
export function sweepExpiry(db: Database, customerId: string, now = Date.now()): number {
  const due = expiryDue(ledgerOf(db, customerId), now);
  const insert = db.prepare(`INSERT OR IGNORE INTO loyalty_ledger (id, customer_id, kind, points, note, created_at, created_by, client_ref)
    VALUES (?, ?, 'expire', ?, ?, ?, ?, ?)`);
  // The ledger needs a user; expiry is the restaurant's own doing, so it is recorded against the first admin.
  const actor = due.length ? systemActor(db) : null;
  let expired = 0;
  for (const lot of due) {
    const res = insert.run(uuidv7(), customerId, -lot.points, "Points expired", now, actor, expireRef(lot.lotId));
    if (res.changes) expired += lot.points;
  }
  return expired;
}

/** Sweeps every customer holding points that could have expired. Returns the points expired. */
export function sweepAllExpiry(db: Database, now = Date.now()): number {
  const ids = db.prepare("SELECT DISTINCT customer_id AS id FROM loyalty_ledger WHERE expires_at IS NOT NULL AND expires_at <= ?").all(now) as Array<{ id: string }>;
  let total = 0;
  for (const { id } of ids) total += db.transaction(() => sweepExpiry(db, id, now))();
  return total;
}

function systemActor(db: Database): string {
  const row = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1").get() as { id: string } | undefined;
  if (!row) throw new Error("no admin user to record points expiry");
  return row.id;
}

/** The points a customer can spend now: the ledger balance less points past their expiry that no sweep has written yet. */
export function spendableBalance(db: Database, customerId: string, now = Date.now()): number {
  const entries = ledgerOf(db, customerId);
  const balance = entries.reduce((sum, e) => sum + e.points, 0);
  return balance - expiryDue(entries, now).reduce((sum, d) => sum + d.points, 0);
}

/** When points earned now would expire, or null when expiry is off. */
export const earnExpiry = (settings: LoyaltySettings, now: number) => settings.expiryMonths > 0 ? addMonths(now, settings.expiryMonths) : null;

/** Points expiring in the next 30 days. */
export function pointsExpiringSoon(db: Database, customerId: string, now = Date.now()) {
  return expiringSoon(ledgerOf(db, customerId), now, 30 * 86_400_000);
}

const SWEEP_EVERY = 6 * 60 * 60 * 1000;
/** Expires points at start-up and every six hours while the server runs. */
export function scheduleExpirySweeps(app: FastifyInstance): void {
  const run = () => {
    try {
      const expired = sweepAllExpiry(app.db);
      if (expired) app.log.info({ expired }, "loyalty points expired");
    } catch (err) { app.log.error({ err }, "loyalty expiry sweep failed"); }
  };
  run();
  const timer = setInterval(run, SWEEP_EVERY);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}

export function registerLoyaltyTiers(app: FastifyInstance): void {
  const db = app.db;
  const crm = requireIntegration(app, "crm");
  const read = [app.requirePermission("customers.read"), crm];
  const admin = [app.requirePermission("settings.manage"), crm];
  const nameTaken = (name: string, exceptId = "") => {
    if (db.prepare("SELECT 1 FROM loyalty_tiers WHERE name = ? COLLATE NOCASE AND id <> ?").get(name, exceptId)) throw httpError(409, "A tier with this name already exists");
  };
  const tierJson = (id: string) => loyaltyTiers(db).find((t) => t.id === id)!;

  app.get("/api/loyalty-tiers", { preHandler: read }, async () => ({ tiers: loyaltyTiers(db) }));
  app.post("/api/loyalty-tiers", { preHandler: admin }, async (req, reply) => {
    const body = LoyaltyTierCreate.parse(req.body);
    nameTaken(body.name);
    const id = uuidv7();
    db.prepare("INSERT INTO loyalty_tiers (id, name, min_spend_paise, earn_multiplier, created_at) VALUES (?, ?, ?, ?, ?)").run(id, body.name, body.minSpendPaise, body.earnMultiplier, Date.now());
    return reply.status(201).send({ tier: tierJson(id) });
  });
  app.patch("/api/loyalty-tiers/:id", { preHandler: admin }, async (req) => {
    const { id } = req.params as { id: string };
    const body = LoyaltyTierUpdate.parse(req.body);
    const row = loyaltyTiers(db).find((t) => t.id === id);
    if (!row) throw httpError(404, "tier not found");
    if (body.name) nameTaken(body.name, id);
    db.prepare("UPDATE loyalty_tiers SET name = ?, min_spend_paise = ?, earn_multiplier = ?, is_active = ? WHERE id = ?").run(
      body.name ?? row.name, body.minSpendPaise ?? row.minSpendPaise, body.earnMultiplier ?? row.earnMultiplier,
      (body.isActive ?? row.isActive) ? 1 : 0, id);
    return { tier: tierJson(id) };
  });
}
