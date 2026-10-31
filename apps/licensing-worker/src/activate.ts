import { ActivationRequest, readClaims } from "@forkflow/license-issuer";
import { reissueLicense, type Deps } from "./issue.js";
import { isWellFormedSecret, verifyInstallationSecret } from "./secret.js";
import { getInstallation, insertLicenseIfAbsentStatement, latestLicense, raiseRevisionFloorStatement, touchInstallationStatement } from "./store.js";

export type { Deps } from "./issue.js";
export type ActivateDeps = Deps & { log: (msg: string) => void };

// A client-reported revision can become the floor, so it is capped far below Number.MAX_SAFE_INTEGER.
const MAX_REPORTED_REVISION = 1_000_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * POST /v1/activate: a counter's hourly check. It hands back a newer licence when there is one (a renewal, a module change, a staff
 * adjustment). Counters are only created by enrolling with a Customer ID and Order ID, so an unknown one gets nothing and nothing is
 * written; `enrolled` tells the counter whether it holds a seat on an order.
 */
export async function handleActivate(deps: ActivateDeps, body: unknown, secret: string | null): Promise<Response> {
  const parsed = ActivationRequest.safeParse(body);
  if (!parsed.success || parsed.data.currentRevision > MAX_REPORTED_REVISION) return json({ error: "bad_request" }, 400);
  const request = parsed.data;
  if (request.verificationKeyFingerprint !== deps.signer.fingerprint) return json({ error: "wrong_key" }, 409);
  if (!isWellFormedSecret(secret)) return json({ error: "unauthorized" }, 401);
  const { db } = deps;

  const found = await getInstallation(db, request.installationId);
  if (!found) return json({ license: null, enrolled: false });
  // Trust on first use for a row without a secret (support's "reset pairing"); nothing is written for a caller that does not hold it.
  const installation = await verifyInstallationSecret(db, found, secret);
  if (!installation) return json({ error: "unauthorized" }, 401);
  const { installationId } = installation;
  await touchInstallationStatement(db, installationId, deps.now(), request.appVersion ?? null, request.outletName ?? null).run();
  const held = request.licenseId !== null && request.organizationId !== null && request.outletId !== null;
  const mismatched = held && (request.licenseId !== installation.licenseId || request.organizationId !== installation.organizationId || request.outletId !== installation.outletId);

  // A counter reporting a revision above the floor holds a licence the service never issued or handed out: a hand-issued one.
  let handIssued = false;
  if (mismatched) deps.log(`activate: installation ${installationId} reported identifiers that differ from the stored ones; nothing issued`);
  else if (held && request.currentRevision > installation.revisionFloor) {
    await raiseRevisionFloorStatement(db, installationId, request.currentRevision).run();
    handIssued = true;
  }

  let latest = await latestLicense(db, installationId);
  // A current paid licence at or below the hand-issued revision would never reach the counter, so its terms are re-signed above it.
  // Never a trial or an expired licence.
  if (handIssued && latest && latest.revision <= request.currentRevision && latest.expiresAt > deps.now() && readClaims(latest.envelope).trial !== true) {
    const reissued = await reissueLicense(deps, installation, latest.reason === "order" ? "manual" : latest.reason);
    if (reissued) {
      await insertLicenseIfAbsentStatement(db, reissued.row).run();
      latest = await latestLicense(db, installationId);
    }
  }

  const license = latest && latest.revision > request.currentRevision ? latest : null;
  // Handing a licence out raises the floor as well, so a counter that later reports this revision is known to hold it and is not re-signed.
  if (license && !mismatched) await raiseRevisionFloorStatement(db, installationId, license.revision).run();
  return json({ license: license?.envelope ?? null, enrolled: installation.orderId !== null });
}
