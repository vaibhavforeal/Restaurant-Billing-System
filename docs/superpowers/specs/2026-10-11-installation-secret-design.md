# Installation Secret for the Licensing Service — Design Addendum

**Date:** 11 October 2026
**Status:** Approved in conversation; awaiting written-spec review
**Amends:** `2026-10-10-licensing-service-design.md` (§3.1, §3.3, §3.5, §5)

## 1. Goal

Only the restaurant's own counter server can act for its installation on the licensing service. Knowing an installation id, which any cashier can see, is no longer enough to fetch its licences, change its revision floor, or buy a plan in its name.

Success means:

- `/v1/activate` refuses a request that lacks the installation's secret once the installation is known.
- Buying a plan needs a short-lived checkout session that only the counter server can create, and only for an admin.
- The secret never reaches a browser, the activation-request file, a log, or the D1 database in plain form.
- Billing at the counter is unaffected; a failed secret check behaves like any other `rejected` renewal.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Secret | 32 random bytes, hex (64 chars), stored as `installationSecret` in `installation.json` beside `installationId`. Created with the id on first start; added to an existing file that lacks it. Backups never include `installation.json`, so the secret follows the data folder exactly as the id does |
| Transport | HTTP header `X-MasalaPOS-Installation-Secret` on counter → Worker calls only. Not part of `ActivationRequest`, so the downloadable activation-request file is unchanged |
| Storage on the Worker | `installations.secret_hash` = lowercase hex SHA-256 of the secret string. Compared in constant time |
| Trust model | Trust on first use. The request that creates the installation row sets the hash. A known row with a `NULL` hash is claimed by the next request carrying a well-formed secret (this is also the operator's reset path) |
| Failure | Missing, malformed or wrong secret for a known installation → `401 { error: "unauthorized" }` |
| Checkout | Admin-only, via a one-time session token minted by the Worker for the counter server. Token: 32 random bytes, base64url; stored as SHA-256 hex; valid 30 minutes; reusable within that time (retries after closing Checkout) |
| Status API | `LicenseStatus.subscribeUrl` is replaced by `subscriptionAvailable: boolean`. `installationId` stays (harmless without the secret) |
| Out of scope | Secret rotation UI, per-device secrets, admin re-authentication on the Worker |

## 3. Worker changes (`apps/licensing-worker`)

### 3.1 Migration `0002_installation_secret.sql`

```sql
ALTER TABLE installations ADD COLUMN secret_hash TEXT;
CREATE TABLE subscribe_sessions (
  token_hash TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

### 3.2 `POST /v1/activate`

Order of checks: parse body (400) → key fingerprint (409) → secret (401) → existing behaviour.

- The header must match `^[a-f0-9]{64}$`; otherwise 401 (for both known and unknown installations).
- **Unknown installation** (first contact or adoption): the row is created with `secret_hash`. Racing first contacts with different secrets: `ON CONFLICT DO NOTHING`, re-read, compare; the loser gets 401.
- **Known installation, `secret_hash` NULL:** set it from this request, then continue.
- **Known installation, hash differs:** 401; nothing written (no floor change, no re-sign).

### 3.3 New `POST /v1/subscribe-sessions`

- Caller: counter server. Header: the secret. Body: `{ installationId: uuid }`. Rate limited like `/v1/activate`.
- Unknown installation → `404 { error: "unknown_installation" }`. Wrong or missing secret → 401. (A `NULL` hash is claimed as in §3.2.)
- Creates a session, deletes that installation's expired sessions, returns `{ session: string, expiresAt: number }`.

### 3.4 Checkout

- `GET /subscribe?session=<token>`: a valid, unexpired session renders the page for its installation, embedding the session (escaped) instead of the installation id. Anything else → 404 page with the copy `This payment link has expired. In MasalaPOS, open Settings > Plan and devices and press Subscribe again.`
- `POST /v1/subscriptions` body becomes `{ session, plan, period, email }`. The installation comes from the session. Invalid or expired session → `401 { error: "session_expired" }`, and the page shows the same expired copy. Everything else (Razorpay notes, 502 on provider failure, stored email) is unchanged.
- `?installation=` is no longer accepted.
- The webhook is unchanged: Razorpay's signature already authenticates it, and `notes.installationId` was set by a session-checked checkout.

## 4. Counter changes

### 4.1 `apps/server/src/license-config.ts`

- `installation.json` holds `{ installationId, installationSecret }`. If the secret is missing or malformed, generate one and rewrite the file atomically with the same id.
- `LicensingOptions` gains `installationSecret: string`.

### 4.2 `apps/server/src/licensing.ts`

- `fetchLatest()` sends the secret header. A 401 maps to `rejected` with the message `The licensing service doesn't recognise this installation. Contact MasalaPOS support.`
- New `Licensing.subscribeSession(): Promise<{ url: string } | { error: string; status: 409 | 503 }>`:
  - No service URL → 409 `Automatic renewal is not set up for this installation.`
  - Calls `POST /v1/subscribe-sessions`. On 404, run `fetchLatest()` once (it registers the installation) and retry once.
  - 401 → 409 with the not-recognised message above. Network error, timeout or any other status → 503 `Couldn't reach the licensing service. Check the internet connection and try again.`
  - Success → `{ url: "${serviceUrl}/subscribe?session=${session}" }`.
- New route `POST /api/license/subscribe-session` (`settings.manage`, `Cache-Control: no-store`), returning `{ url }` or the error with its status.
- `LicenseStatus.subscriptionAvailable` = commercial build with a service URL.

### 4.3 `apps/ui/src/screens/LicenseSettings.tsx`

- **Subscribe** and **Manage plan** become buttons with the same visibility rules, now keyed on `subscriptionAvailable`.
- On click, open a blank tab synchronously (`window.open("", "_blank")`), request the session URL, set `tab.opener = null`, then navigate the tab. On error, close the tab and show the message. If the browser blocks the tab, show the URL as a link to click instead.

## 5. Errors

| Situation | Behaviour |
| --- | --- |
| Counter has no secret yet (older `installation.json`) | Secret generated on start; the next activate claims a `NULL` hash or creates the row |
| Someone else's request with a known installation id | 401; nothing changes |
| A cashier | Cannot create a session (403); the old subscribe URL no longer exists |
| Admin's checkout tab left open past 30 minutes | Expired copy; pressing Subscribe again creates a new session |
| Operator needs to re-pair a counter (lost data folder restored elsewhere) | `UPDATE installations SET secret_hash = NULL WHERE installation_id = ?` in D1; the next counter request claims it. Documented in the README |

## 6. Testing

- Worker: activate with no / malformed / wrong / right secret; first contact stores the hash; NULL-hash claim; racing first contacts with different secrets (one 401); wrong secret writes nothing (floor and licences unchanged); session create / unknown installation 404 / wrong secret 401; subscribe page with valid, expired and unknown session; `/v1/subscriptions` with a valid session tags notes with the session's installation, expired session 401, no installation id accepted from the body.
- Counter: `installation.json` gains a secret without changing the id; the header is sent on activate and session calls; 401 → `rejected` with the verbatim copy; `subscribeSession` success / 404-then-retry / 401 / unreachable; the route needs `settings.manage`; the secret never appears in `GET /api/license`, the activation-request download, or logs.
- UI and e2e: Subscribe opens the session URL in a new tab; a blocked tab falls back to a link; `licensing.js` updated for the button flow.
