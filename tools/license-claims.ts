// Operator-only licensing helpers. This file and the private key are never bundled into POS builds.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { buildClaims as buildClaimsFromTerms, encodeEnvelope, type ActivationRequest } from "../packages/license-issuer/src/index.js";
import type { LicenseClaims, Plan } from "../packages/domain/src/licensing.js";

export { ActivationRequest, parseActivationRequest } from "../packages/license-issuer/src/index.js";

export interface LicenseTerms { plan: Plan; months: number; graceDays: number }

/** Adds calendar months in UTC, keeping the time of day. */
function addMonths(ms: number, months: number): number {
  const date = new Date(ms);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

export function buildClaims(request: ActivationRequest, terms: LicenseTerms, now: number, uuid?: () => string): LicenseClaims {
  if (!Number.isInteger(terms.months) || terms.months < 1 || terms.months > 120) throw new Error("Choose a whole number of months from 1 to 120");
  if (!Number.isInteger(terms.graceDays) || terms.graceDays < 0 || terms.graceDays > 90) throw new Error("Choose grace days from 0 to 90");
  const expiresAt = addMonths(now, terms.months);
  return buildClaimsFromTerms(request, { plan: terms.plan, expiresAt, graceUntil: expiresAt + terms.graceDays * 24 * 60 * 60 * 1000 }, now, uuid);
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

export async function signClaims(claims: LicenseClaims, privatePem: string): Promise<string> {
  const key = ed25519PrivateKey(privatePem);
  return encodeEnvelope(claims, async (message) => new Uint8Array(sign(null, message, key)));
}
