# ForkFlow web migration implementation ledger

The approved seven-phase implementation plan is in the current conversation. This ledger records execution and release gates; it is not a claim that the product is release-ready.

## Baseline and rulings

- Original changes saved outside the repository in `Research & Docs/web-migration-2026-10-12`: tracked binary diff, status, and copies of untracked source files.
- Ruling: preserve and extend the existing `codex/audit-remediation` checkout, since the approved architecture depends on uncommitted feature/permission work. No reset, stash, bulk commit, or clean is permitted.
- Ruling: retain Electron until clean-machine service, real printer, and outage acceptance gates pass.
- Ruling: integration boundaries use a versioned, allowlisted row-change journal; cloud never re-executes billing actions.
- Ruling: no live cloud deployment, machine-wide service installation, certificate trust changes, firewall changes, or reboot is part of local verification.

## Workstreams

- [ ] Contracts and application boundaries; baseline checks.
- [ ] Windows outlet service packaging and runtime.
- [ ] Cloud accounts, PostgreSQL isolation, pairing, projections, command API.
- [ ] Outlet transactional journal, bootstrap, synchronization, management application.
- [ ] Cloud portal and browser shell resilience.
- [ ] Backup/recovery, rollout, end-to-end verification.
- [ ] Independent code review and release runbooks.

## External acceptance gates

Production credentials/domain, signed release artifacts, clean Windows installation, actual printer transports, and a real 24-hour disconnected-operation rehearsal require a configured staging/hardware environment. Keep these visibly pending until verified.

## Continuation verification — 2026-10-12

- CC plugin installation cancelled by the user; migration continued in the preserved checkout.
- Full regression run: 169 files / 1,601 tests passed. Focused migration run: 14 files / 78 tests passed, including PostgreSQL reports/isolation, journal, synchronization, commands, recovery, storage, and portal contracts.
- Outlet and cloud UI builds passed; root and cloud UI type checks passed. Outlet packaging/update tests: 14 passed. Signed packaged Node/native SQLite status, backup, restore and full-store migration smoke passed using disposable data and a nonexecutable WinSW fixture.
- Cancellation report fractional menu estimates are preserved by the current code. Corrected backup validation coverage to distinguish inconsistent manifest (400) from a consistent manifest conflicting with its upload ticket (409).
- Found and supplied missing cloud `main.ts` and `bootstrap-admin.ts` entry points. Startup validates the restricted PostgreSQL role/schema before listening and closes Fastify/pool on shutdown. First-operator bootstrap uses an advisory transaction lock and refuses existing accounts/operators. Three new tests passed; subsequent complete cloud suite: 6 files / 40 tests passed.
- Added cloud bundle builder with outlet-runtime import guard, API/UI Dockerfiles, local PostgreSQL/MinIO Compose dependencies, and `docs/operations/cloud-deployment.md`. All cloud entry points bundle; bundled startup reaches its missing-configuration guard without module-load errors. Compose configuration validates.
- Docker CLI is present but the Linux Docker daemon is unavailable. Container builds/startup, actual MinIO/R2/mail delivery and deployed HTTPS remain unverified. Existing browser workflow evidence comes from the earlier chat; no new browser acceptance run is claimed here.
- Release remains pending: independent final review, container/staging acceptance, actual WinSW install/boot, printer transports, 24-hour disconnected operation, and normal-connectivity synchronization latency. Electron remains available pending these gates.

## Docker verification — 2026-10-12

- Docker Desktop Linux engine operational. PostgreSQL 17 container passed readiness, table write/read, and data preservation after restart.
- API/UI images built successfully after disabling workspace install scripts in build stages to avoid unnecessary outlet SQLite compilation. Runtime Argon2 hashing verified inside the API image.
- Packaged cloud migration command applied schema to the isolated PostgreSQL container. API started with the restricted application role and passed startup schema/RLS validation.
- Nginx configuration passed; portal `/` and invitation SPA route returned HTTP 200. `/v1/auth/me` routed through Nginx to API and returned the expected unauthenticated 401.
- Test containers `forkflow-postgres-test`, `forkflow-api-test`, and `forkflow-ui-test` were stopped after checks. Images and disposable test state are retained. No live storage or email service was used; their integration remains pending.

## Preserve existing POS UI — 2026-10-12

- User requested the established screenshot UI in the new architecture. Confirmed the installed outlet bundle already copies `apps/ui/dist`, preserving the original React screens and styles.
- Added `npm run start:pos`: builds that same UI and launches the current outlet server with loopback browser-preview defaults on port 4110 and isolated `.forkflow/browser-outlet` state. Existing desktop server/data are not replaced.
- Runtime defaults/loopback protection, outlet identity and offline-shell tests passed: 19 tests. Root/UI type checks and original POS build passed. Preview started successfully; initial restaurant setup is required for its separate database.
- Launch/use instructions recorded in `docs/operations/browser-pos.md`. Cloud portal remains a separate remote-management application; restaurant POS uses the preserved UI.
