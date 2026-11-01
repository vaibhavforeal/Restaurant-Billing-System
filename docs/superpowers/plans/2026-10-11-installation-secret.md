# Installation Secret Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only the restaurant's own counter server can act for its installation on the licensing service: a per-installation secret authenticates `/v1/activate`, and checkout needs a short-lived session that only an admin on the counter can create.

**Architecture:** The counter stores a random secret in `installation.json` and sends it as a header. The Worker keeps only its SHA-256 hash (trust on first use), mints hashed 30-minute subscribe sessions for the counter, and serves checkout by session instead of by installation id. The counter exposes an admin-only route that returns the session URL; the Settings buttons open it.

**Tech Stack:** TypeScript, Cloudflare Worker + D1 (tested via the better-sqlite3 `memoryD1` adapter), Fastify, React, vitest, Playwright MCP for e2e.

**Spec:** `docs/superpowers/specs/2026-10-11-installation-secret-design.md` (amends `docs/superpowers/specs/2026-10-10-licensing-service-design.md`)

## Global Constraints

- Header name: `X-MasalaPOS-Installation-Secret`. Secret format: `^[a-f0-9]{64}$` (32 random bytes, hex).
- Worker stores `secret_hash` = lowercase hex SHA-256 of the secret string; comparison is constant time.
- Session token: 32 random bytes, base64url (43 chars); stored as SHA-256 hex; TTL 30 minutes (`30 * 60_000`); reusable within TTL.
- Worker errors: `401 { error: "unauthorized" }` (secret), `404 { error: "unknown_installation" }` (sessions), `401 { error: "session_expired" }` (checkout).
- Copy (verbatim): expired link page → `This payment link has expired. In MasalaPOS, open Settings > Plan and devices and press Subscribe again.`; 401 on the counter → `The licensing service doesn't recognise this installation. Contact MasalaPOS support.`; session unreachable → `Couldn't reach the licensing service. Check the internet connection and try again.`; no service URL → `Automatic renewal is not set up for this installation.`
- The secret never appears in a response to a browser, the activation-request file, a log line, or D1 in plain form.
- Worker source: only WebCrypto/fetch/Request/Response/URL/console; imports `@masalapos/license-issuer`, `@masalapos/domain/licensing`, `zod`, local files; no `node:` outside tests.
- Run vitest from the repo root; the two `captain-https` failures in the main folder are a known environment issue. Vitest rewrites `apps/server/src/print/__snapshots__/*.snap` with LF endings — restore those two files with `git checkout --` after a full run unless the user had already modified them (the user has uncommitted changes to `receipt.test.ts.snap`: never touch or stage it).
- The main checkout has unrelated uncommitted user changes; stage only the files each task names. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never run `npm install`/`npm ci`.

## Review Focus

- **Existing callers without a secret:** every existing Worker test that posts to `/v1/activate` must send a valid secret header via a shared test helper; a request with no header must now get 401 even for a first contact. Task 1.
- **Wrong secret has no side effects:** with a wrong secret, the floor, licences and installation row are byte-for-byte unchanged (no floor raise, no re-sign, no trial). Task 1.
- **Older `installation.json`:** a file with only `installationId` gains a secret, keeps the same id, and a second start does not change the secret. Task 3.
- **Secret leakage:** `GET /api/license`, `GET /api/license/activation-request`, `POST /api/license/subscribe-session` responses and captured logs never contain the secret. Task 3.
- **Popup blocked:** when `window.open` returns `null`, Settings shows the session URL as a link instead of failing silently. Task 4.

---

### Task 1: Worker secret check on `/v1/activate`

**Files:**
- Create: `apps/licensing-worker/migrations/0002_installation_secret.sql`, `apps/licensing-worker/src/secret.ts`, `apps/licensing-worker/src/secret.test.ts`
- Modify: `apps/licensing-worker/src/testing/d1.ts` (apply every `migrations/*.sql` in name order), `apps/licensing-worker/src/store.ts`, `apps/licensing-worker/src/activate.ts`, `apps/licensing-worker/src/index.ts`, `apps/licensing-worker/src/activate.test.ts`, `apps/licensing-worker/src/index.test.ts`, `apps/licensing-worker/src/webhook.test.ts` (only if it activates)

**Interfaces:**
- Produces (`secret.ts`): `SECRET_HEADER = "x-masalapos-installation-secret"`; `isWellFormedSecret(value: string | null): value is string`; `sha256Hex(text: string): Promise<string>`; `constantTimeEqual(a: string, b: string): boolean`.
- Produces (`store.ts`): `InstallationRow.secretHash: string | null`; `createInstallation` row input gains `secretHash: string | null`; `claimSecretStatement(db, installationId, secretHash): D1StatementLike` (`UPDATE … SET secret_hash = ? WHERE installation_id = ? AND secret_hash IS NULL`).
- Changes: `handleActivate(deps, body, secret: string | null): Promise<Response>`.

