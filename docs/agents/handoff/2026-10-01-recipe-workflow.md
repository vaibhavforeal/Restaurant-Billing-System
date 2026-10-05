# Recipe workflow redesign

Implemented the approved Inventory → Stock / Recipes split. Recipes use a
searchable menu-item list and one editor, with a list/detail mobile flow.
Ingredient picking excludes archived and selected items. Missing stock items
can be created in a native dialog without discarding the recipe draft.

kg/L stock defaults to g/ml entry, with conversion to stored stock units,
normalized dirty checks, unit switching and field-level precision errors.
Storage remains in thousandths: whole g/ml for kg/L stock. Saving keeps the
editor open and updates its baseline. Basic single ingredients use the existing
stock-link endpoint; Pro uses the recipe endpoint. Cashiers and Basic multiple
ingredient recipes are read-only. No domain schema, migration, ledger or server
endpoint behavior changed.

Draft guards cover products, tabs, mobile Back, application navigation, logout
and browser unload. Saves and stock creation block leaving. Failed loads have
retry; failed reloads preserve but disable the stale draft. Conflicts offer
confirmed reload. Live updates refresh clean recipes and retain dirty drafts.
Stock creation retains its client reference across failed/lost-response retries.

Validation: TypeScript checks and UI build passed; 18 tests passed across UI
recipe quantities and server recipes. The 30-check browser gate passed on the
isolated signed-license fixture, including Basic/Pro/cashier access, stale
writes, save/creation locking, converted requests, original kitchen deductions
and cancellation reversal. Nine additional browser checks passed for refresh,
failed reload, creation retries, 100-row limit, archived stock and empty lists.
Six mobile/keyboard checks passed. Light/dark layouts were visually inspected
at 1280×720, 1920×1080 and 390×844; no horizontal overflow or browser errors.

The reusable fixture is tools/e2e/recipes-server.mts on port 4155 with an
in-memory database and fake printer. Restart it before the main gate because
license revisions are monotonic. All recipe QA servers were stopped. Recipe
documentation and screenshots were updated. Built UI assets were copied into
build/desktop/app/ui for the existing Start ForkFlow.cmd launcher, with matching
index hashes. The running restaurant was not restarted, and installers were
not repackaged; the launcher shows the redesign on its next load.
