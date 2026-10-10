# Licensing Service with Razorpay Subscriptions — Design

**Date:** 10 October 2026
**Status:** Approved in conversation (approach 1: one Cloudflare Worker + D1); awaiting written-spec review

## 1. Goal

Restaurants pay for their ForkFlow licence through Razorpay and receive it automatically. A small licensing service on Cloudflare takes Razorpay subscription payments, signs licences in the existing offline format, and hands them to the counter server when it asks. The counter app keeps verifying licences offline exactly as today.

Success means:

- A fresh installation that is online gets a 14-day Pro trial on first start, with nothing to paste.
- An admin can open a checkout page from Settings, pick Basic or Pro and monthly or yearly, and pay through Razorpay.
- Each successful Razorpay charge produces the next licence revision, and the counter installs it on its own within 6 hours, or at once from a **Check for renewal** button.
- A failed or cancelled subscription issues nothing new; the current licence runs out through its grace period.
- Billing at the counter never depends on the service being reachable.
- Pasting a licence by hand (`tools/issue-license.ts`) keeps working as the offline fallback.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Who pays | Restaurants pay ForkFlow for their licence. Razorpay is not used for diners' bills |
| Host | One Cloudflare Worker, `apps/licensing-worker`, with one D1 database |
| Delivery | The counter server fetches its licence (outbound HTTPS only). No email delivery in v1 |
| Onboarding | Self-serve checkout page served by the Worker |
| Plans | Basic and Pro, each monthly or yearly: four Razorpay plans. Prices live in the Razorpay dashboard; the Worker maps plan ids through configuration |
| Trial | 14-day Pro trial, no grace, once per installation id, issued on first contact |
| Paid licence | `expiresAt` = the billing period end from Razorpay; `graceUntil` = `expiresAt` + 7 days |
| Trial to paid | The paid licence starts from the payment; unused trial days are not added |
| Failure / cancel | Nothing new is issued. Offline licences are never revoked early |
| Plan change | A new Razorpay subscription; the old one is cancelled. Proration and refunds are manual in the Razorpay dashboard |
| Source of truth | The service's `licenses` table owns revision numbers and identifiers |
| Secrets | Razorpay key, Razorpay webhook secret and the Ed25519 signing key are Worker secrets. None ever reach a POS build |
| Out of scope | Email delivery, diner payments, GST invoices for subscriptions, proration, a signing-only Worker, trial-abuse controls beyond rate limiting, an operator admin UI |

## 3. Licensing service (`apps/licensing-worker`)

### 3.1 Endpoints

| Route | Caller | Behaviour |
| --- | --- | --- |
| `POST /v1/activate` | Counter server | Body: the existing `ActivationRequest`. Returns `{ license: string \| null }`: the newest stored envelope if its revision is above `currentRevision`, else `null` |
| `GET /subscribe?installation=<id>` | Admin's browser | HTML page: plan, period and email, then Razorpay Checkout |
| `POST /v1/subscriptions` | The subscribe page | Body: `{ installationId, plan, period, email }`. Creates the Razorpay subscription with `notes: { installationId, plan, period }`, records it, returns the subscription id and the public Razorpay key id |
| `POST /webhooks/razorpay` | Razorpay | Verifies the signature, records the event, issues a licence on a successful charge |

`/v1/activate` and `/v1/subscriptions` are unauthenticated. That is acceptable because a licence names its installation id and the counter rejects any other; both are rate limited per IP.

### 3.2 D1 tables

```sql
CREATE TABLE installations (
  installation_id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL, organization_id TEXT NOT NULL, outlet_id TEXT NOT NULL,
  trial_started_at INTEGER, contact_email TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE subscriptions (
  razorpay_subscription_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  plan TEXT NOT NULL CHECK (plan IN ('basic','pro')),
  period TEXT NOT NULL CHECK (period IN ('monthly','yearly')),
  status TEXT NOT NULL, current_period_end INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE licenses (
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  revision INTEGER NOT NULL,
  plan TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, grace_until INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('trial','charge')),
  razorpay_subscription_id TEXT, razorpay_payment_id TEXT UNIQUE,
  PRIMARY KEY (installation_id, revision)
);
CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY, type TEXT NOT NULL, outcome TEXT NOT NULL, received_at INTEGER NOT NULL
);
```

### 3.3 `POST /v1/activate`

