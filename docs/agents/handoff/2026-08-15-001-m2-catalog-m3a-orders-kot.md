# Handoff: M1 acceptance + M2 Catalog + M3a Orders/KOT shipped

**Date:** 2026-08-15 (session ran 2026-08-14 11:41 → 2026-08-15 00:15 IST)
**Session scope:** M1 browser acceptance → M2 plan+build+merge → M3 split decision → M3a plan (subagent-written) + build + merge. M3b (printing) is planned-next, not started.

## Goal

Pick up the M1 handoff and advance ForkFlow (local-only desktop POS) through its milestones: clear the M1 acceptance gate, then plan and ship M2 (Catalog: categories/products/variants, settings, users admin) and as much of M3 (Tables + KOT) as possible, executing subagent-driven per the established pattern.

## Current state

- `main` is at `efbee00`, pushed to origin. **120/120 vitest tests green, typecheck clean across all workspaces, working tree clean, no feature branches left.**
- Working software: everything M1/M2 had, plus the full core order flow — Tables screen (tap-to-open, derived free/occupied status, admin table management), OrderScreen (localStorage draft cart, punch/send/cancel), Kitchen display (live KOT board over WebSocket, mark-done), parcel orders, role-gated nav (admin/cashier/waiter/kitchen see different tabs).
- **Blocked on the human (or a Playwright-capable session): M3a real-browser click-through.** The Playwright MCP server disconnected mid-session (~18:00) and never reconnected, so M3a was verified only by 120 tests + a full curl API round trip. The final reviewer's Critical find (see below) proves this gap has teeth: the click-through MUST include a **LAN-IP origin** (`http://<LAN-IP>:4100` from a second device/browser), not just localhost. This gates M3b execution.
- M3b (KOT printing + WS hardening) is the next plan to write. M4 Billing onward unchanged.
- ADHD-mode output rules were enabled by the user mid-session ("stop adhd mode" disables); bypass-permissions was also enabled.

## What was accomplished

