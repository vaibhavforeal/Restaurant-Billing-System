import { webCryptoSigner, encodeFeaturePolicy } from "@forkflow/license-issuer";
import { z } from "zod";
import { ownerRoute, installationPolicy } from "./owner-features.js";
import { syncStaffRoster } from "./staff-permissions.js";
import { StaffRoster } from "@forkflow/domain/staff-permissions";
import { handleActivate } from "./activate.js";
import type { Env } from "./env.js";
import type { Deps } from "./issue.js";
import { razorpayApi } from "./razorpay.js";
import { SECRET_HEADER } from "./secret.js";
import { subscribePage } from "./subscribe-page.js";
import { handleCreateSubscription } from "./subscriptions.js";
import { handleCreateSession, resolveSession } from "./sessions.js";
import { handleWebhook } from "./webhook.js";
import { handleCloudSubscriptionSession } from './cloud-subscriptions.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

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
  if(method==='POST'&&url.pathname==='/v1/cloud/subscribe-session'){
    if(await rateLimited(request,env))return json({error:'rate_limited'},429);
    const body=await readJson(request);return body.ok?handleCloudSubscriptionSession({db:env.DB,now:Date.now},body.body,request.headers.get('authorization'),env.CLOUD_SERVICE_TOKEN):json({error:'bad_request'},400);
  }
  const owner = await ownerRoute(request, env);
  if (owner) return owner;
  if (method === "POST" && url.pathname === "/v1/features") {
    if (await rateLimited(request, env)) return json({ error: "rate_limited" }, 429);
    const body = await readJson(request);
    const parsed = z.object({ installationId: z.string().uuid(), staff: StaffRoster.optional() }).strict().safeParse(body.ok ? body.body : null);
    if (!parsed.success) return json({ error: "bad_request" }, 400);
    const policy = await installationPolicy(env.DB, parsed.data.installationId, request.headers.get(SECRET_HEADER));
    if (!policy) return json({ error: "unauthorized" }, 401);
    if (parsed.data.staff && !await syncStaffRoster(env.DB, parsed.data.installationId, request.headers.get(SECRET_HEADER), parsed.data.staff)) return json({ error: "bad_request" }, 400);
    const response = json({ policy: await encodeFeaturePolicy(policy, (await signerFor(env)).sign) });
    response.headers.set("Cache-Control", "no-store"); return response;
  }
  const deps = async (): Promise<Deps> => ({ db: env.DB, signer: await signerFor(env), now: Date.now, uuid: () => crypto.randomUUID() });

  if (method === "POST" && url.pathname === "/v1/activate") {
    if (await rateLimited(request, env)) return json({ error: "rate_limited" }, 429);
    const body = await readJson(request);
    return body.ok ? handleActivate({ ...(await deps()), log: (message) => console.warn(message) }, body.body, request.headers.get(SECRET_HEADER)) : json({ error: "bad_request" }, 400);
  }
  if (method === "POST" && url.pathname === "/v1/subscribe-sessions") {
    if (await rateLimited(request, env)) return json({ error: "rate_limited" }, 429);
    const body = await readJson(request);
    return body.ok ? handleCreateSession(await deps(), body.body, request.headers.get(SECRET_HEADER)) : json({ error: "bad_request" }, 400);
  }
  if (method === "POST" && url.pathname === "/v1/subscriptions") {
    if (await rateLimited(request, env)) return json({ error: "rate_limited" }, 429);
    const body = await readJson(request);
    if (!body.ok) return json({ error: "bad_request" }, 400);
    return handleCreateSubscription({ ...(await deps()), razorpay: razorpayApi(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET), env }, body.body);
  }
  if (method === "GET" && url.pathname === "/subscribe") {
    // A malformed, unknown or expired session is never echoed; `?installation=` is not a thing any more.
    const session = url.searchParams.get("session");
    const valid = (await resolveSession(env.DB, session, Date.now())) !== null;
    return html(subscribePage(valid ? session! : "", valid), valid ? 200 : 404);
  }
  if (method === "POST" && url.pathname === "/webhooks/razorpay") {
    return handleWebhook({
      ...(await deps()), razorpay: razorpayApi(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET),
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET, log: (message) => console.warn(message),
    }, request);
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
