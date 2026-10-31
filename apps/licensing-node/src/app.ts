// Turns the Worker's fetch(request, env) into a Node HTTP server. Runs behind Caddy on the same machine, which terminates HTTPS.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Env } from "../../licensing-worker/src/env.js";

export interface Fetcher { fetch(request: Request, env: Env): Promise<Response> }
export interface AppOptions {
  /** The public https origin (https://portal.billnroll.in). Redirects and absolute URLs the Worker builds use it, not the local port. */
  publicOrigin?: string;
  /** Largest request body accepted; the biggest legitimate one is a few KB of JSON. */
  maxBodyBytes?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The real client address. Only a proxy on this machine (Caddy) may name it through X-Forwarded-For; anyone else is who the socket says. */
export function clientIp(req: Pick<IncomingMessage, "socket" | "headers">): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const forwarded = LOOPBACK.has(peer) ? req.headers["x-forwarded-for"] : undefined;
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || peer;
}

class BodyTooLarge extends Error {}
class BadTarget extends Error {}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function toRequest(req: IncomingMessage, body: Buffer, publicOrigin: string | undefined): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  // The Worker rate-limits on cf-connecting-ip. A client-supplied one is discarded; this one comes from the connection (or from Caddy).
  headers.set("cf-connecting-ip", clientIp(req));
  const origin = (publicOrigin ?? `http://${req.headers.host ?? "localhost"}`).replace(/[/]+$/, "");
  const target = req.url ?? "/";
  // Joined, not resolved: new URL("//evil.com/x", origin) would swap the host and make url.origin (redirects, CSRF checks) attacker-chosen.
  if (!target.startsWith("/")) throw new BadTarget();
  const method = req.method ?? "GET";
  return new Request(new URL(origin + target), { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body }) });
}

export function createApp(worker: Fetcher, env: Env, options: AppOptions = {}): Server {
  const limit = options.maxBodyBytes ?? 1_048_576;
  return createServer(async (req, res) => {
    try {
      const response = await worker.fetch(toRequest(req, await readBody(req, limit), options.publicOrigin), env);
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => { if (name !== "set-cookie") headers.push([name, value]); });
      for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
      res.writeHead(response.status, headers);
      res.end(req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      const [status, code] = error instanceof BodyTooLarge ? [413, "payload_too_large"] : error instanceof BadTarget ? [400, "bad_request"] : [500, "internal"];
      if (status === 500) console.error("licensing-node: unhandled error:", error instanceof Error ? error.message : "unknown error");
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: code }));
    }
  });
}
