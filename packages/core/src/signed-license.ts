import { createPublicKey, verify } from "node:crypto";

/** Verify exact encoded bytes; never trust claims until the signature passes. */
export function verifyLicenseSignature(envelope: string, publicKeyPem: string): unknown {
  if (envelope.length > 16_384) throw new Error("License is too large");
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== "ff1" || !parts[1] || !parts[2]
    || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) throw new Error("Invalid license format");
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("License key must use Ed25519");
  const signature = Buffer.from(parts[2], "base64url");
  if (signature.toString("base64url") !== parts[2] || Buffer.from(parts[1], "base64url").toString("base64url") !== parts[1]) throw new Error("Non-canonical license encoding");
  if (signature.length !== 64 || !verify(null, Buffer.from(`ff1.${parts[1]}`), key, signature)) throw new Error("Invalid license signature");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
}
