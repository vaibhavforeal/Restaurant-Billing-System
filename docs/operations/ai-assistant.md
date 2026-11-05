# AI assistant

The AI assistant is optional and needs internet. It does three jobs:

| Feature | Where | Who |
| --- | --- | --- |
| **Ask MasalaPOS:** plain-English questions about sales | Reports → More reports → Ask MasalaPOS | Admins |
| **Write summary:** a short end-of-day summary with a Copy button for WhatsApp | Reports → Day-end / GST | Admins |
| **Write description / Rewrite:** a draft menu description for the QR menu | Catalog → Edit dish → Description | Anyone who can edit dishes |

Billing, KOTs and everything else never depend on it. Without internet, or before it is set up, the AI buttons are hidden or show a clear message.

## Setting it up (OpenRouter, free tier)

1. Create an account at <https://openrouter.ai> and create an API key (it starts `sk-or-v1-`).
2. In your OpenRouter account's privacy settings, **turn off "allow training"**.
3. In MasalaPOS, go to **Settings → Restaurant profile → AI assistant**:
   1. Paste the key into **OpenRouter key**.
   2. Leave the model as **Gemma 4 31B (recommended)** and keep **If it fails, try another free model** ticked.
   3. Press **Save AI settings**, then **Test**. It should say "Working · answered by …".
4. **Use the AI assistant** is switched on when the first key is saved. Untick it to hide the AI features without removing the key.

The key is encrypted on this PC with Windows' credential protection and is never shown again: Settings only shows its last four characters. It is stored in `ai-assistant.json` in the data folder, **not** in the database or its backups. A data folder copied to another PC will ask for the key again.

## Free-tier limits

- 20 requests a minute.
- **50 requests a day**, rising to **1,000 a day** once the OpenRouter account has bought $10 of credit (one-time; free models stay free).
- One Ask question uses 2–7 requests (one per lookup, then the answer). A day summary or a description uses one.
- **Test** shows how many of today's free requests are used. The **Usage** table in Settings shows requests and tokens per feature.

## What is sent, and what never is

- **Sent:** sales figures (by day, hour, dish, category and order type), menu-engineering groups, the prep forecast, the restaurant's name and city (for the day summary), dish and category names, and staff **first names** (for staff-activity questions and the day summary).
- **Never sent:** customer names, phone numbers, addresses, birthdays, notes or loyalty details, and no notes staff typed (cancel reasons, discount notes).
- The model never reads the database. It can only call fixed, read-only lookups, at most 6 per question. Each answer lists the **Figures used** so they can be checked in the matching report.

## Messages and what to do

| Message | Cause | Fix |
| --- | --- | --- |
| "The AI assistant needs internet…" | No internet, or OpenRouter unreachable | Check the connection; everything else keeps working |
| "OpenRouter didn't accept the key…" | Wrong or revoked key | Paste a new key in Settings → AI assistant |
| "OpenRouter's free limit is used up…" | 50 (or 1,000) requests today, or 20 in the last minute | Wait for midnight UTC, or add $10 of credit |
| "The chosen model is no longer available…" | OpenRouter retired the model | Pick another model in Settings (shown as "no longer offered") |
| "The AI service isn't responding right now…" | OpenRouter or the model is having trouble | Try again in a minute; the fallback model usually covers this |
| "The AI couldn't answer that…" | Empty or unusable reply | Ask more simply, or try another model |

## Moving to OpenAI or Anthropic later

The features talk to providers only through `apps/server/src/ai/provider.ts`. Moving to a paid provider means:

1. Add `apps/server/src/ai/openai.ts` (official `openai` SDK) or `apps/server/src/ai/anthropic.ts` (official `@anthropic-ai/sdk`) implementing `AiProvider`, plus an option in the Provider select.
2. Each provider keeps its own sealed key in `ai-assistant.json`.

The lookups, prompts, privacy rules, routes and screens stay as they are. Use the Usage table's request and token counts to price a paid plan. Details: `docs/superpowers/specs/2026-11-04-ai-assistant-design.md` section 9.
