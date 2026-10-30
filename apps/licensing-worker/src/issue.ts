import type { Plan } from "@forkflow/domain/licensing";
import type { ModuleOverrides } from "@forkflow/domain/modules";
import { buildClaims, encodeEnvelope, readClaims, type Signer } from "@forkflow/license-issuer";
import type { D1Like, D1StatementLike } from "./env.js";
import { getOwnerSettings, insertLicenseStatement, latestLicense, nextRevision, type InstallationRow, type LicenseReason, type LicenseRow } from "./store.js";

export interface Deps { db: D1Like; signer: { sign: Signer; fingerprint: string }; now: () => number; uuid: () => string }

export interface IssueInput {
  installation: InstallationRow; plan: Plan; expiresAt: number; graceUntil: number; trial: boolean;
  reason: LicenseReason;
  /** The order these terms come from; its Order ID goes into the licence. */
  orderId: string | null;
  /** The module choices to sign, when the caller is about to store new ones in the same batch; otherwise the stored ones. */
  modules?: ModuleOverrides;
}

/**
 * Builds and signs the next revision for an installation. Returns the insert unrun so callers can batch it.
 * Every licence carries the installation's devices, its customer's and order's codes, and the owner's module choices, whatever
 * the reason it is issued, so a later re-issue never quietly drops something that was sold.
 */
export async function issueLicense(deps: Deps, input: IssueInput): Promise<{ row: LicenseRow; statement: D1StatementLike }> {
  const i = input.installation, { db } = deps;
  const [revision, modules, customerCode, orderCode] = await Promise.all([
    nextRevision(db, i.installationId),
    input.modules ?? getOwnerSettings(db, i.installationId).then((s) => s.overrides),
    i.customerId ? db.prepare(`SELECT code FROM customers WHERE id = ?`).bind(i.customerId).first<{ code: string }>().then((r) => r?.code) : undefined,
    input.orderId ? db.prepare(`SELECT code FROM orders WHERE id = ?`).bind(input.orderId).first<{ code: string }>().then((r) => r?.code) : undefined,
  ]);
  const now = deps.now();
  // The installation row owns the identifiers and the revision comes from the store, so present buildClaims with a renewal of revision - 1.
  const claims = buildClaims({
    format: "forkflow-activation-request", version: 1, installationId: i.installationId, licenseId: i.licenseId,
    organizationId: i.organizationId, outletId: i.outletId, currentRevision: revision - 1, generatedAt: now,
    verificationKeyFingerprint: deps.signer.fingerprint,
  }, {
    plan: input.plan, expiresAt: input.expiresAt, graceUntil: input.graceUntil, trial: input.trial, modules,
    ...(i.maxDevices !== null ? { maxDevices: i.maxDevices } : {}),
    ...(customerCode ? { customerCode } : {}),
    ...(orderCode ? { orderCode } : {}),
  }, now, deps.uuid);
  const row: LicenseRow = {
    installationId: i.installationId, revision, plan: input.plan, issuedAt: now, expiresAt: input.expiresAt, graceUntil: input.graceUntil,
    envelope: await encodeEnvelope(claims, deps.signer.sign), reason: input.reason, orderId: input.orderId,
  };
  return { row, statement: insertLicenseStatement(db, row) };
}

/**
 * Re-signs an installation's current licence as the next revision, with `changes` applied: after a module change ('owner') or a
 * staff adjustment ('manual'). The counter picks it up on its next check. Returns null (nothing to sign) when the installation has no
 * licence, or its licence has run out and the change does not give it a new end date.
 */
export async function reissueLicense(
  deps: Deps, installation: InstallationRow, reason: Exclude<LicenseReason, "order">,
  changes: Partial<Pick<IssueInput, "plan" | "expiresAt" | "graceUntil" | "trial" | "modules">> = {},
): Promise<{ row: LicenseRow; statement: D1StatementLike } | null> {
  const latest = await latestLicense(deps.db, installation.installationId);
  if (!latest) return null;
  const expiresAt = changes.expiresAt ?? latest.expiresAt;
  if (expiresAt <= deps.now()) return null;
  return issueLicense(deps, {
    installation, plan: changes.plan ?? latest.plan, expiresAt, graceUntil: changes.graceUntil ?? latest.graceUntil,
    trial: changes.trial ?? readClaims(latest.envelope).trial === true, reason, orderId: latest.orderId,
    ...(changes.modules ? { modules: changes.modules } : {}),
  });
}