- [ ] **Step 1: Migration** exactly as spec §3.1; update `memoryD1()` to apply all migration files in order.
- [ ] **Step 2: Failing tests.** `secret.test.ts`: well-formed / malformed secrets; `sha256Hex("abc")` equals the known digest `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`; `constantTimeEqual` true/false incl. different lengths. `activate.test.ts` (add a shared helper `activate(body, secret = SECRET)`): first contact stores `secretHash`; no header → 401 and no row; malformed → 401; known installation, wrong secret → 401 and floor/licences/row unchanged (snapshot rows before and after); right secret → existing behaviour; NULL-hash row is claimed and the next wrong secret gets 401; two racing first contacts with different secrets → exactly one 200, one 401, one row. Update all existing activate calls to send the secret.
- [ ] **Step 3: Run** `npx vitest run apps/licensing-worker` — expected FAIL.
- [ ] **Step 4: Implement.** Order in `handleActivate`: parse (400) → fingerprint (409) → secret format (401) → lookup/create with hash → for a known row: NULL hash → run `claimSecretStatement` then re-read; hash mismatch (constant time) → 401 before any write → existing logic. Racing first contact: after `createInstallation` (ON CONFLICT DO NOTHING) re-read and compare hashes; mismatch → 401. `index.ts` passes `request.headers.get(SECRET_HEADER)`.
- [ ] **Step 5: Run** `npx vitest run apps/licensing-worker` and `npx tsc --noEmit` — PASS / clean.
- [ ] **Step 6: Commit** — `feat(licensing-worker): installation secret on activate`

### Task 2: Subscribe sessions and session-based checkout

**Files:**
- Create: `apps/licensing-worker/src/sessions.ts`, `apps/licensing-worker/src/sessions.test.ts`
- Modify: `apps/licensing-worker/src/store.ts`, `apps/licensing-worker/src/subscriptions.ts`, `apps/licensing-worker/src/subscribe-page.ts`, `apps/licensing-worker/src/index.ts`, `apps/licensing-worker/src/index.test.ts`

**Interfaces:**
- Consumes: Task 1 `secret.ts`, `claimSecretStatement`, `InstallationRow.secretHash`.
- Produces (`store.ts`): `insertSessionStatement(db, { tokenHash, installationId, expiresAt, createdAt })`, `deleteExpiredSessionsStatement(db, installationId, now)`, `sessionInstallation(db, tokenHash, now): Promise<string | null>` (installation id of an unexpired session).
- Produces (`sessions.ts`): `SESSION_TTL_MS = 30 * 60_000`; `handleCreateSession(deps: Deps, body: unknown, secret: string | null): Promise<Response>` → `200 { session, expiresAt }` | 400 | 401 | 404; `resolveSession(db, token: string | null, now): Promise<string | null>` (hashes the token, returns the installation id or null; malformed tokens → null).
- Changes: `handleCreateSubscription` body becomes `{ session, plan, period, email }`; invalid/expired → `401 { error: "session_expired" }`. `subscribePage(session: string, valid: boolean): string` — valid embeds the session (escaped) in a data attribute and posts it; invalid renders the expired copy. Route `POST /v1/subscribe-sessions` (rate limited); `GET /subscribe?session=`; `?installation=` no longer accepted (treated as invalid).

- [ ] **Step 1: Failing tests.** `sessions.test.ts`: unknown installation → 404; wrong / missing secret → 401; NULL hash claimed; success returns a 43-char base64url token and `expiresAt = now + 30 min`, stores only the hash (assert the raw token is not in the DB); expired sessions of that installation are deleted on create; `resolveSession` valid / expired / malformed / unknown. `index.test.ts`: `/subscribe?session=valid` 200 and contains the escaped session, not the installation id; expired / unknown / `?installation=<uuid>` → 404 with the verbatim expired copy; `/v1/subscriptions` with a valid session tags Razorpay notes with the session's installation; an `installationId` in the body is ignored/rejected (schema has no such field; extra keys → 400 via `.strict()`); expired session → 401 `session_expired`; session reuse within TTL works twice.
- [ ] **Step 2: Run** — expected FAIL. **Step 3: Implement.** The page script posts `{ session, plan, period, email }` and on a `401` response shows the expired copy. **Step 4: Run** `npx vitest run apps/licensing-worker`, `npx tsc --noEmit` — PASS / clean.
- [ ] **Step 5: Commit** — `feat(licensing-worker): admin checkout sessions replace installation links`

