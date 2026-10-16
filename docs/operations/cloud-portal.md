# Owner portal and outlet browser

The owner portal is a separate React application in `apps/cloud-ui`. It reads cloud copies of outlet records. The outlet computer remains responsible for billing, settlement, printing, stock accounting, and accepting remote changes.

## Run locally

Run the cloud API on port 4200, then run `npm run dev --workspace=@forkflow/cloud-ui`. Vite serves the portal at `http://127.0.0.1:4300` and proxies `/v1` to the API. The API must allow that portal origin and its cookie configuration must support the local development environment. Build with `npm run build --workspace=@forkflow/cloud-ui`; publish `apps/cloud-ui/dist` behind HTTPS and route `/v1` to the cloud API on the same origin. Serve the SPA entry for invitation and password-reset paths.

The portal has no database connection or cloud service secrets. The session uses an HttpOnly cookie. The browser reads the CSRF token from login or `/v1/auth/me`, keeps it in memory, and sends it as `x-csrf-token` on mutations. API fetches use `credentials: include` and `cache: no-store`. The cloud API remains responsible for checking membership, outlet scope, role, CSRF, and the configured Origin on every request.

## Account setup

Platform administrators create organizations and send invitations from Platform administration. Existing owners sign in with their email and password. Staff PINs are not cloud passwords. Recovery sends a one-use link to the account email without revealing whether an account exists.

Invitation links may use `/?invite=TOKEN` or `/invite?token=TOKEN`; reset links may use `/?reset=TOKEN` or `/reset?token=TOKEN`. Hash forms `/#invite=TOKEN` and `/#reset=TOKEN` are also accepted. Tokens are removed from browser history on load. Invite and reset forms require a new password and matching confirmation.

## Pair an outlet

1. Select the organization and add its outlet in the portal.
2. Choose **Generate pairing code** on the outlet card. The code has the server-provided expiry time.
3. On the outlet computer, open Settings → Owner cloud connection. Enter the cloud service address and the pairing code.
4. Wait for the initial upload. Reports show the latest uploaded sequence and last contact time.

**Disconnect cloud access** revokes the outlet connection; local operation continues. Use a new pairing code to connect a replacement computer according to the service recovery procedure. The portal never infers unuploaded changes from the cloud copy: when the server does not report an outstanding upload count, it says **Check at outlet**. The outlet Settings panel shows its durable upload backlog.

## Reports and remote changes

Sales, daily totals, taxes, and collections use the cloud reporting API and its persisted monetary values. Detailed reports include item/category sales, cashier collections, hourly sales, KOT performance, cancellations, stock consumption/wastage, credit notes, order analytics, profit/costing, and day-end summaries. The API supplies each report’s columns, date scope, timezone, and explanatory notes. Totals use integer paise formatted without floating-point rounding. A missing upload is shown explicitly; outages never turn into fabricated zero-value reports. The displayed date range applies to the reporting API. Last contact is connectivity information, not proof that every outlet record has uploaded.

Date filters and hourly buckets use the uploaded `outlet_meta.timezone`, with UTC for legacy fixtures that have no timezone. All 24 hour buckets are present, including empty hours; repeated daylight-saving hours share their local-hour bucket. Credits offset taxes and revenue on the credit-note issue date. Collections use receipt/refund dates, exclude Zomato receivables, and attribute refunds to the requesting cashier. Legacy receipts without a settlement actor are **Unknown**. Profit uses immutable bill-line taxable revenue and the recorded unreversed ingredient movements linked to each item, regardless of movement date. Unknown costs and dishes with no recipe remain excluded from costed profit. Credit notes do not imply stock returns. Fractional quantities remain quantities; derived cancelled menu values can include fractional paise and are rounded only for currency display.

Menu products, categories, variants, business settings, feature controls, and staff permissions use typed forms. Editors load all pages of their mirrored records before offering changes. Each submitted command includes the selected target and its uploaded revision. The form does not optimistically update the outlet’s data.

Change history distinguishes:

- **Pending:** waiting for the outlet to validate and apply the change.
- **Applied:** the outlet accepted it.
- **Conflict:** the outlet record changed since the uploaded revision used for the edit. Refresh, review its current values, then submit a new change.
- **Rejected:** validation or outlet policy refused the change; review the reason.
- **Cancelled:** a pending change was cancelled before application.

