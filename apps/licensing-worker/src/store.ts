import type { Plan } from "@forkflow/domain/licensing";
import { ModuleOverridesSchema, type ModuleId, type ModuleOverrides } from "@forkflow/domain/modules";
import type { D1Like, D1StatementLike, Period } from "./env.js";

export interface InstallationRow {
  installationId: string; licenseId: string; organizationId: string; outletId: string;
  trialStartedAt: number | null; contactEmail: string | null; createdAt: number; revisionFloor: number; secretHash: string | null;
}
export interface LicenseRow {
  installationId: string; revision: number; plan: Plan; issuedAt: number; expiresAt: number; graceUntil: number;
  envelope: string; reason: "trial" | "charge" | "owner"; razorpaySubscriptionId: string | null; razorpayPaymentId: string | null;
}
export interface SubscriptionRow {
  razorpaySubscriptionId: string; installationId: string; plan: Plan; period: Period;
  status: string; currentPeriodEnd: number | null; createdAt: number;
}

const INSTALLATION_COLUMNS = `installation_id AS installationId, license_id AS licenseId, organization_id AS organizationId, outlet_id AS outletId,
  trial_started_at AS trialStartedAt, contact_email AS contactEmail, created_at AS createdAt, revision_floor AS revisionFloor, secret_hash AS secretHash`;
const LICENSE_COLUMNS = `installation_id AS installationId, revision, plan, issued_at AS issuedAt, expires_at AS expiresAt, grace_until AS graceUntil,
  envelope, reason, razorpay_subscription_id AS razorpaySubscriptionId, razorpay_payment_id AS razorpayPaymentId`;
const SUBSCRIPTION_COLUMNS = `razorpay_subscription_id AS razorpaySubscriptionId, installation_id AS installationId, plan, period, status,
  current_period_end AS currentPeriodEnd, created_at AS createdAt`;

export const getInstallation = (db: D1Like, installationId: string) =>
  db.prepare(`SELECT ${INSTALLATION_COLUMNS} FROM installations WHERE installation_id = ?`).bind(installationId).first<InstallationRow>();

export async function createInstallation(db: D1Like, row: Pick<InstallationRow, "installationId" | "licenseId" | "organizationId" | "outletId" | "trialStartedAt" | "revisionFloor" | "createdAt" | "secretHash">): Promise<void> {
  await db.prepare(`INSERT INTO installations (installation_id, license_id, organization_id, outlet_id, trial_started_at, created_at, revision_floor, secret_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id) DO NOTHING`)
    .bind(row.installationId, row.licenseId, row.organizationId, row.outletId, row.trialStartedAt, row.createdAt, row.revisionFloor, row.secretHash).run();
}

/** Trust on first use: sets the hash only while it is still NULL, so a claim never overwrites an existing secret. */
export const claimSecretStatement = (db: D1Like, installationId: string, secretHash: string): D1StatementLike =>
  db.prepare(`UPDATE installations SET secret_hash = ? WHERE installation_id = ? AND secret_hash IS NULL`).bind(secretHash, installationId);

/** Only the SHA-256 of a session token is stored. */
export const insertSessionStatement = (db: D1Like, r: { tokenHash: string; installationId: string; expiresAt: number; createdAt: number }): D1StatementLike =>
  db.prepare(`INSERT INTO subscribe_sessions (token_hash, installation_id, expires_at, created_at) VALUES (?, ?, ?, ?)`).bind(r.tokenHash, r.installationId, r.expiresAt, r.createdAt);

export const deleteExpiredSessionsStatement = (db: D1Like, installationId: string, now: number): D1StatementLike =>
  db.prepare(`DELETE FROM subscribe_sessions WHERE installation_id = ? AND expires_at <= ?`).bind(installationId, now);

/** The installation a session belongs to, while it is unexpired (a session expires at `expires_at`). */
export async function sessionInstallation(db: D1Like, tokenHash: string, now: number): Promise<string | null> {
  return (await db.prepare(`SELECT installation_id AS installationId FROM subscribe_sessions WHERE token_hash = ? AND expires_at > ?`).bind(tokenHash, now).first<{ installationId: string }>())?.installationId ?? null;
}

/** The floor only ever rises: it records the highest revision the counter is known to hold (reported by it, or handed to it). */
export const raiseRevisionFloorStatement = (db: D1Like, installationId: string, revision: number): D1StatementLike =>
  db.prepare(`UPDATE installations SET revision_floor = MAX(revision_floor, ?) WHERE installation_id = ?`).bind(revision, installationId);