### Task 3: Counter sends its secret and mints checkout sessions

**Files:**
- Modify: `apps/server/src/license-config.ts`, `apps/server/src/license-config.test.ts`, `apps/server/src/licensing.ts`, `apps/server/src/licensing.test.ts`, `apps/server/src/test-helpers.ts` (if `LicensingOptions` construction needs the secret), `packages/domain/src/licensing.ts`, `tools/e2e/licensing-server.mts` (pass a secret so it still starts)

**Interfaces:**
- Produces: `LicensingOptions.installationSecret?: string` (required whenever `serviceUrl` is set; validated `^[a-f0-9]{64}$`); `LicenseStatus.subscriptionAvailable: boolean` replacing `subscribeUrl`; `Licensing.subscribeSession(): Promise<{ url: string } | { error: string; status: 409 | 503 }>`; route `POST /api/license/subscribe-session` (`settings.manage`, `Cache-Control: no-store`) → `200 { url }` or `{ error }` with 409/503.

- [ ] **Step 1: Failing tests.** `license-config.test.ts`: new file gets id + secret; file with only `installationId` gains a secret, id unchanged; second call returns the same secret; malformed secret replaced. `licensing.test.ts`: `fetchLatest` sends the header with the configured secret; 401 → `rejected` with the verbatim not-recognised copy; `subscribeSession` success URL `${serviceUrl}/subscribe?session=…`; 404 → runs `fetchLatest` once then retries once; 401 → 409 copy; network error / 500 → 503 copy; no service URL → 409 copy and no fetch; route 403 for a cashier, 200 for an admin; secret absent from `GET /api/license`, the activation-request download, the session route response and captured logs (Review Focus); `subscriptionAvailable` true only with a service URL.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/licensing.test.ts apps/server/src/license-config.test.ts` — expected FAIL.
- [ ] **Step 3: Implement.** Keep `fetchLatest`'s never-throw contract and in-flight sharing. Secret header added in one place used by both calls.
- [ ] **Step 4: Run** the focused tests, then the full suite once, `npm run typecheck` (the UI will fail to compile until Task 4 if it still reads `subscribeUrl` — update `LicenseSettings.tsx` minimally to read `subscriptionAvailable` here, keeping the anchors until Task 4), `npm run test:packaging`.
- [ ] **Step 5: Commit** — `feat(server): installation secret and admin checkout sessions`

### Task 4: Settings buttons, e2e and docs

**Files:**
- Modify: `apps/ui/src/screens/LicenseSettings.tsx`, `tools/e2e/licensing-server.mts`, `tools/e2e/licensing.js`, `apps/licensing-worker/README.md`, `docs/licensing-service-test-mode.md`

**Interfaces:**
- Consumes: Task 3 `subscriptionAvailable`, `POST /api/license/subscribe-session`.

- [ ] **Step 1: UI.** **Subscribe** / **Manage plan** become buttons (same visibility rules, keyed on `subscriptionAvailable`). Click: `const tab = window.open("", "_blank")` synchronously; `POST /api/license/subscribe-session`; on success, if `tab` → `tab.opener = null; tab.location.href = url`, else render the URL as an `<a target="_blank" rel="noopener noreferrer">Open payment page</a>` with a short note that the browser blocked the new tab; on error → `tab?.close()` and show the error message in the existing alert line.
- [ ] **Step 2: e2e.** The fake service on 4129 requires the secret header on `/v1/activate` (401 otherwise) and implements `POST /v1/subscribe-sessions` (returns a fixed token). `licensing.js`: stub `window.open` to capture the tab and the URL it is sent to; assert Subscribe sends the tab to `http://127.0.0.1:4129/subscribe?session=<token>`; assert the blocked-tab fallback link (stub returns `null`); assert a cashier's `POST /api/license/subscribe-session` is 403; keep all existing checks passing. Run through the Playwright MCP (`npm run build -w @masalapos/ui` first; ports 4128/4129; never 4110).
- [ ] **Step 3: Docs.** README: the installation secret (where it lives, header name, trust on first use, `UPDATE installations SET secret_hash = NULL WHERE installation_id = ?` to re-pair a counter, apply migration `0002` with `wrangler d1 migrations apply` before deploying), checkout now via Subscribe in Settings only. Test-mode checklist: add "a request without the secret gets 401" and "an expired payment link shows the expired copy".
- [ ] **Step 4: Gates.** `npx vitest run`, `npm run typecheck`, `npm run test:packaging`, licensing e2e (and licensing-recovery e2e) — all pass apart from the known captain-https pair.
- [ ] **Step 5: Commit** — `feat(ui): checkout via admin session from Plan and devices`, then `docs(licensing-worker): installation secret and session checkout`
