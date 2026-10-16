# Azure hosting implementation plan

**Goal:** Prepare the user's separate Ubuntu Azure host for the cloud portal/API and, following the user's explicit selection, the full restaurant POS.

**Architecture:** Caddy terminates HTTPS, the UI proxies same-origin API calls, and PostgreSQL has no published host port. One-time migration/bootstrap jobs receive separate credentials. The existing Windows outlet authority and rc-vm remain independent.

**User decisions:** Azure CLI access; separate Ubuntu VM authorized; domain undecided; email and object storage not configured yet.

- [x] Inspect Azure account and existing VM read-only.
- [x] Prepare production Compose, HTTPS routing, environment template and infrastructure-only bootstrap page.
- [x] Select an available 2 CPU/4GB Linux VM size and provision dedicated hosting resources.
- [x] Install Docker using Ubuntu packages; verify readiness and HTTPS on an Azure hostname.
- [x] Configure Azure Email, private Azure Blob Storage and secure API secrets.
- [x] Build/upload cloud images and migrate PostgreSQL with separate application credentials.
- [x] Bootstrap first operator and start production services after configuring integrations.
- [x] Verify HTTPS, login/session security, role restrictions, Azure email acceptance and private storage against the deployed environment.
- [ ] Pair the first restaurant and verify its synchronization/recovery workflow; complete subscription integration when needed.

Preserve all existing local changes. Never package local databases, signing keys or secrets for transfer. A public setup page is infrastructure verification only, not a product release. VM/disk/public-IP charges accrue while resources exist. Avoid opening database or API ports to the Internet.

## Initial investigation (superseded by the provisioning status below)

Azure account access verified. Existing `rc-vm` is Windows Server 2025 and remains the user's remote coding host. B2s is restricted in East US and unavailable in the checked Central US, East US 2, and South Central US results. D2als_v7 is available in East US with sufficient family/regional quota: 2 CPUs, 4GB RAM. Azure Retail Prices reports USD 0.0804/hour for Linux compute (about USD 59/month at 730 hours), plus Standard SSD and public IP costs. User's decision on this approximately USD 70/month alternative is pending; no hosting resources have been created.

Provisioning script: `deploy/cloud/provision-azure.ps1`. PowerShell syntax validation passed. Production and bootstrap Compose validation passed with disposable process-only inputs. Execution, container runtime and live HTTPS validation are pending. Docker Desktop's local engine was unavailable during preparation; no container startup is claimed.

## Lower-cost direction — October 13

The user declined D2als_v7 and requested cheaper alternatives. Central India B2pls_v2 is the best checked candidate: 2 ARM CPUs/4GB, approximately USD 25.28/month baseline including 64GB SSD and public IP. Its Bpsv2 quota is currently zero. No quota increase or VM provisioning has been submitted. See `docs/operations/hosting-cost-options.md` for pricing and compatibility evidence. Provisioning script supports Arm64 Ubuntu; complete ARM image/runtime verification remains pending.

## Available VM selected and provisioned — October 13

After the ARM quota request required MFA, the user explicitly chose the available Linux VM at approximately USD 70/month. Provisioned `forkflow-cloud` in `rg-forkflow-hosting`, East US, Standard_D2als_v7 (2 CPUs/4GB), Ubuntu 24.04 x64, 64GB Standard SSD. Static public IP: 4.157.250.215; hostname: forkflow-072db191.eastus.cloudapp.azure.com. Charges started with provisioning.

Dedicated SSH key stored locally at `C:/Users/mivhaan/.ssh/forkflow-hosting_ed25519`; private key was never transferred. Server host key was obtained through Azure Run Command and pinned in `forkflow-hosting_known_hosts` before SSH. NSG allows SSH only from 20.157.84.139/32 and public web ports 80/443. No PostgreSQL/API ports are published. Existing rc-vm unchanged.

