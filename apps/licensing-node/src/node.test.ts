import { generateKeyPairSync } from "node:crypto";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { LiveHub } from "../../licensing-worker/src/live/types.js";
import worker from "../../licensing-worker/src/index.js";
import type { Env } from "../../licensing-worker/src/env.js";
import { createApp, type Fetcher } from "./app.js";
import { directoryAssets } from "./assets.js";
import { memoryLimiter } from "./limiter.js";
import { aiEnv, readSecret } from "./secrets.js";
import { fileD1 } from "./sqlite-d1.js";

const MIGRATIONS = fileURLToPath(new URL("../../licensing-worker/migrations/", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "licensing-node-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function listen(fetcher: Fetcher, env: Env, publicOrigin?: string) {
  const server = createApp(fetcher, env, publicOrigin ? { publicOrigin, maxBodyBytes: 1024 } : { maxBodyBytes: 1024 }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe("fileD1", () => {
  it("applies every migration once and does nothing on a restart", () => {
    const path = join(root, "a", "licensing.db");
    const first = fileD1(path, MIGRATIONS);
    expect(first.applied.length).toBeGreaterThanOrEqual(7);
    first.db.close();
    const second = fileD1(path, MIGRATIONS);
    expect(second.applied).toEqual([]);
    second.db.close();
  });

  it("rolls a whole batch back when one statement fails", async () => {
    const { d1, db } = fileD1(":memory:", MIGRATIONS);
    const ok = d1.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").bind("x", "now");
    const dup = d1.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").bind("x", "again");
    await expect(d1.batch([ok, dup])).rejects.toThrow();
    expect(await d1.prepare("SELECT name FROM _migrations WHERE name = ?").bind("x").first()).toBeNull();
    db.close();
  });
});

describe("directoryAssets", () => {
  const dir = join(root, "web");
  mkdirSync(join(dir, "portal", "assets"), { recursive: true });
  writeFileSync(join(dir, "portal", "index.html"), "<h1>portal</h1>");
  writeFileSync(join(dir, "portal", "assets", "app.js"), "1");
  writeFileSync(join(root, "secret.txt"), "nope");
  const assets = directoryAssets(dir);
  const get = (path: string) => assets.fetch(new Request(`https://x.test${path}`));

  it("serves a directory as its index.html and files by type", async () => {
    const page = await get("/portal/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toBe("<h1>portal</h1>");
    expect((await get("/portal/assets/app.js")).headers.get("content-type")).toContain("javascript");
  });

  it("never reads outside the root", async () => {
    for (const path of ["/portal/../../secret.txt", "/%2e%2e/secret.txt", "/portal/%2e%2e/%2e%2e/secret.txt", "/%00"]) expect((await get(path)).status).toBe(404);
  });
});

describe("memoryLimiter", () => {
  it("allows the limit, refuses the next, and resets after the period", async () => {
    let now = 0;
    const limiter = memoryLimiter(2, 60, () => now);
    expect([await limiter.limit({ key: "a" }), await limiter.limit({ key: "a" }), await limiter.limit({ key: "a" })].map((r) => r.success)).toEqual([true, true, false]);
    expect((await limiter.limit({ key: "b" })).success).toBe(true);
    now = 61_000;
    expect((await limiter.limit({ key: "a" })).success).toBe(true);
  });
});

describe("createApp", () => {
  const env = { DB: fileD1(":memory:", MIGRATIONS).d1, LIMITER: memoryLimiter(100, 60), RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w", LICENSE_SIGNING_KEY: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString() } satisfies Env;

  it("runs the real Worker: bad JSON is a 400 and a missing portal build is a 503", async () => {
    const app = await listen(worker, env, "https://portal.test");
    expect((await fetch(`${app.url}/v1/activate`, { method: "POST", body: "{nope" })).status).toBe(400);
    expect((await fetch(`${app.url}/portal/`)).status).toBe(503);
    expect((await fetch(`${app.url}/nothing`)).status).toBe(404);
    await app.close();
  });

  it("redirects to the public origin, not the local port", async () => {
    const app = await listen(worker, env, "https://portal.test");
    const response = await fetch(`${app.url}/portal`, { redirect: "manual" });
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://portal.test/portal/");
    await app.close();
  });

  it("replaces a client-supplied cf-connecting-ip and takes the address from the proxy header only for loopback peers", async () => {
    const seen: (string | null)[] = [];
    const echo: Fetcher = { fetch: async (request) => { seen.push(request.headers.get("cf-connecting-ip")); return new Response("ok"); } };
    const app = await listen(echo, env);
    await fetch(`${app.url}/x`, { headers: { "cf-connecting-ip": "6.6.6.6" } });
    await fetch(`${app.url}/x`, { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } });
    expect(seen).toEqual(["127.0.0.1", "203.0.113.9"].map((ip) => (ip === "127.0.0.1" ? expect.stringMatching(/127\.0\.0\.1|::1/) : ip)));
    await app.close();
  });

  it("refuses an oversized body", async () => {
    const app = await listen(worker, env);
    expect((await fetch(`${app.url}/v1/activate`, { method: "POST", body: "x".repeat(5000) })).status).toBe(413);
    await app.close();
  });

  it("returns every Set-Cookie header separately", async () => {
    const cookies: Fetcher = { fetch: async () => { const h = new Headers(); h.append("set-cookie", "a=1; Path=/"); h.append("set-cookie", "b=2; Path=/"); return new Response("ok", { headers: h }); } };
    const app = await listen(cookies, env);
    const response = await fetch(`${app.url}/x`);
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    await app.close();
  });
});

describe("request targets", () => {
  const env = { DB: fileD1(":memory:", MIGRATIONS).d1, LIMITER: memoryLimiter(100, 60), RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w", LICENSE_SIGNING_KEY: "unused" } satisfies Env;

  it("a path that begins with // keeps the public origin and never redirects off-site", async () => {
    const seen: string[] = [];
    const echo: Fetcher = { fetch: async (req) => { const url = new URL(req.url); seen.push(`${url.origin}${url.pathname}`); return new Response("ok"); } };
    const app = await listen(echo, env, "https://portal.test");
    await fetch(`${app.url}//evil.com/portal`);
    expect(seen).toEqual(["https://portal.test//evil.com/portal"]);
    await app.close();
    const real = await listen(worker, env, "https://portal.test");
    const response = await fetch(`${real.url}//evil.com/portal`, { redirect: "manual" });
    expect([response.status, response.headers.get("location")]).toEqual([404, null]);
    await real.close();
  });

  it("refuses a request target that is not a path", async () => {
    const app = await listen(worker, env, "https://portal.test");
    const { port } = new URL(app.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "http://evil.com/portal" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject); req.end();
    });
    expect(status).toBe(400);
    await app.close();
  });
});

describe("readSecret", () => {
  it("drops the trailing newline of a secret file and prefers the variable itself", () => {
    const file = join(root, "whsec");
    writeFileSync(file, "whsec_123\n");
    expect(readSecret({ X_FILE: file }, "X")).toBe("whsec_123");
    expect(readSecret({ X: "direct", X_FILE: file }, "X")).toBe("direct");
    expect(readSecret({}, "X")).toBeUndefined();
  });
});

describe("live sockets", () => {
  const env = {} as Env;
  const noFetch: Fetcher = { fetch: async () => new Response("no") };

  /** A server whose hub records what it sees; `authorize` lets in requests carrying x-ok and names them by it. */
  async function liveServer() {
    const events: string[] = [];
    let sockets: Array<{ send(text: string): void; close(code?: number): void }> = [];
    const hub = {
      connect: (peer: { kind: string }, socket: { send(text: string): void; close(code?: number): void }) => {
        sockets.push(socket);
        events.push(`open:${peer.kind}`);
        return { onMessage: (text: string) => { events.push(`msg:${text}`); socket.send(`echo:${text}`); }, onClose: () => events.push("close") };
      },
    } as unknown as LiveHub;
    const authorize = async (request: Request) => {
      seenOrigins.push(new URL(request.url).origin);
      return request.headers.get("x-ok") ? { kind: "counter", installationId: "i", customerId: "c" } as const : null;
    };
    const seenOrigins: string[] = [];
    const server = createApp(noFetch, env, { publicOrigin: "https://portal.example", live: { hub, authorize, paths: ["/v1/counter/live"] } }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    return { events, seenOrigins, sockets: () => sockets, url: (path: string) => `ws://127.0.0.1:${port}${path}`, close: () => new Promise((resolve) => server.close(resolve)) };
  }
  const refusal = (ws: WebSocket) => new Promise<number>((resolve) => ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));

  it("refuses unknown paths and unauthorised peers before upgrading", async () => {
    const s = await liveServer();
    expect(await refusal(new WebSocket(s.url("/elsewhere"), { headers: { "x-ok": "1" } }))).toBe(404);
    expect(await refusal(new WebSocket(s.url("/v1/counter/live")))).toBe(403);
    expect(s.seenOrigins).toEqual(["https://portal.example"]);
    expect(s.events).toEqual([]);
    await s.close();
  });

  it("connects an authorised peer, carries text both ways, reports the close, and closing the server ends it", async () => {
    const s = await liveServer();
    const ws = new WebSocket(s.url("/v1/counter/live"), { headers: { "x-ok": "1" } });
    await new Promise((resolve) => ws.once("open", resolve));
    const reply = new Promise<string>((resolve) => ws.once("message", (data) => resolve(data.toString())));
    ws.send("hello");
    expect(await reply).toBe("echo:hello");
    const closed = new Promise((resolve) => ws.once("close", resolve));
    await s.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.events).toEqual(["open:counter", "msg:hello", "close"]);
  });

  it("closes a socket that sends binary", async () => {
    const s = await liveServer();
    const ws = new WebSocket(s.url("/v1/counter/live"), { headers: { "x-ok": "1" } });
    await new Promise((resolve) => ws.once("open", resolve));
    const code = new Promise<number>((resolve) => ws.once("close", (c) => resolve(c)));
    ws.send(Buffer.from([1, 2, 3]));
    expect(await code).toBe(1003);
    await s.close();
  });
});

describe("AI assistant relay configuration", () => {
  it("reads MasalaPOS's OpenRouter key from the environment or a root-only file, with the model and fallback", () => {
    expect(aiEnv({})).toEqual({});
    expect(aiEnv({ OPENROUTER_API_KEY: "sk-or-v1-env", OPENROUTER_MODEL: "nvidia/nemotron:free", OPENROUTER_FALLBACK: "off" }))
      .toEqual({ OPENROUTER_API_KEY: "sk-or-v1-env", OPENROUTER_MODEL: "nvidia/nemotron:free", OPENROUTER_FALLBACK: "off" });
    const file = join(root, "openrouter-key");
    writeFileSync(file, "sk-or-v1-file\n");
    expect(aiEnv({ OPENROUTER_API_KEY_FILE: file })).toEqual({ OPENROUTER_API_KEY: "sk-or-v1-file" });
  });

  it("answers /v1/ai/status on the Node adapter, refusing a counter it doesn't know", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const store = fileD1(join(root, "ai.db"), MIGRATIONS);
    const env: Env = {
      DB: store.d1, LIMITER: memoryLimiter(20, 60), LICENSE_SIGNING_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w", ...aiEnv({ OPENROUTER_API_KEY: "sk-or-v1-env" }),
    };
    const app = await listen(worker, env);
    try {
      const res = await fetch(`${app.url}/v1/ai/status`, { headers: { "x-masalapos-installation-id": crypto.randomUUID(), "x-masalapos-installation-secret": "c".repeat(64) } });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "unknown_installation" });
    } finally { await app.close(); store.db.close(); }
  });
});
