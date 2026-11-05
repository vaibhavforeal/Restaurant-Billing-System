# AI Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an optional online AI assistant on the hub (Ask your sales, end-of-day summary, menu descriptions) using the restaurant's own OpenRouter key now, behind a provider interface so OpenAI or Anthropic adapters can replace it later.

**Architecture:** a new `apps/server/src/ai/` folder holds a neutral `AiProvider` interface, an OpenRouter adapter (plain `fetch`, injectable), read-only lookup tools wrapping existing report functions, the request flows, and routes. Settings, the sealed key and usage counters live in `dataDir/ai-assistant.json`, sealed with AES-256-GCM helpers extracted from `google-drive.ts`. The UI adds a Settings section, a Reports tab, a Day-end button and a dish-editor button, all hidden unless `/api/ai/status` says the feature is on.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, zod, React, vitest, Playwright-style browser scripts (`tools/e2e`).

**Spec:** `docs/superpowers/specs/2026-11-04-ai-assistant-design.md`

## Global Constraints

- No new npm dependencies. OpenRouter is called with global `fetch`; the OpenAI and Anthropic SDKs are **not** added now.
- No database migration. All AI state is in `dataDir/ai-assistant.json`, outside SQLite and its backups.
- Default model `google/gemma-4-31b-it:free`; fallback `openrouter/free`, on by default.
- OpenRouter base URL `https://openrouter.ai/api/v1`. Headers: `Authorization: Bearer <key>`, `HTTP-Referer: https://billnroll.in`, `X-Title: MasalaPOS`. Request timeout 60 s.
- Permissions:
  - Settings, models and Test use `settings.manage`.
  - Ask and day summary use `users.manage` (admins).
  - Describe uses `catalog.manage`.
  - Status needs any signed-in user.
- At most 6 lookups per question. Lookup date ranges are capped at 366 days (as `reportRange` already does).
- Descriptions are at most 200 characters.
- Never sent to the provider: customer names, phones, addresses, birthdays, notes, types or loyalty. Staff appear by first name only.
- The key is write-only. No response ever contains it; settings return `keySaved` and `keyEnding` (last 4 characters).
- Error copy is verbatim from spec section 7. This plan adds one code, `unavailable` (provider 5xx): "The AI service isn't responding right now. Try again in a minute."
- Every UI entry point is hidden when the assistant is off. Billing never depends on AI.
- e2e fixtures sign in as `admin` / `admin-password`. The fake OpenRouter listens on 127.0.0.1:4161 and the app fixture on 127.0.0.1:4160.

## Review Focus

1. **The provider returns tool-call arguments that aren't valid JSON, or a tool name it wasn't given.** Expect the lookup to return `{"error": ...}` to the model and the loop to continue, not a 500. Tested in Task 5.
2. **A model loops on lookups.** Expect the 7th call to be refused, and the final request sent without tools so the model must answer. Tested in Task 5.
3. **A saved model is no longer in OpenRouter's free list.** Expect Settings to show it with "(no longer offered)" rather than silently switching. Tested in Task 7.
4. **The data dir holds an `ai-assistant.json` sealed with another PC's key** (a copied data folder). Expect "key saved" to read false, with no crash, and the owner to re-enter the key. Tested in Task 2.
5. **Chat history sent from the browser is oversized or forged** (role "system", huge text). Expect it trimmed to the last 10 user/assistant turns of at most 2,000 characters each, with any other role dropped. Tested in Task 5.

---

### Task 1: Shared secret box

**Files:**
- Create: `apps/server/src/secret-box.ts`
- Modify: `apps/server/src/google-drive.ts` (replace private `seal`/`unseal` with the helpers); `apps/server/src/drive-config.ts` (use `resolveSecretKey`)
- Test: `apps/server/src/secret-box.test.ts`