Cloud-init completed. Docker 29.1.3 and Compose 2.40.3 installed from Ubuntu packages. Source archive (184 selected cloud source/manifests/deployment files, no local databases/keys/secrets) transferred to `/opt/forkflow/source`; SHA-256 matched on both ends. HTTPS bootstrap Caddy obtained a Let's Encrypt certificate; a normal certificate-validating HTTPS request returned the expected setup-page HTTP 503. API/UI images built successfully on the x64 server; Argon2 password hash/verification succeeded in the API image.

PostgreSQL 17 is healthy, with schema versions 1, 2 and 3 applied. The application login has no superuser, create-role, create-database or bypass-RLS privileges and owns no application tables. All seven tenant tables enforce row security. Database passwords were generated on the VM and the server-only environment file has mode 600. Host sockets expose SSH/HTTP/HTTPS only; PostgreSQL has no host port mapping.

### Azure integrations and portal launch

The user selected Azure for app email/storage and `founder@billnroll.in` as the platform administrator. This mailbox remains with BigRock; no mailbox settings or DNS/MX records were modified. Added provider-selectable adapters using Azure Communication Services Email and private Azure Blob Storage while preserving the existing HTTP-mail/S3 options.

Provisioned `forkflow-email` with a verified Azure-managed sender domain, linked `forkflow-communication`, and `forkflow072db191` Standard LRS Blob storage with the private `forkflow-private` container. Resource credentials were transferred through SSH stdin into the mode-600 server environment, never printed or committed. Email/storage incur usage charges beyond the VM baseline.

All 45 cloud API tests passed, including new Azure SDK boundary and configuration tests. TypeScript verification and cloud bundling passed. Rebuilt API image on the VM. Live Blob verification passed actual upload/checksum verification, incorrect-checksum rejection, ETag-conditional promotion, signed download, anonymous-read denial and cleanup of verification objects.

Bootstrapped the platform administrator with a server-generated random password, then removed bootstrap configuration. Production PostgreSQL/API/UI/Caddy are running; the bootstrap Caddy service is stopped with its volumes preserved. Normal HTTPS returns the portal with HTTP 200 and `/health` returns the cloud service health response. An isolated temporary account verified login, secure/HttpOnly session cookies, authenticated session lookup, denial of platform and unauthorized outlet access, logout and session invalidation; the account was deleted afterward.

At the user's explicit request, the real reset endpoint sent a password-setup email to `founder@billnroll.in`; Azure returned successful acceptance. Link expiration: 2026-10-13 18:22:53 UTC. Inbox receipt is not independently confirmed. Screenshot: `docs/screenshots/azure-portal-login.png`.

The first real restaurant is not paired yet. Licensing/subscription checkout is not configured. Complete off-VM PostgreSQL backup and restore verification before onboarding customers; Azure object storage availability does not itself establish a database backup schedule.

### Full POS deployment correction

The user reported that the hosted page did not show the UI changes and explicitly selected full restaurant POS on Azure. The initial deployment served apps/cloud-ui, a separate owner portal; the requested desktop-style screens are in apps/ui. Added an explicit hosted POS runtime/image, persistent SQLite data, same-origin gateway with selected-owner cloud session protection, and owner-portal routing at /owner/. Existing invitation/password-reset URLs remain usable.

The actual POS image was built and started on the Azure VM. HTTPS root redirects unauthenticated visitors securely to owner sign-in; authorized owner requests return ForkFlow POS and its fresh setup screen. An unrelated account is denied by targeted tests. Public POS health works and anonymous business API calls return 401 JSON. Downloaded production JS/CSS through the authenticated public endpoint; both SHA-256 hashes exactly match the updated local build. A real restart preserved outlet identity. Browser setup screenshot is docs/screenshots/azure-full-pos-setup.png; no browser warning/error logs.

Verification: 99 targeted tests passed, main/cloud-UI TypeScript and both UI/server builds passed. Nginx configuration validated after fixing relative HTTPS redirects and JSON API auth failures. No existing credentials were reset. A ten-minute QA session for the selected owner was removed after verification. Production has no demo records; restaurant/admin-PIN setup remains for the user. Off-VM PostgreSQL plus SQLite backup/restore and local printer connectivity remain unconfigured. Hosted billing needs Internet access and is one restaurant, not a multi-tenant POS runtime.