export const setContactEmailStatement = (db: D1Like, installationId: string, email: string): D1StatementLike =>
  db.prepare(`UPDATE installations SET contact_email = ? WHERE installation_id = ?`).bind(email, installationId);

export const latestLicense = (db: D1Like, installationId: string) =>
  db.prepare(`SELECT ${LICENSE_COLUMNS} FROM licenses WHERE installation_id = ? ORDER BY revision DESC LIMIT 1`).bind(installationId).first<LicenseRow>();

export async function nextRevision(db: D1Like, installationId: string): Promise<number> {
  const row = await db.prepare(`SELECT MAX(
      COALESCE((SELECT MAX(revision) FROM licenses WHERE installation_id = ?), 0),
      COALESCE((SELECT revision_floor FROM installations WHERE installation_id = ?), 0)) AS top`).bind(installationId, installationId).first<{ top: number }>();
  return (row?.top ?? 0) + 1;
}

export const latestLicenseForSubscription = (db: D1Like, subscriptionId: string) =>
  db.prepare(`SELECT ${LICENSE_COLUMNS} FROM licenses WHERE razorpay_subscription_id = ? ORDER BY expires_at DESC, revision DESC LIMIT 1`).bind(subscriptionId).first<LicenseRow>();

export const insertLicenseStatement = (db: D1Like, r: LicenseRow): D1StatementLike =>
  db.prepare(`INSERT INTO licenses (installation_id, revision, plan, issued_at, expires_at, grace_until, envelope, reason, razorpay_subscription_id, razorpay_payment_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(r.installationId, r.revision, r.plan, r.issuedAt, r.expiresAt, r.graceUntil, r.envelope, r.reason, r.razorpaySubscriptionId, r.razorpayPaymentId);

/** For racing writers (the trial): a duplicate (installation, revision) is skipped, so the caller re-reads the winner. */
export const insertLicenseIfAbsentStatement = (db: D1Like, r: LicenseRow): D1StatementLike =>
  db.prepare(`INSERT OR IGNORE INTO licenses (installation_id, revision, plan, issued_at, expires_at, grace_until, envelope, reason, razorpay_subscription_id, razorpay_payment_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(r.installationId, r.revision, r.plan, r.issuedAt, r.expiresAt, r.graceUntil, r.envelope, r.reason, r.razorpaySubscriptionId, r.razorpayPaymentId);

export const upsertSubscriptionStatement = (db: D1Like, r: SubscriptionRow): D1StatementLike =>
  db.prepare(`INSERT INTO subscriptions (razorpay_subscription_id, installation_id, plan, period, status, current_period_end, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(razorpay_subscription_id) DO UPDATE SET
      plan = excluded.plan, period = excluded.period, status = excluded.status, current_period_end = excluded.current_period_end`)
    .bind(r.razorpaySubscriptionId, r.installationId, r.plan, r.period, r.status, r.currentPeriodEnd, r.createdAt);

export const recordEventStatement = (db: D1Like, eventId: string, type: string, outcome: string, now: number): D1StatementLike =>
  db.prepare(`INSERT INTO webhook_events (event_id, type, outcome, received_at) VALUES (?, ?, ?, ?)`).bind(eventId, type, outcome, now);

export async function eventSeen(db: D1Like, eventId: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS hit FROM webhook_events WHERE event_id = ?`).bind(eventId).first()) !== null;
}

export async function paymentUsed(db: D1Like, paymentId: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS hit FROM licenses WHERE razorpay_payment_id = ?`).bind(paymentId).first()) !== null;
}

export const getSubscription = (db: D1Like, id: string) =>
  db.prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE razorpay_subscription_id = ?`).bind(id).first<SubscriptionRow>();

/** True when the installation has another subscription created strictly after `createdAt` that has already been charged (issued a licence). */
export async function newerChargedSubscriptionExists(db: D1Like, installationId: string, createdAt: number, exceptId: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS hit FROM subscriptions s
    WHERE s.installation_id = ? AND s.razorpay_subscription_id != ? AND s.created_at > ?
      AND EXISTS (SELECT 1 FROM licenses l WHERE l.razorpay_subscription_id = s.razorpay_subscription_id AND l.reason = 'charge') LIMIT 1`)
    .bind(installationId, exceptId, createdAt).first()) !== null;
}

