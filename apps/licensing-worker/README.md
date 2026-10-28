# ForkFlow licensing service

A Cloudflare Worker with a D1 database. It does three jobs:

- `POST /v1/activate` hands a counter its latest signed licence. A brand-new installation gets one 14-day Pro trial (once per installation id, ever). It needs the installation secret (see below).
- `POST /v1/subscribe-sessions` gives a counter a short-lived checkout link; `GET /subscribe?session=<token>` and `POST /v1/subscriptions` take an admin to Razorpay Checkout for a Basic or Pro, monthly or yearly subscription. The only way to reach checkout is **Subscribe** or **Manage plan** in Settings > Plan and devices, as an admin. A link expires after 30 minutes; pressing the button again makes a new one.
- `POST /webhooks/razorpay` turns a verified Razorpay charge into a new signed licence (expiry = the subscription's `current_end`, plus 7 days of offline grace).

The counter app never talks to Razorpay. It only asks this service for a licence, and it verifies the Ed25519 signature with the public key baked into its build, exactly as it does for a licence imported by hand. The design is in `docs/superpowers/specs/2026-10-10-licensing-service-design.md`.

Nothing under `apps/server`, `apps/ui`, `packages/domain` or `packages/core` imports this package. Worker source uses only WebCrypto, `fetch`, `Request`/`Response` and the interfaces in `src/env.ts`.

## The installation secret

An installation id alone is not proof of who is asking: it appears in activation requests and licence files that get emailed around. So each counter also holds a secret.

- On first start the counter generates 32 random bytes (64 lowercase hex characters) and stores them in `installation.json` next to the installation id, in its data folder. An older `installation.json` without a secret gets one on the next start; the id does not change. Back this file up with the rest of the data folder.
- The counter sends it in the `X-ForkFlow-Installation-Secret` header on `POST /v1/activate` and `POST /v1/subscribe-sessions`. A request without a well-formed secret gets `401 { "error": "unauthorized" }` and nothing is written.
- Trust on first use: the Worker stores only the SHA-256 of the secret (`installations.secret_hash`). The first request for an installation that has no hash yet claims it; every later request must present the same secret, or it gets `401` and changes nothing. The secret is never logged or echoed, and the counter never puts it in the activation-request file or in any response to the browser.
- **Re-pairing a counter** (the data folder was restored from a copy made before the secret existed, or `installation.json` was replaced, so the counter now holds a different secret for the same installation id): clear the stored hash, and the next request from that counter claims it again:

  ```powershell
  npx wrangler@4 d1 execute forkflow-licensing --remote --command "UPDATE installations SET secret_hash = NULL WHERE installation_id = '<installation id>'"
  ```

  (Use `forkflow-licensing-test --env test` for the test database.) Do this only for an installation you have verified is the customer's; until the counter makes its next request, whoever asks first becomes its owner.
- **If someone else registered this installation id first** (the real counter gets `401` on **Check for renewal** and "The licensing service doesn't recognise this installation", and you have not re-paired it): another caller made first contact and now owns the row, so clearing the hash would only let the next caller take it again. Verify the customer first, then delete the hijacked row so the real counter registers fresh on its next start. Check that nothing was paid on it:

  ```powershell
  npx wrangler@4 d1 execute forkflow-licensing --remote --command "SELECT reason, razorpay_payment_id FROM licenses WHERE installation_id = '<installation id>'; SELECT razorpay_subscription_id, status FROM subscriptions WHERE installation_id = '<installation id>'"
  ```

  **Stop if any licence has reason `charge`, or any subscription exists beyond an unpaid attempt.** That installation has paid: contact the customer and Razorpay before touching it. Otherwise delete the dependents first (they reference `installations`), then the row itself:

  ```powershell
  npx wrangler@4 d1 execute forkflow-licensing --remote --command "DELETE FROM subscribe_sessions WHERE installation_id = '<installation id>'; DELETE FROM licenses WHERE installation_id = '<installation id>'; DELETE FROM subscriptions WHERE installation_id = '<installation id>'; DELETE FROM installations WHERE installation_id = '<installation id>'"
  ```

  The installation's trial is deleted with its row, so the real counter gets a fresh 14-day trial when it registers (the trial was spent by the hijacker, not the customer). Then restart the real counter or press **Check for renewal**, and make sure it is the one that registers.
- **Upgrading an existing deployment:** migration `0002_installation_secret.sql` adds `secret_hash` and the checkout-session table. Apply it **before** deploying the Worker that needs it, test first:

  ```powershell
  npx wrangler@4 d1 migrations apply forkflow-licensing-test --env test --remote
  npx wrangler@4 d1 migrations apply forkflow-licensing --remote
  ```

  Counters already in the field have no hash on their row, so each one claims it with its first request after it updates. Counters on the previous build send no secret and get `401` from the new Worker until they are updated to a build that does.

  **Rollout check.** After the migration and deploy, every installation that existed before has `secret_hash` NULL, so the first caller to present a well-formed id and secret claims it, and that caller is not necessarily the customer. Once the counters have updated, run:

  ```powershell
  npx wrangler@4 d1 execute forkflow-licensing --remote --command "SELECT installation_id FROM installations WHERE secret_hash IS NULL"
  ```

  Any installation still listed has not been claimed by its counter. Investigate each one you recognise as a customer (is the counter on the new build and online?) before it is claimed by someone else; if it was already claimed by the wrong party, use the hijacked-installation procedure above.
- **Checkout sessions:** `POST /v1/subscribe-sessions` (with the secret header and `{ "installationId": "..." }`) returns `{ "session": "<43-character token>", "expiresAt": <ms> }`. The Worker keeps only the token's SHA-256. `GET /subscribe?session=` and `POST /v1/subscriptions` identify the installation from the session; an installation id in the address is ignored, and one in the request body is rejected with `400` (the body schema is strict). An unknown or expired session gets a 404 page (or `401 { "error": "session_expired" }` from the form's POST) saying "This payment link has expired. In ForkFlow, open Settings > Plan and devices and press Subscribe again."

