import type { Plan } from "@forkflow/domain/licensing";
import type { D1Like, D1StatementLike, Period } from "./env.js";

export interface InstallationRow {
  installationId: string; licenseId: string; organizationId: string; outletId: string;
  trialStartedAt: number | null; contactEmail: string | null; createdAt: number; revisionFloor: number;
}
export interface LicenseRow {
  installationId: string; revision: number; plan: Plan; issuedAt: number; expiresAt: number; graceUntil: number;
  envelope: string; reason: "trial" | "charge"; razorpaySubscriptionId: string | null; razorpayPaymentId: string | null;
}
export interface SubscriptionRow {
  razorpaySubscriptionId: string; installationId: string; plan: Plan; period: Period;
  status: string; currentPeriodEnd: number | null; createdAt: number;
}

const INSTALLATION_COLUMNS = `installation_id AS installationId, license_id AS licenseId, organization_id AS organizationId, outlet_id AS outletId,
  trial_started_at AS trialStartedAt, contact_email AS contactEmail, created_at AS createdAt, revision_floor AS revisionFloor`;
const LICENSE_COLUMNS = `installation_id AS installationId, revision, plan, issued_at AS issuedAt, expires_at AS expiresAt, grace_until AS graceUntil,
  envelope, reason, razorpay_subscription_id AS razorpaySubscriptionId, razorpay_payment_id AS razorpayPaymentId`;
const SUBSCRIPTION_COLUMNS = `razorpay_subscription_id AS razorpaySubscriptionId, installation_id AS installationId, plan, period, status,
  current_period_end AS currentPeriodEnd, created_at AS createdAt`;

export const getInstallation = (db: D1Like, installationId: string) =>
  db.prepare(`SELECT ${INSTALLATION_COLUMNS} FROM installations WHERE installation_id = ?`).bind(installationId).first<InstallationRow>();

export async function createInstallation(db: D1Like, row: Pick<InstallationRow, "installationId" | "licenseId" | "organizationId" | "outletId" | "trialStartedAt" | "revisionFloor" | "createdAt">): Promise<void> {
  await db.prepare(`INSERT INTO installations (installation_id, license_id, organization_id, outlet_id, trial_started_at, created_at, revision_floor)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id) DO NOTHING`)
    .bind(row.installationId, row.licenseId, row.organizationId, row.outletId, row.trialStartedAt, row.createdAt, row.revisionFloor).run();
}

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

export async function otherActiveSubscriptions(db: D1Like, installationId: string, exceptId: string): Promise<SubscriptionRow[]> {
  const { results } = await db.prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
    WHERE installation_id = ? AND razorpay_subscription_id != ? AND status NOT IN ('cancelled', 'completed', 'expired', 'halted')`)
    .bind(installationId, exceptId).all<SubscriptionRow>();
  return results;
}
