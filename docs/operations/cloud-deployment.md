# Cloud setup and release verification

The cloud API runs independently from the outlet. Run PostgreSQL migrations with a migration principal, then run the API using the restricted `forkflow_cloud_app` account created by the migration command. Startup refuses table owners, superusers, bypass-RLS roles, missing forced tenant policies, and incompatible schema versions.

## Local dependencies

Set `CLOUD_DEV_DATABASE_PASSWORD`, `CLOUD_DEV_STORAGE_USER`, and `CLOUD_DEV_STORAGE_PASSWORD` in your local environment. Start `docker compose -f deploy/cloud/compose.dev.yml up -d`. PostgreSQL is on loopback port 54329; MinIO is on 9000 with its console on 9001. Create a private `forkflow` bucket through the console. Keep the named volumes between runs.

Set `CLOUD_MIGRATION_DATABASE_URL` to the migration connection and `CLOUD_APP_PASSWORD` to a fresh password of at least 16 characters. Run `npm run migrate -w @forkflow/cloud-api`. Set `CLOUD_ADMIN_EMAIL` and `CLOUD_ADMIN_PASSWORD`, then run `npm run bootstrap-admin -w @forkflow/cloud-api`. Bootstrap creates the first operator only; it never replaces an existing password or promotes an existing account. Clear bootstrap and migration credentials from the API process environment afterward.

For API startup configure:

- `DATABASE_URL`: restricted application connection.
- `PORTAL_ORIGIN`: `http://localhost:4300` locally; the public HTTPS origin in staging.
- `CLOUD_COOKIE_INSECURE=true`: local development only.
- `MAIL_DELIVERY_URL`, `MAIL_DELIVERY_TOKEN`: authenticated delivery endpoint accepting `{to,kind,url,expiresAt}`. It must deliver invitation/reset links; use a local capture service for development.
- `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`: storage configuration.
- `S3_ENDPOINT=http://127.0.0.1:9000`, `S3_FORCE_PATH_STYLE=true`: local MinIO only.
- Optional `LICENSING_BASE_URL` and `LICENSING_SERVICE_TOKEN`: configure together for subscription checkout.

Run `npm start -w @forkflow/cloud-api` and `npm run dev -w @forkflow/cloud-ui`. The portal proxies `/v1` to port 4200. Customer/outlet creation and invitation occur through Platform administration after signing in as the bootstrapped operator.

## Container release

Build from the repository root with `docker build -f deploy/cloud/Dockerfile.api -t forkflow-cloud-api .` and `docker build -f deploy/cloud/Dockerfile.ui -t forkflow-cloud-ui .`. Run the API with external environment/secrets; name its service `api` on the UI container network. Put the UI behind an HTTPS ingress and use that exact origin for `PORTAL_ORIGIN`. The UI container routes `/v1` to the API and serves SPA invitation/reset paths. Never expose PostgreSQL or storage administration publicly.

The API container includes `runtime/src/migrate.mjs` and `runtime/src/bootstrap-admin.mjs` for explicit one-time jobs with separate credentials. Run them before the ordinary API container. Keep database migration credentials out of the runtime deployment.

`node tools/build-cloud.mjs` bundles all three entry points, copies SQL migrations, and rejects outlet-server, Electron, and SQLite runtime imports. `SIGINT`/`SIGTERM` close Fastify and the database pool. Container image build/start and real storage/mail delivery still require Docker/staging verification; a successful JavaScript bundle does not establish those gates.

Before release verify two-customer isolation, invitation/reset delivery, pairing/revocation, initial upload under active billing, duplicate uploads, report parity, edit conflicts, private backup upload/download, recovery, and subscription checkout. Record 15-second normal synchronization, clean Windows service installation, actual printers, and the 24-hour internet outage separately. Keep Electron available until those outlet gates pass.

## Ubuntu VPS production deployment

Production files are under `deploy/cloud`: `compose.prod.yml`, `Caddyfile`, and `.env.example`. Use the Compose commands from the repository root with `--env-file deploy/cloud/.env -f deploy/cloud/compose.prod.yml`. The database/API/UI have no public port mapping; Caddy publishes 80 and 443 and obtains certificates for `PORTAL_DOMAIN`. Point that hostname at the VPS before starting Caddy. Keep port 80 available for ACME and HTTPS redirects.

