# Owner-managed restaurant staff permissions

User confirmed restaurant staff permissions with View, Add/Create, Update and Delete checkboxes per data area. Implement in the existing private owner panel, scoped per restaurant and installation, preserving role defaults and overriding individual user actions.

1. Define shared permission resources/action vocabulary, role-derived defaults, strict staff roster/override schemas. Delete means existing archive/cancel/deactivate semantics; do not add hard deletion for accounting records. Preserve special licence, discount and approval rules.
2. Worker: accept authenticated installation staff roster on feature sync (IDs/names/roles/status only), store per-installation roster and permissions. Owner GET staff matrices and PATCH overrides with restaurant revision compare-and-set. Audit changes. Return installation-scoped signed permissions alongside feature preferences. Invalid/cross-restaurant staff changes must fail.
3. Restaurant: signed permission cache follows existing feature revision and offline logic. Re-evaluate overrides on every API permission check, classify separate CRUD actions even where legacy guards use manage/update. Support role defaults when no override. Protect read-only/protected routes and never let overrides alter owner control/licence/recovery authorization. Explicit cost/cancel-sent checks use effective permissions. Expose effective permissions to the current staff session.
4. Owner UI: staff selector, semantic table, four checkbox columns, disabled unavailable actions, reset to role defaults, atomic save/status/errors. Server side enforcement is authoritative. Add tests for grants/denials/role defaults, delete versus update, isolation/stale edits, roster safety and signed offline sync. Run full tests/typecheck/build and browser checks, restart localhost panel with sample staff.

No commit/deployment requested. Preserve unrelated edits.
