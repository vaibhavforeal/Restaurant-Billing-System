import { ActivationRequest } from "@forkflow/license-issuer";
import { issueLicense, type Deps } from "./issue.js";
import { createInstallation, getInstallation, insertLicenseIfAbsentStatement, latestLicense } from "./store.js";

export type { Deps } from "./issue.js";

const TRIAL_MS = 14 * 86_400_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleActivate(deps: Deps, body: unknown): Promise<Response> {
  const parsed = ActivationRequest.safeParse(body);
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  const request = parsed.data;
  if (request.verificationKeyFingerprint !== deps.signer.fingerprint) return json({ error: "wrong_key" }, 409);
  const { db } = deps;

  let installation = await getInstallation(db, request.installationId);
  if (!installation) {
    const held = request.licenseId !== null && request.organizationId !== null && request.outletId !== null;
    // A counter that already holds a hand-issued licence is adopted as it is (its reported revision becomes the floor); anything else is a first contact.
    await createInstallation(db, {
      installationId: request.installationId,
      licenseId: held ? request.licenseId! : deps.uuid(), organizationId: held ? request.organizationId! : deps.uuid(), outletId: held ? request.outletId! : deps.uuid(),
      trialStartedAt: held ? null : deps.now(), revisionFloor: held ? request.currentRevision : 0, createdAt: deps.now(),
    });
    installation = await getInstallation(db, request.installationId);
  }
  if (!installation) return json({ error: "unavailable" }, 500);

  let latest = await latestLicense(db, installation.installationId);
  // The trial is the first licence of an installation created for it; racing callers (or a crash after the row was created) converge on one row.
  if (!latest && installation.trialStartedAt !== null) {
    const now = deps.now(), expiresAt = now + TRIAL_MS;
    const { row } = await issueLicense({ ...deps, now: () => now }, { installation, plan: "pro", expiresAt, graceUntil: expiresAt, trial: true, reason: "trial", subscriptionId: null, paymentId: null });
    await insertLicenseIfAbsentStatement(db, row).run();
    latest = await latestLicense(db, installation.installationId);
  }
  return json({ license: latest && latest.revision > request.currentRevision ? latest.envelope : null });
}