/** Subscriptions of the installation created strictly before `beforeCreatedAt` that can still bill (a halted one can be resumed by Razorpay, so it counts). */
export async function olderOpenSubscriptions(db: D1Like, installationId: string, beforeCreatedAt: number, exceptId: string): Promise<SubscriptionRow[]> {
  const { results } = await db.prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
    WHERE installation_id = ? AND razorpay_subscription_id != ? AND created_at < ? AND status NOT IN ('cancelled', 'completed', 'expired')`)
    .bind(installationId, exceptId, beforeCreatedAt).all<SubscriptionRow>();
  return results;
}

/** The owner's choices for a restaurant: its display name and the modules allowed or blocked beyond its plan. */
export interface OwnerSettings { displayName: string | null; overrides: ModuleOverrides; updatedAt: number | null }

export async function getOwnerSettings(db: D1Like, installationId: string): Promise<OwnerSettings> {
  const row = await db.prepare(`SELECT display_name AS displayName, overrides, updated_at AS updatedAt FROM owner_settings WHERE installation_id = ?`)
    .bind(installationId).first<{ displayName: string | null; overrides: string; updatedAt: number }>();
  if (!row) return { displayName: null, overrides: {}, updatedAt: null };
  // A row written by an older catalogue keeps working: unknown modules are dropped rather than failing issuance.
  const parsed = ModuleOverridesSchema.safeParse(JSON.parse(row.overrides));
  return { displayName: row.displayName, overrides: parsed.success ? parsed.data : {}, updatedAt: row.updatedAt };
}

export const upsertOwnerSettingsStatement = (db: D1Like, installationId: string, displayName: string | null, overrides: ModuleOverrides, now: number): D1StatementLike =>
  db.prepare(`INSERT INTO owner_settings (installation_id, display_name, overrides, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(installation_id) DO UPDATE SET display_name = excluded.display_name, overrides = excluded.overrides, updated_at = excluded.updated_at`)
    .bind(installationId, displayName, JSON.stringify(overrides), now);

export const insertOwnerEventStatement = (db: D1Like, installationId: string, moduleId: ModuleId, allowed: boolean | null, revision: number | null, at: number): D1StatementLike =>
  db.prepare(`INSERT INTO owner_events (installation_id, module_id, allowed, revision, at) VALUES (?, ?, ?, ?, ?)`)
    .bind(installationId, moduleId, allowed === null ? null : allowed ? 1 : 0, revision, at);

export interface OwnerEvent { id: number; moduleId: string; allowed: boolean | null; revision: number | null; at: number }
export async function ownerEvents(db: D1Like, installationId: string, limit = 100): Promise<OwnerEvent[]> {
  const { results } = await db.prepare(`SELECT id, module_id AS moduleId, allowed, revision, at FROM owner_events WHERE installation_id = ? ORDER BY id DESC LIMIT ?`)
    .bind(installationId, limit).all<{ id: number; moduleId: string; allowed: number | null; revision: number | null; at: number }>();
  return results.map((r) => ({ ...r, allowed: r.allowed === null ? null : r.allowed === 1 }));
}

export const listInstallations = async (db: D1Like) =>
  (await db.prepare(`SELECT ${INSTALLATION_COLUMNS} FROM installations ORDER BY created_at DESC`).all<InstallationRow>()).results;

export const insertOwnerSessionStatement = (db: D1Like, tokenHash: string, expiresAt: number): D1StatementLike =>
  db.prepare(`INSERT INTO owner_sessions (token_hash, expires_at) VALUES (?, ?)`).bind(tokenHash, expiresAt);
export const deleteExpiredOwnerSessionsStatement = (db: D1Like, now: number): D1StatementLike =>
  db.prepare(`DELETE FROM owner_sessions WHERE expires_at <= ?`).bind(now);
export const deleteOwnerSessionStatement = (db: D1Like, tokenHash: string): D1StatementLike =>
  db.prepare(`DELETE FROM owner_sessions WHERE token_hash = ?`).bind(tokenHash);
export async function ownerSessionValid(db: D1Like, tokenHash: string, now: number): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS hit FROM owner_sessions WHERE token_hash = ? AND expires_at > ?`).bind(tokenHash, now).first()) !== null;
}
