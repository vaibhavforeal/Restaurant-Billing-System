import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { X509Certificate } from "node:crypto";
import { createServer, type ServerOptions } from "node:https";
import type { Duplex } from "node:stream";
import { z } from "zod";

const Config = z.object({
  port: z.number().int().min(1).max(65535),
  addresses: z.array(z.ipv4()).min(1),
  pfxFile: z.string().min(1), passphraseFile: z.string().min(1),
  caFile: z.string().min(1), certificateFile: z.string().min(1),
}).passthrough();
export interface CaptainHttpsInfo {
  enabled: boolean; port?: number; addresses?: string[]; fingerprint?: string;
  expiresAt?: string; certificate?: Buffer; error?: string;
}
export interface CaptainTls {
  port: number; tls: ServerOptions; info: CaptainHttpsInfo;
}
export function loadCaptainHttps(dataDir: string): CaptainTls | null {
  const configPath = resolve(dataDir, "captain-https.json");
  if (!existsSync(configPath)) return null;
  const config = Config.parse(JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")));
  const file = (name: string) => {
    const path = resolve(dataDir, name), rel = relative(resolve(dataDir), path);
    if (isAbsolute(name) || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Captain certificate files must be inside the POS data folder");
    return readFileSync(path);
  };
  const ca = file(config.caFile), authority = new X509Certificate(ca);
  const certificate = new X509Certificate(file(config.certificateFile));
  if (Date.parse(certificate.validTo) <= Date.now()) throw new Error("Captain HTTPS certificate expired. Renew it before reconnecting tablets.");
  if (!certificate.verify(authority.publicKey)) throw new Error("Captain certificate does not match the restaurant certificate authority");
  for (const address of config.addresses) if (!certificate.checkIP(address)) throw new Error("Captain certificate does not cover its configured address");
  return {
    port: config.port,
    tls: { pfx: file(config.pfxFile), passphrase: file(config.passphraseFile).toString("utf8").replace(/^\uFEFF/, "").trim(), minVersion: "TLSv1.2" },
    info: { enabled: false, port: config.port, addresses: config.addresses, fingerprint: authority.fingerprint256, expiresAt: new Date(certificate.validTo).toISOString(), certificate: ca },
  };
}

/** A second transport for the same Fastify handlers, database and WebSocket hub. */
export async function startCaptainHttps(app: FastifyInstance, config: CaptainTls, host = "0.0.0.0") {
  await app.ready();
  const secure = createServer(config.tls, (request, response) => { app.server.emit("request", request, response); });
  const sockets = new Set<Duplex>();
  secure.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  secure.on("upgrade", (request, socket, head) => { app.server.emit("upgrade", request, socket, head); });
  secure.keepAliveTimeout = 65_000;
  try {
    await new Promise<void>((resolveListen, reject) => {
      secure.once("error", reject);
      secure.listen(config.port, host, () => { secure.off("error", reject); resolveListen(); });
    });
  } catch (error) { secure.close(); throw error; }
  config.info.enabled = true;
  const close = async () => {
    config.info.enabled = false;
    await new Promise<void>((done) => { secure.close(() => done()); for (const socket of sockets) socket.destroy(); });
  };
  return { server: secure, close };
}
