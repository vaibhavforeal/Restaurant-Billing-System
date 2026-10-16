# API-controlled application features

User approved implementation of the feature-panel design. Work in the current checkout, preserving its captured dirty baseline in `.superpowers/feature-controls-2026-10-12`.

## Design

- Extend Marketplace with an authenticated feature catalog and admin-only API switches, persisted in SQLite. All staff can read effective availability; only admins configure it.
- Optional modules: takeaway creation, reservations, inventory management, recipes, dish costing, guest ordering, guest assistance, sales dashboard, reports; include existing Zomato/Swiggy/KDS switches in the catalog without duplicating their storage. Core billing, order completion, catalog, users, settings, backups and feature controls remain available.
- Preserve current defaults for installed modules. Licence entitlements remain a separate requirement. Recipes and costing depend on inventory; guest assistance depends on guest ordering. Dependencies determine effective availability without destroying saved preferences.
- Disable new operations, not historical data or completion of existing requests/orders. Inventory accounting continues for existing sales and recipes to protect ledger consistency. Guest menu browsing and receipt recovery remain available.
- GET `/api/features` and PATCH `/api/features/:id` return complete, uncached catalogs. Database revision prevents stale client updates. Existing integration routes remain compatible and publish their existing event.
- Shared React provider refreshes on feature/integration/licence changes and reconnection. Panel includes effective state, saved preference, lock/dependency explanations and recoverable request errors. Optional screens/actions respect effective state, retain existing drafts when disabled, and do not clear historic data.

## Implementation and acceptance

1. Add failing API regressions for defaults, roles, persistence, idempotency, dependencies, licence restrictions, recovery and disabled operations.
2. Implement domain registry, migration, server catalog APIs and operation guards. Preserve authentication before disabled-feature errors.
3. Add client state synchronization tests; implement provider, Marketplace section, navigation/screen/action gates and guest availability flags.
4. Run focused and complete tests, typecheck and desktop build. Exercise panel toggles and a second window against disposable fixtures. Inspect changed files against the baseline. Leave changes uncommitted unless requested.
