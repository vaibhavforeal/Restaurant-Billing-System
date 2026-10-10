# Licensing Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restaurants pay for their ForkFlow licence through Razorpay subscriptions; a Cloudflare Worker signs licences in the existing `ff1.` format and the counter server fetches them automatically.

**Architecture:** A new `packages/license-issuer` holds the pure licence-building and envelope code, shared by the operator tools and the Worker. `apps/licensing-worker` is a Cloudflare Worker whose handlers depend only on small interfaces (`D1Like`, `Signer`, `RazorpayApi`, `RateLimiter`), so they are tested under Node in the root vitest run against a better-sqlite3 adapter, and smoke-tested once under `wrangler dev`. The counter server gains `fetchLatest()`, which posts its activation request to the Worker and installs any newer licence through the existing `activate()`.

**Tech Stack:** TypeScript, Node 24, Fastify, better-sqlite3, zod 4, React, vitest 4, Cloudflare Workers + D1 + Workers Rate Limiting (wrangler), Razorpay Subscriptions API and Checkout.

**Spec:** `docs/superpowers/specs/2026-10-10-licensing-service-design.md`

## Global Constraints

- Envelope format is unchanged: `ff1.<base64url(JSON claims)>.<base64url(64-byte Ed25519 signature)>\n`, canonical unpadded base64url. `packages/core/src/signed-license.ts` is not modified.
- Trial: Pro, 14 days (`14 * 86_400_000` ms), `graceUntil === expiresAt`, `trial: true`, once per installation id.
- Paid licence: `expiresAt = subscription.current_end * 1000`; `graceUntil = expiresAt + 7 * 86_400_000`.
- Plans `basic | pro`; periods `monthly | yearly`. Razorpay `total_count`: monthly `120`, yearly `10`.
- Renewal interval on the counter: 6 hours (`6 * 60 * 60 * 1000`); fetch timeout 10 seconds.
- Audit actor name for automatic installs: `Automatic renewal`.
- Copy (verbatim): unreachable → `Couldn't reach the licensing service. Billing continues on your current licence.`; up to date → `Your licence is up to date.`; installed → `A new licence was installed.`; unknown installation on `/subscribe` → `Open ForkFlow once while connected to the internet, then try again.`; checkout success → `Payment received. Return to ForkFlow and press Check for renewal.`; trial line → `Pro trial — ends {date}`.
- Secrets (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `LICENSE_SIGNING_KEY`) exist only as Worker secrets. Nothing under `apps/server`, `apps/ui`, `packages/domain` or `packages/core` imports `packages/license-issuer` or `apps/licensing-worker`.
- Worker source uses only WebCrypto, `fetch`, `Request`/`Response` and the interfaces in `apps/licensing-worker/src/env.ts`; no `node:` imports and no `@cloudflare/workers-types` dependency outside test files.
- Run vitest from the repo root. The two `captain-https` failures are a known environment issue, not regressions.
- npm on this machine blocks install scripts; new workspace packages need a `node_modules/@forkflow/<name>` directory junction (create with `node -e "require('fs').symlinkSync(require('path').resolve('packages/license-issuer'), 'node_modules/@forkflow/license-issuer', 'junction')"`).
- Commit after every task with the session's `Co-Authored-By` trailer. Stage only the files the task names; the working tree has unrelated user changes.

### Deviations from the spec (approved with the plan)

- `trial` is `z.boolean().optional()` rather than `.default(false)`, so `tools/issue-license.ts` output stays byte-identical. Readers use `claims.trial === true`.
- `installations` gets a `revision_floor INTEGER NOT NULL DEFAULT 0` column; that is the spec's "placeholder floor" (§3.3 step 4).
- Worker tests run under Node in the root vitest run against a better-sqlite3 `D1Like` adapter instead of the Workers vitest pool; Task 9 adds a `wrangler dev` smoke run to prove the real runtime.

## Review Focus

