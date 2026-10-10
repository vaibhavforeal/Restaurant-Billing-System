import { ActivationRequest } from "@forkflow/license-issuer";
import { issueLicense, type Deps } from "./issue.js";
import { createInstallation, getInstallation, insertLicenseIfAbsentStatement, latestLicense, raiseRevisionFloorStatement } from "./store.js";

export type { Deps } from "./issue.js";
export type ActivateDeps = Deps & { log: (msg: string) => void };

const TRIAL_MS = 14 * 86_400_000;
// A client-reported revision can become the floor, so it is capped far below Number.MAX_SAFE_INTEGER.
const MAX_REPORTED_REVISION = 1_000_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleActivate(deps: ActivateDeps, body: unknown): Promise<Response> {
  const parsed = ActivationRequest.safeParse(body);
  if (!parsed.success || parsed.data.currentRevision > MAX_REPORTED_REVISION) return json({ error: "bad_request" }, 400);
  const request = parsed.data;
  if (request.verificationKeyFingerprint !== deps.signer.fingerprint) return json({ error: "wrong_key" }, 409);
  const { db } = deps;
  const held = request.licenseId !== null && request.organizationId !== null && request.outletId !== null;

  let installation = await getInstallation(db, request.installationId);
  const known = installation !== null;
  if (!installation) {
    // A counter that already holds a hand-issued licence is adopted as it is (its reported revision becomes the floor); anything else is a first contact.
    await createInstallation(db, {
      installationId: request.installationId,
      licenseId: held ? request.licenseId! : deps.uuid(), organizationId: held ? request.organizationId! : deps.uuid(), outletId: held ? request.outletId! : deps.uuid(),
      trialStartedAt: held ? null : deps.now(), revisionFloor: held ? request.currentRevision : 0, createdAt: deps.now(),
    });
    installation = await getInstallation(db, request.installationId);
  }
  if (!installation) return json({ error: "unavailable" }, 500);
  const { installationId } = installation;
  const mismatched = held && (request.licenseId !== installation.licenseId || request.organizationId !== installation.organizationId || request.outletId !== installation.outletId);

  // A known counter reporting a revision above the floor holds a licence the service never issued or handed out: a hand-issued one.
  let handIssued = false;
  if (known && mismatched) deps.log(`activate: installation ${installationId} reported identifiers that differ from the stored ones; nothing issued`);
  else if (known && held && request.currentRevision > installation.revisionFloor) {
    await raiseRevisionFloorStatement(db, installationId, request.currentRevision).run();
    handIssued = true;
  }

  let latest = await latestLicense(db, installationId);
  // The trial is the first licence of an installation created for it; racing callers (or a crash after the row was created) converge on one row.
  if (!latest && installation.trialStartedAt !== null) {
    const now = deps.now(), expiresAt = now + TRIAL_MS;
    const { row } = await issueLicense({ ...deps, now: () => now }, { installation, plan: "pro", expiresAt, graceUntil: expiresAt, trial: true, reason: "trial", subscriptionId: null, paymentId: null });
    await insertLicenseIfAbsentStatement(db, row).run();
    latest = await latestLicense(db, installationId);
  }
  // A current paid licence at or below the hand-issued revision would never reach the counter, so its terms are re-signed above it.
  // Never a trial or an expired licence; the payment id stays on the original row only (it is UNIQUE).
  if (handIssued && latest?.reason === "charge" && latest.revision <= request.currentRevision && latest.expiresAt > deps.now()) {
    const { row } = await issueLicense(deps, {
      installation, plan: latest.plan, expiresAt: latest.expiresAt, graceUntil: latest.graceUntil, trial: false, reason: "charge",
      subscriptionId: latest.razorpaySubscriptionId, paymentId: null,
    });
    await insertLicenseIfAbsentStatement(db, row).run();
    latest = await latestLicense(db, installationId);
  }

  const license = latest && latest.revision > request.currentRevision ? latest : null;
  // Handing a licence out raises the floor as well, so a counter that later reports this revision is known to hold it and is not re-signed.
  if (license && !mismatched) await raiseRevisionFloorStatement(db, installationId, license.revision).run();
  return json({ license: license?.envelope ?? null });
}
