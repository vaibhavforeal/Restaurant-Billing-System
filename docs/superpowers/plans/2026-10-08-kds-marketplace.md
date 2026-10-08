# Kitchen Display (KDS) Marketplace Add-on Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the view-only Kitchen Display a Pro-plan licence feature that an admin switches on or off in the Marketplace, and remove the kitchen-acceptance step from billing everywhere.

**Architecture:** First remove kitchen acceptance (Accept route and button, billing check, order flag, setting). Then reuse the Marketplace integration registry, `integration_state` table, PATCH route and `integrations.changed` broadcast for a `kds` integration linked to a new `kds` licence feature. One server module `kds.ts` computes `kdsActive(db)` from the installation's licence and the stored switch; the kitchen routes use it, and kitchen clients learn the state from a `403 { code: "kds_off" }`.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, zod, React (Vite), vitest; e2e via in-page scripts in `tools/e2e`.

**Spec:** `docs/superpowers/specs/2026-10-08-kds-marketplace-design.md`

## Global Constraints

- Plan features: Basic `kds: false`, Pro `kds: true`; development builds report `kds: true`.
- Grant schema: `kds: z.boolean().default(false)`; grants issued before this change read as not licensed.
- `kdsActive = licence.features.kds && integration_state(kds).enabled`. No migration; no row means off. Licence features are installation-wide, so the helper is `kdsActive(db)`.
- Registry entry, exactly: `{ id: "kds", name: "Kitchen Display (KDS)", description: "Show KOTs on kitchen screens and tablets so the kitchen can see what to cook and mark tickets done.", category: "kitchen", status: "available", setupPage: null, feature: "kds" }`.
- PATCH on while unlicensed → `403` "Kitchen Display requires the Pro plan". Turning off is always allowed.
- `GET /api/kots` and `POST /api/kots/:id/done` while inactive → `403 { error: "Kitchen Display is turned off", code: "kds_off" }`. `POST /api/kots/:id/accept` no longer exists. `POST /api/orders/:id/send` is never gated.
- Billing has no kitchen condition. "Send kitchen items before billing" stays.
- The `settings.require_kitchen_acceptance` and `kots.accepted_at` columns stay, unused. No migration.
- Notice copy: title "Kitchen Display is turned off"; text "Ask an admin to turn it on in the Marketplace."
- Marketplace header: "Connect ForkFlow to delivery platforms and add-ons". Unlicensed card: pill "Pro plan", note "Upgrade to Pro to use the Kitchen Display", admin button "View licence".
- Run vitest from the repo root. Gates: `npm run typecheck` clean; `npx vitest run` passing except the 2 known `captain-https` environment failures.
- Do not commit unless the user asks; stage files explicitly when they do.

## Review Focus

1. **Plan downgraded while KDS is switched on** — the admin must still be able to switch it off, must not be able to switch it on, and kitchen routes must refuse. Test: Task 3 "allows turning kds off but not on while unlicensed".
2. **Kitchen-role users in the staff app** have an empty integrations list (no `integrations.read`); a naive `isEnabled("kds")` nav filter would hide their only tab. Expected: their Kitchen tab stays and the board shows the notice. Test: Task 5 `navTabVisible` kitchen-role case.
3. **A table whose KOTs are sent but not done, with KDS on** — the old rule blocked this; it must now bill normally. Test: Task 1 "bills a table with sent, not-done KOTs".
4. **Done pressed just after KDS is turned off** — expected: the board switches to the notice, no button stuck on "Saving…". Test: Task 7 `isKdsOff` plus the `kitchen-app.js` live-off step.
5. **Unactivated or invalid commercial licence with the switch on** — features are all false, so KDS is inactive and the kitchen API refuses. Test: Task 4 "commercial installation without kds refuses the kitchen".

---

### Task 1: Remove kitchen acceptance