**Interfaces:**
- Produces:
  - `seal(key: Buffer, text: string): string` (format `v1.iv.tag.data`, base64 parts, as today)
  - `unseal(key: Buffer, sealed: string): string` (throws `Error("Unsupported credential format")` on a bad version or parts; the GCM failure throws on a wrong key or tampering)
  - `resolveSecretKey(input: { dataDir: string; secretKey: string | undefined; commercial: boolean; warn: (m: string) => void }): Buffer | undefined`, holding the dev-secret.key fallback moved from drive-config. It returns undefined if the key length isn't 32.

- [ ] **Step 1: Write the failing tests**
  - `round-trips text with the same key`: `unseal(k, seal(k, "sk-or-123")) === "sk-or-123"`, and two seals of the same text differ.
  - `rejects a wrong key or a changed byte`: `expect(() => unseal(otherKey, sealed)).toThrow()`, and the same after flipping one character of the data part.
  - `rejects an unknown format`: `toThrow("Unsupported credential format")` for `"v2.a.b.c"` and `"junk"`.
  - `resolveSecretKey uses the shell key, else a dev key file, else nothing in commercial builds`:
    - A base64 32-byte input returns that key.
    - With undefined input and `commercial: false`, it creates `dev-secret.key` in a temp dir and returns the same key on the second call.
    - With `commercial: true` and no key, it returns `undefined`.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/secret-box.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `secret-box.ts`**, moving the bodies from `google-drive.ts` lines ~355–367 and drive-config's dev-key block. Make `GoogleDriveProvider` call `seal(this.options.secretKey, …)` and `unseal(…)`. Make `drive-config.ts` call `resolveSecretKey` and keep its warnings.
- [ ] **Step 4: Run** `npx vitest run apps/server/src/secret-box.test.ts apps/server/src/google-drive.test.ts`. Expected: all PASS (the Drive tests unchanged).
- [ ] **Step 5: Commit** `refactor(server): shared AES-GCM secret box for sealed credentials`

### Task 2: AI settings store

**Files:**
- Create: `apps/server/src/ai/store.ts`
- Test: `apps/server/src/ai/store.test.ts`

