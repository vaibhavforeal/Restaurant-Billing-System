# ForkFlow licensing service and portal

A Cloudflare Worker with a D1 database. It does four jobs:

- **`POST /v1/enroll`** activates a counter. At setup (or later from Settings > Plan and devices) the restaurant types the **Customer ID** and **Order ID** from ForkFlow's setup card. The order must belong to that customer and be paid, approved on credit, or a trial. The counter takes one of the order's seats and gets the order's licence; the term counts from that moment.
- **`POST /v1/activate`** is every counter's hourly check. It hands back a newer licence when there is one (a renewal, a module change, a staff adjustment). It records when the counter was last seen and which version it runs. There are no automatic trials any more: a counter that has not enrolled gets `{ "license": null, "enrolled": false }`, and nothing is written.
- **`POST /webhooks/razorpay`** turns a paid Razorpay **payment link** into a recorded payment. When that payment completes its order, the order is fulfilled: licences extended, tax invoice issued, other open links cancelled.
- **`/portal`** is the ForkFlow Portal: the web app staff use for leads, customers, orders, payments, GST invoices, counters, renewals, support tickets and reports. It is served from Workers Static Assets with its API under `/portal/api`. How staff use it is in `docs/operations/vendor-portal.md`.

The counter app never talks to Razorpay. It only asks this service for a licence, and it verifies the Ed25519 signature with the public key baked into its build, exactly as it does for a licence imported by hand.

Nothing under `apps/server`, `apps/ui`, `packages/domain` or `packages/core` imports this package. Worker source uses only WebCrypto, `fetch`, `Request`/`Response` and the interfaces in `src/env.ts`. The portal web app (`apps/portal`) imports only `src/portal/api-types.ts` and `src/portal/shared.ts`.

> [!IMPORTANT]
> **The portal needs Cloudflare Workers Paid** (about $5 a month). Workers Free allows 10 ms of CPU per request. Staff sign-in hashes the password with PBKDF2 at 100,000 iterations, about 23 ms. An invoice PDF takes 20 to 80 ms. Both would be cut off on the free plan. Licensing alone (`/v1/*`) fits in the free plan.

## The installation secret

An installation id alone is not proof of who is asking: it appears in activation requests and licence files that get emailed around. So each counter also holds a secret.

- On first start the counter generates 32 random bytes (64 lowercase hex characters) and stores them in `installation.json` next to the installation id, in its data folder. Back this file up with the rest of the data folder.
- The counter sends it in the `X-ForkFlow-Installation-Secret` header on `POST /v1/enroll` and `POST /v1/activate`. A request without a well-formed secret gets `401 { "error": "unauthorized" }` and nothing is written.
- Trust on first use: the Worker stores only the SHA-256 of the secret (`installations.secret_hash`). A counter's row is created when it first enrols with a valid Customer ID and Order ID, so a stranger guessing installation ids gets nothing. Every later request must present the same secret, or it gets `401` and changes nothing. The secret is never logged or echoed.
- **Re-pairing a counter** (the restaurant restored or replaced `installation.json`, so the counter now holds a different secret for the same installation id): in the portal, open the customer's **Counters** tab, then the counter, then **Reset pairing**. Support or an admin can do this. The next check-in from that counter claims it again. Do it only for a counter you have verified is the customer's; until the counter checks in, whoever asks first becomes its owner.
- **A counter activated offline** (from an activation request file, in the portal) has no secret stored yet. Its first check-in claims it the same way.

## What you need

