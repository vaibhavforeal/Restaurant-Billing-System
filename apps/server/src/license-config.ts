import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJson } from "./backups.js";
import type { LicensingOptions } from "./licensing.js";

// Replaced by esbuild. Packaged builds cannot switch off licensing via env vars.
declare const __FORKFLOW_LICENSE_PUBLIC_KEY__: string;
declare const __FORKFLOW_COMMERCIAL__: boolean;
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
  const path = join(dataDir, "installation.json");
  if (!existsSync(path)) atomicJson(path, { installationId: randomUUID() });
  const { installationId } = JSON.parse(readFileSync(path, "utf8")) as { installationId: string };
  return { publicKey, installationId };
}
