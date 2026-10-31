import { parseVendorCode } from "@forkflow/domain/vendor-codes";
import { ActivationRequest, readClaims } from "@forkflow/license-issuer";
import { z } from "zod";
import { issueLicense, type Deps } from "./issue.js";
import { activationBlocker, orderById, orderByCodes, orderTerms, type LicensingOrder } from "./orders.js";
import { isWellFormedSecret, sha256Hex, verifyInstallationSecret } from "./secret.js";
import {
  activityStatement, createInstallation, getInstallation, latestLicense, raiseRevisionFloorStatement, setOverridesStatement,
  type InstallationRow, type LicenseRow,
} from "./store.js";

// A client-reported revision can become the floor, so it is capped far below Number.MAX_SAFE_INTEGER.
const MAX_REPORTED_REVISION = 1_000_000;
const Enroll = z.object({ activation: ActivationRequest, customerId: z.string().max(40), orderId: z.string().max(40) }).strict();

/** Plain words a counter can show as they are; the `error` code is for its logic and tests. */
const REFUSALS = {
  not_found: [404, "Check the Customer ID and Order ID. They are on the setup card ForkFlow gave you."],
  order_not_ready: [409, "This order isn't confirmed yet. Contact ForkFlow."],
  order_cancelled: [409, "This order was cancelled. Contact ForkFlow."],
  not_paid: [409, "This order hasn't been paid yet. Pay the ForkFlow invoice, or contact ForkFlow."],
  renewal_order: [409, "This Order ID renews outlets that are already set up. Use the Order ID from your first purchase or trial."],
  seats_full: [409, "Every outlet on this order is already set up. Contact ForkFlow to move it to this computer or add an outlet."],
  other_customer: [409, "This computer is registered to another ForkFlow customer. Contact ForkFlow."],
  already_licensed: [409, "This computer already has a paid ForkFlow licence; a trial can't replace it."],
  mismatch: [409, "This computer's licence doesn't match ForkFlow's records. Contact ForkFlow support."],
} as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (error: keyof typeof REFUSALS) => json({ error, message: REFUSALS[error][1] }, REFUSALS[error][0]);

/**
 * POST /v1/enroll: a counter at setup (or an administrator later) gives the Customer ID and Order ID from its setup card. The order must
 * belong to that customer and be paid, on credit, or a trial; the counter takes one of its seats and gets the order's licence, with
 * the term counted from now. Enrolling again on the same order hands back the same licence; enrolling on another order of the same
 * customer moves the counter's seat there (a trial becoming paid).
 */
export async function handleEnroll(deps: Deps, body: unknown, secret: string | null): Promise<Response> {
  const parsed = Enroll.safeParse(body);
  if (!parsed.success || parsed.data.activation.currentRevision > MAX_REPORTED_REVISION) return json({ error: "bad_request" }, 400);
  const { activation: request } = parsed.data;
  if (request.verificationKeyFingerprint !== deps.signer.fingerprint) return json({ error: "wrong_key" }, 409);
  if (!isWellFormedSecret(secret)) return json({ error: "unauthorized" }, 401);
  const { db } = deps;

  // One answer for a typo, an unknown customer, an unknown order and an order of another customer, so the codes cannot be probed.
  const customerCode = parseVendorCode("customer", parsed.data.customerId), orderCode = parseVendorCode("order", parsed.data.orderId);
  const order = customerCode && orderCode ? await orderByCodes(db, customerCode, orderCode) : null;
  if (!order) return refuse("not_found");
  const blocker = activationBlocker(order, deps.now());
  if (blocker) return refuse(blocker);

  const held = request.licenseId !== null && request.organizationId !== null && request.outletId !== null;
  let installation = await getInstallation(db, request.installationId);
  if (!installation) {
    // A counter that already holds a hand-issued licence keeps its identifiers (its reported revision becomes the floor), or it would refuse ours.
    await createInstallation(db, {
      installationId: request.installationId,
      licenseId: held ? request.licenseId! : deps.uuid(), organizationId: held ? request.organizationId! : deps.uuid(), outletId: held ? request.outletId! : deps.uuid(),
      revisionFloor: held ? request.currentRevision : 0, createdAt: deps.now(), secretHash: await sha256Hex(secret),
    });
    installation = await getInstallation(db, request.installationId);
  }
  if (!installation) return json({ error: "unavailable" }, 500);
  // Trust on first use; a counter that does not hold the secret changes nothing from here on.
  const verified = await verifyInstallationSecret(db, installation, secret);
  if (!verified) return json({ error: "unauthorized" }, 401);
  installation = verified;
  if (held && (request.licenseId !== installation.licenseId || request.organizationId !== installation.organizationId || request.outletId !== installation.outletId)) {
    return refuse("mismatch");
  }
  if (installation.customerId !== null && installation.customerId !== order.customerId) return refuse("other_customer");
  if (installation.orderId === order.id) return handOut(deps, installation, order, request.currentRevision);
  if (order.kind === "trial" && installation.orderId !== null && await holdsPaidLicence(deps, installation)) return refuse("already_licensed");
  if (order.seatsUsed >= order.outlets) return refuse("seats_full");

  try {
    const row = await assignSeat(deps, installation, order, { actorId: null, outletName: request.outletName ?? null, appVersion: request.appVersion ?? null, handedOut: true });
    return json(reply(order, row.envelope, row.expiresAt));
  } catch (error) {
    // Lost a race: for the last seat, or to this same counter enrolling twice at once.
    const fresh = await getInstallation(db, installation.installationId);
    if (fresh?.orderId === order.id) return handOut(deps, fresh, order, request.currentRevision);
    if (await orderFull(deps, order.id)) return refuse("seats_full");
    throw error;
  }
}

