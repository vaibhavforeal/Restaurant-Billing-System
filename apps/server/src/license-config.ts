import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicJson } from "./backups.js";
import { INSTALLATION_SECRET_PATTERN, type Licensing, type LicensingOptions } from "./licensing.js";

// Replaced by esbuild. Packaged builds cannot switch off licensing via env vars.
declare const __MASALAPOS_LICENSE_PUBLIC_KEY__: string;
declare const __MASALAPOS_LICENSE_SERVICE_URL__: string;
declare const __MASALAPOS_COMMERCIAL__: boolean;

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
/** Where the customer installer leaves the activation it made (tools/installer-activate.ps1); shared by every Windows user of the PC. */
function stagedActivationPath(): string | undefined {
  const programData = process.env["ProgramData"];
  return programData ? join(programData, "MasalaPOS", "activation.json") : undefined;
}
const StagedActivation = z.object({
  format: z.literal("masalapos-installer-activation"), version: z.literal(1),
  installationId: z.string().uuid(), installationSecret: z.string().regex(INSTALLATION_SECRET_PATTERN),
  license: z.string().max(16_384).nullable(),
});
type StagedActivation = z.infer<typeof StagedActivation>;

const ADMINS = "S-1-5-32-544", SYSTEM = "S-1-5-18";
// Reads the path from the environment, so it never becomes part of the script text.
const OWNERSHIP_SCRIPT = `$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $env:MASALAPOS_STAGED -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { 'null'; exit }
$acl = Get-Acl -LiteralPath $env:MASALAPOS_STAGED
$write = [Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteAttributes, WriteExtendedAttributes, ChangePermissions, TakeOwnership'
$writers = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
  Where-Object { $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $write) } |
  ForEach-Object { $_.IdentityReference.Value })
@{ owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; writers = $writers } | ConvertTo-Json -Compress`;

/**
 * Whether setup made and locked the staged file: owned by Administrators or SYSTEM, not a link, and writable by nobody else (setup
 * gives the person using MasalaPOS only read and delete). %ProgramData% is shared by every Windows user, so a file that fails this may
 * have been planted by another user to hand MasalaPOS an identity they know. Windows only; elsewhere setup never stages a file.
 */
export function stagedFileTrusted(path: string): boolean {
  if (process.platform !== "win32" || !existsSync(path)) return false;
  const run = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", OWNERSHIP_SCRIPT],
    { env: { ...process.env, MASALAPOS_STAGED: path }, encoding: "utf8", timeout: 15_000, windowsHide: true });
  if (run.status !== 0) return false;
  try {
    const found = JSON.parse(run.stdout.trim()) as { owner?: string; writers?: string[] | string } | null;
    const writers = Array.isArray(found?.writers) ? found.writers : found?.writers ? [found.writers] : [];
    return !!found && [ADMINS, SYSTEM].includes(found.owner ?? "") && writers.every((sid) => sid === ADMINS || sid === SYSTEM);
  } catch { return false; }
}

function readStaged(path: string | undefined, trusted: (path: string) => boolean): StagedActivation | null {
  if (!path || !existsSync(path) || !trusted(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    return StagedActivation.parse(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  } catch { return null; }
}

export function licenseConfig(dataDir: string, stagedPath = stagedActivationPath(), trusted = stagedFileTrusted): LicensingOptions | undefined {
  const publicKey = typeof __MASALAPOS_LICENSE_PUBLIC_KEY__ !== "undefined"
    ? __MASALAPOS_LICENSE_PUBLIC_KEY__ : process.env["MASALAPOS_LICENSE_PUBLIC_KEY"];
  if (!publicKey) {
    if (typeof __MASALAPOS_COMMERCIAL__ !== "undefined" && __MASALAPOS_COMMERCIAL__) {
      throw new Error("Customer build is missing its license verification key");
    }
    return undefined; // Explicit development build; never sell this artifact.
  }
  if (publicKey.includes("PRIVATE KEY")) throw new Error("Configure only the public license verification key on the POS server");
  // Like the key, an embedded URL cannot be redirected by an environment variable in a packaged build.
  const serviceUrl = serviceUrlFrom(typeof __MASALAPOS_LICENSE_SERVICE_URL__ !== "undefined"
    ? __MASALAPOS_LICENSE_SERVICE_URL__ : process.env["MASALAPOS_LICENSE_SERVICE_URL"],
    typeof __MASALAPOS_COMMERCIAL__ !== "undefined" && __MASALAPOS_COMMERCIAL__);
  const path = join(dataDir, "installation.json");
  // The secret is created with the id and added to older files that lack it; the id is never replaced.
  let saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as { installationId: string; installationSecret?: unknown } : null;
  // A first start after setup activated this PC takes the identity setup enrolled with, so the licence it got belongs here.
  const staged = saved ? null : readStaged(stagedPath, trusted);
  if (staged) {
    saved = { installationId: staged.installationId, installationSecret: staged.installationSecret };
    atomicJson(path, saved);
  }
  const installationId = saved ? saved.installationId : randomUUID();
  const kept = saved?.installationSecret;
  const valid = typeof kept === "string" && INSTALLATION_SECRET_PATTERN.test(kept);
  const installationSecret = valid ? kept : randomBytes(32).toString("hex");
  // A file without an id is left alone (start-up fails on it as before) rather than rewritten.
  if (!valid && (!saved || typeof saved.installationId === "string")) atomicJson(path, { ...saved, installationId, installationSecret });
  return { publicKey, installationId, installationSecret, ...(serviceUrl ? { serviceUrl } : {}) };
}

/**
 * Installs the licence setup fetched for this installation, then removes setup's file (it holds the installation secret). A file made
 * for another identity (another Windows user's installation) is left for that user. Never throws: the counter's Setup screen and the
 * hourly check are the fallback.
 */
export function adoptStagedActivation(licensing: Pick<Licensing, "activate">, installationId: string, log: (message: string) => void,
  stagedPath = stagedActivationPath(), trusted = stagedFileTrusted): "installed" | "none" | "failed" {
  const staged = readStaged(stagedPath, trusted);
  if (!staged || staged.installationId !== installationId) return "none";
  let outcome: "installed" | "none" | "failed" = "none";
  if (staged.license) {
    try { licensing.activate(staged.license.trim(), "Setup"); outcome = "installed"; }
    catch (error) {
      outcome = "failed";
      log(`The licence from setup was not applied (${error instanceof Error ? error.message : "error"}); the hourly check or Setup takes over.`);
    }
  }
  try { rmSync(stagedPath!, { force: true }); } catch { log("Couldn't remove setup's activation file; it is ignored from now on."); }
  return outcome;
}
