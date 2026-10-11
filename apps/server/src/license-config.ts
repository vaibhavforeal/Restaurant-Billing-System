import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { atomicJson } from "./backups.js";
import { INSTALLATION_SECRET_PATTERN, type LicensingOptions } from "./licensing.js";

// Replaced by esbuild. Packaged builds cannot switch off licensing via env vars.
declare const __FORKFLOW_LICENSE_PUBLIC_KEY__: string;
declare const __FORKFLOW_LICENSE_SERVICE_URL__: string;
declare const __FORKFLOW_COMMERCIAL__: boolean;

/** HTTPS only; plain HTTP to this machine is allowed for source development and tests, never in a customer build. */
function serviceUrlFrom(value: string | undefined, commercial: boolean): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL | undefined;
  try { url = new URL(text); } catch { /* reported below */ }
  const local = url?.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!url || !url.hostname || !(url.protocol === "https:" || (local && !commercial))) throw new Error("Licensing service URL must use HTTPS");
  return text.endsWith("/") ? text.slice(0, -1) : text;
}
export function licenseConfig(dataDir: string): LicensingOptions | undefined {
  const publicKey = typeof __FORKFLOW_LICENSE_PUBLIC_KEY__ !== "undefined"
    ? __FORKFLOW_LICENSE_PUBLIC_KEY__ : process.env["FORKFLOW_LICENSE_PUBLIC_KEY"];
  if (!publicKey) {
    if (typeof __FORKFLOW_COMMERCIAL__ !== "undefined" && __FORKFLOW_COMMERCIAL__) {
      throw new Error("Customer build is missing its license verification key");
    }
    return undefined; // Explicit development build; never sell this artifact.
  }
  if (publicKey.includes("PRIVATE KEY")) throw new Error("Configure only the public license verification key on the POS server");
  // Like the key, an embedded URL cannot be redirected by an environment variable in a packaged build.
  const serviceUrl = serviceUrlFrom(typeof __FORKFLOW_LICENSE_SERVICE_URL__ !== "undefined"
    ? __FORKFLOW_LICENSE_SERVICE_URL__ : process.env["FORKFLOW_LICENSE_SERVICE_URL"],
    typeof __FORKFLOW_COMMERCIAL__ !== "undefined" && __FORKFLOW_COMMERCIAL__);
  const path = join(dataDir, "installation.json");
  // The secret is created with the id and added to older files that lack it; the id is never replaced.
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as { installationId: string; installationSecret?: unknown } : null;
  const installationId = saved ? saved.installationId : randomUUID();
  const kept = saved?.installationSecret;
  const valid = typeof kept === "string" && INSTALLATION_SECRET_PATTERN.test(kept);
  const installationSecret = valid ? kept : randomBytes(32).toString("hex");
  // A file without an id is left alone (start-up fails on it as before) rather than rewritten.
  if (!valid && (!saved || typeof saved.installationId === "string")) atomicJson(path, { ...saved, installationId, installationSecret });
  return { publicKey, installationId, installationSecret, ...(serviceUrl ? { serviceUrl } : {}) };
}
