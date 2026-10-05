import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { request } from "node:https";
import { createRequire } from "node:module";
import type { EventEmitter } from "node:events";
import type { ConnectionOptions } from "node:tls";
import { freshApp, setupAdmin } from "./test-helpers.js";
import { loadCaptainHttps, startCaptainHttps } from "./captain-https.js";

// Use Fastify's existing ws dependency; only this integration test needs a client.
const WebSocket = createRequire(import.meta.url)("ws") as new (url: string, options: ConnectionOptions) => EventEmitter & { send(data: string): void; terminate(): void };

describe.skipIf(process.platform !== "win32")("Captain local HTTPS", () => {
  const directory = mkdtempSync(join(tmpdir(), "forkflow-captain-test-"));
  let generated = false;
  function configuration() {
    if (!generated) {
      execFileSync("powershell.exe", ["-NoProfile", "-File", resolve("tools/setup-captain-https.ps1"), "-ServerAddress", "127.0.0.1", "-DataDirectory", directory, "-Port", "4443"], { stdio: "pipe" });
      generated = true;
    }
    return loadCaptainHttps(directory)!;
  }
  afterAll(() => {
    if (!generated) return;
    const config = JSON.parse(readFileSync(join(directory, "captain-https.json"), "utf8"));
    const leaf = new X509Certificate(readFileSync(join(directory, config.certificateFile))).fingerprint.replaceAll(":", "");
    // Remove only the two certificates this test created in CurrentUser/My.
    for (const thumbprint of [config.caThumbprint, leaf]) {
      if (!/^[A-F0-9]{40}$/.test(thumbprint)) throw new Error("Invalid test certificate thumbprint");
      execFileSync("powershell.exe", ["-NoProfile", "-Command", `Remove-Item -LiteralPath 'Cert:\\CurrentUser\\My\\${thumbprint}' -ErrorAction SilentlyContinue`], { stdio: "pipe" });
    }
  });
  it("is optional and validates certificate address coverage", () => {
    expect(loadCaptainHttps(mkdtempSync(join(tmpdir(), "forkflow-no-tls-")))).toBeNull();
    const config = configuration(); expect(config.info.addresses).toEqual(["127.0.0.1"]);
    expect(config.info.fingerprint).toMatch(/^[A-F0-9:]+$/);
    const file = join(directory, "captain-https.json"), original = readFileSync(file, "utf8");
    try { writeFileSync(file, JSON.stringify({ ...JSON.parse(original), addresses: ["192.0.2.1"] })); expect(() => loadCaptainHttps(directory)).toThrow("does not cover"); }
    finally { writeFileSync(file, original); }
  });
  it("serves authenticated APIs and live KOT/table events through trusted TLS using the same POS", async () => {
    const app = freshApp(); const admin = await setupAdmin(app); await app.listen({ host: "127.0.0.1", port: 0 });
    const config = configuration(); const ca = new X509Certificate(config.info.certificate!).toString();
    const secure = await startCaptainHttps(app, { ...config, port: 0 }, "127.0.0.1");
    const address = secure.server.address() as { port: number };
    const get = (path: string, token?: string) => new Promise<{ status: number; body: any }>((done, reject) => {
      const req = request({ hostname: "127.0.0.1", port: address.port, path, ca, rejectUnauthorized: true, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
        let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => done({ status: res.statusCode!, body: JSON.parse(body) }));
      }); req.on("error", reject); req.end();
    });
    let ws: InstanceType<typeof WebSocket> | undefined;
    try {
      expect((await get("/api/health")).status).toBe(200);
      expect((await get("/api/orders")).status).toBe(401);
      expect((await get("/api/me", admin.token)).body.user.name).toBe("Asha");
      ws = new WebSocket(`wss://127.0.0.1:${address.port}/api/ws`, { ca, rejectUnauthorized: true });
      const authenticated = new Promise<void>((done, reject) => {
        ws!.on("error", reject); ws!.on("open", () => ws!.send(JSON.stringify({ type: "auth", token: admin.token })));
        ws!.on("message", (data: Buffer) => { if (JSON.parse(data.toString()).event === "auth.ok") done(); });
      });
      await authenticated;
      const event = new Promise<string>((done) => ws!.once("message", (data: Buffer) => done(JSON.parse(data.toString()).event)));
      app.broadcast("table.changed", {}); expect(await event).toBe("table.changed");
      expect((await app.inject("/api/health")).statusCode).toBe(200);
    } finally { ws?.terminate(); await secure.close(); await app.close(); app.db.close(); }
  });
});