**Interfaces:**
- Consumes: `seal`, `unseal` (Task 1); `atomicJson` from `apps/server/src/backups.ts`.
- Produces:
  - `type AiProviderId = "openrouter"`
  - `type AiFeature = "ask" | "daySummary" | "describe" | "test"`
  - `interface AiSettings { enabled: boolean; provider: AiProviderId; model: string; fallback: boolean }`
  - `interface AiUsageTotals { requests: number; inputTokens: number; outputTokens: number }`
  - `class AiStore`:
    - `constructor(dataDir: string, secretKey: Buffer | undefined)`
    - `settings(): AiSettings` (defaults `{ enabled: false, provider: "openrouter", model: "google/gemma-4-31b-it:free", fallback: true }`)
    - `saveSettings(patch: Partial<AiSettings>): AiSettings`
    - `setKey(provider: AiProviderId, key: string | null): void` (throws `Error("Saving a key needs Windows credential protection")` when there's no secretKey)
    - `key(provider): string | null`
    - `keyEnding(provider): string | null`
    - `recordUsage(feature: AiFeature, usage: { inputTokens: number; outputTokens: number }): void`
    - `usage(): Record<AiFeature, AiUsageTotals>`
  - File `ai-assistant.json`: `{ settings, keys: { openrouter?: sealedString }, usage }`.

- [ ] **Step 1: Write the failing tests**
  - `starts with the defaults and no key`: `settings()` equals the defaults; `key("openrouter")` is `null`.
  - `seals the key on disk and reads it back`: after `setKey("openrouter", "sk-or-v1-abcd1234")`:
    - the raw file text does not contain `"sk-or-v1-abcd1234"`
    - a new `AiStore` on the same dir returns the key
    - `keyEnding` is `"1234"`
  - `forgets a key sealed on another PC` (Review Focus 4): write with key A, read with key B. `key()` is `null` and `keyEnding()` is `null`, with no throw.
  - `removes the key with null`.
  - `refuses to save a key without a secret key`: the constructor gets `undefined`, and `setKey` throws the message above.
  - `adds usage per feature`: two `recordUsage("ask", {inputTokens: 100, outputTokens: 20})` give `{requests: 2, inputTokens: 200, outputTokens: 40}`; the others stay 0.
  - `keeps settings when the file is unreadable JSON`: the file contains `"{"`, and `settings()` returns the defaults.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/ai/store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `store.ts`.** Read the file lazily and catch parse errors (treat them as empty). Write with `atomicJson` after every change.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): settings store with a sealed provider key and usage counters`

### Task 3: Provider interface and OpenRouter adapter

**Files:**
- Create: `apps/server/src/ai/provider.ts`, `apps/server/src/ai/openrouter.ts`
- Test: `apps/server/src/ai/openrouter.test.ts`

**Interfaces:**
- Produces (`provider.ts`):
  - `interface AiTool { name: string; description: string; parameters: Record<string, unknown> }` (JSON schema object)
  - `interface AiToolCall { id: string; name: string; arguments: string }` (raw JSON text)
  - `type AiMessage = { role: "user"; text: string } | { role: "assistant"; text: string; toolCalls?: AiToolCall[] } | { role: "tool"; toolCallId: string; name: string; content: string }`
  - `interface AiRequest { system: string; messages: AiMessage[]; tools?: AiTool[]; maxTokens: number }`
  - `interface AiReply { text: string; toolCalls: AiToolCall[]; model: string; usage: { inputTokens: number; outputTokens: number } }`
  - `interface AiModel { id: string; name: string; contextLength: number; free: boolean; supportsTools: boolean }`
  - `interface AiCheck { model: string; freeRequestsUsed: number | null; freeRequestsLimit: number | null }`
  - `interface AiProvider { listModels(): Promise<AiModel[]>; chat(req: AiRequest): Promise<AiReply>; check(): Promise<AiCheck> }`
  - `type AiErrorCode = "off" | "offline" | "bad_key" | "limit" | "model_gone" | "unavailable" | "no_answer"`
  - `class AiError extends Error { readonly code: AiErrorCode }`
  - `const AI_MESSAGES: Record<AiErrorCode, string>`. The copy is from spec section 7 plus `unavailable` (Global Constraints). `off` is "Set up the AI assistant in Settings → AI assistant."
- Produces (`openrouter.ts`):
  - `DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free"` and `OPENROUTER_FALLBACK = "openrouter/free"`
  - `createOpenRouter(opts: { apiKey: string; model: string; fallback: boolean; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }): AiProvider`