**Files:**
- Modify: `apps/server/src/kots.ts` (delete `POST /api/kots/:id/accept`), `apps/server/src/billing.ts:79-85`, `apps/server/src/mappers.ts:129`, `apps/server/src/settings.ts:7,20,25,39-40`, `packages/domain/src/settings-schemas.ts:13`, `apps/server/src/demo-seed.ts:54,61`
- Modify: `apps/ui/src/screens/BillingPanel.tsx` (:72, :149, :165, :173, :232, :246, :252, :283, :297-300), `apps/ui/src/types.ts:137`, `apps/ui/src/screens/Settings.tsx:11,311-317`, `apps/ui/src/screens/Kitchen.tsx` (Accept button, acceptance status line)
- Delete: `apps/ui/src/kitchen-billing.ts`, `apps/ui/src/kitchen-billing.test.ts`, `tools/e2e/kitchen-billing.js` and its README section
- Tests: `apps/server/src/billing.test.ts`, `kots.test.ts`, `settings.test.ts`, `demo-seed.test.ts`, `table-label.test.ts`, `table-transfer.test.ts`, `service-pricing.test.ts`, `apps/ui/src/captain-worker.test.ts` (wherever they rely on accept or the setting)

**Interfaces:**
- Produces: order JSON without `kitchenAcceptanceRequired`; settings JSON without `requireKitchenAcceptance`; no accept route.

- [ ] **Step 1: Write the failing tests.**
  - `billing.test.ts`: replace "blocks table previews and direct billing until the kitchen accepts…" with `it("bills a table with sent, not-done KOTs")`: dine-in, send → preview 200 and bill created; order JSON has no `kitchenAcceptanceRequired` key.
  - `kots.test.ts`: replace the "kots: kitchen acceptance" describe with `it("has no accept route")` → `POST /api/kots/:id/accept` 404; keep Done tests.
  - `settings.test.ts`: GET settings has no `requireKitchenAcceptance`; PUT with `requireKitchenAcceptance: false` still 200 (stripped).
