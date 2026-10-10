// Shared by the operator tools (Node) and the licensing Worker. WebCrypto only: no node: imports, no Buffer.
import { z } from "zod";
import { LicenseClaims, PLANS, type Plan } from "@forkflow/domain/licensing";
import { fromBase64, toBase64Url } from "./base64url.js";

export const ActivationRequest = z.object({
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
  try { return ActivationRequest.parse(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)); }
  catch { throw new Error("This is not a ForkFlow activation request. Download it from Settings > Plan and devices > Activation details."); }
}

export interface ClaimTerms { plan: Plan; expiresAt: number; graceUntil: number; trial?: boolean }

/**
 * A first activation gets fresh identifiers at revision 1. A request that already
 * carries a license is a renewal or plan change: same identifiers, next revision.
 */
export function buildClaims(request: ActivationRequest, terms: ClaimTerms, now: number, uuid: () => string = () => crypto.randomUUID()): LicenseClaims {
  const plan = PLANS[terms.plan];
  if (!plan) throw new Error("Choose plan basic or pro");
  const renewal = request.licenseId !== null && request.organizationId !== null && request.outletId !== null;
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
    expiresAt: terms.expiresAt,
    graceUntil: terms.graceUntil,
    ...(terms.trial ? { trial: true } : {}),
  });
}

export type Signer = (message: Uint8Array) => Promise<Uint8Array>;

export async function encodeEnvelope(claims: LicenseClaims, sign: Signer): Promise<string> {
  const message = `ff1.${toBase64Url(new TextEncoder().encode(JSON.stringify(LicenseClaims.parse(claims))))}`;
  return `${message}.${toBase64Url(await sign(new TextEncoder().encode(message)))}\n`;
}

const SPKI_ED25519_PREFIX = Uint8Array.of(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00);

/** Same fingerprint the installed app puts in its activation request: SHA-256 of the SPKI DER public key. */
export async function webCryptoSigner(pkcs8Pem: string): Promise<{ sign: Signer; fingerprint: string }> {
  const der = fromBase64(pkcs8Pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, ""));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"])
    .catch(() => { throw new Error("Expected an Ed25519 private key"); });
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (!jwk.x) throw new Error("Expected an Ed25519 private key");
  const spki = new Uint8Array([...SPKI_ED25519_PREFIX, ...fromBase64(jwk.x)]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", spki));
  return {
    sign: async (message) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, message)),
    fingerprint: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}