- [ ] **Step 1: Write the failing tests** with a recording fake `fetch`.
  - `sends the system prompt, mapped messages, tools and the fallback list`. The body sent to `POST {base}/chat/completions` has:
    - `models: ["google/gemma-4-31b-it:free", "openrouter/free"]` and no `model`
    - `messages[0]` equal to `{role: "system", content: "S"}`
    - an assistant turn with `tool_calls: [{id: "c1", type: "function", function: {name: "item_sales", arguments: "{}"}}]`
    - a tool turn `{role: "tool", tool_call_id: "c1", content: "{...}"}`
    - `tools[0]` equal to `{type: "function", function: {name, description, parameters}}`
    - `max_tokens` set
    - the headers `Authorization: Bearer sk`, `HTTP-Referer` and `X-Title`
  - `sends model alone when fallback is off`: the body has `model` and no `models`.
  - `maps a reply with text, tool calls, the answering model and usage`: the response `{model: "openrouter/free", choices: [{message: {content: null, tool_calls: [...]}}], usage: {prompt_tokens: 10, completion_tokens: 3}}` maps to `{text: "", toolCalls: [{id, name, arguments}], model: "openrouter/free", usage: {inputTokens: 10, outputTokens: 3}}`.
  - `maps failures to codes`:
    - a fetch that throws `TypeError` → `offline`
    - a fetch that aborts or times out → `offline`
    - 401 and 403 → `bad_key`
    - 429 → `limit`
    - 404 → `model_gone`
    - 500 and 503 → `unavailable`
    - 200 with `{error: {code: 429}}` → `limit`
    - 200 with no content and no tool calls → `no_answer`
  - `lists only free models that support tools`. Given four models (free with tools, free without tools, paid with tools, and `openrouter/free`), only the free tool-capable ones come back, as `AiModel` with `contextLength` from `context_length`. `GET {base}/models` is called without an Authorization header.
  - `check reports the answering model and today's free requests`: a chat reply plus `GET {base}/key` → `{data: {free_model_daily_requests: {used: 12, limit: 50}}}` gives `{model, freeRequestsUsed: 12, freeRequestsLimit: 50}`. A missing field gives `null`s.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/ai/openrouter.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files. `AbortSignal.timeout(timeoutMs ?? 60_000)` on every request. Treat a model as free when `pricing.prompt === "0" && pricing.completion === "0"`, and as supporting tools when `supported_parameters` includes `"tools"`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): provider interface and OpenRouter adapter`

### Task 4: Read-only lookups with privacy rules

**Files:**
- Create: `apps/server/src/ai/tools.ts`
- Modify: `apps/server/src/costing.ts` (export `profitLines`)
- Test: `apps/server/src/ai/tools.test.ts`

**Interfaces:**
- Consumes:
  - `reportRange` and `ReportRange` (`sales-reports.ts`)
  - `orderAnalyticsReport(db, range, "all")` (`order-analytics.ts`)
  - `profitLines` + `buildMenuEngineeringReport`
  - `prepForecast(db, date, today)`
  - `activityEvents`, `activityThresholds`, `ACTIVITY_BASELINE_DAYS` (`staff-activity.ts`) + `buildStaffActivityReport`
  - `moduleActive(db, "costing")`
  - `localDateKey`
- Produces:
  - `AI_TOOLS: AiTool[]`: exactly `sales_by_day`, `sales_by_hour`, `item_sales`, `category_sales`, `order_types`, `menu_engineering`, `prep_forecast`, `staff_activity`, `today`, with the arguments from spec section 2. `from` and `to` are `YYYY-MM-DD` strings and optional (default last 7 days). `category` is optional. `date` is required.
  - `runTool(db: Database, name: string, argsJson: string, now: number): { content: string; used: string }`:
    - `content` is compact JSON.
    - `used` is a human label, e.g. `"Item sales, 2026-10-01 to 2026-10-31"`.
    - Unknown name or bad JSON or arguments: `content` is `{"error":"..."}` and `used` is `""`. It never throws.
  - `firstName(name: string): string`

- [ ] **Step 1: Write the failing tests.** Use `freshApp` + `setupAdmin` and seed bills through the API, as in `order-analytics.test.ts`.
  - `sales_by_day returns each date with orders and sales`
  - `item_sales returns at most 30 dishes and filters by category`
  - `today returns the hub date, weekday and timezone`
  - `menu_engineering returns dish, category, plates, margin and group, or an error while Dish costing is off`
  - `prep_forecast returns dishes and ingredients for the date`
  - `staff_activity names staff by first name only`: an admin named "Asha Rao" appears as `"Asha"`, and `"Rao"` is absent.
  - `never returns customer details`: seed customer "Priya Sharma" with phone `98765 43210` attached to billed orders. For every tool in `AI_TOOLS`, run it with a range covering those bills, and its `content` contains neither `"Priya"` nor `"98765"`.
  - `bad arguments and unknown tools return an error result` (Review Focus 1): `runTool(db, "item_sales", "{not json", now)` and `runTool(db, "drop_tables", "{}", now)` both give `content` matching `/"error"/`, with no throw. `{"from":"2020-01-01","to":"2026-11-04"}` gives an error (more than 366 days).
- [ ] **Step 2: Run** `npx vitest run apps/server/src/ai/tools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `tools.ts`**: one zod schema per tool, `reportRange` for date validation, and output trimmed to the fields in spec section 2. Export `profitLines` from `costing.ts` unchanged.
- [ ] **Step 4: Run** the same command plus `npx vitest run apps/server/src/costing.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): read-only sales lookups for the assistant, without customer details`