Generate two different database passwords using `openssl rand -hex 32`, put them in the server-only `.env`, and restrict it with `chmod 600`. Hex passwords can safely be included in the PostgreSQL connection URLs assembled by Compose. Do not use the disposable local Docker credentials. Configure either the authenticated HTTP mail adapter and private S3/R2 storage, or the Azure Email/Blob adapters documented below. Restic does not satisfy object upload/download.

1. Build: `sudo docker compose --env-file deploy/cloud/.env -f deploy/cloud/compose.prod.yml build api ui`.
2. Start PostgreSQL: the same Compose prefix followed by `up -d postgres`.
3. Migrate: append `--profile setup run --rm migrate`.
4. Bootstrap the first platform admin: supply `CLOUD_ADMIN_EMAIL` and a unique `CLOUD_ADMIN_PASSWORD` only for `--profile setup run --rm bootstrap-admin`, then remove the bootstrap fields.
5. Start the app: append `up -d api ui caddy`. Verify `/health`, login, invitations/reset, pairing, scopes and storage against HTTPS.

If integrations are not ready, `compose.bootstrap.yml` with `Caddyfile.bootstrap` serves an explicit setup-only HTTP 503 page. It needs only `PORTAL_DOMAIN`; it does not pretend that the cloud API is ready. Stop that Compose project before starting production because both publish 80/443.

Keep PostgreSQL/Caddy volumes across deployments. Never use `docker compose down -v` during updates. Back up PostgreSQL consistently with `pg_dump`, encrypt it and copy it off the VM; verify a restore before onboarding customers. A VM snapshot is not a tested application restore. Hosting on one VM is a starting deployment with one failure domain.

### Current Azure host — October 13, 2026

- VM: `forkflow-cloud`, resource group `rg-forkflow-hosting`, East US.
- Size: Standard_D2als_v7, Ubuntu 24.04 x64, 2 CPUs, 4GB RAM, 64GB Standard SSD.
- Public URL: https://forkflow-072db191.eastus.cloudapp.azure.com; static IP `4.157.250.215`.
- Deployment directory: `/opt/forkflow/source`; environment: `deploy/cloud/.env` (server-only, mode 600).
- Images built: `forkflow-cloud-api:local`, `forkflow-cloud-ui:local` and `forkflow-pos:local`.
- PostgreSQL migrations 1–3 applied; restricted runtime login and forced tenant row security verified.
- Running services: PostgreSQL, production cloud API/owner UI, POS, routing gateway and HTTPS Caddy. Setup-only Caddy is stopped.
- Platform administrator: `founder@billnroll.in`; password setup sent by Azure Email. The mailbox remains at BigRock.
- Storage: private Azure Blob container `forkflow-private` in account `forkflow072db191`.
- App email: `forkflow-communication`, linked to the verified Azure-managed domain in `forkflow-email`.
- Estimated baseline: approximately USD 70/month before taxes and usage. Charges began when provisioned.

Connect from the authorized Windows computer using its dedicated key and pinned host record:

```powershell
$hostingKeyPath = Join-Path $env:USERPROFILE '.ssh/forkflow-hosting_ed25519'
$hostingKnownHostsPath = Join-Path $env:USERPROFILE '.ssh/forkflow-hosting_known_hosts'
ssh -i $hostingKeyPath -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$hostingKnownHostsPath" forkflow@forkflow-072db191.eastus.cloudapp.azure.com
```

SSH is restricted to `20.157.84.139/32`; update the NSG allow rule if this computer's public egress IP changes. Keep the private key local. Bootstrap values have been removed; bootstrap refuses to modify an existing administrator. Use the portal's password-reset workflow if needed. The full hosted POS still needs its first restaurant/admin-PIN setup. Subscription checkout requires licensing configuration.

### Full restaurant POS on this Azure VM

At the user's request, the main URL now serves `apps/ui`, the actual desktop-style restaurant POS. The separate owner portal lives at `/owner/`. Both use the same HTTPS origin; `/v1/` remains the cloud API and `/api/` is the restaurant service. Existing `/reset` and `/invite` email links remain valid. A cloud login returns to the POS when entered through the main URL.

