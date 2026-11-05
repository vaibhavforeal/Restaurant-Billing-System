// The AI assistant's relay: a counter (signed in with its installation secret) sends a chat request, and this service forwards it with
// MasalaPOS's own OpenRouter key, within the counter's daily limit. Counters never hold a provider key.
import { AiChatRequest, type AiChatResponse, type AiReply, type AiRequest, type AiServiceStatus } from "@masalapos/domain/ai-wire";
import type { Env } from "../env.js";
import type { Deps } from "../issue.js";
import { INSTALLATION_HEADER } from "../live/authorize.js";
import { json } from "../portal/http.js";
import { SECRET_HEADER, verifyInstallationSecret } from "../secret.js";
import { getInstallation, latestLicense } from "../store.js";
import { createOpenRouter, DEFAULT_OPENROUTER_MODEL, ProviderError } from "./openrouter.js";
import { addTokens, aiDay, getAiSettings, releaseRequest, reserveRequest, usedOn } from "./store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Comfortably above the largest request the counter builds (AI_CHAT_LIMITS), so a body is never read without bound. */
const MAX_BODY_BYTES = 512 * 1024;
/** Under the counter's own 75 s wait, so the counter hears the service's answer rather than timing out first. */
const PROVIDER_TIMEOUT_MS = 65_000;

type Authenticated = { ok: true; installationId: string } | { ok: false; response: Response };

/** The counter behind the request: a known installation with a matching secret, enrolled with a customer, with a licence still in grace. */
export async function authenticateInstallation(deps: Deps, request: Request): Promise<Authenticated> {
  const installationId = request.headers.get(INSTALLATION_HEADER) ?? "";
  const found = UUID.test(installationId) ? await getInstallation(deps.db, installationId) : null;
  const installation = found ? await verifyInstallationSecret(deps.db, found, request.headers.get(SECRET_HEADER)) : null;
  if (!installation) return { ok: false, response: json({ error: "unknown_installation", message: "This counter isn't registered with MasalaPOS." }, 403) };
  // A released or replaced counter keeps its customer but not its seat; only a counter holding a seat may use the assistant.
  if (!installation.customerId || !installation.orderId) return { ok: false, response: json({ error: "not_enrolled", message: "This counter doesn't hold a seat on an order." }, 409) };
  const licence = await latestLicense(deps.db, installation.installationId);
  if (!licence || deps.now() >= licence.graceUntil) return { ok: false, response: json({ error: "licence_expired", message: "This counter's licence has ended." }, 403) };
  return { ok: true, installationId: installation.installationId };
}

/** GET /v1/ai/status: costs no AI request. */
export async function handleAiStatus(deps: Deps, request: Request): Promise<Response> {
  const auth = await authenticateInstallation(deps, request);
  if (!auth.ok) return auth.response;
  const settings = await getAiSettings(deps.db, auth.installationId);
  const status: AiServiceStatus = { enabled: settings.enabled, dailyLimit: settings.dailyLimit, usedToday: await usedOn(deps.db, auth.installationId, aiDay(deps.now())) };
  return json(status);
}

const fallbackOn = (value: string | undefined) => !/^(0|off|false|no)$/i.test(value?.trim() ?? "");
/** Provider trouble the counter may retry later (503), and failures retrying won't fix (502). */
const RETRYABLE = new Set(["limit", "unavailable", "offline"]);

/** POST /v1/ai/chat. */
export async function handleAiChat(deps: Deps, env: Env, request: Request): Promise<Response> {
  const auth = await authenticateInstallation(deps, request);
  if (!auth.ok) return auth.response;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "bad_request", message: "That request is too large." }, 400);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({ error: "bad_request" }, 400); }
  const parsed = AiChatRequest.safeParse(body);
  if (!parsed.success) return json({ error: "bad_request", message: "That AI request isn't in the expected form." }, 400);

  const { installationId } = auth;
  const settings = await getAiSettings(deps.db, installationId);
  if (!settings.enabled) return json({ error: "ai_not_enabled", message: "The AI assistant isn't switched on for this restaurant." }, 403);
  if (!env.OPENROUTER_API_KEY) return json({ error: "ai_unavailable", message: "The AI service isn't set up." }, 503);
  const day = aiDay(deps.now());
  if (!(await reserveRequest(deps.db, installationId, day, settings.dailyLimit))) {
    return json({ error: "ai_daily_limit", message: "Today's AI requests are used up.", limit: settings.dailyLimit, used: await usedOn(deps.db, installationId, day) }, 429);
  }

  const provider = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL, fallback: fallbackOn(env.OPENROUTER_FALLBACK), timeoutMs: PROVIDER_TIMEOUT_MS,
    ...(env.OPENROUTER_BASE_URL ? { baseUrl: env.OPENROUTER_BASE_URL } : {}) });
  let reply: AiReply;
  try {
    // zod reads optional fields as `T | undefined`; the parsed request is an AiRequest.
    reply = await provider.chat(parsed.data as AiRequest);
  } catch (error) {
    // A request the provider refused or never got costs nothing, so it is given back. One it answered (even uselessly) may have been
    // charged, so it stays counted; otherwise empty replies would be a way around the daily limit.
    if (!(error instanceof ProviderError) || error.code !== "no_answer") await releaseRequest(deps.db, installationId, day);
    if (!(error instanceof ProviderError)) throw error;
    // The provider's own message stays in the log: it can name MasalaPOS's account, so it never reaches the counter.
    console.warn(`licensing-worker: AI request failed: ${error.code}${error.detail ? ` (${error.detail.slice(0, 200)})` : ""}`);
    return json({ error: `ai_${error.code}` }, RETRYABLE.has(error.code) ? 503 : 502);
  }
  await addTokens(deps.db, installationId, day, reply.usage.inputTokens, reply.usage.outputTokens);
  const response: AiChatResponse = { reply, usedToday: await usedOn(deps.db, installationId, day), dailyLimit: settings.dailyLimit };
  return json(response);
}
