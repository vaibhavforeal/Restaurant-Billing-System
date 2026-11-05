import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { userCan } from "../auth.js";
import { ask, cleanHistory, daySummary, describeDish } from "./assistant.js";
import { AI_MESSAGES, AiError, type AiErrorCode, type AiProvider, type AiUsage } from "./provider.js";
import { createAiService, type AiServiceClient, type AiServiceOptions } from "./service.js";
import { AiStore, type AiFeature, type AiServiceCache } from "./store.js";

/** `service` is how this counter reaches MasalaPOS's AI service; without it (development and demo copies) the assistant is off. */
export interface AiOptions { dataDir: string; service?: Omit<AiServiceOptions, "fetch">; fetch?: typeof fetch }

const STATUS: Record<AiErrorCode, number> = {
  off: 409, not_enabled: 403, daily_limit: 429, limit: 503, offline: 503, unavailable: 503, bad_key: 502, model_gone: 502, no_answer: 502,
};
/** How old the service's last answer may be before the next status read asks again (in the background). */
const FRESH_MS = 15 * 60_000;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SettingsUpdate = z.object({ enabled: z.boolean() }).strict();
const AskBody = z.object({ question: z.string().trim().min(1).max(1000), history: z.unknown().optional() });
const DescribeBody = z.object({ name: z.string().trim().min(1).max(120), category: z.string().trim().max(80), isVeg: z.boolean(),
  sizes: z.array(z.string().trim().max(60)).max(20), current: z.string().max(500).optional() });
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * The AI assistant's HTTP surface. Requests go to MasalaPOS's AI service, which decides whether this restaurant may use it and how much;
 * the restaurant's own switch can turn it off here. The service's last answer is cached, refreshed at start, when it is older than 15
 * minutes, on Test, and after every AI request. Every reply is no-store; usage is counted per feature after each success.
 */
export function registerAi(app: FastifyInstance, opts: AiOptions | undefined): void {
  const store = opts ? new AiStore(opts.dataDir) : undefined;
  const client: AiServiceClient | undefined = opts?.service ? createAiService({ ...opts.service, ...(opts.fetch ? { fetch: opts.fetch } : {}) }) : undefined;
  const manage = app.requirePermission("settings.manage");

  /** The cached service status, with today's count reset once the UTC day has turned. */
  function service(): AiServiceCache | null {
    const cached = store?.service() ?? null;
    if (!cached) return null;
    return utcDay(cached.checkedAt) === utcDay(Date.now()) ? cached : { ...cached, usedToday: 0 };
  }
  const enabled = () => !!client && !!store && store.localEnabled() && !!service()?.enabled;
  function remember(next: Omit<AiServiceCache, "checkedAt">) {
    const was = enabled();
    store!.setService({ ...next, checkedAt: Date.now() });
    // Open screens show or hide the AI buttons from /api/ai/status.
    if (enabled() !== was) app.broadcast("settings.changed", {});
  }

  let refreshing: Promise<void> | null = null;
  /** Asks the service for this counter's status; one request at a time. */
  function refresh(): Promise<void> {
    if (!client || !store) return Promise.reject(new AiError("off"));
    refreshing ??= client.status().then(remember).finally(() => { refreshing = null; });
    return refreshing;
  }
  function refreshIfOld() {
    const cached = store?.service();
    if (client && (!cached || Date.now() - cached.checkedAt > FRESH_MS)) {
      refresh().catch((error: unknown) => app.log.warn({ detail: error instanceof Error ? error.message : String(error) }, "AI assistant status check failed"));
    }
  }
  app.addHook("onReady", async () => { refreshIfOld(); });

  /** The AI model, through the service. Keeps the cached limit and today's use up to date from each answer. */
  function provider(): AiProvider {
    if (!client || !store || !store.localEnabled()) throw new AiError("off");
    return {
      async chat(request) {
        try {
          const answer = await client.chat(request);
          remember({ enabled: true, dailyLimit: answer.dailyLimit, usedToday: answer.usedToday });
          return answer.reply;
        } catch (error) {
          const cached = service();
          if (error instanceof AiError && error.code === "not_enabled") remember({ enabled: false, dailyLimit: cached?.dailyLimit ?? 0, usedToday: cached?.usedToday ?? 0 });
          if (error instanceof AiError && error.code === "daily_limit" && cached) remember({ ...cached, usedToday: cached.dailyLimit });
          throw error;
        }
      },
    };
  }
  function settingsView() {
    if (!store) throw new AiError("off");
    return { connected: !!client, localEnabled: store.localEnabled(), service: service(), usage: store.usage() };
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
  /** A feature's AI requests: counts their tokens under `feature` and leaves them out of the reply. */
  function metered<T extends { usage?: AiUsage }>(reply: FastifyReply, feature: AiFeature, work: () => Promise<T>) {
    return guard(reply, async () => {
      const { usage, ...rest } = await work();
      store?.recordUsage(feature, usage ?? { inputTokens: 0, outputTokens: 0 });
      return rest;
    });
  }

  app.get("/api/ai/status", { preHandler: app.requireAuth }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    refreshIfOld();
    return { enabled: enabled(), connected: !!client, canAsk: userCan(req.user, "users.manage"), canDescribe: userCan(req.user, "catalog.manage"), canManage: userCan(req.user, "settings.manage") };
  });
  app.get("/api/ai/settings", { preHandler: manage }, async (_req, reply) => guard(reply, async () => { refreshIfOld(); return settingsView(); }));
  app.put("/api/ai/settings", { preHandler: manage }, async (req, reply) => {
    const body = SettingsUpdate.parse(req.body);
    return guard(reply, async () => {
      if (!store) throw new AiError("off");
      store.setLocalEnabled(body.enabled);
      app.broadcast("settings.changed", {});
      return settingsView();
    });
  });
  app.post("/api/ai/test", { preHandler: manage }, async (_req, reply) => guard(reply, async () => {
    if (!client) throw new AiError("off");
    await refresh();
    return settingsView();
  }));
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
