import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { networkInterfaces } from "node:os";
import { createReadStream } from "node:fs";
import QRCode from "qrcode";
import { z } from "zod";
import { parseBackupName, type Backups } from "./backups.js";
import type { CaptainHttpsInfo } from "./captain-https.js";
import type { CloudBackups, CloudBackupWorkerStatus } from "./cloud-backups.js";
import type { RestoreStaging } from "./restore-staging.js";
import type { UpdateBridge } from "./updates.js";
import { httpError } from "./http-error.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** The desktop window on the main POS PC talks to the server over loopback; counters and tablets use the LAN. */
export function fromMainPc(req: FastifyRequest): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? "");
}
/** e.g. "MasalaPOS backup - Spice Garden - 2026-10-31 1430.db": ASCII so every browser keeps the name. */
export function exportFileName(restaurantName: string, at: number): string {
  const name = restaurantName.normalize("NFKD").replace(/[^A-Za-z0-9 &'.-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Restaurant";
  const d = new Date(at), pad = (n: number) => String(n).padStart(2, "0");
  return `MasalaPOS backup - ${name} - ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}.db`;
}

export function lanUrls(port: number): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
    .map((entry) => `http://${entry.address}:${port}`))];
}
export function edgeShortcut(url: string): string {
  // The only caller passes a URL generated from the server's own IPv4 interfaces.
  return `$edge = [Environment]::GetFolderPath('ProgramFilesX86') + '\\Microsoft\\Edge\\Application\\msedge.exe'\r\nif (!(Test-Path -LiteralPath $edge)) { $edge = [Environment]::GetFolderPath('ProgramFiles') + '\\Microsoft\\Edge\\Application\\msedge.exe' }\r\nif (!(Test-Path -LiteralPath $edge)) { throw 'Install Microsoft Edge first.' }\r\n$shell = New-Object -ComObject WScript.Shell\r\n$link = $shell.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\\MasalaPOS.lnk')\r\n$link.TargetPath = $edge\r\n$link.Arguments = '--app=${url}'\r\n$link.IconLocation = $edge + ',0'\r\n$link.Save()\r\n`;
}
/** Copied into the UI build by tools/build-desktop.mjs when the Android app has been built. */
export const CAPTAIN_APK_PATH = "/captain/android/MasalaPOS-Captain.apk";
/** QR payload for the Android Captain app: the POS origin and, for HTTPS, the restaurant CA it must pin. */
export function captainPairingUri(origin: string, fingerprint?: string): string {
  const params = new URLSearchParams({ server: origin });
  if (fingerprint) params.set("ca", fingerprint.replaceAll(":", "").toUpperCase());
  return `masalapos-captain://pair?${params}`;
}
export function registerSystem(app: FastifyInstance, backups?: Backups, port = 4100, generation = "initial", captainHttps?: CaptainHttpsInfo, cloudBackups?: CloudBackups,
  restore: { staging?: RestoreStaging; desktop?: UpdateBridge } = {}) {
  const manage = app.requirePermission("settings.manage");
  app.get("/api/system/generation", { preHandler: app.requireAuth }, async () => ({ generation }));
  app.get("/api/system/connections", { preHandler: manage }, async () => {
    const secure = captainHttps?.enabled ? (captainHttps.addresses ?? []).map((address) => `https://${address}:${captainHttps.port}`) : [];
    return {
      connections: await Promise.all(lanUrls(port).map(async (url) => ({ url, qr: await QRCode.toDataURL(url, { width: 220, margin: 2 }) }))),
      android: {
        // A new tablet's browser does not trust the restaurant CA yet, so the APK downloads over LAN HTTP.
        downloads: await Promise.all(lanUrls(port).map(async (origin) => {
          const url = `${origin}${CAPTAIN_APK_PATH}`;
          return { url, qr: await QRCode.toDataURL(url, { width: 220, margin: 2 }) };
        })),
        // Pair over HTTPS when it is set up; plain LAN HTTP still works but is unencrypted.
        pairings: await Promise.all((secure.length ? secure : lanUrls(port)).map(async (origin) => {
          const pairing = captainPairingUri(origin, secure.length ? captainHttps?.fingerprint : undefined);
          return { origin, secure: secure.length > 0, qr: await QRCode.toDataURL(pairing, { width: 220, margin: 2 }) };
        })),
      },
      captain: {
        enabled: captainHttps?.enabled ?? false,
        error: captainHttps?.error,
        fingerprint: captainHttps?.fingerprint,
        expiresAt: captainHttps?.expiresAt,
        connections: captainHttps?.enabled ? await Promise.all((captainHttps.addresses ?? []).map(async (address) => {
          const url = `https://${address}:${captainHttps.port}/captain/`;
          return { url, qr: await QRCode.toDataURL(url, { width: 220, margin: 2 }) };
        })) : [],
      },
    };
  });
  // A CA certificate is public onboarding material, never a private key.
  app.get("/captain/restaurant-ca.cer", async (_req, reply) => {
    if (!captainHttps?.enabled || !captainHttps.certificate) return reply.status(404).send({ error: "Captain HTTPS is not configured" });
    return reply.type("application/x-x509-ca-cert").header("Cache-Control", "no-store")
      .header("Content-Disposition", 'attachment; filename="MasalaPOS-Restaurant-CA.cer"').send(captainHttps.certificate);
  });
  app.get("/api/system/shortcut", { preHandler: manage }, async (req, reply) => {
    const { url } = z.object({ url: z.string() }).parse(req.query);
    if (!lanUrls(port).includes(url)) return reply.status(400).send({ error: "Choose a current server LAN address" });
    return reply.type("text/plain").header("Content-Disposition", 'attachment; filename="Create-MasalaPOS-Shortcut.ps1"').send(edgeShortcut(url));
  });
  if (!backups) return;
  const { staging, desktop } = restore;
  /** Restore stops every counter, so it is started only from the main PC's desktop app. */
  const restoreBlocked = (req: FastifyRequest): string | null =>
    !desktop || !staging ? "Restore runs in the MasalaPOS desktop app on the main POS PC. Use the tray menu â†’ Restore backup."
      : !fromMainPc(req) ? "To restore, open Settings â†’ Backups on the main POS PC." : null;
  const requireRestore = (req: FastifyRequest) => { const reason = restoreBlocked(req); if (reason) throw httpError(409, reason); return staging!; };
  const backupStatus = (req: FastifyRequest, status: ReturnType<Backups["status"]>) => ({ ...status, restoreBlockedReason: restoreBlocked(req) });
  const restaurantName = () => (app.db.prepare("SELECT restaurant_name FROM settings WHERE id = 1").get() as { restaurant_name: string } | undefined)?.restaurant_name ?? "";

  if (cloudBackups) {
    const cloud = (req: FastifyRequest, status: CloudBackupWorkerStatus) => ({ ...status, onMainPc: fromMainPc(req) });
    app.get("/api/system/cloud-backups", { preHandler: manage }, async (req, reply) => {
      return reply.header("Cache-Control", "no-store").send(cloud(req, cloudBackups.status()));
    });
    app.put("/api/system/cloud-backups", { preHandler: manage }, async (req) => cloud(req, cloudBackups.configure(req.body)));
    app.post("/api/system/cloud-backups/upload", { preHandler: manage }, async (req, reply) => reply.code(202).send(cloud(req, cloudBackups.uploadNow())));
    app.post("/api/system/cloud-backups/retry", { preHandler: manage }, async (req, reply) => reply.code(202).send(cloud(req, cloudBackups.retry())));
    app.post("/api/system/cloud-backups/disconnect", { preHandler: manage }, async (req) => cloud(req, await cloudBackups.disconnect()));
    // Google redirects to a listener on 127.0.0.1, so sign-in must start in the main PC's own browser.
    app.post("/api/system/cloud-backups/connect", { preHandler: manage }, async (req) => {
      if (!fromMainPc(req)) throw httpError(409, "Connect Google Drive from Settings on the main POS PC.");
      return cloudBackups.connect();
    });
    app.get("/api/system/cloud-backups/files", { preHandler: manage }, async (_req, reply) => {
      return reply.header("Cache-Control", "no-store").send({ files: await cloudBackups.listRemote() });
    });
    app.post("/api/system/cloud-backups/restore", { preHandler: manage }, async (req) => {
      const target = requireRestore(req);
      const { id } = z.object({ id: z.string().min(1).max(200) }).parse(req.body);
      let name = "Google Drive backup";
      const preview = await target.fromDownload(name, async (path) => { name = (await cloudBackups.downloadRemote(id, path)).name; });
      return { ...preview, label: name, takenAt: parseBackupName(name)?.createdAt ?? null };
    });
  }
  app.get("/api/system/backups", { preHandler: manage }, async (req) => backupStatus(req, backups.status()));
  app.put("/api/system/backups", { preHandler: manage }, async (req) => backupStatus(req, backups.configure(req.body)));
  app.post("/api/system/backups", { preHandler: manage }, async (req) => backupStatus(req, backups.create("manual")));
  // One click: a fresh verified snapshot of all restaurant data, downloaded as a single file.
  app.post("/api/system/backups/export", { preHandler: manage }, async (_req, reply) => {
    const { name } = backups.create("manual");
    const path = backups.download(name)!;
    return reply.type("application/octet-stream").header("Cache-Control", "no-store")
      .header("Content-Disposition", `attachment; filename="${exportFileName(restaurantName(), parseBackupName(name)!.createdAt)}"`)
      .send(createReadStream(path));
  });
  app.get("/api/system/backups/:name", { preHandler: manage }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const path = backups.download(name);
    if (!path) return reply.status(404).send({ error: "backup not found" });
    return reply.type("application/octet-stream").header("Content-Disposition", `attachment; filename="${name}"`).send(createReadStream(path));
  });

  // Restore is two steps: stage + preview (nothing changes yet), then confirm hands the checked file to the desktop shell.
  app.post("/api/system/restore/local", { preHandler: manage }, async (req) => {
    const target = requireRestore(req);
    const { name } = z.object({ name: z.string() }).parse(req.body);
    const path = backups.download(name);
    if (!path) throw httpError(404, "backup not found");
    return target.fromFile(path, name);
  });
  void app.register(async (scope) => {
    // Stream the upload straight to disk; the staging writer enforces the size cap.
    scope.addContentTypeParser("application/octet-stream", (_req, payload, done) => { done(null, payload); });
    scope.post("/api/system/restore/file", { preHandler: manage }, async (req) => {
      const target = requireRestore(req);
      const header = req.headers["x-file-name"];
      let label = "Backup file";
      try { if (typeof header === "string" && header) label = decodeURIComponent(header).slice(0, 200); } catch { /* keep the default */ }
      return target.fromStream(req.body as Readable, label);
    });
  });
  app.post("/api/system/restore/cancel", { preHandler: manage }, async (_req, reply) => { staging?.clear(); return reply.code(204).send(); });
  app.post("/api/system/restore/confirm", { preHandler: manage }, async (req, reply) => {
    const target = requireRestore(req);
    const { token } = z.object({ token: z.string() }).parse(req.body);
    desktop!.send({ type: "restore", path: target.take(token) });
    return reply.code(202).send({ restoring: true });
  });
}
