import type { Plan } from "@masalapos/domain/licensing";
import { ModuleOverridesSchema, type ModuleId, type ModuleOverrides } from "@masalapos/domain/modules";
import type { D1Like, D1StatementLike } from "./env.js";

export interface InstallationRow {
  installationId: string; licenseId: string; organizationId: string; outletId: string; createdAt: number; revisionFloor: number; secretHash: string | null;
  /** Set once the counter enrols with a Customer ID and Order ID; `orderId` is the new or trial order whose seat it holds. */
  customerId: string | null; orderId: string | null;
  /** Devices sold with the order; null follows the plan. Every licence issued for the installation uses it. */
  maxDevices: number | null;
  outletName: string | null; activatedAt: number | null; lastSeenAt: number | null; appVersion: string | null;
}
export type LicenseReason = "order" | "manual" | "owner";
export interface LicenseRow {
  installationId: string; revision: number; plan: Plan; issuedAt: number; expiresAt: number; graceUntil: number;
  envelope: string; reason: LicenseReason; orderId: string | null;
}

export const INSTALLATION_COLUMNS = `installation_id AS installationId, license_id AS licenseId, organization_id AS organizationId, outlet_id AS outletId,
  created_at AS createdAt, revision_floor AS revisionFloor, secret_hash AS secretHash, customer_id AS customerId, order_id AS orderId,
  max_devices AS maxDevices, outlet_name AS outletName, activated_at AS activatedAt, last_seen_at AS lastSeenAt, app_version AS appVersion`;
export const LICENSE_COLUMNS = `installation_id AS installationId, revision, plan, issued_at AS issuedAt, expires_at AS expiresAt, grace_until AS graceUntil,
  envelope, reason, order_id AS orderId`;

export const getInstallation = (db: D1Like, installationId: string) =>
  db.prepare(`SELECT ${INSTALLATION_COLUMNS} FROM installations WHERE installation_id = ?`).bind(installationId).first<InstallationRow>();

export async function createInstallation(db: D1Like, row: Pick<InstallationRow, "installationId" | "licenseId" | "organizationId" | "outletId" | "revisionFloor" | "createdAt" | "secretHash">): Promise<void> {
  await db.prepare(`INSERT INTO installations (installation_id, license_id, organization_id, outlet_id, created_at, revision_floor, secret_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id) DO NOTHING`)
    .bind(row.installationId, row.licenseId, row.organizationId, row.outletId, row.createdAt, row.revisionFloor, row.secretHash).run();
}

/** Trust on first use: sets the hash only while it is still NULL, so a claim never overwrites an existing secret. */
export const claimSecretStatement = (db: D1Like, installationId: string, secretHash: string): D1StatementLike =>
  db.prepare(`UPDATE installations SET secret_hash = ? WHERE installation_id = ? AND secret_hash IS NULL`).bind(secretHash, installationId);

/** The floor only ever rises: it records the highest revision the counter is known to hold (reported by it, or handed to it). */
export const raiseRevisionFloorStatement = (db: D1Like, installationId: string, revision: number): D1StatementLike =>
  db.prepare(`UPDATE installations SET revision_floor = MAX(revision_floor, ?) WHERE installation_id = ?`).bind(revision, installationId);

/** What a counter reports on each check, so the portal can show when it was last online and what it runs. */
export const touchInstallationStatement = (db: D1Like, installationId: string, at: number, appVersion: string | null, outletName: string | null): D1StatementLike =>
  db.prepare(`UPDATE installations SET last_seen_at = ?, app_version = COALESCE(?, app_version), outlet_name = COALESCE(?, outlet_name) WHERE installation_id = ?`)
    .bind(at, appVersion, outletName, installationId);

export const latestLicense = (db: D1Like, installationId: string) =>
  db.prepare(`SELECT ${LICENSE_COLUMNS} FROM licenses WHERE installation_id = ? ORDER BY revision DESC LIMIT 1`).bind(installationId).first<LicenseRow>();

export async function nextRevision(db: D1Like, installationId: string): Promise<number> {
  const row = await db.prepare(`SELECT MAX(
      COALESCE((SELECT MAX(revision) FROM licenses WHERE installation_id = ?), 0),
      COALESCE((SELECT revision_floor FROM installations WHERE installation_id = ?), 0)) AS top`).bind(installationId, installationId).first<{ top: number }>();
  return (row?.top ?? 0) + 1;
}

