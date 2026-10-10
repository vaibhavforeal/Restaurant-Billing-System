import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { LicenseClaims } from "@forkflow/domain/licensing";
import { verifyLicenseSignature } from "../../core/src/signed-license.js";
import { buildClaims, encodeEnvelope, parseActivationRequest, webCryptoSigner } from "./index.js";

const now = Date.UTC(2026, 9, 10, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const installationId = "44444444-4444-4444-8444-444444444444";
const request = parseActivationRequest(JSON.stringify({ format: "forkflow-activation-request", version: 1, installationId, licenseId: null,
  organizationId: null, outletId: null, currentRevision: 0, generatedAt: now, verificationKeyFingerprint: "a".repeat(64) }));
const terms = { plan: "pro" as const, expiresAt: now + 30 * DAY, graceUntil: now + 37 * DAY };

const pair = generateKeyPairSync("ed25519");
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();

describe("WebCrypto signing", () => {
  it("envelopes signed with WebCrypto pass the app's verifier", async () => {
    const claims = buildClaims(request, terms, now);
    const { sign: webSign } = await webCryptoSigner(privatePem);
    const envelope = await encodeEnvelope(claims, webSign);
    expect(envelope.endsWith("\n")).toBe(true);
    expect(LicenseClaims.parse(verifyLicenseSignature(envelope.trim(), publicPem))).toEqual(claims);
  });

  it("WebCrypto fingerprint matches the app's activation request fingerprint", async () => {
    const { fingerprint } = await webCryptoSigner(privatePem);
    expect(fingerprint).toBe(createHash("sha256").update(pair.publicKey.export({ type: "spki", format: "der" })).digest("hex"));
  });

  it("node and WebCrypto signers produce identical envelopes", async () => {
    const claims = buildClaims(request, terms, now);
    const nodeSign = async (message: Uint8Array) => new Uint8Array(sign(null, message, pair.privateKey));
    const { sign: webSign } = await webCryptoSigner(privatePem);
    expect(await encodeEnvelope(claims, webSign)).toBe(await encodeEnvelope(claims, nodeSign));
  });
});

describe("buildClaims", () => {
  it("takes explicit dates and marks only trials", () => {
    const trial = buildClaims(request, { plan: "pro", expiresAt: now + 14 * DAY, graceUntil: now + 14 * DAY, trial: true }, now);
    expect(trial.trial).toBe(true);
    expect(trial.revision).toBe(1);
    expect(trial.expiresAt).toBe(now + 14 * DAY);
    expect(trial.graceUntil).toBe(trial.expiresAt);
    expect("trial" in buildClaims(request, terms, now)).toBe(false);
  });
});
