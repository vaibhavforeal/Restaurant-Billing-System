import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Credentials kept on the hub (Google Drive tokens, AI provider keys) are sealed with AES-256-GCM under the key the
 * desktop shell protects with Windows DPAPI. Format: `v1.<iv>.<tag>.<data>`, each part base64.
 */
export function seal(key: Buffer, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((part) => typeof part === "string" ? part : part.toString("base64")).join(".");
}

/** Opens a sealed value; throws on another format, a different key or any changed byte. */
export function unseal(key: Buffer, sealed: string): string {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unsupported credential format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

/**
 * The 32-byte key the shell passed in (base64). A development server without the shell gets an unprotected local key
 * (`dev-secret.key`, never used by the customer build); a commercial build without the shell's key gets none.
 */
export function resolveSecretKey(input: { dataDir: string; secretKey: string | undefined; commercial: boolean; warn: (message: string) => void }): Buffer | undefined {
  let key = input.secretKey ? Buffer.from(input.secretKey, "base64") : undefined;
  if (!key && !input.commercial) {
    const path = join(input.dataDir, "dev-secret.key");
    if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString("base64"));
    key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    input.warn("Saved credentials use an unprotected development key (dev-secret.key)");
  }
  return key && key.length === 32 ? key : undefined;
}
