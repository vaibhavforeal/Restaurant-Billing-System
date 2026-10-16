# Owner restaurant feature controls

User approved moving feature control to a private central owner panel, with restaurant staff unable to override settings. Reuse Cloudflare licensing Worker, installation-secret authentication and Ed25519 build key. No deployment or commit requested.

1. Domain: strict, signed policy schema scoped to organization/outlet/installation, monotonic revision. Central defaults match existing module defaults. SQLite cache includes signed envelope, validated on every server start.
2. Worker: D1 restaurant policy, owner sessions and audit migrations. Private /owner panel, owner secret login, hashed expiring HttpOnly Secure SameSite cookies, same-origin mutation checks, rate limiting. Restaurant list grouped by outlet; names editable, feature toggles with optimistic revision checks and change history. Installation-secret /v1/features returns signed settings for the caller's outlet only.
3. Server: authenticate and validate policy signature and all identity fields; reject revision rollback/conflicting same revisions. Poll immediately after license activation and every minute, cache atomically and broadcast effective settings. Offline uses last verified policy. Commercial integrations derive availability from policy, never local preference. Staff PATCH feature/integration APIs deny changes; demo development integration fixtures retain legacy setup API only. Remove staff switches from UI.
4. Tests: owner access, cross-outlet isolation, stale updates, signed settings, tampering/replay, cache restart/offline, staff override denial, existing feature gates/recovery. Run full tests, typecheck/build, private panel browser smoke with disposable fixtures. Document deployment secrets/migrations and offline timing.

Preserve unrelated working-copy edits. Changes remain uncommitted.