1. **M1 acceptance passed** (the previous handoff's human-gate): real-Chromium click-through of setup → logout (old token verified 401 server-side) → PIN-pad login, against the production serving path on a scratch DB.
2. **M2 Catalog shipped** (branch `m2-catalog`, fast-forwarded into main at `4183219`): users admin API with PIN uniqueness across ALL users incl. inactive + last-admin lockout guard; categories/products/variants/kot-stations API; settings API; UI nav shell + Catalog/ProductEditor/Users/Settings screens. 72 tests at merge. Verified by a full browser click-through (dup-PIN 409 and last-admin 409 surfaced in UI, cashier saw no admin tabs).
3. **M3 split decision** (user-approved): M3a core order flow now, M3b printing separately — each plan produces working software alone.
4. **M3a Orders+KOT shipped** (branch `m3a-orders-kot`, fast-forwarded into main at `efbee00`): migration 002 (`kots.done_at`, `order_items.client_ref` + partial unique index), `nextSequence`/`localDateKey` helpers, order/table zod schemas, tables API (derived status), orders API (idempotent create, snapshot items, cancel flows incl. `orders.cancel_sent`), send-to-kitchen (per-day gapless KOT numbers, one transaction), WS broadcast layer (`app.broadcast`), and the three screens. 120 tests at merge.
5. **Process evolution (user-directed): plans are now subagent-written too.** For M3a I authored only a binding contracts document; 4 parallel subagents wrote the plan sections, a top-tier reviewer audited the assembly (found 10 blocking plan bugs), a fixer applied 17 findings, re-verified EXECUTABLE AS-IS. Execution then ran the M2-style loop: fresh haiku implementer + sonnet reviewer per task, scoped re-reviews per fix round, top-tier final whole-branch review + one fix wave.

## Files changed (map, not diff — new/changed since the M1 handoff)

| File | What it is now |
|---|---|
| `docs/superpowers/plans/2026-08-14-m2-catalog.md` | Executed M2 plan (11 tasks, complete code in-plan). |
| `docs/superpowers/plans/2026-08-14-m3a-orders-kot.md` | Executed M3a plan (12 tasks). Written by subagents; its Global Constraints section carries the sandbox/execution notes. |
| `packages/domain/src/catalog-schemas.ts` / `user-schemas.ts` / `settings-schemas.ts` / `order-schemas.ts` | zod schemas for all admin + order APIs. GST slabs locked to [0,5,12,18,28]; ClientRef is 8–64 chars. |
| `packages/domain/src/sequences.ts` | `nextSequence(db, name)` — gapless named counters via UPDATE…RETURNING; caller must hold the transaction. |
| `packages/domain/src/dates.ts` | `localDateKey(ms)` — local-time YYYY-MM-DD for per-day KOT sequences. |
| `packages/domain/src/migrations/002-kot-done-and-item-refs.ts` | The ONLY schema change since 001: `kots.done_at`, `order_items.client_ref` (partial unique index). |
| `apps/server/src/http-error.ts` | `httpError(status, msg)` — throwable non-500s; the global handler sends `{error: msg}` and DROPS extra fields (403-with-permission must use `reply.send` directly). |
| `apps/server/src/test-helpers.ts` | Shared server-test fixtures: `freshApp`, `setupAdmin`, `auth`, `createUser`. auth.test.ts deliberately keeps its own. |
| `apps/server/src/users.ts` | Users admin. `pinInUse()` scans ALL users (reactivation can't re-verify a hashed PIN); last-admin guard. |
| `apps/server/src/catalog.ts` | Categories/products/variants/stations. FK pre-checks → 400s; product+inline-variants transactional. |
| `apps/server/src/settings.ts` | Settings singleton GET/PUT (full replace). |
| `apps/server/src/tables.ts` | Tables CRUD; status DERIVED per request from latest open/billed order; 409 deactivate-while-occupied. |
| `apps/server/src/orders.ts` | Order create (idempotent on client_ref BEFORE table checks), get/list, item punch (snapshots, targeted client_ref dedupe), item PATCH/cancel (both guard parent-order-open), order cancel. Sent-item cancel does its own `can(role,"orders.cancel_sent")` + required reason. |
| `apps/server/src/kots.ts` | Send-to-kitchen (groups pending stationed items, per-day kot_no inside the send transaction), active-KOT board (constant-query, tableName join), idempotent done. |
| `apps/server/src/ws.ts` | `registerWs`: `/api/ws?token=` (validated via exported `sessionUser` from auth.ts), clients Set, `app.broadcast(event, data)`. Registered right after auth so later modules can broadcast. |
| `apps/server/src/auth.ts` | Refactor only: `sessionUser(db, token)` extracted + exported; login comment now points at users.ts for PIN uniqueness. |
| `apps/ui/src/uuid.ts` | v4 UUID via `getRandomValues` — exists because `crypto.randomUUID` is missing on plain-http LAN origins. Use THIS, never randomUUID, in UI code. |
| `apps/ui/src/ws.ts` | Reconnecting WS client (1s→10s backoff); screens refetch on reconnect via `onStatus(true)`. |
| `apps/ui/src/money.ts` / `types.ts` | ₹↔paise edge converters; UI mirrors of every server JSON shape. |
| `apps/ui/src/NavBar.tsx` / `App.tsx` / `screens/Home.tsx` | `Page` is a discriminated union (`{name:"order", orderId}`…); role→tab matrix; kitchen role lands directly on the Kitchen board. |
| `apps/ui/src/screens/Catalog.tsx` / `ProductEditor.tsx` / `Users.tsx` / `Settings.tsx` | M2 admin screens. ProductEditor: create mode collects variants locally (useRef counter ids), edit mode saves variants immediately. |
| `apps/ui/src/screens/Tables.tsx` / `OrderScreen.tsx` / `Kitchen.tsx` | M3a screens. All three have in-flight guards on mutating buttons (double-tap class was caught twice by reviewers). |

## Files in flight

- Nothing uncommitted, unpushed, or stashed. `main` checked out. Both SDD workspaces deleted post-merge (git history is the record).
- `data/` still does not exist — no one has run the app for real; first `npm run dev:desktop` shows setup.
- The M3a plan-writing scaffolding (contracts.md, section files) lives only in the background-job tmp dir (`~/.claude/jobs/40705ba9/tmp/m3a/`) — disposable; the plan document is self-contained.

## Failed attempts

- **My M2 plan-writing turn died mid-stream** on the first attempt (response cut off writing a ~2,300-line file in one Write). Fix that worked: write in ~6 chunks — initial Write, then Edit-appends replacing a `<!-- CONTINUE -->` marker.
- **Both M2 bugs found in execution were in MY plan-embedded code** (variant-id collision from `local-${vs.length}`; unmasked PIN input regressing an M1 ruling) — not implementer errors. That motivated the M3a change: adversarial plan review BEFORE execution, which caught 10 blocking plan bugs (schema-violating test fixtures, FK-violating tests, a 403 response shape the error handler would drop, missing reconnect-refetch). Don't execute a large embedded-code plan without that review pass again.
- **`claude-sonnet-5` permission-classifier outages** hit repeatedly (~20:20–22:10): tool calls fail with "temporarily unavailable (timed out)". Waiting 90s–5min and retrying identical calls worked every time. Don't rewrite the call; just wait and retry.
- **Playwright MCP + several other MCP servers disconnected ~18:00 and never returned** in-session. Consequence: M3a click-through undone. A fresh session should have them back.
- **TaskStop on a background `npx tsx` server kills the wrapper but leaves the node child on :4100** (bit us twice; also in the M1 handoff). Port-check, then `powershell.exe -Command "Stop-Process -Id <pid> -Force"`, then delete WAL-locked db files.
- **`model: "sonnet"`/`"haiku"` subagent dispatches worked all session** (M1's alias failures did not recur). Division that worked well: haiku implementers for transcription-from-plan tasks, sonnet task-reviewers, top-tier (omit model) for plan review and final whole-branch reviews.

## Key decisions (and what was ruled out)

- **M3 split into M3a (core flow) + M3b (printing)** — user chose this over one 16-task mega-plan. Kitchen display is the kitchen's view until M3b ships printers.
- **Plans are subagent-written now** (user: "use sub by sub agents"): controller writes a binding contracts doc; parallel writers produce sections; a strong reviewer + fixer close the loop. The contracts doc is the load-bearing artifact — cross-section consistency bugs are the failure mode.
- **WS auth token rides in `?token=` — twice ruled acceptable for now** (flagged by an automated security scan, ruling upheld independently by the final reviewer): server log and plaintext `sessions` table are co-located on the same single-PC install, LAN is cleartext http by accepted spec trade-off. NOT a license to keep it: M3b must ship first-message WS auth + log redaction (full list in Next steps).
- **roles.ts was deliberately NOT modified in M3a** — `orders.cancel_sent` works because cashier holds `orders.*` and admin `*`; waiter's explicit list excludes it. Don't add roles rows/slugs without checking the wildcard math.
- **Item mutations guard on parent-order-open** (added in the final fix wave) — M4 billing will build on this invariant.
- **Branch-in-place, no worktree** (M1 precedent): fresh worktrees would force a full npm install (Electron + native better-sqlite3) for no isolation gain.
- **Table status stays derived** (never stored); **KOT numbers are per-local-day** (`kot:YYYY-MM-DD` sequences); **stationless items never go to kitchen** — they stay `pending` for M4 billing to sweep.

## What a fresh agent would otherwise rediscover

- **`crypto.randomUUID` does not exist on plain-http LAN origins** — the biggest catch of the session, invisible to localhost tests, curl, and injectWS. Anything browser-facing must be validated from a LAN-IP origin too. `apps/ui/src/uuid.ts` is the sanctioned helper.
- The error handler in server.ts sends only `{error: message}` from thrown errors — a 403 that needs a `permission` field must `return reply.status(403).send(...)` directly (see orders.ts sent-cancel).
- `(m as { event?: string })` type-guard filters in WS tests are the sanctioned pattern (ruled twice); root tsconfig has `noUncheckedIndexedAccess` — index into test arrays with `[0]!` or `?.`.
- Import style split still holds: `.js` suffixes in packages/* and apps/server (NodeNext); extensionless in apps/ui (Vite). Root vitest picks up `apps/*/src/**/*.test.ts` — pure-TS tests in apps/ui DO run (money, uuid).
- vite dev proxy has `ws: true`; WS event vocabulary is exactly `order.updated` `kot.created` `kot.updated` `table.changed` — server broadcasts and all three screens must stay in sync with it.
- Superpowers SDD scripts live at `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/subagent-driven-development/scripts/` (`sdd-workspace`, `task-brief`, `review-package`). Review packages keep diffs out of controller context — always hand reviewers file paths, never paste diffs.
- Memory files at `~/.claude/projects/D--Software-Ideas-Restauarant-Billing-System/memory/` are current as of this session's end (project-overview has the full M2+M3a state and the M3b mandate list).

## Next steps

1. **(Gate for M3b execution) M3a browser click-through** — human or a Playwright-capable session: scratch data dir server, setup → manage tables → dine-in order → punch (variant + stationless item; draft survives reload) → send → Kitchen board updates live → done → cancel-sent as admin (waiter must not see the button) → parcel round trip → **repeat the order-create path once from `http://<LAN-IP>:4100`** (the uuid fix is what this validates). If anything fails, fix on main before M3b.
2. **Write the M3b plan** (subagent-written per the new pattern; controller writes contracts first). Mandatory scope: ESC/POS print service (fake-sink byte-snapshot tests per spec §7), printers CRUD + station→printer assignment + test-print in Settings, KOT + cancellation-slip templates (80/58mm), in-memory print queue with visible failed jobs + retry; **WS hardening task:** first-message auth (kill `?token=`), 4401-fatal client reconnect, session-expiry → login transition (kills the zombie-screen state), WS request-log redaction, broadcast-session revalidation on deactivate.
3. **Execute M3b** subagent-driven (haiku implementers / sonnet reviewers / top-tier final review — this division held up well).
4. Then M4 Billing (spec §9.4) — note for its planner: stationless `pending` items are swept at billing; item routes already 409 on non-open orders; `bills`/`payments`/`bill_taxes` tables exist since migration 001.
5. Deferred-minor backlog (all ledgered in the two merged plans' git history, none urgent): shared server mappers extraction, `table.changed` on table admin edits, atomic sortOrder swap, kitchen age clamp on clock skew, draft-localStorage cleanup for abandoned orders, "nothing to send" copy, zod-400s surfacing as the literal word "validation" in the UI (M2 leftover), window.prompt PIN masking (M2 leftover).