- [ ] **Step 2: Run** `npx vitest run apps/server/src/billing.test.ts apps/server/src/kots.test.ts apps/server/src/settings.test.ts` — FAIL.
- [ ] **Step 3: Implement** the removals listed under Files. In `BillingPanel`, delete the block reason and every condition and message derived from it; Preview bill / F10 disabled state keeps its other conditions. In `Kitchen.tsx`, every ticket shows only the Done button; drop the acceptance status line. In the demo seed, keep the Done calls, drop the accept calls (line 61's "accepted" sample tickets simply stay open).
- [ ] **Step 4: Run** `npx vitest run` and `npm run typecheck` — fix remaining tests that called accept or set the setting (delete assertions about acceptance; keep their other checks). PASS except the 2 known failures.
- [ ] **Step 5: Commit** (when asked): `refactor: remove kitchen acceptance from billing and KDS`.

### Task 2: `kds` licence feature

**Files:**
- Modify: `packages/domain/src/licensing.ts:3-8,21,35`, `apps/server/src/licensing.ts:59,64,208`
- Test: `apps/server/src/licensing.test.ts`

**Interfaces:**
- Produces: `Feature` includes `"kds"`; `LicenseStatus["features"]` is `{ recipes: boolean; qrOrdering: boolean; kds: boolean }`; `app.licensing.status().features.kds`.

- [ ] **Step 1: Write the failing tests** in `licensing.test.ts`:
  - `it("reads grants issued before kds as not licensed for the kitchen display")`: claims with `features: { recipes: true, qrOrdering: true }` → `LicenseClaims.parse(...).features.kds === false`; after activation `f.app.licensing.status().features.kds === false`.
  - `it("includes kds in Pro only")`: `PLANS.pro.features.kds === true`, `PLANS.basic.features.kds === false`.
  - `it("reports kds in development builds")`: `freshApp().licensing.status().features` toEqual `{ recipes: true, qrOrdering: true, kds: true }`.
  - `it("names the kitchen display in the missing-feature error")`: a `requireFeature("kds")` test route in `fixture()` (like `/api/test-recipes`); Basic grant → 403, error `"This feature requires a plan with the Kitchen Display"`.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/licensing.test.ts` — the four new tests FAIL.
- [ ] **Step 3: Implement.** Add `kds` to both `PLANS` and `kds: z.boolean().default(false)` to `LicenseClaims.features`; widen `LicenseStatus.features`. Server: `kds: false` in the base status, `kds: true` in development mode. Replace the `assertFeature` ternary with a `Record<Feature, string>`: `recipes: "recipe editing"`, `qrOrdering: "QR ordering"`, `kds: "the Kitchen Display"`.
- [ ] **Step 4: Run** the licensing tests and `npm run typecheck` — PASS (fix any `features` literals the compiler flags).
- [ ] **Step 5: Commit** (when asked): `feat(licensing): add kds feature to Pro plan`.

### Task 3: KDS integration entry, `kdsActive`, licensed flag

**Files:**
- Modify: `packages/domain/src/integrations.ts`, `apps/server/src/integrations.ts`, `apps/server/src/server.ts:118` (error-code passthrough) and after `configureLicensing` (register the licence lookup)
- Create: `apps/server/src/kds.ts`
- Test: `packages/domain/src/integrations.test.ts`, `apps/server/src/integrations.test.ts`

**Interfaces:**
- Consumes: `Feature` (Task 2).
- Produces:
  - `IntegrationId = "zomato" | "swiggy" | "kds"`; `IntegrationDef.category: "delivery" | "kitchen"`; `IntegrationDef.feature?: Feature`; `IntegrationInfo.licensed: boolean`.
  - `apps/server/src/kds.ts`: `provideLicensedFeatures(db: Database, features: () => LicenseStatus["features"]): void`, `integrationLicensed(db: Database, def: IntegrationDef): boolean`, `kdsActive(db: Database): boolean`, `assertKdsActive(db: Database): void` (throws `httpError(403, "Kitchen Display is turned off", "kds_off")`).
  - The error handler passes through `code` values `"menu_changed"` and `"kds_off"`.

- [ ] **Step 1: Write the failing tests.**
  - Domain: `INTEGRATIONS` ids equal `["zomato", "swiggy", "kds"]`; the `kds` entry equals the Global Constraints entry.
  - `integrations.test.ts:29`: expect `["zomato", "swiggy", "kds"]` and every entry `licensed: true` (development build).
  - New `describe("kds licensing")` with a commercial Basic-grant fixture (copy `fixture()` from `licensing.test.ts`; device header required):
    - `it("reports kds as unlicensed on Basic")`: `kds.licensed === false`, `zomato.licensed === true`.
    - `it("allows turning kds off but not on while unlicensed")`: PATCH `{enabled:true}` → 403 "Kitchen Display requires the Pro plan"; insert an enabled `kds` row directly (simulated downgrade); PATCH `{enabled:false}` → 200, `enabled: false`.
  - `kdsActive`: development app false with no row, true after `enableIntegration(app, "kds")`; Basic commercial app with an enabled row → false.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/integrations.test.ts apps/server/src/integrations.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Registry entry and types. `kds.ts` keeps a module-level `WeakMap<Database, () => features>`; with no lookup registered, licence features count as all false (fail closed); `integrationLicensed` is `true` when `def.feature` is undefined. In `server.ts`, right after `configureLicensing`, call `provideLicensedFeatures(app.db, () => app.licensing.status().features)`. `listIntegrations` adds `licensed`; PATCH throws 403 with the exact Global Constraints message when enabling an unlicensed integration. Add `"kds_off"` to the error-handler code allow-list.
- [ ] **Step 4: Run** the Step 2 tests and `npm run typecheck` — PASS (add `licensed: true` to `apps/ui/src/integrations-model.test.ts` fixtures if the compiler requires it).
- [ ] **Step 5: Commit** (when asked): `feat(integrations): KDS integration entry and licence check`.

### Task 4: Gate the kitchen routes

**Files:**
- Modify: `apps/server/src/kots.ts` (`GET /api/kots`, `POST /api/kots/:id/done`), `apps/server/src/demo-seed.ts` (enable `kds`)
- Modify tests that use the kitchen board or Done: `kots.test.ts`, `guest-ordering.test.ts`, `operational-reports.test.ts`, `table-transfer.test.ts`, `demo-seed.test.ts`
- Test: new `apps/server/src/kds.test.ts`

**Interfaces:**
- Consumes: `assertKdsActive(db)` (Task 3); `enableIntegration(app, "kds")` (existing test helper).

- [ ] **Step 1: Write the failing tests** in `kds.test.ts`:
  - `it("refuses the kitchen board and Done while KDS is off")`: dev app, send a KOT; GET `/api/kots` and POST done → 403 `{ error: "Kitchen Display is turned off", code: "kds_off" }`; ticket row unchanged.
  - `it("serves the kitchen once KDS is on")`: `enableIntegration(app, "kds")` → GET lists the ticket; done 200.
  - `it("sends and prints KOTs with KDS off")`: `freshAppWithFakeSink()`, station with printer, send → 200 and one KOT print job queued.
  - `it("commercial installation without kds refuses the kitchen")`: Basic commercial fixture with an enabled `kds` row → GET `/api/kots` 403 `kds_off`.
  - `it("keeps open tickets while off and shows them again when turned back on")`: send, enable, disable, enable → GET lists the same ticket id.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/kds.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Call `assertKdsActive(app.db)` first in both handlers (after the permission preHandler, so 401/403-permission responses are unchanged). In `seedDemo`, insert `integration_state ('kds', 1, now, <demo admin id>)` before sample tickets are marked done.
- [ ] **Step 4: Run** `npx vitest run apps/server` — add `enableIntegration(app, "kds")` after `setupAdmin` in existing tests that read the board or press Done. PASS except the 2 known failures.
- [ ] **Step 5: Commit** (when asked): `feat(server): gate the kitchen display on KDS`.

### Task 5: Marketplace card and navigation model

**Files:**
- Modify: `apps/ui/src/integrations-model.ts`, `apps/ui/src/screens/Marketplace.tsx`, `apps/ui/src/marketplace.css`, `apps/ui/src/NavBar.tsx:82`
- Test: `apps/ui/src/integrations-model.test.ts`

**Interfaces:**
- Consumes: `IntegrationInfo.licensed`, `category: "kitchen"` (Task 3).
- Produces (in `integrations-model.ts`):
  - `isEnabled(list, id)` = entry `enabled && licensed`.
  - `statusLabel(info)` returns `"Pro plan"` when `!info.licensed`.
  - `canToggle(info, role)`: admin, `available`, and (`licensed` or currently `enabled`).
  - `navTabVisible(page: Page["name"], role: User["role"], isEnabled: (id: IntegrationId) => boolean): boolean` — `zomato` needs `"zomato"`; `kitchen` needs `"kds"` except for the `kitchen` role (always visible); every other page visible.

- [ ] **Step 1: Write the failing tests** in `integrations-model.test.ts`:
  - `isEnabled` false for `{ id: "kds", enabled: true, licensed: false }`.
  - `statusLabel` → `"Pro plan"` for unlicensed; `canToggle` false for unlicensed+off admin, true for unlicensed+on admin, false for cashier.
  - `navTabVisible("kitchen", "admin", () => false) === false`; `("kitchen", "kitchen", () => false) === true`; `("kitchen", "cashier", (id) => id === "kds") === true`; `("zomato", "admin", () => false) === false`; `("tables", "admin", () => false) === true`.
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/integrations-model.test.ts` — FAIL.
- [ ] **Step 3: Implement** the model functions; NavBar uses `roleTabs.filter((t) => navTabVisible(t.page.name, user.role, isEnabled))`. Marketplace: header copy; `categoryLabel` gains `kitchen: "Kitchen"`; pill class `is-locked` when unlicensed (styled like `is-soon`); unlicensed cards show `<p className="marketplace-note">Upgrade to Pro to use the Kitchen Display</p>` and, for admins, a "View licence" button navigating to `{ name: "settings" }`. The switch's `aria-checked` stays the stored `enabled`.
- [ ] **Step 4: Run** the model tests and `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** (when asked): `feat(ui): KDS card and integration-aware navigation`.

### Task 6: Hide kitchen surfaces in the staff app

**Files:**
- Modify: `apps/ui/src/App.tsx:137` (kitchen route), `apps/ui/src/screens/Home.tsx:32`, `apps/ui/src/screens/SystemSettings.tsx:75-82`
- Test: `tools/e2e/marketplace.js` (Task 8 adds the checks)

**Interfaces:**
- Consumes: `useIntegrations().isEnabled("kds")`, `IntegrationOff` (existing).

- [ ] **Step 1: Implement** `KitchenRoute` beside `ZomatoRoute` in `App.tsx`: for admin/cashier, `!ready` → loading text; `!isEnabled("kds")` → `<IntegrationOff name="Kitchen Display" …/>`; otherwise `<Kitchen />`. The kitchen role renders `<Kitchen />` directly (the board handles `kds_off`, Task 7).
- [ ] **Step 2: Implement** `Home.tsx`: the Kitchen quick link only when `isEnabled("kds")`. `SystemSettings.tsx`: the "Kitchen displays" heading, text and links only when `isEnabled("kds")`.
- [ ] **Step 3: Run** `npm run typecheck` and `npm run build -w @forkflow/ui` — PASS. Behaviour is verified by the Task 8 e2e checks.
- [ ] **Step 4: Commit** (when asked): `feat(ui): hide kitchen surfaces while KDS is off`.

### Task 7: Kitchen board handles `kds_off`

**Files:**
- Modify: `apps/ui/src/api.ts` (`ApiError` gains `code?: string`, set from `body.code`), `apps/ui/src/screens/Kitchen.tsx`
- Create: `apps/ui/src/kds.ts`
- Test: `apps/ui/src/kds.test.ts`, `tools/e2e/kitchen-app.js`, `tools/e2e/demo-kitchen.js`

**Interfaces:**
- Produces: `isKdsOff(error: unknown): boolean` — true only for an `ApiError` with `status === 403 && code === "kds_off"`.

- [ ] **Step 1: Write the failing unit tests** in `kds.test.ts`: true for `new ApiError(403, "Kitchen Display is turned off", "kds_off")`; false for `new ApiError(403, "forbidden")`, `new ApiError(500, "x", "kds_off")` and `new Error("kds_off")`.
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/kds.test.ts` — FAIL.
- [ ] **Step 3: Implement.** `ApiError(status, message, code?)`; `apiFetch` passes `body.code`. In `Kitchen.tsx`, add `off` state: `reload()` sets it on `isKdsOff(error)` (and clears tickets) and clears it on success; a Done failing with `isKdsOff` sets `off` instead of the error message; the 15 s poll skips while `off`; `onEvent` also reloads on `"integrations.changed"`. While `off`, render only the notice panel with the Global Constraints copy.
- [ ] **Step 4: Run** unit tests and typecheck — PASS. Update `kitchen-app.js` and `demo-kitchen.js`: turn KDS on first via admin API; expect no Accept button; in `kitchen-app.js`, turning KDS off from a second admin session shows the notice without reload, and turning it back on brings the tickets back. Run both gates per `tools/e2e/README.md` — PASS.
- [ ] **Step 5: Commit** (when asked): `feat(kitchen): view-only board with turned-off notice`.

### Task 8: Marketplace e2e and documentation

**Files:**
- Modify: `tools/e2e/marketplace.js`, `tools/e2e/README.md`
- Modify: `docs/operations/marketplace.md`, `demo-and-kitchen.md`, `tables-workspace.md`, `rollout-checklist.md`

- [ ] **Step 1: Extend `marketplace.js`.** Admin: KDS card shows tag "Kitchen" and "Disabled"; Kitchen nav item and Home quick link hidden; `GET /api/kots` 403 `kds_off`; toggling on shows the nav item and quick link; toggling off hides them; turn KDS off again in `finally`. Cashier: KDS switch disabled; Kitchen tab follows the admin's toggle live. Update the README check counts.
- [ ] **Step 2: Run** the Marketplace gate (admin and cashier) and the sales-dashboard gate per README — PASS.
- [ ] **Step 3: Update docs** as listed in spec §8, including removing the kitchen-acceptance step from `tables-workspace.md` and `rollout-checklist.md`.
- [ ] **Step 4: Final gates:** `npm run typecheck`; `npx vitest run` (only the 2 known `captain-https` failures).
- [ ] **Step 5: Commit** (when asked): `docs: kitchen display as a Marketplace add-on`.