1. Parse the body with the shared `ActivationRequest` schema; reject with 400 otherwise.
2. Reject with 409 if `verificationKeyFingerprint` differs from the fingerprint of the Worker's signing key (a build pointed at the wrong service).
3. **Unknown installation, no licence in the request** (`licenseId` null): create the `installations` row with fresh identifiers, set `trial_started_at`, and issue revision 1 as a Pro licence expiring 14 days later with `graceUntil = expiresAt`.
4. **Unknown installation that already holds a licence** (issued by hand): adopt the request's identifiers and store a placeholder floor so the next issued revision is `currentRevision + 1`. No trial.
5. **Known installation:** never issue anything; just look up the latest licence.
6. Return the latest envelope if `revision > currentRevision`, else `null`. Repeat calls are idempotent: one trial per installation, ever.

For step 4 the floor is the only time a client-reported revision is trusted; afterwards revisions come from the `licenses` table alone.

### 3.4 Webhook

1. Verify the `X-Razorpay-Signature` HMAC-SHA256 over the raw body with the webhook secret, compared in constant time. Bad signature → 400, nothing written.
2. Take the event id (Razorpay's event id header). If it already exists in `webhook_events`, return 200 and do nothing.
3. Read `notes.installationId` from the subscription entity. Unknown installation → record the event as `unmatched`, log it, return 200 (a 5xx would make Razorpay retry for ever).
4. On a **successful charge** event: compute `expiresAt` from the subscription's current period end and `graceUntil = expiresAt + 7 days`. If the payment id was already used, or `expiresAt` is not later than the latest licence issued **for the same subscription**, record `ignored` and stop; this absorbs late, duplicate or out-of-order deliveries without blocking a plan change to a shorter period. Otherwise build claims at `latest revision + 1` with the installation's identifiers and the subscription's plan, sign, and in **one D1 batch** insert the licence, update the subscription row and record the event as `issued`. If the installation has another active subscription, cancel it through the Razorpay API after the batch commits (a failed cancel is logged for manual follow-up, not retried by failing the webhook).
5. On **activated / halted / cancelled / completed** events: update `subscriptions.status` and record the event. No licence change.
6. A D1 or signing failure returns 5xx so Razorpay retries.

### 3.5 Checkout

1. `/subscribe` requires a known installation; otherwise it says "Open ForkFlow once while connected to the internet, then try again".
2. The page posts to `/v1/subscriptions`, which creates the subscription with the plan id for the chosen plan and period, and opens Razorpay Checkout with the subscription id.
3. Choosing a plan when an active subscription already exists creates the new one; the old one is cancelled once the new one's first charge succeeds (§3.4 step 4), so the restaurant is never left without a paid subscription.
4. The success screen tells the admin to return to ForkFlow and press **Check for renewal**. The browser success callback never issues a licence; only the verified webhook does.

### 3.6 Configuration

Worker secrets: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `LICENSE_SIGNING_KEY` (Ed25519 PKCS#8 PEM).
Worker variables: `RAZORPAY_PLAN_BASIC_MONTHLY`, `RAZORPAY_PLAN_BASIC_YEARLY`, `RAZORPAY_PLAN_PRO_MONTHLY`, `RAZORPAY_PLAN_PRO_YEARLY`.
Test and production are separate Worker environments with separate D1 databases and Razorpay test/live keys.

## 4. Shared licence code (`packages/license-issuer`)

The pure parts of `tools/license-claims.ts` move into a new package that only `tools/` and the Worker import. The counter server and UI never import it.

- `ActivationRequest` Zod schema and `parseActivationRequest`.
- `buildClaims(request, { plan, expiresAt, graceUntil }, now, uuid)`: same identifier and revision rules as today, but takes explicit dates. `tools/` keeps its `months` and `graceDays` options and converts them before calling.
- `encodeEnvelope(claims, sign)`: builds `ff1.<base64url claims>`, calls `sign(bytes) => Promise<Uint8Array>`, returns `ff1.<claims>.<signature>\n`. Encoding uses plain `Uint8Array` and base64url helpers, not `Buffer`.
- `tools/` passes a `node:crypto` signer; the Worker passes a WebCrypto Ed25519 signer.

The verifier in `packages/core/src/signed-license.ts` does not change.

## 5. Counter server and Settings

### 5.1 Server — `apps/server/src/licensing.ts`, `license-config.ts`

- `LicensingOptions` gains `serviceUrl?: string`. Commercial builds bake it in through an esbuild define (`__FORKFLOW_LICENSE_SERVICE_URL__`), like the public key; development uses the `FORKFLOW_LICENSE_SERVICE_URL` environment variable. With no URL, nothing is ever fetched.
- New `Licensing.fetchLatest()`: posts `activationRequest()` to `${serviceUrl}/v1/activate` with a 10-second timeout. A returned envelope goes through the existing `activate()`, so revision, identity and clock checks still apply. The audit actor is "Automatic renewal". Returns `{ outcome: "installed" | "up_to_date" | "unreachable" | "rejected", message }`.
- Runs on server start, every 6 hours, and from a new `POST /api/license/check` (permission `settings.manage`), which also broadcasts `license.changed` when something was installed.
- Failures are logged and never thrown into request handling; `canOperate` keeps coming from the saved licence.

### 5.2 Settings — `apps/ui/src/screens/LicenseSettings.tsx`

- **Subscribe** (no paid plan yet) or **Manage plan** opens `${serviceUrl}/subscribe?installation=<id>` in a new tab. `GET /api/license` adds `subscribeUrl: string | null` so the UI does not build URLs itself.
- **Check for renewal** calls `POST /api/license/check` and shows its message.
- During a trial the plan line reads "Pro trial — ends <date>", driven by the new `trial` claim (below).
- Licence import by hand stays as it is.

### 5.3 Trial claim — `packages/domain/src/licensing.ts`

- `LicenseClaims` adds `trial: z.boolean().default(false)` (the object stays `.strict()`), the same pattern used when `kds` was added. Licences without it read as paid.
- `LicenseStatus` and `LicensePreview` add `trial: boolean`; unactivated and development report `false`.
- The service sets `trial: true` only on the 14-day licence from §3.3; `tools/issue-license.ts` never sets it.

## 6. Errors

| Situation | Behaviour |
| --- | --- |
| Counter offline or service down | `fetchLatest` returns `unreachable`; billing unaffected; the button says "Couldn't reach the licensing service. Billing continues on your current licence." |
| Service returns a licence the counter rejects | `rejected`, logged with the reason; the saved licence is untouched |
| Wrong signing key or fingerprint | Service returns 409; the counter reports it as `rejected` |
| Webhook bad signature | 400, nothing written |
| Webhook for an unknown installation | 200, recorded `unmatched` |
| Duplicate or out-of-order webhook | 200, recorded `ignored` |
| D1 failure in the webhook | 5xx, Razorpay retries |
| Trial already used | `/v1/activate` returns the existing licence or `null`; never a second trial |

## 7. Testing

- **Format compatibility (first task):** an envelope signed through `encodeEnvelope` with the WebCrypto signer must pass the real `verifyLicenseSignature` and `LicenseClaims.parse`. This proves Workers' Ed25519 works with the existing verifier before anything else is built.
- **Shared package:** `buildClaims` keeps today's rules (first activation revision 1 with fresh identifiers; renewal keeps identifiers and bumps revision); `tools/issue-license.ts` output is byte-identical to before for the same inputs.
- **Worker** (vitest with the Workers pool and a local D1): trial issued once; repeat activate idempotent; hand-issued licence adopted with its revision floor; fingerprint mismatch; charge issues the next revision with the same identifiers and the payload's period end; grace 7 days; duplicate, late and out-of-order charges ignored; bad signature; unmatched installation; status events; rate limit; subscribe page rejects an unknown installation.
- **Counter server:** `fetchLatest` with a fake fetch installs a newer licence, ignores an equal one, reports `unreachable` on timeout without changing `canOperate`, reports `rejected` for a bad envelope; no calls without `serviceUrl`; `POST /api/license/check` needs `settings.manage`.
- **UI:** Settings shows Subscribe, Manage plan, Check for renewal and the trial line; e2e through the Playwright MCP.
- **Razorpay test mode:** a written manual checklist (`docs/licensing-service-test-mode.md`) for a real test-mode subscription end to end. It needs the owner's test keys, so it is not automated.

## 8. To verify before building

These are assumptions, not checked against current documentation:

- Cloudflare Workers support Ed25519 signing in WebCrypto and import PKCS#8 Ed25519 keys.
- Razorpay's current Subscriptions API (create, cancel), the webhook event names for a successful charge and for status changes, the event id header, and where the period end appears in the payload.
- Razorpay's handling of a new subscription replacing an old one, and how many charge retries it makes before `halted` (the 7-day grace should cover them).
- Cloudflare's rate-limiting binding for Workers and D1 batch atomicity.

## 9. Rollout

- Generate the production signing key pair; the public half goes into commercial builds (the existing key, if it is kept).
- Create the four Razorpay plans in test mode, deploy the test Worker, run the manual checklist, then repeat in live mode.
- Point the Razorpay webhook at the live Worker.
- Ship a counter build with the service URL baked in.
- No restaurant is live yet, so there are no existing licences to migrate.
