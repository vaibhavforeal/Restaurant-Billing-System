import type { FastifyInstance } from "fastify";
import { networkInterfaces } from "node:os";
import { createReadStream } from "node:fs";
import QRCode from "qrcode";
import { z } from "zod";
import type { Backups } from "./backups.js";
import type { CaptainHttpsInfo } from "./captain-https.js";
import type { CloudBackups } from "./cloud-backups.js";

export function lanUrls(port: number): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
    .map((entry) => `http://${entry.address}:${port}`))];
}
export function edgeShortcut(url: string): string {
  // The only caller passes a URL generated from the server's own IPv4 interfaces.
  return `$edge = [Environment]::GetFolderPath('ProgramFilesX86') + '\\Microsoft\\Edge\\Application\\msedge.exe'\r\nif (!(Test-Path -LiteralPath $edge)) { $edge = [Environment]::GetFolderPath('ProgramFiles') + '\\Microsoft\\Edge\\Application\\msedge.exe' }\r\nif (!(Test-Path -LiteralPath $edge)) { throw 'Install Microsoft Edge first.' }\r\n$shell = New-Object -ComObject WScript.Shell\r\n$link = $shell.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\\ForkFlow.lnk')\r\n$link.TargetPath = $edge\r\n$link.Arguments = '--app=${url}'\r\n$link.IconLocation = $edge + ',0'\r\n$link.Save()\r\n`;
}
export function registerSystem(app: FastifyInstance, backups?: Backups, port = 4100, generation = "initial", captainHttps?: CaptainHttpsInfo, cloudBackups?: CloudBackups) {
  const manage = app.requirePermission("settings.manage");
  app.get("/api/system/generation", { preHandler: app.requireAuth }, async () => ({ generation }));
  app.get("/api/system/connections", { preHandler: manage }, async () => ({
    connections: await Promise.all(lanUrls(port).map(async (url) => ({ url, qr: await QRCode.toDataURL(url, { width: 220, margin: 2 }) }))),
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
  }));
  // A CA certificate is public onboarding material, never a private key.
  app.get("/captain/restaurant-ca.cer", async (_req, reply) => {
    if (!captainHttps?.enabled || !captainHttps.certificate) return reply.status(404).send({ error: "Captain HTTPS is not configured" });
    return reply.type("application/x-x509-ca-cert").header("Cache-Control", "no-store")
      .header("Content-Disposition", 'attachment; filename="ForkFlow-Restaurant-CA.cer"').send(captainHttps.certificate);
  });
  app.get("/api/system/shortcut", { preHandler: manage }, async (req, reply) => {
    const { url } = z.object({ url: z.string() }).parse(req.query);
    if (!lanUrls(port).includes(url)) return reply.status(400).send({ error: "Choose a current server LAN address" });
    return reply.type("text/plain").header("Content-Disposition", 'attachment; filename="Create-ForkFlow-Shortcut.ps1"').send(edgeShortcut(url));
  });
  if (!backups) return;
  if (cloudBackups) {
    app.get("/api/system/cloud-backups", { preHandler: manage }, async (_req, reply) => {
      return reply.header("Cache-Control", "no-store").send(cloudBackups.status());
    });
    app.put("/api/system/cloud-backups", { preHandler: manage }, async (req) => cloudBackups.configure(req.body));
    app.post("/api/system/cloud-backups/upload", { preHandler: manage }, async (_req, reply) => reply.code(202).send(cloudBackups.uploadNow()));
    app.post("/api/system/cloud-backups/retry", { preHandler: manage }, async (_req, reply) => reply.code(202).send(cloudBackups.retry()));
    app.post("/api/system/cloud-backups/disconnect", { preHandler: manage }, async () => cloudBackups.disconnect());
  }
  app.get("/api/system/backups", { preHandler: manage }, async () => backups.status());
  app.put("/api/system/backups", { preHandler: manage }, async (req) => backups.configure(req.body));
  app.post("/api/system/backups", { preHandler: manage }, async () => backups.create("manual"));
  app.get("/api/system/backups/:name", { preHandler: manage }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const path = backups.download(name);
    if (!path) return reply.status(404).send({ error: "backup not found" });
    return reply.type("application/octet-stream").header("Content-Disposition", `attachment; filename="${name}"`).send(createReadStream(path));
  });
}
