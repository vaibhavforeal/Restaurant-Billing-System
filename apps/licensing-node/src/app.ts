// Turns the Worker's fetch(request, env) into a Node HTTP server. Runs behind Caddy on the same machine, which terminates HTTPS.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Env } from "../../licensing-worker/src/env.js";
import type { LiveHub, Peer } from "../../licensing-worker/src/live/types.js";

export interface Fetcher { fetch(request: Request, env: Env): Promise<Response> }
export interface AppOptions {
  /** The public https origin (https://portal.billnroll.in). Redirects and absolute URLs the Worker builds use it, not the local port. */
  publicOrigin?: string;
  /** Largest request body accepted; the biggest legitimate one is a few KB of JSON. */
  maxBodyBytes?: number;
  /** Live sockets for support: the hub, and who may open one (live/authorize.ts). Without it every upgrade is refused. */
  live?: { hub: LiveHub; authorize(request: Request): Promise<Peer | null>; paths: readonly string[] };
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

/** Largest live message: an SDP offer with many candidates is a few KB. */
const MAX_LIVE_MESSAGE = 64 * 1024;
/** Proxies drop idle connections; a ping every 25 s keeps them open and finds dead ones. */
const HEARTBEAT_MS = 25_000;

function refuse(socket: Duplex, status: number, text: string) {
  socket.end(["HTTP/1.1 " + status + " " + text, "Connection: close", "Content-Length: 0", "", ""].join("\r\n"));
}

function attachLive(server: Server, live: NonNullable<AppOptions["live"]>, publicOrigin: string | undefined) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LIVE_MESSAGE, perMessageDeflate: false });
  const alive = new WeakMap<WebSocket, boolean>();
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    void (async () => {
      let request: Request;
      try { request = toRequest(req, Buffer.alloc(0), publicOrigin); } catch { refuse(socket, 400, "Bad Request"); return; }
      if (!live.paths.includes(new URL(request.url).pathname)) { refuse(socket, 404, "Not Found"); return; }
      const peer = await live.authorize(request).catch(() => null);
      if (!peer) { refuse(socket, 403, "Forbidden"); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const connection = live.hub.connect(peer, {
          send: (text) => { if (ws.readyState === ws.OPEN) ws.send(text); },
          close: (code, reason) => ws.close(code, reason),
        });
        alive.set(ws, true);
        ws.on("pong", () => alive.set(ws, true));
        ws.on("message", (data, isBinary) => { if (isBinary) ws.close(1003, "Text only"); else connection.onMessage(data.toString()); });
        ws.on("close", () => connection.onClose());
        ws.on("error", () => ws.terminate());
      });
    })().catch(() => refuse(socket, 500, "Internal Server Error"));
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) { ws.terminate(); continue; }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  // Upgraded sockets would keep close() waiting: they go first.
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    return close(callback);
  }) as Server["close"];
}

export function createApp(worker: Fetcher, env: Env, options: AppOptions = {}): Server {
  const limit = options.maxBodyBytes ?? 1_048_576;
  const server = createServer(async (req, res) => {
    try {
      const response = await worker.fetch(toRequest(req, await readBody(req, limit), options.publicOrigin), env);
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => { if (name !== "set-cookie") headers.push([name, value]); });
      for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
      res.writeHead(response.status, headers);
      const body = req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer());
      res.end(body);
      const route = (req.url ?? "").split("?")[0];
      if (route && ["/portal/api/connector","/support/connector","/support/connector-runtime/latest.json","/v1/connector/redeem","/v1/connector/consent"].includes(route)) {
        console.log(JSON.stringify({event:"connector.http",route,status:response.status,bytes:body?.length ?? 0}));
      }
    } catch (error) {
      const [status, code] = error instanceof BodyTooLarge ? [413, "payload_too_large"] : error instanceof BadTarget ? [400, "bad_request"] : [500, "internal"];
      if (status === 500) console.error("licensing-node: unhandled error:", error instanceof Error ? error.name : "unknown error");
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: code }));
    }
  });
  if (options.live) attachLive(server, options.live, options.publicOrigin);
  return server;
}
