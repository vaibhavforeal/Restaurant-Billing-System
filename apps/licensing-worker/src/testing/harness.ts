// Test-only: one signing key pair per test file, an Env over an in-memory D1, and request helpers for driving the Worker.
import { generateKeyPairSync } from "node:crypto";
import { verifyLicenseSignature } from "@forkflow/core";
import { LicenseClaims } from "@forkflow/domain/licensing";
import { webCryptoSigner } from "@forkflow/license-issuer";
import type { Env } from "../env.js";
import worker from "../index.js";
import { SECRET_HEADER } from "../secret.js";
import { memoryD1 } from "./d1.js";
import { TEST_SECRET } from "./secret.js";

export const ORIGIN = "https://licensing.test";

export function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    publicPem, privatePem,
    fingerprint: () => webCryptoSigner(privatePem).then((s) => s.fingerprint),
    /** Verifies an envelope the Worker returned and parses its claims. */
    claims: (envelope: string) => LicenseClaims.parse(verifyLicenseSignature(envelope.trim(), publicPem)),
  };
}

export function testEnv(privatePem: string, over: Partial<Env> = {}): Env {
  return {
    DB: memoryD1(), LIMITER: { limit: async () => ({ success: true }) },
    RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "rzp_secret", RAZORPAY_WEBHOOK_SECRET: "whsec", LICENSE_SIGNING_KEY: privatePem,
    ...over,
  };
}

/** A request to the Worker; JSON bodies are encoded, strings are sent as they are. */
export function send(env: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const init: RequestInit = { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
}

export const withSecret = (headers: Record<string, string> = {}, secret = TEST_SECRET) => ({ [SECRET_HEADER]: secret, ...headers });

export const activation = (installationId: string, fingerprint: string, over: Record<string, unknown> = {}) => ({
  format: "forkflow-activation-request", version: 1, installationId, licenseId: null, organizationId: null, outletId: null,
  currentRevision: 0, generatedAt: Date.now(), verificationKeyFingerprint: fingerprint, ...over,
});