## What you need

- A Cloudflare account and `npx wrangler@4` (never install it into the repo). Run `npx wrangler login` yourself, once.
- A Razorpay account. Start in **test mode** (test keys, test plans); repeat everything in live mode only after the checklist in `docs/licensing-service-test-mode.md` passes.
- **Two separate Ed25519 key pairs: one for test, one for production.** The production pair is the one your commercial builds already trust (or make one). Always make a new pair for test:

  ```powershell
  # Production (skip if your commercial builds already trust a pair)
  openssl genpkey -algorithm ed25519 -out C:\secure\license-private.pem
  openssl pkey -in C:\secure\license-private.pem -pubout -out C:\secure\license-public.pem
  # Test: a different pair, used for nothing else
  openssl genpkey -algorithm ed25519 -out C:\secure\license-test-private.pem
  openssl pkey -in C:\secure\license-test-private.pem -pubout -out C:\secure\license-test-public.pem
  ```

  Each private key goes only into the `LICENSE_SIGNING_KEY` secret (PKCS#8 PEM) of its own Worker: the test key into the test Worker, the production key into the production Worker and nowhere else. Each public key goes into the counter builds for that environment (see step 7). A build whose public key does not match a Worker's signing key is told `409 wrong_key`. Settings shows only "The licensing service returned a licence this installation can't use."; the specific cause ("The licensing service signs with a different key than this build trusts") is in the counter server's log.

> [!WARNING]
> **Never load the production signing key into the test Worker.** The test Worker is public and takes Razorpay test-mode payments, which anyone can make with Razorpay's published test card. If it signed with the production key, anyone could send a production counter's activation request to it, "pay" with the test card on its `/subscribe` page, collect a licence that production counters accept and import it by hand. With a separate test key, a licence from the test Worker only works in test builds.

## Environments

`wrangler.jsonc` defines two Worker environments. They share nothing:

| | Test | Production |
| --- | --- | --- |
| Deploy | `npx wrangler deploy --env test` | `npx wrangler deploy` |
| Database | `forkflow-licensing-test` | `forkflow-licensing` |
| Razorpay keys and plans | test mode | live mode |
| Signing key (`LICENSE_SIGNING_KEY`) | `license-test-private.pem` | `license-private.pem` |
| Counter builds that use it | test builds (test public key) | production builds (production public key) |

Wrangler does not inherit `vars` or secrets between environments, so every step below is done once per environment. Add `--env test` to each command for the test environment; leave it off for production.

## 1. Create the database

```powershell
cd apps\licensing-worker
npx wrangler d1 create forkflow-licensing-test
npx wrangler d1 create forkflow-licensing
```

Each command prints a `database_id`. Put it in `wrangler.jsonc` in place of `<set by wrangler d1 create>` (the top-level `d1_databases` entry is production, the one under `env.test` is test). Do not commit a local-run id or one from someone else's account.

## 2. Apply the migrations

```powershell
npx wrangler d1 migrations apply forkflow-licensing-test --env test --remote
npx wrangler d1 migrations apply forkflow-licensing --remote
```

Run this again whenever a new file appears under `migrations/`, before deploying the Worker that needs it.

## 3. Create the Razorpay plans and set the plan ids

In the Razorpay dashboard (test mode first) create four plans, with the amounts you want to charge:

| Plan | Period | Interval |
| --- | --- | --- |
| Basic monthly | monthly | 1 |
| Basic yearly | yearly | 1 |
| Pro monthly | monthly | 1 |
| Pro yearly | yearly | 1 |

The Worker chooses the number of billing cycles itself when it creates a subscription (`total_count` 120 for monthly, 10 for yearly), so leave that out of the plan. Copy the four plan ids into `wrangler.jsonc` as plain variables. `vars` is not inherited by `env.test`, so give each environment its own block:

```jsonc
"vars": {
  "RAZORPAY_PLAN_BASIC_MONTHLY": "plan_...",
  "RAZORPAY_PLAN_BASIC_YEARLY": "plan_...",
  "RAZORPAY_PLAN_PRO_MONTHLY": "plan_...",
  "RAZORPAY_PLAN_PRO_YEARLY": "plan_..."
}
```

(Put one at the top level for production and one inside `"env": { "test": { ... } }`.)

## 4. Set the four secrets

```powershell
npx wrangler secret put RAZORPAY_KEY_ID --env test
npx wrangler secret put RAZORPAY_KEY_SECRET --env test
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET --env test
Get-Content C:\secure\license-test-private.pem -Raw | npx wrangler secret put LICENSE_SIGNING_KEY --env test
```

Then production, with live Razorpay keys and the production signing key:

```powershell
npx wrangler secret put RAZORPAY_KEY_ID
npx wrangler secret put RAZORPAY_KEY_SECRET
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
Get-Content C:\secure\license-private.pem -Raw | npx wrangler secret put LICENSE_SIGNING_KEY
```

For the owner control panel (see "Owner control panel" below), also set a long owner password in each environment. Use a password manager to generate one of at least 16 characters, different per environment:

```powershell
npx wrangler secret put OWNER_PASSWORD --env test
npx wrangler secret put OWNER_PASSWORD
```

Without it the panel stays closed (its login answers `503`); licensing itself does not need it.

The test Worker gets `license-test-private.pem`, never `license-private.pem` (see the warning under "What you need"). `RAZORPAY_WEBHOOK_SECRET` is a string you choose, different per environment; you enter the same string in the Razorpay webhook settings in step 6. Secrets live only in Cloudflare: never put them in the repo, in `wrangler.jsonc`, in a counter build or in browser code.

## 5. Deploy

```powershell
npx wrangler deploy --env test
npx wrangler deploy
```

Wrangler prints the Worker's URL (`https://forkflow-licensing-test.<account>.workers.dev` for the test environment, or a custom domain you attach). The counter requires HTTPS.

The test Worker is only for the test-mode checklist. Once the checklist passes, take it off the internet: delete it (`npx wrangler delete --env test`), or add `"workers_dev": false` to the `env.test` block of `wrangler.jsonc` and deploy it again so it has no public URL. Deploy it again the same way when you next need a test run.

## 6. Point the Razorpay webhook at the Worker

In the Razorpay dashboard (matching mode) open Settings, then Webhooks, and add:

- URL: `https://<worker-url>/webhooks/razorpay`
- Secret: the `RAZORPAY_WEBHOOK_SECRET` you set above
- Events: `subscription.charged`, `subscription.activated`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`

Only `subscription.charged` can issue a licence; the other four just update the stored subscription status. A request with a bad signature gets `400` and writes nothing; a duplicate event id gets `200` and is ignored.

## 7. Build the counter against the service

The service URL is baked into commercial builds next to the public key, like the key itself. HTTPS is required. A build's public key and service URL always belong to the same environment.

Production builds (the ones you ship) embed the production public key and the production Worker's URL:

```powershell
$env:FORKFLOW_LICENSE_PUBLIC_KEY = Get-Content 'C:\secure\license-public.pem' -Raw
$env:FORKFLOW_LICENSE_SERVICE_URL = 'https://<production-worker-url>'
npm.cmd run package:commercial
```

Test builds (only for the test-mode checklist, never given to a restaurant) embed the **test** public key and the test Worker's URL:

```powershell
$env:FORKFLOW_LICENSE_PUBLIC_KEY = Get-Content 'C:\secure\license-test-public.pem' -Raw
$env:FORKFLOW_LICENSE_SERVICE_URL = 'https://<test-worker-url>'
npm.cmd run package:commercial
```

Clear both variables (or open a new terminal) between a test build and a production build.

A build without `FORKFLOW_LICENSE_SERVICE_URL` never contacts the service: no automatic trial, no renewals, and Settings hides Subscribe, Manage plan and Check for renewal. When running the server from source, set the same variable (plain `http://127.0.0.1` is accepted there, never in a packaged build).

A counter asks for its licence when the server starts, every 6 hours, and when an admin presses **Check for renewal** in Settings, Plan and devices. Billing never depends on the answer.

## Owner control panel

`https://<worker-url>/owner` is where ForkFlow decides which modules each restaurant may use: takeaway, reservations, QR guest ordering, guest assistance, inventory, recipes, dish costing, reports, the sales dashboard, Zomato, the Kitchen Display and CRM & Loyalty. Sign in with `OWNER_PASSWORD`; a session lasts 8 hours, and sign-in attempts share the service's rate limit (20 a minute per address).

Every restaurant appears the first time its ForkFlow contacts the service. For each module choose **Follow the plan** (Basic or Pro defaults), **Allow** or **Block**, and press **Save**. Saving signs the restaurant's current terms (plan, dates, trial, subscription) with the new modules as the next licence revision; renaming a restaurant issues nothing. The card shows "Waiting for the restaurant to check in" until the counter has collected that revision, which happens within an hour, or at once when an admin presses **Check for renewal**. A restaurant whose licence has run out gets no new revision; its next trial or payment carries the change, because every licence the service issues includes the owner's choices.

Within what you allow, the restaurant's admin can still switch a module off in its Marketplace and back on later. **Change history** on each card lists every change with the licence revision it went into.

## Running it locally

```powershell
cd apps\licensing-worker
npx wrangler d1 migrations apply forkflow-licensing --local
npx wrangler dev
```

`wrangler dev` reads `.dev.vars` (secrets and variables, same names as above). Both `.dev.vars` and `.wrangler/` are gitignored; keep it that way and use a throwaway signing key and dummy Razorpay values. Never commit `.dev.vars`, a key, or a `database_id` from a local run. Delete `.dev.vars` and `.wrangler/` when you are done.

The unit tests run under Node in the root vitest run against a better-sqlite3 stand-in for D1. A local `wrangler dev` run is how Ed25519 signing on the real Workers runtime was checked: `POST /v1/activate` returned a 14-day Pro trial that `verifyLicenseSignature` accepted.

**The Worker fails open on rate-limiter errors.** If the `LIMITER` binding throws or rejects, the Worker logs `licensing-worker: rate limiter unavailable:` plus the error message (never the IP, headers or body) and lets the request through as if it were allowed; a `{ success: false }` answer still gets `429`. This matters locally: on a Windows machine with wrangler 4.149 every call to the rate-limit binding currently fails with `internal error` under `wrangler dev`, so local runs exercise that fail-open path (expect one "rate limiter unavailable" log line per request) and need no stub. It also means that on a deployed Worker a broken rate-limit binding silently disables rate limiting, so watch the logs for that line (the Setup section of the test-mode checklist checks it).

## Operations

- **Logs:** `npx wrangler tail --env test` (or without `--env`). The Worker logs messages only, never request bodies, licences or secrets.
- **Plan changes leave an old subscription to cancel by hand when something fails.** A superseded older subscription is cancelled only when the newer subscription's first charge arrives. If that cancel fails (it is logged as `could not cancel superseded subscription ...`) or the Worker dies between writing the licence and cancelling, the old subscription stays active in Razorpay and keeps charging. Cancel it by hand in the Razorpay dashboard. After any plan change, look through the Worker logs for "cancel" failures. A charge that does arrive on such an old subscription issues nothing: it is recorded with outcome `superseded` (Razorpay's webhook delivery view shows `{"outcome":"superseded"}`), the Worker tries the cancel again, and logs `could not cancel superseded subscription ...` if that fails too. Refund that charge in the dashboard.
- **Hand-issuing for an installation the service already knows is fine.** Make the licence with `tools/prepare-license.ts` from the counter's activation request as usual. The counter reports the new revision on its next check, and the service issues every later paid licence above it. If a paid licence from the service is still current when the counter reports the hand-issued one, the service re-signs the paid terms (plan, renewal date, grace) at a higher revision on that check, so a hand-issued extension longer than the paid period, or a different plan, may be replaced by the paid terms. A counter whose licence carries different licence, organisation or outlet ids from the ones the service stored gets no new licence; the Worker logs `activate: installation <id> reported identifiers that differ from the stored ones; nothing issued`.
- **Abandoned checkouts:** `/v1/subscriptions` creates a Razorpay subscription for every checkout attempt, so subscriptions that were opened and never paid pile up in the `created` state. They are harmless: they are never charged, and they never issue a licence. Clear them out of the dashboard whenever you like.
- **A webhook that Razorpay keeps retrying** means a `5xx` from D1 or signing; the log line starts `webhook <event id> failed`. Fix the cause and Razorpay's retry delivers the licence. Events for an installation the service has never seen are recorded as `unmatched` and answered `200`.
- **A counter that reports "The licensing service doesn't recognise this installation":** the Worker answered `401`, so the secret in that counter's `installation.json` differs from the one stored for its installation id. If the customer legitimately restored or replaced its data folder, re-pair it (see "The installation secret"). Otherwise treat it as someone else using that installation id.
- **Trial already used:** a second `/v1/activate` for the same installation id returns its existing licence or `null`, never a second trial. There is no way to grant another trial short of editing the database.
- **Key rotation:** a new signing key means a new public key in a new counter build. Counters on the old build report `rejected` (wrong key) until they are updated, and keep running on their current licence.
