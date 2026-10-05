// Operator-only licensing helpers. This file and the private key are never bundled into POS builds.
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { z } from "zod";
import { LicenseClaims, PLANS, type Plan } from "../packages/domain/src/licensing.js";

const ActivationRequest = z.object({
  format: z.literal("forkflow-activation-request"),
  version: z.literal(1),
  installationId: z.string().uuid(),
  licenseId: z.string().uuid().nullable(),
  organizationId: z.string().uuid().nullable(),
  outletId: z.string().uuid().nullable(),
  currentRevision: z.number().int().nonnegative(),
  generatedAt: z.number().int().nonnegative(),
  verificationKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ActivationRequest = z.infer<typeof ActivationRequest>;

export function parseActivationRequest(text: string): ActivationRequest {
  try { return ActivationRequest.parse(JSON.parse(text.replace(/^\uFEFF/, ""))); }
  catch { throw new Error("This is not a ForkFlow activation request. Download it from Settings > Plan and devices > Activation details."); }
}

export interface LicenseTerms { plan: Plan; months: number; graceDays: number }

/** Adds calendar months in UTC, keeping the time of day. */
function addMonths(ms: number, months: number): number {
  const date = new Date(ms);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

/**
 * A first activation gets fresh identifiers at revision 1. A request that already
 * carries a license is a renewal or plan change: same identifiers, next revision.
 */
export function buildClaims(request: ActivationRequest, terms: LicenseTerms, now: number, uuid: () => string = randomUUID): LicenseClaims {
  const plan = PLANS[terms.plan];
  if (!plan) throw new Error("Choose plan basic or pro");
  if (!Number.isInteger(terms.months) || terms.months < 1 || terms.months > 120) throw new Error("Choose a whole number of months from 1 to 120");
  if (!Number.isInteger(terms.graceDays) || terms.graceDays < 0 || terms.graceDays > 90) throw new Error("Choose grace days from 0 to 90");
  const renewal = request.licenseId !== null && request.organizationId !== null && request.outletId !== null;
  const expiresAt = addMonths(now, terms.months);
  return LicenseClaims.parse({
    version: 1,
    licenseId: renewal ? request.licenseId : uuid(),
    organizationId: renewal ? request.organizationId : uuid(),
    outletId: renewal ? request.outletId : uuid(),
    installationId: request.installationId,
    revision: renewal ? request.currentRevision + 1 : 1,
    plan: terms.plan,
    maxDevices: plan.maxDevices,
    features: plan.features,
    issuedAt: now,
    expiresAt,
    graceUntil: expiresAt + terms.graceDays * 24 * 60 * 60 * 1000,
  });
}

function ed25519PrivateKey(privatePem: string) {
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 private key");
  return key;
}

/** Same fingerprint the installed app puts in its activation request. */
export function keyFingerprint(privatePem: string): string {
  const publicKey = createPublicKey(ed25519PrivateKey(privatePem));
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

export function signClaims(claims: LicenseClaims, privatePem: string): string {
  const message = `ff1.${Buffer.from(JSON.stringify(LicenseClaims.parse(claims))).toString("base64url")}`;
  return `${message}.${sign(null, Buffer.from(message), ed25519PrivateKey(privatePem)).toString("base64url")}\n`;
}
