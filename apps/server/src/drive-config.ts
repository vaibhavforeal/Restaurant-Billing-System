import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleDriveProvider } from "./google-drive.js";

declare const __MASALAPOS_GOOGLE_CLIENT_ID__: string;
declare const __MASALAPOS_GOOGLE_CLIENT_SECRET__: string;
declare const __MASALAPOS_COMMERCIAL__: boolean;

/**
 * Google Drive backup is available when the build carries a Google OAuth "Desktop app" client and the desktop shell
 * supplied its Windows-protected key. Without either, Settings shows Drive as not configured and local backups continue.
 */
export function driveProvider(input: { dataDir: string; secretKey: string | undefined; restaurantName: () => string; warn: (message: string) => void }): GoogleDriveProvider | undefined {
  const commercial = typeof __MASALAPOS_COMMERCIAL__ !== "undefined" && __MASALAPOS_COMMERCIAL__;
  const built = typeof __MASALAPOS_GOOGLE_CLIENT_ID__ !== "undefined" && __MASALAPOS_GOOGLE_CLIENT_ID__
    ? { clientId: __MASALAPOS_GOOGLE_CLIENT_ID__, clientSecret: typeof __MASALAPOS_GOOGLE_CLIENT_SECRET__ !== "undefined" ? __MASALAPOS_GOOGLE_CLIENT_SECRET__ : "" } : null;
  // Development only: the client file downloaded into the working folder (git-ignored), when no env vars are set.
  const { clientId, clientSecret } = built ?? (process.env["MASALAPOS_GOOGLE_CLIENT_ID"]
    ? { clientId: process.env["MASALAPOS_GOOGLE_CLIENT_ID"], clientSecret: process.env["MASALAPOS_GOOGLE_CLIENT_SECRET"] ?? "" }
    : commercial ? { clientId: "", clientSecret: "" } : developmentClientFile(input.warn));
  if (!clientId) return undefined;
  let key = input.secretKey ? Buffer.from(input.secretKey, "base64") : undefined;
  if (!key && !commercial) {
    // Development server without the desktop shell: an unprotected local key, never used by the customer build.
    const path = join(input.dataDir, "dev-secret.key");
    if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString("base64"));
    key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    input.warn("Google Drive tokens use an unprotected development key (dev-secret.key)");
  }
  if (!key || key.length !== 32) { input.warn("Google Drive backup unavailable: Windows credential protection is not available"); return undefined; }
  try {
    return new GoogleDriveProvider({ clientId, clientSecret, dataDir: input.dataDir, secretKey: key, restaurantName: input.restaurantName });
  } catch (error) {
    // Unreadable Drive settings never block billing or local backups.
    input.warn(`Google Drive backup unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function developmentClientFile(warn: (message: string) => void): { clientId: string; clientSecret: string } {
  try {
    const name = readdirSync(process.cwd()).find((file) => /^client_secret_.+\.json$/.test(file));
    if (!name) return { clientId: "", clientSecret: "" };
    const client = (JSON.parse(readFileSync(join(process.cwd(), name), "utf8")) as { installed?: { client_id?: string; client_secret?: string } }).installed;
    return { clientId: client?.client_id ?? "", clientSecret: client?.client_secret ?? "" };
  } catch (error) { warn(`Google OAuth client file unreadable: ${String(error)}`); return { clientId: "", clientSecret: "" }; }
}
