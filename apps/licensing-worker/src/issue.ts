import type { Plan } from "@forkflow/domain/licensing";
import { buildClaims, encodeEnvelope, type Signer } from "@forkflow/license-issuer";
import type { D1Like, D1StatementLike } from "./env.js";
import { insertLicenseStatement, nextRevision, type InstallationRow, type LicenseRow } from "./store.js";

export interface Deps { db: D1Like; signer: { sign: Signer; fingerprint: string }; now: () => number; uuid: () => string }

export interface IssueInput {
  installation: InstallationRow; plan: Plan; expiresAt: number; graceUntil: number; trial: boolean;
  reason: "trial" | "charge"; subscriptionId: string | null; paymentId: string | null;
}

/** Builds and signs the next revision for an installation. Returns the insert unrun so callers can batch it. */
export async function issueLicense(deps: Deps, input: IssueInput): Promise<{ row: LicenseRow; statement: D1StatementLike }> {
  const { installation: i } = input;
  const revision = await nextRevision(deps.db, i.installationId);
  const now = deps.now();
  // The installation row owns the identifiers and the revision comes from the store, so present buildClaims with a renewal of revision - 1.
  const claims = buildClaims({
    format: "forkflow-activation-request", version: 1, installationId: i.installationId, licenseId: i.licenseId,
    organizationId: i.organizationId, outletId: i.outletId, currentRevision: revision - 1, generatedAt: now,
    verificationKeyFingerprint: deps.signer.fingerprint,
  }, { plan: input.plan, expiresAt: input.expiresAt, graceUntil: input.graceUntil, trial: input.trial }, now, deps.uuid);
  const row: LicenseRow = {
    installationId: i.installationId, revision, plan: input.plan, issuedAt: now, expiresAt: input.expiresAt, graceUntil: input.graceUntil,
    envelope: await encodeEnvelope(claims, deps.signer.sign), reason: input.reason,
    razorpaySubscriptionId: input.subscriptionId, razorpayPaymentId: input.paymentId,
  };
  return { row, statement: insertLicenseStatement(deps.db, row) };
}
