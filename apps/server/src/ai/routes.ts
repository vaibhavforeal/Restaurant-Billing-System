import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { userCan } from "../auth.js";
import { ask, cleanHistory, daySummary, describeDish } from "./assistant.js";
import { createOpenRouter } from "./openrouter.js";
import { AI_MESSAGES, AiError, type AiErrorCode, type AiProvider, type AiUsage } from "./provider.js";
import { AiStore, type AiFeature } from "./store.js";

export interface AiOptions { dataDir: string; secretKey: Buffer | undefined; fetch?: typeof fetch; baseUrl?: string }

const STATUS: Record<AiErrorCode, number> = { off: 409, limit: 429, offline: 503, unavailable: 503, bad_key: 502, model_gone: 502, no_answer: 502 };
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SettingsUpdate = z.object({
  enabled: z.boolean().optional(), model: z.string().min(1).max(200).optional(), fallback: z.boolean().optional(),
  key: z.string().trim().min(10).max(300).nullable().optional(),
}).strict();
const AskBody = z.object({ question: z.string().trim().min(1).max(1000), history: z.unknown().optional() });
const DescribeBody = z.object({ name: z.string().trim().min(1).max(120), category: z.string().trim().max(80), isVeg: z.boolean(),
  sizes: z.array(z.string().trim().max(60)).max(20), current: z.string().max(500).optional() });

/**
 * The AI assistant's HTTP surface. Without `opts` (demo, or no data folder) every route but status answers "off".
 * Keys are write-only; every reply is no-store; usage is counted per feature after each success.
 */
export function registerAi(app: FastifyInstance, opts: AiOptions | undefined): void {
  const store = opts ? new AiStore(opts.dataDir, opts.secretKey) : undefined;
  const manage = app.requirePermission("settings.manage");
  const enabled = () => !!store && store.settings().enabled && !!store.key(store.settings().provider);

  function provider(): AiProvider {
    if (!store || !enabled()) throw new AiError("off");
    const settings = store.settings();
    return createOpenRouter({ apiKey: store.key(settings.provider)!, model: settings.model, fallback: settings.fallback,
      ...(opts?.fetch ? { fetch: opts.fetch } : {}), ...(opts?.baseUrl ? { baseUrl: opts.baseUrl } : {}) });
  }
  function settingsView() {
    if (!store) throw new AiError("off");
    const settings = store.settings();
    return { settings, keySaved: !!store.key(settings.provider), keyEnding: store.keyEnding(settings.provider), usage: store.usage(), canSaveKey: !!opts?.secretKey };
  }
  /** Maps an AiError to its status and message; every AI reply is no-store. */
  async function guard<T>(reply: FastifyReply, work: () => Promise<T>) {
    reply.header("Cache-Control", "no-store");
    try { return await work(); } catch (error) {
      if (!(error instanceof AiError)) throw error;
      app.log.warn({ code: error.code, detail: error.message }, "AI assistant request failed");
      return reply.status(STATUS[error.code]).send({ error: AI_MESSAGES[error.code], code: `ai_${error.code}` });
    }
  }
  /** A request to the provider: counts its tokens under `feature` and leaves them out of the reply. */
  function metered<T extends { usage?: AiUsage }>(reply: FastifyReply, feature: AiFeature, work: () => Promise<T>) {
    return guard(reply, async () => {
      const { usage, ...rest } = await work();
      store?.recordUsage(feature, usage ?? { inputTokens: 0, outputTokens: 0 });
      return rest;
    });
  }

  app.get("/api/ai/status", { preHandler: app.requireAuth }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { enabled: enabled(), canAsk: userCan(req.user, "users.manage"), canDescribe: userCan(req.user, "catalog.manage"), canManage: userCan(req.user, "settings.manage") };
  });
  app.get("/api/ai/settings", { preHandler: manage }, async (_req, reply) => guard(reply, async () => settingsView()));
  app.put("/api/ai/settings", { preHandler: manage }, async (req, reply) => {
    const body = SettingsUpdate.parse(req.body);
    return guard(reply, async () => {
      if (!store) throw new AiError("off");
      if (body.key !== undefined) store.setKey(store.settings().provider, body.key);
      store.saveSettings({ ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), ...(body.model !== undefined ? { model: body.model } : {}), ...(body.fallback !== undefined ? { fallback: body.fallback } : {}) });
      // Open screens show or hide the AI buttons from /api/ai/status.
      app.broadcast("settings.changed", {});
      return settingsView();
    });
  });
  app.get("/api/ai/models", { preHandler: manage }, async (_req, reply) => guard(reply, async () => {
    if (!store) throw new AiError("off");
    const key = store.key(store.settings().provider) ?? "";
    const models = await createOpenRouter({ apiKey: key, model: store.settings().model, fallback: false, ...(opts?.fetch ? { fetch: opts.fetch } : {}), ...(opts?.baseUrl ? { baseUrl: opts.baseUrl } : {}) }).listModels();
    return { models };
  }));
  app.post("/api/ai/test", { preHandler: manage }, async (_req, reply) => metered(reply, "test", () => provider().check()));
  app.post("/api/ai/ask", { preHandler: app.requirePermission("users.manage") }, async (req, reply) => {
    const body = AskBody.parse(req.body);
    return metered(reply, "ask", () => ask(provider(), app.db, body.question, cleanHistory(body.history), Date.now()));
  });
  app.post("/api/ai/day-summary", { preHandler: app.requirePermission("users.manage") }, async (req, reply) => {
    const { date } = z.object({ date: DATE }).parse(req.body);
    return metered(reply, "daySummary", () => daySummary(provider(), app.db, date));
  });
  app.post("/api/ai/describe", { preHandler: app.requirePermission("catalog.manage") }, async (req, reply) => {
    const body = DescribeBody.parse(req.body);
    return metered(reply, "describe", () => describeDish(provider(), { name: body.name, category: body.category, isVeg: body.isVeg, sizes: body.sizes, ...(body.current ? { current: body.current } : {}) }));
  });
}