- **Webhook arrives before the subscription row exists** (Razorpay can fire `subscription.charged` very quickly after checkout, or the `/v1/subscriptions` insert failed after Razorpay created it): the charge must still issue a licence using `notes.installationId`, `notes.plan`, `notes.period`, creating the subscription row if missing. Test in Task 6.
- **Counter clock or service clock skew:** the service sets `issuedAt` from its own clock; the counter rejects `issuedAt > now + 5 min`. A licence fetched by a counter whose clock is slow by more than 5 minutes is `rejected`, not installed, and the saved licence is untouched. Test in Task 7.
- **Trial ending while offline, then a later fetch:** a counter that comes back online after its trial has expired, with no payment, gets `null` (no second trial) and stays `expired`. Test in Task 4.
- **Two counters on one installation id at once** (two first-contact requests racing): exactly one `installations` row and one trial licence; both callers get the same envelope. Test in Task 4 (concurrent `Promise.all` against the adapter; the insert uses `INSERT ... ON CONFLICT DO NOTHING` then re-reads).
- **Webhook body that is valid JSON but missing `notes` or `current_end`:** recorded as `unmatched`, 200, no throw. Test in Task 6.

---

### Task 1: Shared licence issuer package

**Files:**
- Create: `packages/license-issuer/package.json`, `packages/license-issuer/src/index.ts`, `packages/license-issuer/src/base64url.ts`, `packages/license-issuer/src/index.test.ts`
- Modify: `packages/domain/package.json` (add export `"./licensing": "./src/licensing.ts"`), `tools/license-claims.ts`, `tools/license-claims.test.ts`, `tools/issue-license.ts`, `tools/prepare-license.ts`, `vitest.config.ts` (alias `@forkflow/license-issuer`), `tsconfig.json` (path `@forkflow/license-issuer`)