export const insertLicenseStatement = (db: D1Like, r: LicenseRow): D1StatementLike =>
  db.prepare(`INSERT INTO licenses (installation_id, revision, plan, issued_at, expires_at, grace_until, envelope, reason, order_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(r.installationId, r.revision, r.plan, r.issuedAt, r.expiresAt, r.graceUntil, r.envelope, r.reason, r.orderId);

/** For racing writers: a duplicate (installation, revision) is skipped, so the caller re-reads the winner. */
export const insertLicenseIfAbsentStatement = (db: D1Like, r: LicenseRow): D1StatementLike =>
  db.prepare(`INSERT OR IGNORE INTO licenses (installation_id, revision, plan, issued_at, expires_at, grace_until, envelope, reason, order_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(r.installationId, r.revision, r.plan, r.issuedAt, r.expiresAt, r.graceUntil, r.envelope, r.reason, r.orderId);

export const recordEventStatement = (db: D1Like, eventId: string, type: string, outcome: string, now: number): D1StatementLike =>
  db.prepare(`INSERT INTO webhook_events (event_id, type, outcome, received_at) VALUES (?, ?, ?, ?)`).bind(eventId, type, outcome, now);

export async function eventSeen(db: D1Like, eventId: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS hit FROM webhook_events WHERE event_id = ?`).bind(eventId).first()) !== null;
}

/** The owner's choices for a restaurant: its display name and the modules allowed or blocked beyond its plan. */
export interface OwnerSettings { displayName: string | null; overrides: ModuleOverrides; updatedAt: number | null }

/** A row written by an older catalogue keeps working: unknown modules are dropped rather than failing issuance. */
export function parseOverrides(json: string): ModuleOverrides {
  const parsed = ModuleOverridesSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : {};
}

export async function getOwnerSettings(db: D1Like, installationId: string): Promise<OwnerSettings> {
  const row = await db.prepare(`SELECT display_name AS displayName, overrides, updated_at AS updatedAt FROM owner_settings WHERE installation_id = ?`)
    .bind(installationId).first<{ displayName: string | null; overrides: string; updatedAt: number }>();
  if (!row) return { displayName: null, overrides: {}, updatedAt: null };
  return { displayName: row.displayName, overrides: parseOverrides(row.overrides), updatedAt: row.updatedAt };
}

export const upsertOwnerSettingsStatement = (db: D1Like, installationId: string, displayName: string | null, overrides: ModuleOverrides, now: number): D1StatementLike =>
  db.prepare(`INSERT INTO owner_settings (installation_id, display_name, overrides, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(installation_id) DO UPDATE SET display_name = excluded.display_name, overrides = excluded.overrides, updated_at = excluded.updated_at`)
    .bind(installationId, displayName, JSON.stringify(overrides), now);

/** Only the module choices; the display name is kept. */
export const setOverridesStatement = (db: D1Like, installationId: string, overrides: ModuleOverrides, now: number): D1StatementLike =>
  db.prepare(`INSERT INTO owner_settings (installation_id, overrides, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(installation_id) DO UPDATE SET overrides = excluded.overrides, updated_at = excluded.updated_at`)
    .bind(installationId, JSON.stringify(overrides), now);

export const insertOwnerEventStatement = (db: D1Like, installationId: string, moduleId: ModuleId, allowed: boolean | null, revision: number | null, at: number, actorId: string | null = null): D1StatementLike =>
  db.prepare(`INSERT INTO owner_events (installation_id, module_id, allowed, revision, at, actor_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(installationId, moduleId, allowed === null ? null : allowed ? 1 : 0, revision, at, actorId);

export interface OwnerEvent { id: number; moduleId: string; allowed: boolean | null; revision: number | null; at: number; actorName: string | null }
export async function ownerEvents(db: D1Like, installationId: string, limit = 100): Promise<OwnerEvent[]> {
  const { results } = await db.prepare(`SELECT e.id, e.module_id AS moduleId, e.allowed, e.revision, e.at, u.name AS actorName
    FROM owner_events e LEFT JOIN staff_users u ON u.id = e.actor_id WHERE e.installation_id = ? ORDER BY e.id DESC LIMIT ?`)
    .bind(installationId, limit).all<{ id: number; moduleId: string; allowed: number | null; revision: number | null; at: number; actorName: string | null }>();
  return results.map((r) => ({ ...r, allowed: r.allowed === null ? null : r.allowed === 1 }));
}

export interface ActivityEntry {
  actorId: string | null; action: string; entityType: string; entityId: string; customerId: string | null; summary: string; data?: unknown;
}
/** Written in the same batch as the change it describes, so the log never claims a change that rolled back. */
export const activityStatement = (db: D1Like, at: number, e: ActivityEntry): D1StatementLike =>
  db.prepare(`INSERT INTO activity_log (at, actor_id, action, entity_type, entity_id, customer_id, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(at, e.actorId, e.action, e.entityType, e.entityId, e.customerId, e.summary, e.data === undefined ? null : JSON.stringify(e.data));
