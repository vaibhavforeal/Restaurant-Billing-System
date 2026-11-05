# AI assistant

The AI assistant is optional, needs internet, and is **run by MasalaPOS**. Restaurants never enter or hold an AI key. Their counter sends each AI request to MasalaPOS's licensing service (`https://portal.billnroll.in`). The service checks the counter and forwards the request to OpenRouter with MasalaPOS's own key.

It does three jobs:

| Feature | Where | Who |
| --- | --- | --- |
| **Ask MasalaPOS:** plain-English questions about sales | Reports → More reports → Ask MasalaPOS | Admins |
| **Write summary:** a short end-of-day summary with a Copy button for WhatsApp | Reports → Day-end / GST | Admins |
| **Write description / Rewrite:** a draft menu description for the QR menu | Catalog → Edit dish → Description | Anyone who can edit dishes |

Billing, KOTs and everything else never depend on it. When the assistant is off or there's no internet, the AI buttons are hidden or show a clear message.

## How a request travels

1. The restaurant's hub sends `POST /v1/ai/chat` with its installation ID and secret (the same pair support chat uses).
2. The service accepts only a counter that:
   - is enrolled with a customer
   - has a licence that's active or in grace
   - has been **switched on in the portal**
   - is under its **daily limit**
3. It forwards the request to OpenRouter:
   - with `OPENROUTER_API_KEY`
   - asking for `OPENROUTER_MODEL` (default `google/gemma-4-31b-it:free`)
   - with `openrouter/free` as a second choice unless `OPENROUTER_FALLBACK=off`
4. It records the request and its tokens for that counter and UTC day. A request OpenRouter refused or never received isn't counted; one it timed out on or answered with nothing usable is (it may have been charged).
5. The hub caches what the service says (on or off, the limit, today's use). It refreshes that at start, when the cache is older than 15 minutes, when an admin presses **Check**, and after every AI request.

## Switching a restaurant on (portal)

1. Open the counter in the portal: from its customer's page, or search for the Installation ID.
2. In **AI assistant**, tick **On for this counter** and set **Requests a day**: 40 by default, 1 to 1,000.
3. Press **Save AI assistant**. This needs an admin, and the change goes into the activity log.

The switch belongs to the counter's **seat**: if the seat is released, or the counter is activated again on another order, the assistant is off until switched on again. A replacement computer takes over the old one's setting with the seat.

The counter picks it up within 15 minutes, or at once when the restaurant's admin presses **Check** in **Settings → Restaurant profile → AI assistant**.

The same panel shows today's requests against the limit, and requests and tokens for each of the last 7 UTC days.

**One question uses 2 to 7 requests:** one per lookup, then the answer. A day summary or a description uses one. So 40 a day is about 6 to 20 questions.

## OpenRouter account limits (MasalaPOS's account)

The free tier is shared by **every** restaurant using the assistant:

- 20 requests a minute.
- 50 requests a day, rising to 1,000 a day once the account has bought $10 of credit (one-time; free models stay free).

Keep the sum of the restaurants' daily limits within what the account allows, and buy the $10 of credit before switching on more than one or two restaurants. When OpenRouter's limit is hit, restaurants see "The AI service is busy right now".

Moving to a paid model only needs `OPENROUTER_MODEL` changed on the server. The restaurants change nothing. Use the portal's token counts to price it.

## Server setup (`portal.billnroll.in`)

Add these to `/etc/forkflow-portal/env`, then restart the service:

```
OPENROUTER_API_KEY_FILE=/etc/forkflow-portal/openrouter-key   # a root-only file holding the sk-or-v1-… key
# or OPENROUTER_API_KEY=sk-or-v1-…
# OPENROUTER_MODEL=google/gemma-4-31b-it:free                 # optional
# OPENROUTER_FALLBACK=off                                       # optional; on by default
```

- **The key file:** create it with `install -m 600 -o root /dev/null /etc/forkflow-portal/openrouter-key`, then write the key into it.
- **No key:** every AI request answers 503 and restaurants see "The AI service isn't responding right now".
- **Migration:** `0011_ai_assistant.sql` adds `ai_settings` and `ai_usage`. It runs when the service starts.
- **Deploying:** see `docs/operations/connector-release.md` → Deployment.
- **The OpenRouter account:** turn off "allow training" in its privacy settings.

## What is sent, and what never is

- **Sent:**
  - sales figures (by day, hour, dish, category and order type)
  - menu-engineering groups and the prep forecast
  - the restaurant's name and city (for the day summary)
  - dish and category names
  - staff **first names** (for staff-activity questions and the day summary)
- **Never sent:**
  - customer names, phone numbers, addresses, birthdays, notes or loyalty details
  - notes staff typed (cancel reasons, discount notes)
- **The service** stores only counts and token totals, never the questions or answers.
- **The model never reads the database.** It can only call fixed, read-only lookups, at most 6 per question. Each answer lists the **Figures used** so they can be checked in the matching report.

## The restaurant's side

**Settings → Restaurant profile → AI assistant · provided by MasalaPOS** shows one of:

- "On for this restaurant · 12 of 40 requests used today"
- "Not switched on for this restaurant. Contact MasalaPOS to add the AI assistant."
- "This copy isn't connected to MasalaPOS…": development and demo copies, or a copy that was never activated online.

The panel also has:

- **Use the AI assistant:** the restaurant's own switch, which hides the AI buttons on its counter.
- **Check:** asks MasalaPOS again.
- The counter's usage for each feature.

## Messages and what to do

| Message | Cause | Fix |
| --- | --- | --- |
| "The AI assistant needs internet…" | The counter can't reach portal.billnroll.in | Check the connection; everything else keeps working |
| "The AI assistant isn't switched on for this restaurant…" | Not switched on in the portal | Switch it on in the portal's counter panel |
| "Today's AI limit for this restaurant is used up…" | The counter's daily limit was reached | Wait for midnight UTC, or raise the limit in the portal |
| "The AI service is busy right now…" | OpenRouter's rate limit (shared account) | Try later; buy the $10 credit or move to a paid model |
| "The AI service isn't responding right now…" | No key on the server, OpenRouter down, or the model gone | Check the server log (`licensing-worker: AI request failed: …`) and the env file |
| "MasalaPOS couldn't verify this counter…" | Not enrolled, the licence ended, or the pairing was reset | Fix the licence in the portal |
| "The AI couldn't answer that…" | An empty or unusable reply | Ask more simply |

## Moving to OpenAI or Anthropic later

The provider lives only in the licensing service (`apps/licensing-worker/src/ai/openrouter.ts`, behind the `ChatProvider` interface). Adding OpenAI or Anthropic means:

1. Add an adapter beside it (official `openai` or `@anthropic-ai/sdk` SDK).
2. Choose it with a server setting.

The hub, its lookups, prompts, privacy rules and screens stay as they are. Details: `docs/superpowers/specs/2026-11-04-ai-assistant-design.md`, sections 9 and 10.