**Interfaces:**
- Produces (from `@forkflow/license-issuer`):
  - `ActivationRequest` (zod schema, moved verbatim from `tools/license-claims.ts`) and `type ActivationRequest`
  - `parseActivationRequest(text: string): ActivationRequest` (same error text as today)
  - `interface ClaimTerms { plan: Plan; expiresAt: number; graceUntil: number; trial?: boolean }`
  - `buildClaims(request: ActivationRequest, terms: ClaimTerms, now: number, uuid?: () => string): LicenseClaims` — identifier and revision rules unchanged; sets `trial: true` only when `terms.trial` is true (omits the key otherwise)
  - `type Signer = (message: Uint8Array) => Promise<Uint8Array>`
  - `encodeEnvelope(claims: LicenseClaims, sign: Signer): Promise<string>`
  - `webCryptoSigner(pkcs8Pem: string): Promise<{ sign: Signer; fingerprint: string }>` — imports the key with `crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"])`; `fingerprint` = hex SHA-256 of the SPKI DER (`302a300506032b6570032100` prefix + 32-byte public key taken from the JWK export's `x`)
- `tools/license-claims.ts` keeps `buildClaims(request, { plan, months, graceDays }, now, uuid)` as a wrapper that converts to `ClaimTerms`, `keyFingerprint(privatePem)`, and `signClaims(claims, privatePem): Promise<string>` (now async, via `encodeEnvelope` with a `node:crypto` signer).

- [ ] **Step 1: Write the failing tests** in `packages/license-issuer/src/index.test.ts`:
  - `"envelopes signed with WebCrypto pass the app's verifier"`: generate an Ed25519 pair with `node:crypto`, export PKCS#8 PEM, `webCryptoSigner(pem)`, `encodeEnvelope(claims, sign)`; assert `LicenseClaims.parse(verifyLicenseSignature(envelope.trim(), publicPem))` deep-equals `claims`, and `envelope.endsWith("\n")`.
  - `"WebCrypto fingerprint matches the app's activation request fingerprint"`: `fingerprint` equals `createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex")`.
  - `"node and WebCrypto signers produce identical envelopes"`: Ed25519 is deterministic, so `encodeEnvelope` with each signer returns the same string.
  - `"buildClaims takes explicit dates and marks only trials"`: with `{ plan: "pro", expiresAt: now + 14 * DAY, graceUntil: now + 14 * DAY, trial: true }` → `claims.trial === true`, `revision === 1`; without `trial` → `"trial" in claims === false`.
- [ ] **Step 2: Run** `npx vitest run packages/license-issuer` — expected FAIL (module not found).
- [ ] **Step 3: Create the package** (`"name": "@forkflow/license-issuer"`, `"type": "module"`, `"private": true`, `"exports": { ".": "./src/index.ts" }`, dependencies `zod` and `@forkflow/domain`), the junction, the vitest alias and tsconfig path. Import `LicenseClaims`, `PLANS`, `Plan` from `@forkflow/domain/licensing` (not the index, which pulls in better-sqlite3). `base64url.ts` exports `toBase64Url(bytes: Uint8Array): string` and `fromBase64(pemBody: string): Uint8Array` using `btoa`/`atob`, no `Buffer`. Implement the interfaces above.
- [ ] **Step 4: Rewire `tools/`**: `license-claims.ts` re-exports `ActivationRequest`/`parseActivationRequest` from the package and wraps `buildClaims`; `signClaims` becomes async; `issue-license.ts` and `prepare-license.ts` `await` it (top-level await). Update `tools/license-claims.test.ts` to `await signClaims(...)`; all its existing assertions stay.
- [ ] **Step 5: Add a regression test** in `tools/license-claims.test.ts`: `"signClaims output is unchanged by the refactor"` — sign fixed claims (no `trial` key) with a fixed key and assert the payload segment equals `Buffer.from(JSON.stringify(claims)).toString("base64url")`.
- [ ] **Step 6: Run** `npx vitest run packages/license-issuer tools/license-claims.test.ts` — expected PASS. Run `npx tsc --noEmit` — expected clean.
- [ ] **Step 7: Commit** — `feat(licensing): shared license-issuer package with WebCrypto signing`

### Task 2: `trial` claim in the app

**Files:**
- Modify: `packages/domain/src/licensing.ts`, `apps/server/src/licensing.ts`, `apps/server/src/licensing.test.ts`

**Interfaces:**
- Produces: `LicenseClaims.trial?: boolean` (`z.boolean().optional()`, object stays `.strict()`); `LicenseStatus.trial: boolean`; `LicensePreview.trial: boolean`. Unactivated and development report `false`; otherwise `claims.trial === true`.

- [ ] **Step 1: Write the failing tests** in `apps/server/src/licensing.test.ts`:
  - `"reports a trial licence as trial and older grants as paid"`: activate a grant with `trial: true` → `GET /api/license` has `trial: true`; activate revision 2 without the key → `trial: false`; `POST /api/license/preview` of a trial grant → `trial: true`.
  - `"rejects a non-boolean trial claim"`: a signed grant with `trial: "yes"` → `400`.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/licensing.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** the schema field, the two interface fields and the status/preview mapping.
- [ ] **Step 4: Run** the licensing tests and `npx tsc --noEmit` — expected PASS / clean (the UI compiles because it only reads `LicenseStatus`).
- [ ] **Step 5: Commit** — `feat(licensing): trial claim`

### Task 3: Worker scaffold, schema and store

**Files:**
- Create: `apps/licensing-worker/package.json`, `apps/licensing-worker/wrangler.jsonc`, `apps/licensing-worker/migrations/0001_initial.sql`, `apps/licensing-worker/src/env.ts`, `apps/licensing-worker/src/store.ts`, `apps/licensing-worker/src/testing/d1.ts`, `apps/licensing-worker/src/store.test.ts`
- Modify: `vitest.config.ts` only if `apps/*/src/**/*.test.ts` does not already pick the tests up (it does; no change expected)

**Interfaces:**
- Produces (`env.ts`):
  - `interface D1Like { prepare(sql: string): D1StatementLike; batch(statements: D1StatementLike[]): Promise<unknown[]> }`
  - `interface D1StatementLike { bind(...values: unknown[]): D1StatementLike; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<{ meta: { changes: number } }> }`
  - `interface RateLimiter { limit(options: { key: string }): Promise<{ success: boolean }> }`
  - `interface Env { DB: D1Like; LIMITER: RateLimiter; RAZORPAY_KEY_ID: string; RAZORPAY_KEY_SECRET: string; RAZORPAY_WEBHOOK_SECRET: string; LICENSE_SIGNING_KEY: string; RAZORPAY_PLAN_BASIC_MONTHLY: string; RAZORPAY_PLAN_BASIC_YEARLY: string; RAZORPAY_PLAN_PRO_MONTHLY: string; RAZORPAY_PLAN_PRO_YEARLY: string }`
  - `type Period = "monthly" | "yearly"`
- Produces (`store.ts`, all `async`, first argument `db: D1Like`):
  - `getInstallation(db, installationId): Promise<InstallationRow | null>`
  - `createInstallation(db, row: { installationId; licenseId; organizationId; outletId; trialStartedAt: number | null; revisionFloor: number; createdAt: number }): Promise<void>` — `INSERT ... ON CONFLICT(installation_id) DO NOTHING`
  - `latestLicense(db, installationId): Promise<LicenseRow | null>` (highest revision)
  - `nextRevision(db, installationId): Promise<number>` = `max(max(licenses.revision), installations.revision_floor) + 1`
  - `latestLicenseForSubscription(db, subscriptionId): Promise<LicenseRow | null>`
  - `insertLicenseStatement(db, row: LicenseRow): D1StatementLike`, `upsertSubscriptionStatement(db, row: SubscriptionRow): D1StatementLike`, `recordEventStatement(db, eventId, type, outcome, now): D1StatementLike` — returned unrun so callers can `db.batch` them
  - `eventSeen(db, eventId): Promise<boolean>`, `paymentUsed(db, paymentId): Promise<boolean>`
  - `getSubscription(db, id)`, `otherActiveSubscriptions(db, installationId, exceptId): Promise<SubscriptionRow[]>` (status not in `cancelled`, `completed`, `expired`, `halted`)
  - Row types `InstallationRow`, `LicenseRow`, `SubscriptionRow` mirror the spec §3.2 columns in camelCase, plus `revisionFloor` and `razorpaySubscriptionId`/`razorpayPaymentId` on `LicenseRow`.
- Produces (`testing/d1.ts`, test-only): `memoryD1(): D1Like` — better-sqlite3 `:memory:` with `migrations/0001_initial.sql` applied; `batch` runs inside one `db.transaction`.

- [ ] **Step 1: Write the migration** exactly as spec §3.2, plus `revision_floor INTEGER NOT NULL DEFAULT 0` on `installations`, `razorpay_subscription_id TEXT` and `razorpay_payment_id TEXT UNIQUE` on `licenses`, and `CREATE INDEX licenses_subscription ON licenses(razorpay_subscription_id, expires_at)`.
- [ ] **Step 2: Write the failing tests** in `store.test.ts`:
  - `"next revision honours the adoption floor"`: installation with `revisionFloor: 3`, no licences → `4`; after inserting revision 4 → `5`.
  - `"createInstallation is idempotent"`: two calls, second with different ids → one row, first ids kept.
  - `"a batch that fails writes nothing"`: batch of a licence insert plus an event insert reusing an existing event id → throws; licence absent.
  - `"payment ids are unique"`: inserting a second licence with the same `razorpayPaymentId` throws.
- [ ] **Step 3: Run** `npx vitest run apps/licensing-worker` — expected FAIL.
- [ ] **Step 4: Implement** `env.ts`, `store.ts`, `testing/d1.ts`. Create `package.json` (`@forkflow/licensing-worker`, private, deps `@forkflow/license-issuer`, `@forkflow/domain`; devDeps `wrangler`), its junction, and `wrangler.jsonc`: `main: "src/index.ts"`, `compatibility_date` = today, `d1_databases: [{ binding: "DB", database_name: "forkflow-licensing", database_id: "<set by wrangler d1 create>", migrations_dir: "migrations" }]`, `ratelimits: [{ name: "LIMITER", namespace_id: "1001", simple: { limit: 20, period: 60 } }]`, and an `env.test` block with its own database. Before writing `wrangler.jsonc`, confirm against current Cloudflare docs the `ratelimits` binding syntax and that `D1Database.batch` runs as one transaction (rolls back on a failed statement); adjust the config and `memoryD1` to match. Install wrangler with `npm install -D wrangler -w @forkflow/licensing-worker` and confirm `npx wrangler --version` runs (install scripts are blocked; if workerd's binary is missing, run its `install.js` by hand as with Electron).
- [ ] **Step 5: Run** the tests — expected PASS. `npx tsc --noEmit` — clean.
- [ ] **Step 6: Commit** — `feat(licensing-worker): scaffold, D1 schema and store`

### Task 4: `POST /v1/activate`

**Files:**
- Create: `apps/licensing-worker/src/activate.ts`, `apps/licensing-worker/src/issue.ts`, `apps/licensing-worker/src/activate.test.ts`

**Interfaces:**
- Consumes: Task 1 `ActivationRequest`, `buildClaims`, `encodeEnvelope`, `Signer`; Task 3 store.
- Produces:
  - `interface Deps { db: D1Like; signer: { sign: Signer; fingerprint: string }; now: () => number; uuid: () => string }`
  - `issueLicense(deps, input: { installation: InstallationRow; plan: Plan; expiresAt: number; graceUntil: number; trial: boolean; reason: "trial" | "charge"; subscriptionId: string | null; paymentId: string | null }): Promise<{ row: LicenseRow; statement: D1StatementLike }>` — builds claims at `nextRevision`, signs, returns the unrun insert so callers batch it
  - `handleActivate(deps, body: unknown): Promise<Response>` — `400` bad body; `409 { error: "wrong_key" }` fingerprint mismatch; `200 { license: string | null }`

- [ ] **Step 1: Write the failing tests** in `activate.test.ts` (fixed `now`, `memoryD1()`, a `webCryptoSigner` from a generated key):
  - `"first contact gets one 14-day Pro trial"`: response licence verifies; claims `plan: "pro"`, `trial: true`, `revision: 1`, `expiresAt - issuedAt === 14 * DAY`, `graceUntil === expiresAt`.
  - `"repeat contact returns the same trial, never a new one"`: second call with `currentRevision: 0` returns the identical envelope; with `currentRevision: 1` returns `null`; only one `licenses` row.
  - `"an expired trial is not renewed"` (Review Focus): advance `now` by 30 days, call with `currentRevision: 1` → `null`.
  - `"concurrent first contacts create one installation"` (Review Focus): `Promise.all` of two calls → both return the same envelope; one installation row, one licence row.
  - `"a hand-issued installation is adopted without a trial"`: request with ids set and `currentRevision: 3` → `null`; row has the request's ids and `revisionFloor: 3`, `trialStartedAt: null`.
  - `"wrong verification key is refused"`: `verificationKeyFingerprint: "0".repeat(64)` → `409`.
  - `"malformed request is refused"`: `{}` → `400`.
- [ ] **Step 2: Run** `npx vitest run apps/licensing-worker/src/activate.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** per spec §3.3. For first contact: `createInstallation` with fresh `uuid()` ids, then re-read; issue the trial only if `latestLicense` is still null, inserting with `INSERT OR IGNORE` on `(installation_id, revision)` and re-reading, so a racing duplicate cannot create a second licence.
- [ ] **Step 4: Run** the tests — expected PASS.
- [ ] **Step 5: Commit** — `feat(licensing-worker): activation endpoint with one-time trial`

### Task 5: Razorpay client and webhook signature

**Files:**
- Create: `apps/licensing-worker/src/razorpay.ts`, `apps/licensing-worker/src/razorpay.test.ts`

**Interfaces:**
- Produces:
  - `verifyWebhookSignature(rawBody: string, signatureHex: string | null, secret: string): Promise<boolean>` — HMAC-SHA256 via WebCrypto `crypto.subtle.verify` (constant time)
  - `interface RazorpayApi { createSubscription(input: { planId: string; totalCount: number; notes: Record<string, string> }): Promise<{ id: string; status: string }>; cancelSubscription(id: string): Promise<void> }`
  - `razorpayApi(keyId: string, keySecret: string, fetchImpl?: typeof fetch): RazorpayApi` — `POST https://api.razorpay.com/v1/subscriptions` (`plan_id`, `total_count`, `customer_notify: 1`, `notes`) and `POST /v1/subscriptions/{id}/cancel` (`cancel_at_cycle_end: 0`), Basic auth; non-2xx throws `Error("Razorpay {status}: {error.description}")`
  - `planIdFor(env: Env, plan: Plan, period: Period): string`
  - `TOTAL_COUNT: Record<Period, number> = { monthly: 120, yearly: 10 }`

- [ ] **Step 1: Verify the API against current Razorpay docs** (WebFetch `https://razorpay.com/docs/api/payments/subscriptions/` and the subscriptions webhook events page). Confirm: create/cancel endpoints and bodies; webhook header names `X-Razorpay-Signature` and `X-Razorpay-Event-Id`; event names `subscription.charged`, `subscription.activated`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`; `payload.subscription.entity.current_end` (Unix seconds), `.notes`, `.status`; `payload.payment.entity.id`. Record any difference at the top of `razorpay.ts` and adjust Tasks 5–6 before writing code.
- [ ] **Step 2: Write the failing tests**: signature valid / tampered body / wrong secret / missing header; `createSubscription` sends the expected URL, `Authorization: Basic base64(key:secret)` and JSON body (fake `fetchImpl`); a `400` response throws with Razorpay's description.
- [ ] **Step 3: Run** — expected FAIL. **Step 4: Implement.** **Step 5: Run** — expected PASS.
- [ ] **Step 6: Commit** — `feat(licensing-worker): Razorpay client and webhook signature check`

### Task 6: Webhook handler

**Files:**
- Create: `apps/licensing-worker/src/webhook.ts`, `apps/licensing-worker/src/webhook.test.ts`

**Interfaces:**
- Consumes: Task 4 `Deps`, `issueLicense`; Task 5 `verifyWebhookSignature`, `RazorpayApi`.
- Produces: `handleWebhook(deps: Deps & { razorpay: RazorpayApi; webhookSecret: string; log: (msg: string) => void }, request: Request): Promise<Response>`. Outcomes recorded in `webhook_events.outcome`: `issued`, `ignored`, `unmatched`, `status`.

- [ ] **Step 1: Write the failing tests** (a `charged(overrides)` fixture builds a signed request):
  - `"a charge issues the next revision with the payload's period end"`: after a trial (rev 1), charge for `pro`/`monthly` with `current_end` → rev 2, same ids, `trial` absent, `expiresAt === current_end * 1000`, `graceUntil === expiresAt + 7 * DAY`, `reason: "charge"`; `/v1/activate` with `currentRevision: 1` now returns it.
  - `"duplicate event id is a no-op"`: same event twice → one licence; second response `200`.
  - `"same payment under a new event id is ignored"`.
  - `"a late charge for an earlier period is ignored"`: charge period 2, then period 1 → still one charge licence.
  - `"switching yearly to monthly still issues"`: charge on subscription A (yearly), then on B (monthly, earlier `current_end`) → issued.
  - `"a new subscription's first charge cancels the old one"`: fake `RazorpayApi.cancelSubscription` called with A's id; a throwing cancel is logged and the response is still `200`.
  - `"charge before the subscription row exists"` (Review Focus): no `subscriptions` row → licence issued, row created from notes.
  - `"bad signature"` → `400`, nothing written. `"unknown installation"` → `200`, `unmatched`. `"missing notes or current_end"` (Review Focus) → `200`, `unmatched`.
  - `"status events update the subscription only"`: `subscription.halted` → status `halted`, no licence, outcome `status`.
  - `"a store failure returns 500"`: a `D1Like` whose `batch` throws → `500`.
- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement** per spec §3.4: read raw text first, verify, parse, dedupe on event id, then branch. The charge path writes licence insert + subscription upsert + event record in one `db.batch`; cancel others after the batch.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** — `feat(licensing-worker): Razorpay webhook issues renewals`

### Task 7: Checkout endpoint, subscribe page and Worker entry

**Files:**
- Create: `apps/licensing-worker/src/subscriptions.ts`, `apps/licensing-worker/src/subscribe-page.ts`, `apps/licensing-worker/src/index.ts`, `apps/licensing-worker/src/index.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces:
  - `handleCreateSubscription(deps: Deps & { razorpay: RazorpayApi; env: Env }, body: unknown): Promise<Response>` — body `{ installationId: uuid, plan, period, email: email }`; unknown installation `404`; stores `contact_email`; creates the Razorpay subscription with `notes: { installationId, plan, period }`; upserts the subscription row (status from Razorpay); returns `{ subscriptionId, keyId }`
  - `subscribePage(installationId: string, known: boolean): string` — HTML; known: form with plan (Basic/Pro), period (Monthly/Yearly), email, loads `https://checkout.razorpay.com/v1/checkout.js`, posts to `/v1/subscriptions`, opens Checkout with `{ key, subscription_id, prefill: { email } }`, shows the success copy in its `handler`; unknown: the "Open ForkFlow once…" copy. All interpolated values HTML-escaped.
  - `default export { fetch(request: Request, env: Env): Promise<Response> }` — routes: `POST /v1/activate`, `GET /subscribe`, `POST /v1/subscriptions`, `POST /webhooks/razorpay`; else `404`. Rate-limits `/v1/activate` and `/v1/subscriptions` with `env.LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" })` → `429`. Builds the signer once per isolate (module-level promise).

- [ ] **Step 1: Write the failing tests** in `index.test.ts` (call `worker.fetch` with a fake `Env` around `memoryD1()`, a fake limiter and a fake Razorpay via `fetch` stub):
  - `"routes activate and returns a trial"`; `"unknown route is 404"`; `"rate limit returns 429"`.
  - `"subscribe page for an unknown installation shows the reconnect message"` (status `404`, body contains the verbatim copy).
  - `"subscribe page escapes the installation id"`: `?installation=<script>` → no raw `<script>` from the query in the body.
  - `"create subscription tags notes and stores the row"`; `"create subscription for an unknown installation is 404"`; `"invalid email is 400"`.
  - `"counter clock skew"` (Review Focus, end-to-end with the real counter verifier): issue a licence at service time `T`, call the server's `Licensing.activate` with `now = T - 10 min` → throws; saved state unchanged. (Import `buildServer` from `apps/server/src/server.ts`, as `tools/license-claims.test.ts` does.)
- [ ] **Step 2: Run** — expected FAIL. **Step 3: Implement.** **Step 4: Run** — expected PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `feat(licensing-worker): checkout page and Worker routing`

### Task 8: Counter server fetches its licence

**Files:**
- Modify: `apps/server/src/licensing.ts`, `apps/server/src/license-config.ts`, `apps/server/src/license-config.test.ts`, `apps/server/src/main.ts`, `apps/server/src/licensing.test.ts`, `packages/domain/src/licensing.ts`, `tools/desktop-build-config.mjs`, `tools/build-desktop.mjs`, `tools/desktop-packaging.test.mjs`

**Interfaces:**
- Produces:
  - `LicensingOptions.serviceUrl?: string` and `LicensingOptions.fetch?: typeof fetch` (tests inject)
  - `LicenseStatus.subscribeUrl: string | null` = `${serviceUrl}/subscribe?installation=${installationId}` when both exist, else `null`
  - `Licensing.fetchLatest(): Promise<{ outcome: "installed" | "up_to_date" | "unreachable" | "rejected" | "disabled"; message: string }>` — `disabled` when no `serviceUrl` or development build (no fetch made)
  - `Licensing.startRenewalChecks(log: (msg: string) => void): () => void` — runs `fetchLatest` now and every 6 hours (`unref`'d), returns stop
  - `POST /api/license/check` (`settings.manage`) → `{ ...result, status: LicenseStatus }`; broadcasts `license.changed` after `installed`
  - `licenseConfig` reads `__FORKFLOW_LICENSE_SERVICE_URL__` (esbuild define) or, when undefined, `FORKFLOW_LICENSE_SERVICE_URL`; must be `https://` (or `http://127.0.0.1`/`http://localhost` for development) else throws `"Licensing service URL must use HTTPS"`; trailing `/` stripped
  - `desktopBuildConfig` returns `serviceUrl` from `env.FORKFLOW_LICENSE_SERVICE_URL` for commercial builds only (optional; validated `https://`); `build-desktop.mjs` defines `__FORKFLOW_LICENSE_SERVICE_URL__`

- [ ] **Step 1: Write the failing tests** in `licensing.test.ts` (fake `fetch` returning a licence signed with the test key):
  - `"installs a newer licence from the service"`: outcome `installed`, message verbatim, status revision bumped, `license_events` has actor `Automatic renewal`.
  - `"equal revision is up to date"`: service returns `{ license: null }` → `up_to_date`, verbatim message.
  - `"unreachable service leaves billing alone"`: fetch rejects / times out (`AbortSignal.timeout`) → `unreachable`, verbatim message, `canOperate` unchanged.
  - `"a licence for another installation is rejected"`: → `rejected`, saved licence unchanged.
  - `"a wrong-key refusal from the service is rejected"`: service answers `409 { error: "wrong_key" }` → `rejected`.
  - `"no service URL makes no request"`: fetch spy not called, outcome `disabled`.
  - `"check endpoint needs settings.manage"`: cashier → `403`; admin → `200` with `status`.
  - `"status exposes the subscribe URL"`.
  - In `license-config.test.ts`: embedded service URL wins over env in a customer build; `http://example.com` throws; development env URL accepted.
  - In `desktop-packaging.test.mjs`: commercial build passes the URL through; a non-HTTPS URL throws; demo/development ignore it.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/licensing.test.ts apps/server/src/license-config.test.ts` and `npm run test:packaging` — expected FAIL.
- [ ] **Step 3: Implement.** In `main.ts`, after `app.listen`, call `const stopRenewals = app.licensing.startRenewalChecks((m) => app.log.warn(m))` (skip in demo) and stop it in the existing `onClose` hook. `fetchLatest` never throws.
- [ ] **Step 4: Run** the same commands — expected PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `feat(server): fetch renewed licences from the licensing service`

### Task 9: Settings buttons, trial line, docs and smoke run

**Files:**
- Modify: `apps/ui/src/screens/LicenseSettings.tsx`, `tools/e2e/licensing-server.mts`, `tools/e2e/licensing.js`
- Create: `apps/licensing-worker/README.md`, `docs/licensing-service-test-mode.md`

**Interfaces:**
- Consumes: Task 8 `LicenseStatus.subscribeUrl`, `LicenseStatus.trial`, `POST /api/license/check`.

- [ ] **Step 1: UI.** In the plan heading, beside **Refresh plan**: **Subscribe** (when `subscribeUrl` and (`!plan` or `trial`)) or **Manage plan** (when `subscribeUrl` and a paid plan) as an `<a target="_blank" rel="noopener">` to `subscribeUrl`; **Check for renewal** (when `subscribeUrl`) runs `POST /api/license/check` through the existing `run(..., true)` and shows its `message` in the `role="status"` line. The plan line shows `Pro trial — ends {date}` (date via the existing `dateTime(expiresAt, timezone)`) when `trial`.
- [ ] **Step 2: e2e.** `licensing-server.mts` passes `serviceUrl: "http://127.0.0.1:4129"` and starts a tiny fake service on 4129 that answers `/v1/activate` from a queue the browser script can fill via `window.__licenseFixtures` (add a `trialFromService` and `renewalFromService` fixture). Extend `licensing.js`: Subscribe link `href` contains the installation id and opens in a new tab; Check for renewal installs the queued licence and shows `A new licence was installed.`; the trial line appears for a trial grant; with the fake service stopped, the unreachable copy appears and billing pages still load. Run through the Playwright MCP (build the UI first: `npm run build -w @forkflow/ui`).
- [ ] **Step 3: Worker smoke run.** `npx wrangler d1 migrations apply forkflow-licensing --local`, `npx wrangler dev` with a `.dev.vars` holding a throwaway signing key and dummy Razorpay values, then `curl -X POST localhost:8787/v1/activate` with an activation request whose fingerprint matches → `200` with a licence; verify that licence with `verifyLicenseSignature` in a one-off `node --import tsx -e` command. This proves Ed25519 on the real Workers runtime. `.dev.vars` is gitignored; confirm before committing.
- [ ] **Step 4: Docs.** `apps/licensing-worker/README.md`: create D1 (`wrangler d1 create`), apply migrations, set the four secrets with `wrangler secret put`, set the four plan-id vars, deploy test and production environments, point the Razorpay webhook (events from Task 5 Step 1) at `/webhooks/razorpay`, and build the counter with `FORKFLOW_LICENSE_SERVICE_URL`. `docs/licensing-service-test-mode.md`: the manual end-to-end checklist in Razorpay test mode (fresh install gets a trial → Subscribe → test card/UPI → webhook delivered → Check for renewal installs revision 2 → plan change cancels the old subscription → a failed charge issues nothing).
- [ ] **Step 5: Full gates.** `npx vitest run` (only the 2 known captain-https failures), `npm run typecheck`, `npm run test:packaging`, the licensing e2e — all pass.
- [ ] **Step 6: Commit** — `feat(ui): subscribe and renewal check in Plan and devices`; then `docs: licensing service deployment and test-mode checklist`