/** Whether every seat of the order is taken right now. */
export async function orderFull(deps: Deps, orderId: string): Promise<boolean> {
  const current = await orderById(deps.db, orderId);
  return current !== null && current.seatsUsed >= current.outlets;
}

/**
 * Gives a counter one seat of a new or trial order and signs the order's licence for it, the term counted from now. A counter that
 * held a seat on another order of the same customer gives that seat back. One batch: when the order is already full its seat CHECK
 * fails and nothing is written (the caller sees the error). `handedOut` raises the revision floor because the licence goes straight
 * to the counter (in the enrol reply, or as a file) rather than at its next check.
 */
export async function assignSeat(deps: Deps, installation: InstallationRow, order: LicensingOrder,
  opts: { actorId: string | null; outletName: string | null; appVersion: string | null; handedOut: boolean }): Promise<LicenseRow> {
  const { db } = deps, now = deps.now();
  const terms = orderTerms(order, now);
  const next: InstallationRow = {
    ...installation, customerId: order.customerId, orderId: order.id, maxDevices: order.maxDevices, activatedAt: now,
    outletName: opts.outletName ?? installation.outletName,
  };
  const { row, statement } = await issueLicense(deps, { installation: next, ...terms, reason: "order", orderId: order.id, modules: order.modules });
  const outlet = next.outletName ?? "A counter";
  await db.batch([
    // Taking the seat goes first: when the order is already full its CHECK fails and nothing below is written.
    db.prepare(`UPDATE orders SET seats_used = seats_used + 1, updated_at = ? WHERE id = ?`).bind(now, order.id),
    ...(installation.orderId ? [db.prepare(`UPDATE orders SET seats_used = seats_used - 1, updated_at = ? WHERE id = ?`).bind(now, installation.orderId)] : []),
    db.prepare(`UPDATE installations SET customer_id = ?, order_id = ?, max_devices = ?, activated_at = ?, outlet_name = ?,
      last_seen_at = CASE WHEN ? THEN ? ELSE last_seen_at END, app_version = COALESCE(?, app_version) WHERE installation_id = ?`)
      .bind(next.customerId, next.orderId, next.maxDevices, now, next.outletName, opts.actorId === null ? 1 : 0, now, opts.appVersion, next.installationId),
    setOverridesStatement(db, next.installationId, order.modules, now),
    statement,
    ...(opts.handedOut ? [raiseRevisionFloorStatement(db, next.installationId, row.revision)] : []),
    activityStatement(db, now, {
      actorId: opts.actorId, action: "installation.enrolled", entityType: "installation", entityId: next.installationId, customerId: order.customerId,
      summary: installation.orderId ? `${outlet} moved to order ${order.code}` : `${outlet} activated with order ${order.code}`,
      data: { orderId: order.id, revision: row.revision },
    }),
  ]);
  return row;
}

/** The counter already holds this order's seat: hand back its newest licence if the counter does not have it yet. */
async function handOut(deps: Deps, installation: InstallationRow, order: LicensingOrder, currentRevision: number): Promise<Response> {
  const latest = await latestLicense(deps.db, installation.installationId);
  const license = latest && latest.revision > currentRevision ? latest : null;
  if (license) await raiseRevisionFloorStatement(deps.db, installation.installationId, license.revision).run();
  return json(reply(order, license?.envelope ?? null, latest?.expiresAt ?? null));
}

async function holdsPaidLicence(deps: Deps, installation: InstallationRow): Promise<boolean> {
  const latest = await latestLicense(deps.db, installation.installationId);
  return latest !== null && latest.expiresAt > deps.now() && readClaims(latest.envelope).trial !== true;
}

/** Only what the counter shows at setup: never the customer's phone, email or GSTIN. */
const reply = (order: LicensingOrder, license: string | null, expiresAt: number | null) => ({
  license,
  customer: { code: order.customerCode, name: order.customerName },
  order: { code: order.code, plan: order.plan, trial: order.kind === "trial", expiresAt },
});
