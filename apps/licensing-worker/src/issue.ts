import type { Plan } from "@masalapos/domain/licensing";
import { buildClaims, encodeEnvelope, readClaims, type Signer } from "@masalapos/license-issuer";
import type { D1Like, D1StatementLike } from "./env.js";
import { getOwnerSettings, insertLicenseStatement, latestLicense, nextRevision, type InstallationRow, type LicenseRow } from "./store.js";

export interface Deps { db: D1Like; signer: { sign: Signer; fingerprint: string }; now: () => number; uuid: () => string }

export interface IssueInput {
  installation: InstallationRow; plan: Plan; expiresAt: number; graceUntil: number; trial: boolean;
  reason: "trial" | "charge" | "owner"; subscriptionId: string | null; paymentId: string | null;
}

/**
 * Builds and signs the next revision for an installation. Returns the insert unrun so callers can batch it.
 * Every licence carries the owner's current module choices for the restaurant, whatever the reason it is issued.
 */
export async function issueLicense(deps: Deps, input: IssueInput): Promise<{ row: LicenseRow; statement: D1StatementLike }> {
  const { installation: i } = input;
  const revision = await nextRevision(deps.db, i.installationId);
  const { overrides } = await getOwnerSettings(deps.db, i.installationId);
  const now = deps.now();
  // The installation row owns the identifiers and the revision comes from the store, so present buildClaims with a renewal of revision - 1.
  const claims = buildClaims({
    format: "masalapos-activation-request", version: 1, installationId: i.installationId, licenseId: i.licenseId,
    organizationId: i.organizationId, outletId: i.outletId, currentRevision: revision - 1, generatedAt: now,
    verificationKeyFingerprint: deps.signer.fingerprint,
  }, { plan: input.plan, expiresAt: input.expiresAt, graceUntil: input.graceUntil, trial: input.trial, modules: overrides }, now, deps.uuid);
  const row: LicenseRow = {
    installationId: i.installationId, revision, plan: input.plan, issuedAt: now, expiresAt: input.expiresAt, graceUntil: input.graceUntil,
    envelope: await encodeEnvelope(claims, deps.signer.sign), reason: input.reason,
    razorpaySubscriptionId: input.subscriptionId, razorpayPaymentId: input.paymentId,
  };
  return { row, statement: insertLicenseStatement(deps.db, row) };
}

/**
 * After the owner changes a restaurant's modules: re-signs its current terms (plan, dates, trial, subscription) with the new
 * modules as the next revision, so the counter picks the change up on its next check. Nothing is issued when the restaurant
 * has no licence yet or its licence has run out; its next trial or payment carries the change instead.
 */
export async function issueOwnerRevision(deps: Deps, installation: InstallationRow): Promise<LicenseRow | null> {
  const latest = await latestLicense(deps.db, installation.installationId);
  if (!latest || latest.expiresAt <= deps.now()) return null;
  const { row, statement } = await issueLicense(deps, {
    installation, plan: latest.plan, expiresAt: latest.expiresAt, graceUntil: latest.graceUntil, trial: readClaims(latest.envelope).trial === true,
    reason: "owner", subscriptionId: latest.razorpaySubscriptionId, paymentId: null,
  });
  await statement.run();
  return row;
}
