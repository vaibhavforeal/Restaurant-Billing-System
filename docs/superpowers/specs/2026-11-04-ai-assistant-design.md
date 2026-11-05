# AI assistant: design

Status: written for review on 2026-11-04. Branch `feat/ai-assistant`, built on `release/2026-11-04-smart-hints` (PR #16).

## Why

Every "smart hint" so far runs offline on the restaurant's own data, with no AI service. The roadmap's last item adds an optional online AI assistant for three jobs that need language rather than rules:

1. answering an owner's plain-English questions about sales
2. writing an end-of-day summary
3. drafting menu descriptions for the QR menu

The owner starts on **OpenRouter's free tier**. After a set of paying customers, the plan is to move to **OpenAI's or Anthropic's own APIs**. So the provider must be replaceable without touching the features.

## Decisions already made with the user

- **Features:** all three (Ask your sales, End-of-day summary, Menu descriptions).
- **Provider now:** OpenRouter, with the restaurant's own key.
- **Model:** a dropdown of OpenRouter's current free models that support tool calling. `google/gemma-4-31b-it:free` is pre-selected, and `openrouter/free` is the automatic fallback (on by default).
- **Access:** admins only for questions and day summaries. Anyone who can edit dishes can draft descriptions.
- **Paid later** means OpenAI's or Anthropic's own APIs. Their adapters are **not built now**. This spec defines how they plug in.
- **No internet, or not set up:** every AI feature says so clearly. Billing and the rest of the app are unaffected.

## Out of scope (now)

- **OpenAI and Anthropic adapters** (section 9 says how they will fit).
- **MasalaPOS-managed AI**, where MasalaPOS holds one paid key and restaurants buy "AI assistant" as a licensed add-on, with requests going through the licensing service and limited per licence. This needs a new module in `packages/domain/src/modules.ts`, licensing-worker and portal changes, and reissued licences. It is a separate project.
- **Saving conversations or summaries,** and any AI action that changes data.

## 1. Settings: "AI assistant" (admins, `settings.manage`)

A new section in Settings → Restaurant profile, below "Staff activity alerts". It has its own Save.

- **Switch:** "Use the AI assistant" (off until a key is saved).
- **Provider:** fixed to "OpenRouter" for now. The control exists so that adding OpenAI or Anthropic later is only a new option.
- **Key:**
  - A password-style field. On save, the key is encrypted and stored on the hub. The screen afterwards only shows "Key saved · ending …3f9a", with Replace and Remove.
  - The key never goes back to the browser.
- **Model:**
  - A dropdown filled from the provider's model list, restricted to free models that support tools, with context length shown.
  - Pre-selected `google/gemma-4-31b-it:free`. If the saved model is no longer listed, it shows "(no longer offered)" and asks for another.
- **"If it fails, try another free model":** on by default. It sends `openrouter/free` as a second choice.
- **Test:**
  - Sends one tiny request and shows "Working · answered by Gemma 4 31B".
  - Also shows the key's free-model requests today: `free_model_daily_requests` from `GET https://openrouter.ai/api/v1/key`, for example "12 of 50 used today".
- **Usage:** requests and tokens so far for each feature, from each response's usage, kept on the hub. The point is to know real usage before choosing paid pricing.

## 2. Ask your sales (Reports → More reports → "Ask MasalaPOS", admins)

- A question box with three example chips: "How did this week compare with last week?", "Which dish should I promote?" and "Who cancels most after KOT?" The answer shows below, and the conversation continues until the screen is left. Nothing is saved.
- **The model never sees the database.** It may only call these read-only lookups. Each wraps an existing server function and returns a trimmed, numbers-only result:

  | Lookup | Wraps | Arguments | Returns |
  |---|---|---|---|
  | `sales_by_day` | order analytics daily series | from, to | date, orders, sales (₹) per day |
  | `sales_by_hour` | order analytics hourly | from, to | hour, orders, sales |
  | `item_sales` | order analytics items | from, to, category? | top 30 dishes by plates: plates, sales, category |
  | `category_sales` | order analytics categories | from, to | category, plates, sales |
  | `order_types` | order analytics comparison | from, to | dine-in / takeaway / Zomato orders and sales |
  | `menu_engineering` | `buildMenuEngineeringReport` | from, to | dish, category, plates, margin per plate, group |
  | `prep_forecast` | `prepForecast` | date | dishes and expected plates, ingredients to buy |
  | `staff_activity` | `buildStaffActivityReport` | from, to | flags and per-person counts, **staff first names only** |
  | `today` | the hub clock | none | today's date, weekday and timezone |

- **Limits:**
  - Date ranges are capped at 366 days, as the reports already are.
  - At most **6 lookups per question**. After that, the model is asked to answer with what it has.
- **"Figures used":** under each answer, a small list of the lookups and dates it called, so the owner can check them in the matching report.
- **The system prompt says:**
  - Answer only from lookup results, and say when the data doesn't cover the question.
  - Amounts are in rupees. Be brief and practical, in the owner's language (English unless asked otherwise).
  - Never invent figures.

## 3. End-of-day summary (Day-end screen, admins)

- A **"Write summary"** button on the Day-end report for any date. One request with that day's figures:
  - the day-end report totals
  - the top and bottom 5 dishes
  - the average for the same weekday over the last 4 weeks (computed on the hub)
  - voids, refunds and discounts
  - Staff activity flags
- It returns 5–8 short bullet points, with a **Copy** button for WhatsApp. The summary is not saved, and pressing the button again regenerates it.

## 4. Menu descriptions (dish editor, anyone with `catalog.manage`)

- A **"Write description"** button beside the "Description (optional)" textarea in `apps/ui/src/screens/ProductEditor.tsx`.
- It sends the dish name, category, veg or non-veg, and size names. It returns one or two appetising lines, at most 200 characters (the field allows 500), and fills the textarea. Staff can edit it, and nothing is saved until they press Save.
- If the box already has text, the button reads "Rewrite" and sends the current text as a starting point.

## 5. Privacy rules

These are enforced in the lookups and request builders, not left to the model.

- **Never sent:** customer names, phone numbers, addresses, birthdays, notes, customer types, loyalty data, or bill references that identify a customer.
- **Sent:**
  - aggregate figures
  - dish and category names
  - the restaurant's name and city (for the day summary)
  - staff **first names**, only in `staff_activity` and the day summary's flags
- **Tests:** a fixture restaurant with customers checks that no customer name or phone number appears in any request body.
- **Settings note:** "Some free AI providers may keep what is sent. MasalaPOS sends only sales figures and dish and staff first names, never customer details. In your OpenRouter account, turn off 'allow training'."

## 6. Architecture

- **Folder:** `apps/server/src/ai/` holds the server side.
  - `provider.ts`: the neutral interface:
    - `AiProvider.listModels(): Promise<AiModel[]>`, where `AiModel` has id, name, context length, free, supportsTools.
    - `AiProvider.chat(request): Promise<AiReply>`, where the request has system, messages, tools and maxTokens, and the reply has text, toolCalls, the model that answered and usage.
    - `AiProvider.check(): Promise<AiCheck>`, which returns ok, the model that answered and the daily requests left.
    - Neutral types for messages and tools: a user/assistant text or tool-call turn, a tool result turn, and tools as name + description + JSON-schema parameters.
  - `openrouter.ts`: the `AiProvider` for OpenRouter.
    - `POST https://openrouter.ai/api/v1/chat/completions` with `models: [selected, "openrouter/free"]` when fallback is on. It uses OpenAI-style `tools` / `tool_calls`.
    - Headers: `Authorization: Bearer …`, `HTTP-Referer: https://billnroll.in`, `X-Title: MasalaPOS`.
    - `GET /api/v1/models` filtered to free models with `tools` in `supported_parameters`. `GET /api/v1/key` for Test.
    - It uses global `fetch`, which can be injected for tests (as in `licensing.ts`), with a 60 s `AbortSignal.timeout`.
  - `tools.ts`: the lookups in the table above, defined once in neutral form, each with a JSON schema and a handler that calls existing server functions.
  - `assistant.ts`: the request flows.
    - `ask(question, history)` runs the tool loop: up to 6 calls, then a final answer, and returns `{ answer, figuresUsed }`.
    - `daySummary(date)` and `describeDish(input)`.
    - Prompts live here as constants, so they're provider-neutral.
  - `ai-routes.ts`: the HTTP routes:
    - `GET/PUT /api/ai/settings` (`settings.manage`). The key is write-only: the response has `keySaved` and `keyEnding`.
    - `GET /api/ai/models` and `POST /api/ai/test` (`settings.manage`).
    - `POST /api/ai/ask` and `POST /api/ai/day-summary` (`users.manage`, i.e. admins).
    - `POST /api/ai/describe` (`catalog.manage`).
- **Encryption (`apps/server/src/secret-box.ts`):** AES-256-GCM `seal`/`unseal`, extracted from the private methods in `google-drive.ts`. That file is changed to use it, with no change in behaviour.
- **Storage:** the AI settings and the sealed key go in `dataDir/ai-assistant.json`, written with the existing `atomicJson`. That is **outside the SQLite database and its backups**, so a restored backup never carries a key.
  - **No database migration.**
  - Usage counters live in the same file.
  - It uses the same secret as Drive: `MASALAPOS_SECRET_KEY` from the desktop shell (Windows DPAPI). Dev builds use the existing dev fallback. Without a key, AI settings can't be saved, with a clear message.
- **UI:**
  - `AiAssistantSettings.tsx` (Settings)
  - `AskMasalaPOS.tsx` (a Reports tab)
  - a summary panel in `DayEnd.tsx`
  - the button in `ProductEditor.tsx`
  - A shared `useAiStatus()` hook hides the AI entry points when the assistant is off and shows a "Set up the AI assistant in Settings" link to admins.

## 7. Errors

Errors map to friendly messages, with the raw error logged on the hub.

- **Offline or timeout:** "The AI assistant needs internet. Everything else keeps working."
- **401 / 403:** "OpenRouter didn't accept the key. Check it in Settings → AI assistant."
- **429:** "OpenRouter's free limit is used up for today (it resets at midnight UTC), or there were too many requests in the last minute. Adding $10 of credit to the OpenRouter account raises the free limit to 1,000 requests a day."
- **Model gone (404 / model-not-found):** "The chosen model is no longer available. Pick another in Settings."
- **The model returned nothing usable, or too many lookups:** "The AI couldn't answer that. Try asking more simply."

## 8. Testing

- **Unit tests, no network:** a fake provider and a fake `fetch`:
  - the OpenRouter request and response mapping, including the `models` fallback and `tool_calls`
  - the tool loop, including the 6-call cap and bad tool arguments
  - each lookup against seeded data
  - the privacy rule: no customer name or phone in any request body
  - the error mapping
  - the settings: the key is never returned, and is sealed on disk
  - the `seal`/`unseal` extraction (the existing Drive tests stay green)
- **Browser check:** `tools/e2e/ai-assistant-server.mts` runs the app with a **fake OpenRouter**, a local HTTP server that answers with scripted model, tool-call and key responses. `ai-assistant.js` drives:
  - Settings (save key, pick a model, Test)
  - Ask MasalaPOS (an answer with "Figures used")
  - Day-end "Write summary" and Copy
  - the dish editor's "Write description"
  - the offline and 429 messages
- **Real check:** the user pastes a real OpenRouter key on a dev build, presses Test, and asks one question.

## 9. Moving to OpenAI or Anthropic later

- **Changes needed:** a new `AiProvider` file and a new option in the Provider control. The lookups, prompts, privacy rules, routes and screens stay as they are.
- **OpenAI** (`apps/server/src/ai/openai.ts`, official `openai` SDK): almost the same mapping as OpenRouter (Chat Completions tools). The models list comes from the SDK, filtered to tool-capable chat models.
- **Anthropic** (`apps/server/src/ai/anthropic.ts`, official `@anthropic-ai/sdk`):
  - Maps neutral messages to Messages API content blocks: `tool_use` / `tool_result`, and `system` as a top-level field.
  - Default model `claude-opus-5-5`, with `claude-sonnet-5-5` / `claude-haiku-5-5` selectable for cost.
  - Adaptive thinking.
  - Checks `stop_reason` (including `refusal`) before reading content.
- **Settings:** each provider keeps its own sealed key and model in `ai-assistant.json`, so switching back and forth doesn't lose keys.
- **Pricing:** the usage counters from section 1 give real per-restaurant request and token numbers for setting a paid plan.

## 10. Managed by MasalaPOS (2026-11-04)

After the first real test, the owner decided the AI key stays with MasalaPOS, not with each restaurant. This section replaces the restaurant-key parts of sections 1, 6, 7 and 9. Branch `feat/managed-ai`.

- **Decisions:**
  - The assistant works only for restaurants MasalaPOS switches on in the portal.
  - Each has a daily limit, 40 requests by default (1–1,000), editable per counter.
  - The "paste your own key" option is removed.
- **Relay:** the licensing service (`apps/licensing-worker/src/ai/`) holds the OpenRouter key and serves two routes:
  - `POST /v1/ai/chat` and `GET /v1/ai/status`, authenticated with the counter's installation ID and secret.
  - Each needs an enrolled counter with a licence that's active or in grace.
  - The chat request is the neutral `AiRequest` (`@masalapos/domain/ai-wire`). The service validates it against size caps: 60 messages, 60,000 characters each, 12 tools, 4,000 max tokens, no model field.
- **Limits and usage:**
  - Migration `0011` adds `ai_settings` (off by default) and `ai_usage` (per counter per UTC day).
  - A request is reserved atomically before the provider call and given back if the call fails.
- **Portal:**
  - `PATCH /installations/:id/ai` takes `{ enabled, dailyLimit, expectedUpdatedAt }`. It needs an admin (`licences.manage`) and is logged as `installation.ai`.
  - The counter panel shows today's use and 7 days of requests and tokens.
- **Hub (`apps/server/src/ai/service.ts`):**
  - `ai-assistant.json` keeps only the restaurant's own switch (on by default), the service's last status and per-feature usage. Older keys are dropped.
  - Copies without a service connection (development, demo) answer `off`.
  - The status refreshes at start, when it is over 15 minutes old, on Check, and after every request.
  - Settings shows "On for this restaurant · N of M requests used today", "Not switched on…" or "This copy isn't connected to MasalaPOS".
- **New error codes:** `not_enabled` and `daily_limit`. No owner-facing message mentions keys or OpenRouter.
- **Answers:**
  - A small Markdown subset (bold, italic, code, bullet and numbered lists, headings) is parsed into data and rendered as React elements, never HTML (`apps/ui/src/ai-markdown.ts`, `AiText.tsx`).
  - Answers sit in a "MasalaPOS AI" card, with figures as chips and the model as a tag.
  - The day summary's Copy converts to WhatsApp formatting.
- **Moving to OpenAI or Anthropic** now means an adapter in the licensing service, not on the hub.
