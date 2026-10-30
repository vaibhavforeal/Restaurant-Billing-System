import { webCryptoSigner } from "@forkflow/license-issuer";
import { handleActivate } from "./activate.js";
import type { Env } from "./env.js";
import type { Deps } from "./issue.js";
import { handleEnroll } from "./enroll.js";
import { SECRET_HEADER } from "./secret.js";
import { handleWebhook } from "./webhook.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type SignerPair = Deps["signer"];
// One signer per isolate (importing the key is not free); a failed import is dropped so the next request retries it.
let cachedSigner: { key: string; promise: Promise<SignerPair> } | null = null;
function signerFor(env: Env): Promise<SignerPair> {
  if (cachedSigner?.key !== env.LICENSE_SIGNING_KEY) {
    const entry = { key: env.LICENSE_SIGNING_KEY, promise: webCryptoSigner(env.LICENSE_SIGNING_KEY) };
    entry.promise.catch(() => { if (cachedSigner === entry) cachedSigner = null; });
    cachedSigner = entry;
  }
  return cachedSigner.promise;
}

// Fails open: an unavailable rate limiter must not take licensing down. Only the error message is logged (no IP, headers or body).
async function rateLimited(request: Request, env: Env): Promise<boolean> {
  try { return !(await env.LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" })).success; }
  catch (error) {
    console.error("licensing-worker: rate limiter unavailable:", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try { return { ok: true, body: await request.json() }; } catch { return { ok: false }; }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { method } = request;
  const deps = async (): Promise<Deps> => ({ db: env.DB, signer: await signerFor(env), now: Date.now, uuid: () => crypto.randomUUID() });

  if (method === "POST" && url.pathname === "/v1/activate") {
    if (await rateLimited(request, env)) return json({ error: "rate_limited" }, 429);
    const body = await readJson(request);
    return body.ok ? handleActivate({ ...(await deps()), log: (message) => console.warn(message) }, body.body, request.headers.get(SECRET_HEADER)) : json({ error: "bad_request" }, 400);
  }
  if (method === "POST" && url.pathname === "/v1/enroll") {
    if (await rateLimited(request, env)) return json({ error: "rate_limited" }, 429);
    const body = await readJson(request);
    return body.ok ? handleEnroll(await deps(), body.body, request.headers.get(SECRET_HEADER)) : json({ error: "bad_request" }, 400);
  }
  if (method === "POST" && url.pathname === "/webhooks/razorpay") {
    return handleWebhook({ ...(await deps()), webhookSecret: env.RAZORPAY_WEBHOOK_SECRET, log: (message) => console.warn(message) }, request);
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await route(request, env); }
    catch (error) {
      // The message only: request bodies and secrets never reach the log.
      console.error("licensing-worker: unhandled error:", error instanceof Error ? error.message : "unknown error");
      return json({ error: "internal" }, 500);
    }
  },
};