### Task 5: Assistant flows

**Files:**
- Create: `apps/server/src/ai/assistant.ts`
- Test: `apps/server/src/ai/assistant.test.ts`

**Interfaces:**
- Consumes: `AiProvider` (Task 3), `AI_TOOLS`/`runTool`/`firstName` (Task 4), `dayEndReport(db, date)` (`reports.ts`), `orderAnalyticsReport`, `activityEvents` + `buildStaffActivityReport`.
- Produces:
  - `MAX_LOOKUPS = 6`
  - `type ChatTurn = { role: "user" | "assistant"; text: string }`
  - `cleanHistory(history: unknown): ChatTurn[]`: keeps the last 10 user/assistant turns, text trimmed to 2,000 characters, other roles dropped
  - `ask(provider: AiProvider, db: Database, question: string, history: ChatTurn[], now: number): Promise<{ answer: string; figuresUsed: string[]; model: string; usage: { inputTokens: number; outputTokens: number } }>`. Usage is summed over every request.
  - `daySummaryInput(db: Database, date: string): object`, containing:
    - `restaurant`: name and city
    - `date` and `weekday`
    - `totals` from `dayEndReport`
    - `top5` and `bottom5` dishes by plates
    - `weekdayAverage`: average net sales over the last 4 same weekdays
    - `credits`: voids and refunds count and amount
    - `discounts`
    - `staffFlags`: first names only
  - `daySummary(provider, db, date): Promise<{ text: string; model: string; usage }>`
  - `describeDish(provider, input: { name: string; category: string; isVeg: boolean; sizes: string[]; current?: string }): Promise<{ text: string; model: string; usage }>`. The text is cut to at most 200 characters, at the last sentence end or word boundary.
  - Prompts: `ASK_SYSTEM`, `SUMMARY_SYSTEM`, `DESCRIBE_SYSTEM` as exported constants. Their content follows spec sections 2–4 (answer only from lookups, never invent figures, rupees, brief; 5–8 bullet points; 1–2 appetising lines with no claims about ingredients that weren't given).

- [ ] **Step 1: Write the failing tests** with a scripted fake `AiProvider` that records requests.
  - `ask runs the lookups the model asks for and returns the answer with figures used`:
    - The script is: a tool call `item_sales {}`, then the text "Paneer tikka sells most."
    - The answer equals that text, and `figuresUsed` has one item-sales label.
    - The second request's messages end with the tool result.
  - `ask stops after 6 lookups and makes the model answer` (Review Focus 2): the fake keeps returning tool calls. Exactly 6 tools run, and the 7th request has no `tools` and gets an answer.
  - `ask feeds bad tool arguments back as an error and continues` (Review Focus 1)
  - `cleanHistory drops system turns and trims long or extra turns` (Review Focus 5): 15 turns including `{role: "system"}` and a 5,000-character text give 10 turns, none "system", each at most 2,000 characters.
  - `daySummaryInput has totals, top and bottom dishes, the weekday average, and staff first names, and no customer details` (seed as in Task 4)
  - `describeDish sends name, category, veg and sizes, and cuts the reply to 200 characters`: the fake returns 300 characters, and the result is at most 200 characters, ending at a word boundary. With `current` given, the request text includes it.
  - `usage adds up across requests`
- [ ] **Step 2: Run** `npx vitest run apps/server/src/ai/assistant.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `assistant.ts`.** The loop: send with `AI_TOOLS`. For each returned tool call, run `runTool` and append the assistant turn and the tool results. When `MAX_LOOKUPS` is reached, send once more without tools. Throw `AiError("no_answer")` if the final text is empty.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): ask, day summary and dish description flows`

### Task 6: Routes and server wiring

**Files:**
- Create: `apps/server/src/ai/routes.ts`
- Modify: `apps/server/src/server.ts` (`ServerOptions.ai`, register); `apps/server/src/main.ts` (build the AI options from `dataDir` + `resolveSecretKey`)
- Test: `apps/server/src/ai/routes.test.ts`

**Interfaces:**
- Consumes: `AiStore` (Task 2), `createOpenRouter` (Task 3), `ask`/`daySummary`/`describeDish`/`cleanHistory` (Task 5).
- Produces:
  - `ServerOptions.ai?: { dataDir: string; secretKey: Buffer | undefined; fetch?: typeof fetch; baseUrl?: string }`. With no `ai` option, every route except status answers 409 `off`.
  - `registerAi(app, opts)` with these routes (error bodies are `{ error: AI_MESSAGES[code], code: "ai_<code>" }`):
    - `GET /api/ai/status` (signed in) → `{ enabled: boolean; canAsk: boolean; canDescribe: boolean; canManage: boolean }`, where `enabled` = settings.enabled && key saved
    - `GET /api/ai/settings` (`settings.manage`) → `{ settings: AiSettings; keySaved: boolean; keyEnding: string | null; usage; canSaveKey: boolean }`
    - `PUT /api/ai/settings` (`settings.manage`) with body `{ enabled?, model?, fallback?, key?: string | null }` → the same shape (zod: model 1–200 characters, key 10–300 characters or null)
    - `GET /api/ai/models` (`settings.manage`) → `{ models: AiModel[] }`
    - `POST /api/ai/test` (`settings.manage`) → `AiCheck`, recording usage under `test`
    - `POST /api/ai/ask` (`users.manage`) with `{ question: string (1–1000), history?: unknown }` → `{ answer, figuresUsed, model }`
    - `POST /api/ai/day-summary` (`users.manage`) with `{ date: "YYYY-MM-DD" }` → `{ text, model }`
    - `POST /api/ai/describe` (`catalog.manage`) with `{ name, category, isVeg, sizes, current? }` → `{ text, model }`
  - HTTP statuses for `AiError`: `off` 409, `limit` 429, `offline` and `unavailable` 503, `bad_key`, `model_gone` and `no_answer` 502.
  - Every response is sent `Cache-Control: no-store`, and usage is recorded per feature after each success.

- [ ] **Step 1: Write the failing tests.** Use `freshApp` with an `ai` option of a temp dir, a 32-byte key and a fake fetch that serves OpenRouter shapes.
  - `status hides the assistant until it is switched on with a key`; `canAsk` is false for a cashier.
  - `settings never return the key`: after `PUT {key: "sk-or-v1-secret9876", enabled: true}`, the GET body text doesn't contain `"secret"`, `keyEnding === "9876"` and `keySaved === true`.
  - `only admins manage settings and ask; dish editors may describe`: a cashier gets 403 on settings and ask, and 200 on describe.
  - `ask returns the answer and figures used, and counts usage`
  - `day summary and describe return text`
  - `provider failures map to statuses and the spec's messages`: a fake 429 gives 429 with the limit message; a fake throw gives 503 with the offline message.
  - `routes answer 409 off while the assistant is off or has no key`
- [ ] **Step 2: Run** `npx vitest run apps/server/src/ai/routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `routes.ts`**, register it in `buildServer`, and pass `ai: { dataDir, secretKey: resolveSecretKey({...}) }` from `main.ts` (skipped in demo mode).
- [ ] **Step 4: Run** `npx vitest run apps/server` and `npm run typecheck`. Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(ai): assistant routes and server wiring`

### Task 7: Settings → AI assistant

**Files:**
- Create: `apps/ui/src/ai-status.ts` (`useAiStatus` hook), `apps/ui/src/screens/AiAssistantSettings.tsx`, `apps/ui/src/ai-settings.ts` (pure helpers)
- Modify: `apps/ui/src/screens/Settings.tsx` (render `<AiAssistantSettings />` after `<ActivityAlertSettings />`)
- Test: `apps/ui/src/ai-settings.test.ts`

**Interfaces:**
- Consumes: the routes from Task 6.
- Produces:
  - `useAiStatus(): { enabled: boolean; canAsk: boolean; canDescribe: boolean; canManage: boolean } | null` (null while loading; it re-reads on `settings.changed` and on focus)
  - `modelOptions(models: AiModel[], saved: string): Array<{ value: string; label: string }>`. The saved model comes first, labelled `"<name> (no longer offered)"` when missing. The default is labelled `"… (recommended)"`. Labels include the context length, e.g. `"Gemma 4 31B · 262K"`.
  - `usageRows(usage): Array<{ feature: string; requests: number; tokens: number }>` with the labels "Ask MasalaPOS", "Day summaries", "Menu descriptions", "Tests".
- Screen copy:
  - legend "AI assistant"
  - a "Provider" select with a single option "OpenRouter" (value `openrouter`), so OpenAI or Anthropic are later just new options
  - key field "OpenRouter key"
  - saved state "Key saved · ending …1234"
  - fallback checkbox "If it fails, try another free model"
  - the privacy note, verbatim from spec section 5
  - Test result "Working · answered by <model> · <used> of <limit> free requests used today"

- [ ] **Step 1: Write the failing tests** for `modelOptions` and `usageRows`:
  - `keeps a saved model that is no longer offered` (Review Focus 3)
  - `marks the default as recommended`
  - `shows the context length in K`
  - `labels usage rows`
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/ai-settings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, the hook and the component (own Save button). The key input clears after saving; Remove sends `key: null`.
- [ ] **Step 4: Run** `npx vitest run apps/ui` and `npm run typecheck`. Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(ui): AI assistant settings`

### Task 8: Reports → Ask MasalaPOS

**Files:**
- Create: `apps/ui/src/screens/AskMasalaPOS.tsx`, `apps/ui/src/ask-chat.ts` (pure helpers)
- Modify: `apps/ui/src/screens/SalesReports.tsx` (add a More reports option `ask` shown when `useAiStatus()?.canAsk && enabled`, rendering `<AskMasalaPOS />`)
- Test: `apps/ui/src/ask-chat.test.ts`

**Interfaces:**
- Consumes: `POST /api/ai/ask`, `useAiStatus`.
- Produces:
  - `appendTurn(turns: ChatTurn[], role, text): ChatTurn[]`
  - `historyForRequest(turns): ChatTurn[]` (the last 10)
  - `aiErrorText(error: unknown): string` (the server's `error` message, or the offline copy for network failures)
- Screen:
  - the example chips from spec section 2
  - a question box (1–1,000 characters) with an Ask button
  - answers with a "Figures used" list
  - a busy state while waiting (60 s)
  - errors shown inline

- [ ] **Step 1: Write the failing tests**: `appendTurn keeps order`, `historyForRequest sends at most 10 turns`, `aiErrorText prefers the server message and falls back to the offline copy`.
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/ask-chat.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, the screen and the More reports entry.
- [ ] **Step 4: Run** `npx vitest run apps/ui` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): Ask MasalaPOS in Reports`

### Task 9: Day-end summary and dish description buttons

**Files:**
- Modify: `apps/ui/src/screens/DayEnd.tsx` (a "Write summary" button and summary panel with Copy, when `canAsk`); `apps/ui/src/screens/ProductEditor.tsx` (a "Write description" / "Rewrite" button inside the Description `<details>`, when `canDescribe`)
- Test: `apps/ui/src/ai-buttons.test.ts` (pure helpers in `apps/ui/src/ai-buttons.ts`)

**Interfaces:**
- Consumes: `POST /api/ai/day-summary`, `POST /api/ai/describe`, `useAiStatus`, `aiErrorText` (Task 8).
- Produces:
  - `describeRequest(product: { name: string; categoryName: string; isVeg: boolean; variantNames: string[]; description: string }): { name; category; isVeg; sizes; current? }`. `current` is included only when the description isn't empty.
  - `summaryClipboardText(date: string, restaurant: string, text: string): string` → `"<restaurant> · <date>\n<text>"`
- Behaviour:
  - The summary is generated on click, not saved, and cleared when the date changes.
  - The description fills the textarea (marking the form dirty) and is not saved until Save.

- [ ] **Step 1: Write the failing tests** for both helpers: `omits current for an empty description`, `uses Rewrite input when text exists`, `formats the clipboard text`.
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/ai-buttons.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers and both buttons.
- [ ] **Step 4: Run** `npx vitest run apps/ui` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): AI day summary and dish description buttons`

### Task 10: Browser check with a fake OpenRouter, docs, and the real-key check

**Files:**
- Create:
  - `tools/e2e/fake-openrouter.mts`: an HTTP server on :4161 answering `/api/v1/models`, `/api/v1/key` and `/api/v1/chat/completions`. It's scripted: the first ask request returns a `sales_by_day` tool call, then text. Requests containing the word "limit" return 429. It records request bodies at `GET /__qa/requests`.
  - `tools/e2e/ai-assistant-server.mts`: the app on :4160 with `ai: { dataDir: tmp, secretKey: random, baseUrl: "http://127.0.0.1:4161/api/v1" }`, billed sales, a customer "Priya Sharma 98765 43210" on bills, and a dish "Paneer tikka".
  - `tools/e2e/ai-assistant.js`
  - `docs/operations/ai-assistant.md`
- Modify: `tools/e2e/README.md` (an "AI assistant" section)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write `ai-assistant.js`.** Its checks (`window.__aiAssistantResult`):
  1. The AI entries are hidden before setup.
  2. In Settings, the key is saved and the screen shows "ending …"; the model dropdown pre-selects Gemma 4 31B; Test shows "Working · … of 50".
  3. Reports → Ask MasalaPOS answers, with "Figures used" listing Sales by day.
  4. The "limit" question shows the free-limit message.
  5. Day-end "Write summary" shows the text, and Copy works (captured with `navigator.clipboard.writeText` replaced).
  6. The dish editor's "Write description" fills the textarea, and the form shows "Unsaved changes".
  7. `/__qa/requests` contains neither "Priya" nor "98765".
  8. With the fake server stopped (`POST /__qa/offline`), asking shows the offline message.
- [ ] **Step 2: Run it.** Build the UI (`npm run build -w @masalapos/ui`), start both servers, sign in as `admin` / `admin-password`, and run the script. Expected: `status: "passed"` with all checks. Fix any failures in the owning task's code.
- [ ] **Step 3: Write `docs/operations/ai-assistant.md`**, covering:
  - getting an OpenRouter key and turning off training
  - the free limits (50 a day, or 1,000 after $10 of credit) and the usage counters
  - what's sent and what's never sent
  - error messages and fixes
  - moving to OpenAI or Anthropic (spec section 9)
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: all PASS.
- [ ] **Step 5: Commit** `test(e2e): AI assistant against a fake OpenRouter; operations guide`
- [ ] **Step 6: Real-key check (with the user).** On a dev build, the user pastes their OpenRouter key in Settings → AI assistant, presses Test, asks "How did this week compare with last week?", and writes one description. Report what came back.