- A Cloudflare account on **Workers Paid**, and `npx wrangler@4` (never install it into the repo). Run `npx wrangler login` yourself, once.
- A Razorpay account. Start in **test mode** (test keys). Repeat everything in live mode only after the checklist in `docs/licensing-service-test-mode.md` passes.
- **Two separate Ed25519 key pairs: one for test, one for production.** The production pair is the one your commercial builds already trust (or make one). Always make a new pair for test:

  ```powershell
  # Production (skip if your commercial builds already trust a pair)
  openssl genpkey -algorithm ed25519 -out C:\secure\license-private.pem
  openssl pkey -in C:\secure\license-private.pem -pubout -out C:\secure\license-public.pem
  # Test: a different pair, used for nothing else
  openssl genpkey -algorithm ed25519 -out C:\secure\license-test-private.pem
  openssl pkey -in C:\secure\license-test-private.pem -pubout -out C:\secure\license-test-public.pem
  ```

  Each private key goes only into the `LICENSE_SIGNING_KEY` secret (PKCS#8 PEM) of its own Worker: the test key into the test Worker, the production key into the production Worker and nowhere else. Each public key goes into the counter builds for that environment (see step 8). A build whose public key does not match a Worker's signing key is told `409 wrong_key`.

> [!WARNING]
> **Never load the production signing key into the test Worker.** Anyone with portal access on the test Worker can issue orders and licences. If it signed with the production key, those licences would work on production counters. With a separate test key, a licence from the test Worker only works in test builds.

## Environments

`wrangler.jsonc` defines two Worker environments. They share nothing:

| | Test | Production |
| --- | --- | --- |
| Deploy | `npx wrangler deploy --env test` | `npx wrangler deploy` |
| Database | `forkflow-licensing-test` | `forkflow-licensing` |
| Razorpay keys | test mode | live mode |
| Signing key (`LICENSE_SIGNING_KEY`) | `license-test-private.pem` | `license-private.pem` |
| Counter builds that use it | test builds (test public key) | production builds (production public key) |
| Portal staff accounts | their own | their own |

Wrangler does not inherit secrets or rate limits between environments, so every step below is done once per environment. The `assets` block is inherited. Add `--env test` to each command for the test environment; leave it off for production.

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

Run this again whenever a new file appears under `migrations/`, before deploying the Worker that needs it. `0004` to `0007` add the portal: staff, customers, orders, payments, invoices, leads, follow-ups and tickets. They also drop the old self-serve subscription tables.

## 3. Set the secrets

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

`RAZORPAY_WEBHOOK_SECRET` is a string you choose, different per environment; you enter the same string in the Razorpay webhook settings in step 7. Without Razorpay keys the portal still works: staff record payments by hand, and **Send payment link** says Razorpay isn't set up. Secrets live only in Cloudflare: never put them in the repo, in `wrangler.jsonc`, in a counter build or in browser code.

## 4. Build the portal

The Worker serves the portal from `apps/portal/dist`, so build it before every deploy:

```powershell
cd ..\..
npm.cmd run build -w @forkflow/portal
cd apps\licensing-worker
```

## 5. Deploy

```powershell
npx wrangler deploy --env test
npx wrangler deploy
```

Wrangler prints the Worker's URL (`https://forkflow-licensing-test.<account>.workers.dev` for the test environment, or a custom domain you attach). The counter requires HTTPS. The portal is at `https://<worker-url>/portal/`.

**A separate hostname for the portal is worth it.** For example, attach `portal.<your-domain>` and `licence.<your-domain>` to the same Worker. Staff cookies then live on a host that counters and Razorpay never use. Point counter builds at the licence hostname.

The test Worker is only for test runs. Afterwards, take it off the internet: delete it (`npx wrangler delete --env test`), or add `"workers_dev": false` to the `env.test` block of `wrangler.jsonc` and deploy it again.

## 6. Create the first admin

Staff accounts live in D1. The first admin is created from your PC, so the password never travels to the Worker in clear and no bootstrap secret is needed:

```powershell
node --import tsx tools\portal-create-admin.ts you@forkflow.in "Your Name"
```

It asks for the password twice (not shown on screen, at least 10 characters) and prints a `wrangler d1 execute` command with the hashed password. Run that command from `apps\licensing-worker`:
- For the test Worker, use `forkflow-licensing-test` with `--env test`.
- For `wrangler dev`, use `--local` instead of `--remote`.

Sign in at `/portal/`. Then go to **Settings** and fill in:
- the seller details: ForkFlow's legal name, GSTIN, address and state;
- the invoice wording;
- the price list.

Add the rest of the staff under **Staff**.

## 7. Point the Razorpay webhook at the Worker

In the Razorpay dashboard (matching mode) open Settings, then Webhooks, and add:

- URL: `https://<worker-url>/webhooks/razorpay`
- Secret: the `RAZORPAY_WEBHOOK_SECRET` you set above
- Events: `payment_link.paid`, `payment_link.partially_paid`, `payment_link.cancelled`, `payment_link.expired`

`payment_link.paid` records the payment against the link's order, once per Razorpay payment id. When the order is then paid in full it is fulfilled in the same batch. The other events only update the link's status.
- A request with a bad signature gets `400` and writes nothing.
- A duplicate event id gets `200 {"outcome":"duplicate"}`.
- A link the portal never created is recorded as `unmatched`.

## 8. Build the counter against the service

The service URL is baked into commercial builds next to the public key, like the key itself. HTTPS is required. A build's public key and service URL always belong to the same environment.

Production builds (the ones you ship) embed the production public key and the production Worker's URL:

```powershell
$env:FORKFLOW_LICENSE_PUBLIC_KEY = Get-Content 'C:\secure\license-public.pem' -Raw
$env:FORKFLOW_LICENSE_SERVICE_URL = 'https://<production-worker-url>'
npm.cmd run package:commercial
```

Test builds (never given to a restaurant) embed the **test** public key and the test Worker's URL:

```powershell
$env:FORKFLOW_LICENSE_PUBLIC_KEY = Get-Content 'C:\secure\license-test-public.pem' -Raw
$env:FORKFLOW_LICENSE_SERVICE_URL = 'https://<test-worker-url>'
npm.cmd run package:commercial
```

Clear both variables (or open a new terminal) between a test build and a production build.

A build without `FORKFLOW_LICENSE_SERVICE_URL` never contacts the service. Setup then goes straight to the admin step, and the licence comes as a file from the portal (**Activate a counter without internet** on the order). When running the server from source, set the same variable; plain `http://127.0.0.1` is accepted there, never in a packaged build.

A counter asks for its licence when the server starts, every hour, and when an admin presses **Check for renewal** in Settings > Plan and devices. Billing never depends on the answer.

## Running it locally

```powershell
npm.cmd run build -w @forkflow/portal
cd apps\licensing-worker
npx wrangler d1 migrations apply forkflow-licensing --local
npx wrangler dev --port 8799
```

Use port 8799. Another local service already uses 8787 on the ForkFlow build PC.
- `wrangler dev` reads `.dev.vars`, which holds the secrets above under the same names. Use a throwaway signing key and dummy Razorpay values.
- Create the first admin with `tools/portal-create-admin.ts` and `--local`.
- For work on the portal screens, run `npm.cmd run dev -w @forkflow/portal` too. Vite serves the app with hot reload and passes `/portal/api` to the Worker on 8799.

Both `.dev.vars` and `.wrangler/` are gitignored; keep it that way. Never commit `.dev.vars`, a key, or a `database_id` from a local run.

The unit tests run under Node in the root vitest run against a better-sqlite3 stand-in for D1 that applies the real migrations. A local `wrangler dev` run is how the Workers runtime itself was checked:
- the migrations on real D1, including the dropped columns and the rebuilt `licenses` table;
- Ed25519 signing at enrolment;
- PBKDF2 sign-in at 100,000 iterations;
- the invoice PDF from pdf-lib;
- the portal served from static assets with its CSP.

**The Worker fails open on rate-limiter errors.**
- If the `LIMITER` or `LOGIN_LIMITER` binding throws or rejects, the Worker lets the request through as if it were allowed. For `LIMITER` it also logs `licensing-worker: rate limiter unavailable:` plus the error message (never the IP, headers or body). A `{ success: false }` answer still gets `429`.
- Staff sign-in has a second guard that does not depend on the binding: five wrong passwords lock the account for 15 minutes.
- On a Windows machine with wrangler 4.149, every call to the rate-limit binding currently fails under `wrangler dev`, so local runs take the fail-open path.

## Operations

- **Logs:** `npx wrangler tail --env test` (or without `--env`). The Worker logs messages only, never request bodies, licences, passwords or secrets.
- **A counter on a new computer (reinstall):** the old computer still holds the order's seat, so the new one is told "Every outlet on this order is already set up".
  - In the portal, open the old counter and choose **Release seat**. The restaurant then enters the IDs again on the new computer.
  - The old computer's licence is signed and offline, so it keeps working until its end date. The activity log records the release with that date.
- **A webhook that Razorpay keeps retrying** means a `5xx` from D1 or signing; the log line starts `webhook <event id> failed`. Fix the cause and Razorpay's retry records the payment.
- **A payment link paid while another link for the same order was still open:** the Worker cancels the other link. If that cancel fails, the log says `could not cancel payment link ...` and the link simply expires after 15 days. A second payment on it would be recorded as an overpayment on the order; refund it in the Razorpay dashboard.
- **Hand-issuing with `tools/prepare-license.ts`** still works for a counter the service knows. The counter reports the new revision on its next check, and the service issues every later licence above it. Prefer the portal: an order's **Activate a counter without internet**, or a counter's **Change this licence**. Both keep the customer, order, devices and modules in the licence and in the activity log.
- **A counter that reports "The licensing service doesn't recognise this installation":** the Worker answered `401`, so the secret in that counter's `installation.json` differs from the stored one. If the customer legitimately restored or replaced its data folder, reset the pairing in the portal. Otherwise treat it as someone else using that installation id.
- **Key rotation:** a new signing key means a new public key in a new counter build. Counters on the old build report `rejected` (wrong key) until they are updated, and keep running on their current licence.