Feature entitlements and dependencies are enforced by the outlet. Core billing and recovery are not configurable. Staff controls use explicit allow/deny overrides or the role default, and never carry PIN hashes. Administrators cannot be restricted by the staff editor. Subscription actions hand off to the existing licensing service to show prices and terms before payment.

## Cashier browser resilience

The POS build emits `/pos-sw.js`, `/pos/manifest.webmanifest`, and POS icons alongside the existing Captain and Kitchen files. `startPosPwa()` registers the worker only for `/` in production and on a secure origin. Browser installation and offline service workers require trusted HTTPS, except supported localhost development origins.

The worker caches only the cashier entry document, explicitly generated JS/CSS assets, manifest, and icons. It does not intercept `/api/`, `/v1/`, any non-GET request, external resources, or Captain/Kitchen/guest navigation. It does not queue or replay mutations. Initial cache installation must complete successfully; a new version waits until the existing cashier windows close. Old cashier caches are removed independently of Captain and Kitchen caches.

The outlet connection panel distinguishes **Outlet computer unreachable** from **Cloud connection unavailable**. Cloud failure does not imply a LAN failure. An unreachable outlet still prevents server-backed operations; an offline shell is not a replacement for the outlet service.

The panel reads backup status independently from `/api/cloud/storage/status`, showing the last successful backup, its age, queued/uploading state, and the last upload error. A recent cloud connection is not presented as proof of a recent backup.

## Browser identity and recovery

Before mounting the outlet application, the browser reads the unauthenticated health endpoint. Identified outlets return `outletIdentity` and `generation`. Sessions, device credentials, draft carts, takeaway recovery, retry queues, and completion evidence are stored through an outlet-scoped facade. The namespace includes both values and a binding nonce. Windows connected to the same identity share the active namespace.

On first migration, outlet replacement, or recovery-generation change, the browser verifies a JSON recovery archive before changing its binding. Original physical keys remain available for manual investigation; they are not replayed into the new outlet. Switching back to an old outlet creates a new binding rather than resuming archived actions automatically. If the archive cannot be written and read back, boot stops without switching identity. The user is told to sign in and check current orders.

An older window cannot write after another window changes the binding. The application reloads on the binding storage event. API requests carry `x-forkflow-outlet-identity` and `x-forkflow-generation`; a server response with `code: outlet_identity_changed` unmounts the active application and checks identity again. The server must reject stale identity headers before mutations. Production outlet startup supplies both health fields. Older servers/test fixtures with neither field retain the previous storage behavior only when this browser has never acquired a real binding; a bound browser never downgrades to the legacy mode.

WebSocket authentication carries the same identity and generation. A configured outlet rejects missing or mismatched values with close code 4409 before registering the connection for events. The browser stops reconnecting that socket, unmounts the old session, and checks the outlet identity again. Legacy servers without an identity fence retain their existing authentication behavior.

Recovery archives use `forkflow.outlet-archive.v1.*` in browser storage and include the old binding, next identity, archive timestamp, and saved entries. They contain sensitive local session/draft information and should be reviewed locally. Restore an intended order by checking its authoritative outlet state, not by copying archived retry keys back into the active namespace.

## Verification

Focused tests cover cookie/CSRF handling, expired sessions, cloud failures, freshness, exact currency conversion, revision-preserving edit payloads, cashier shell caching boundaries, and Captain/Kitchen cache isolation. Run:

```powershell
npx vitest run apps/cloud-ui/src apps/ui/src/pos-worker.test.ts apps/ui/src/cloud-status.test.ts apps/ui/src/captain-worker.test.ts
npx vitest run apps/cloud-api/src/reports.test.ts
npm run typecheck --workspace=@forkflow/cloud-ui
npm run build --workspace=@forkflow/cloud-ui
npm run typecheck --workspace=@forkflow/ui
npm run build --workspace=@forkflow/ui
```

Report parity tests use a disposable real PostgreSQL instance and compare its cloud reports with actual local SQLite report routes fed the same recorded facts. They cover all operational families, profit, filtered analytics, day-end reconciliation, fractional quantities, exact large amounts, timezone boundaries, refunds, and missing/reversed costs.

Before deployment, verify invitation email delivery, login and recovery, scoped outlet access, pairing expiry/revocation, pending command cancellation, stale report labels, offline outlet billing, browser shell reload with the outlet unavailable, and update activation after all cashier windows close against the deployed HTTPS configuration.