This deployment uses **both** Compose files. Run all production operations from `/opt/forkflow/source` with this prefix:

```sh
sudo docker compose --env-file deploy/cloud/.env -f deploy/cloud/compose.prod.yml -f deploy/cloud/compose.pos.yml
```

Append `build api ui pos` and then `up -d` for releases. Append `ps` or `logs --tail 100 pos` for status. Using only the base file would revert the routing to the owner portal. Set `HOSTED_POS_EMAIL` to the existing owner authorized for this one restaurant. The gateway checks a valid cloud session belonging to that exact active account before serving POS pages, assets, API calls and WebSocket handshakes; a valid unrelated account does not gain access. The POS then uses its existing staff PIN/role controls. Health endpoints remain public. No additional host ports are exposed.

The POS runs in explicit `hosted-pos` mode with its packaged UI and persistent data at `/data/restaurant`, in the `forkflow_pos_data` volume. The extra directory allows its data lock to be created without giving the container root filesystem write access. Restaurant identity survived a real container restart. Never remove the POS volume when updating. The initial restaurant database is fresh: sign in as the founder, then enter the restaurant name, admin name and a new admin PIN in the setup screen. No demo records or admin PIN were inserted into production.

The hosted JavaScript and CSS were downloaded through the authenticated HTTPS gateway and matched the current local production build byte for byte. The current build includes compact colored Users & Roles, permission checkboxes, reduced Reports padding and Analytics beside Zomato reconciliation. Live browser setup screenshot: `docs/screenshots/azure-full-pos-setup.png`. Owner access denial, normal HTTPS redirects, POS setup and container restart were checked; the browser reported no warning/error logs. Targeted cloud/auth/users/billing/runtime tests: 99 passed. This confirms deployment and startup, not completed restaurant setup or physical-printer acceptance.

This is a single hosted restaurant, not a shared POS database for multiple cloud tenants. Billing authority is now on Azure, so new writes need Internet connectivity; a cached UI is not an offline outlet service. A cloud container cannot reach a counter's USB/Bluetooth printers or private LAN printers without a local bridge/network arrangement. Windows service administration and Captain certificate-installation tools are not hosting setup tools. Keep local outlet deployments separate until synchronization/recovery is deliberately configured.

PostgreSQL backups and consistent SQLite backups must both be scheduled off this VM and restore-tested before live restaurant use. Azure Blob availability alone does not back up the POS volume, and the outlet Restic workflow has not been configured for this Linux container. Do not describe the deployment as a verified offline/printer/backup production release until these checks pass.

### Azure Email and Blob configuration

Select `MAIL_PROVIDER=azure` with `AZURE_EMAIL_ENDPOINT`, `AZURE_EMAIL_ACCESS_KEY`, and `AZURE_EMAIL_SENDER`. Select `STORAGE_PROVIDER=azure` with `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_KEY`, and `AZURE_STORAGE_CONTAINER`; the normal Azure endpoint is derived from the account name. `AZURE_STORAGE_ENDPOINT` is an optional override that must use HTTPS in production. The original providers remain the defaults (`http` and `s3`). Azure deployments do not need S3 or HTTP-mail credentials.

The current sender is `DoNotReply@309b3e98-e14e-4589-aa27-2a190d9c616d.azurecomm.net`. Sending from `billnroll.in` requires separate Azure domain verification records; it does not require moving the BigRock mailbox or replacing MX records. Azure Email success means service acceptance, not guaranteed inbox receipt. Check spam/quarantine and delivery status when investigating missing mail.

Blob upload links permit creation of only the requested staging blob for 15 minutes; download links permit reads of one blob for 5 minutes. The service verifies actual bytes and length under an ETag before promotion. The container disallows public anonymous access. Live checks passed with verification objects removed. Run `tools/verify-cloud-storage.mts` only with the configured runtime environment when repeating a storage check; it prints no credentials or signed URLs.

Cloud API validation: 45 tests passed, TypeScript and cloud build passed, live HTTPS/session/role-denial/logout checks passed. First restaurant pairing, end-to-end backup recovery, off-VM PostgreSQL backup/restore and subscription checkout remain separate release work. Email and Blob storage add usage-based Azure charges.
