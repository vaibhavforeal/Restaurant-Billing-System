# Kitchen Display as a paid Marketplace add-on (and committing the dashboard work)

Session of 8 October 2026. Everything below is committed and pushed to
`origin/main` (`15c6440..6076549`). The working tree is clean.

## Work done

### 1. Verified the earlier dashboard and Marketplace work

- Re-ran the e2e gates on the sales-dashboard fixture (port 4145): sales
  dashboard 42/42, Marketplace admin 28/28, cashier 12/12. Real Space/Enter on the
  Zomato switch toggles it. A waiter gets 403 on `GET /api/integrations`.
- Fixed a stale sales-dashboard check ("A future date is not accepted"); see
  Problems below.

### 2. Kitchen Display (KDS) became a Pro-plan add-on, view-only

Spec: `docs/superpowers/specs/2026-10-08-kds-marketplace-design.md`
Plan: `docs/superpowers/plans/2026-10-08-kds-marketplace.md`

Decisions taken with the user:

- **Licensing:** KDS is a paid add-on, a licence feature `kds` in the **Pro plan
  only**. Grants issued before this change read as `kds: false`, so existing
  customers need a reissued licence.
- **Switch:** admins turn it on or off in the Marketplace. It **starts off
  everywhere**; the demo seed turns it on.
- **Acceptance removed:** at the user's request the kitchen-acceptance step is
  gone completely: no **Accept order** button or `POST /api/kots/:id/accept`, no
  billing wait, no "Require kitchen acceptance" setting. Tables are billed as soon
  as kitchen items are sent.
- **The board:** shows tickets with a **Done** button only.
- **Printing:** sending and printing KOTs are unchanged on every plan.

What exists now:

- **Licence feature:**
  - `packages/domain/src/licensing.ts`: `kds` in `PLANS` and `LicenseClaims`
    (`.default(false)`).
  - `apps/server/src/licensing.ts`: `FEATURE_NAMES` lookup for the 403 message.
- **Server KDS module (`apps/server/src/kds.ts`):**
  - `kdsActive(db)` is true when the installation's licence has `kds` **and**
    `integration_state(kds)` is on.
  - `buildServer` registers the licence lookup with `provideLicensedFeatures`.
  - `assertKdsActive(db)` throws 403 with `code: "kds_off"`.
- **Kitchen routes:** `GET /api/kots` and `POST /api/kots/:id/done` are gated.
  `POST /api/orders/:id/send` is not.
- **Integrations API:**
  - The list reports `licensed`.
  - PATCH to turn on an unlicensed integration returns 403 "Kitchen Display
    requires the Pro plan"; turning off is always allowed.
  - The error handler passes `kds_off` through (it previously passed only
    `menu_changed`).
- **UI:**
  - **Marketplace:** a KDS card tagged "Kitchen". Without the licence it shows a
    "Pro plan" pill, an upgrade note and **View licence**, which opens Settings →
    Plan & devices.
  - **Navigation:** `navTabVisible` in `integrations-model.ts` hides the Kitchen
    tab while KDS is off. The kitchen role always keeps its tab.
  - **Kitchen route:** `KitchenRoute` in `App.tsx` shows `IntegrationOff` while
    KDS is off.
  - **Kitchen board (`Kitchen.tsx`):** shows "Kitchen Display is turned off" on
    `kds_off`. It reloads on `integrations.changed`, `forkflow:license-changed` and
    reconnect.
  - **Licence screens:** list "Kitchen Display: included / not included"
    (`license-features.ts`).
  - **Live refresh:** licence changes refresh the Marketplace live
    (`integrations.tsx` listens to `forkflow:license-changed`).
- **Acceptance removal:**
  - Removed from the billing check, order JSON (`kitchenAcceptanceRequired`), the
    settings API and schema, `BillingPanel`, and the Settings checkbox.
  - Deleted `kitchen-billing.ts` and its test, and `tools/e2e/kitchen-billing.js`.
  - The `require_kitchen_acceptance` and `accepted_at` columns stay in the
    database, unused; there was no migration.
- **Docs:** `docs/operations/marketplace.md` (KDS table),
  `demo-and-kitchen.md`, `tables-workspace.md`, `table-move-merge.md`,
  `rollout-checklist.md` and `tools/e2e/README.md`.

### 3. Final review and fixes

A separate Opus reviewer returned "ready with fixes", with 0 Critical findings. I
fixed:

- the licence-change refresh;
- **View licence** not opening Plan & devices;
- licence screens not mentioning KDS;
- leftover "acceptance" wording.

### 4. Commits (all pushed)

| Commit | Content |
| --- | --- |
| `bcf2ab3` | Dashboard redesign and integrations Marketplace (earlier sessions' work) |
| `ed00676` | `kds` licence feature |
| `5f1ffe8` | KDS add-on code and unit tests, plus removal of kitchen acceptance |
| `5fe4933` | KDS docs, e2e gates, spec and plan |
| `6076549` | `.gitignore`: `.codex/`, `.playwright-mcp/`, `output/`, `Screenshots/`, all of `.superdesign/`; `.claude/settings.json` removed from the repo |

### Final verification

- `npm run typecheck`: clean.
- `npx vitest run`: 835 passed, plus the 2 known `captain-https` environment
  failures.
- e2e:

| Gate | Result |
| --- | --- |
| Marketplace, admin | 36/36 |
| Marketplace, cashier | 13/13 |
| Sales dashboard | 42/42 |
| demo-kitchen | 6/6 |
| kitchen-app | 14/14 |

## Problems faced and solutions

| Problem | Solution |
| --- | --- |
| agent-browser and local Playwright are not installed. | Ran the e2e scripts through the Playwright MCP: `page.addScriptTag({ path })`, then `waitForFunction` on the result global. |
| A second run read the previous run's `window.__*Result`. | Reload the page or delete the globals before each run; use a fresh browser context per role. |
| `kitchen-app.js` requires the kitchen to have its own storage (no POS token). | Run it in a separate browser context from the admin session. |
| The sales-dashboard "future date" check failed. The date input now keeps a typed draft until blur. | Rewrote the check to test behaviour: no request for 2999, figures unchanged, the field reverts on blur. |
| String edits failed on CRLF files, and early edits mixed LF into CRLF files. | Used an EOL-aware edit helper and normalised the affected test files back to CRLF. |
| Accidentally staged a deletion with `git rm --cached`. | Undid it with `git reset -- <file>`; the index was clean again. |
| vitest exits non-zero because of the 2 `captain-https` failures (PowerShell is blocked on this machine). | Task gates excluded `**/captain-https.test.ts`; full runs still list them. |
| `loadOrderJson(db, id)` has 16 callers and no request, but needs the licence state. | Licence features are installation-wide, so `kdsActive(db)` reads them through a per-database lookup registered in `buildServer`. It fails closed when nothing is registered. |
| The error handler dropped every error code except `menu_changed`, so clients couldn't tell "KDS off" from any other 403. | Added `kds_off` to the allow-list; `ApiError` now carries `code`. |
| Many kitchen tests broke once KDS defaulted to off. | `enableIntegration(app, "kds")` after admin setup; a new `commercialApp(plan)` test helper creates a real signed Basic or Pro installation. |
| `tools/e2e/demo-kitchen.js` tested only the removed acceptance block. | Rewrote it: KDS on in the demo, an open KOT, billing works straight away, and billing doesn't complete the ticket. |
| Port 4110, which the demo e2e expects, was held by the user's own ForkFlow Demo Electron app (old build). | Left it running. Started a scratch demo from source on 4112 (`globalThis.__FORKFLOW_DEMO__ = true`, then import `apps/server/src/main.ts` with `FORKFLOW_PORT=4112` and a scratch `FORKFLOW_DATA_DIR`). Injected copies of the scripts with the port rewritten. |
| Review: a licence change didn't refresh the Marketplace, nav or board. | Listen for `forkflow:license-changed` in `IntegrationsProvider` and `Kitchen.tsx`. |
| Review: **View licence** landed at the top of Settings. | Root cause: Settings returns "Loading settings…" until its data arrives, so the open-and-scroll effect ran before the `<details>` existed. Fixed with dependencies `[section, loaded]`, declared after the `loaded` state to avoid a temporal-dead-zone error. Found by reading the component's hooks from the React fiber in the browser. |
| Committing two intertwined uncommitted features (dashboard/Marketplace and KDS overlap in about 18 files) as separate commits that each build. | Backed up the final state with checksums; reversed only the KDS edits with an anchor-checked script; restored KDS-only files to `HEAD`; verified the result matched the pre-KDS baseline (824 passed); committed; restored the backup and checked it byte-for-byte; then committed KDS. |
| A shell heredoc broke on a script with mixed quotes. | Wrote the script with the file-writing tool instead. |

## Remaining tasks for the next session

1. **Slot chart labels (the user's own task, learning mode).**
   `perBarLabelsFit(pitch, labels)` in `apps/ui/src/dashboard-view.ts` is still a
   committed TODO placeholder (`pitch >= 36`). Once the user writes it: add tests
   in `dashboard-view.test.ts` and screenshot the SlotChart at several widths.
2. **Rollout notes for customers:**
   - Reload every counter browser after updating. A tab running the old code shows
     "Waiting for kitchen…" on tables with open KOTs, and its Accept call now
     returns 404.
   - Reissue Pro licences so they include `kds`; old grants read as not licensed.
   - Turn on **Kitchen Display (KDS)** in the Marketplace where kitchen screens are
     used.
   - Consider a release (the last release is 0.7.0).
3. **Not verified yet:**
   - The visual pass the e2e README asks for: light and dark themes at
     1920×1080, 768×1024 and 390×844.
   - The locked "Pro plan" card layout. The e2e fixture is a development build and
     always licensed, so only the logic is tested (server and unit tests, plus an
     e2e step that simulates an unlicensed list).
   - The kitchen board's reload on licence change (it uses the same pattern as
     the tested Marketplace refresh).
   - The demo scripts' own 4110 port guard (they ran on 4112).
4. **Deferred minor findings from the final review:**
   - `kot.created` / `kot.updated` still broadcast ticket contents to kitchen
     sockets while KDS is off. The board doesn't show them.
   - `apps/server/src/kds.ts` and `integrations.ts` import each other. Move
     `integrationEnabled` into its own module.
   - Several literals name the Kitchen Display directly and need generalising when
     a second paid add-on arrives: the locked-card note ("Upgrade to Pro to use the
     Kitchen Display"), the PATCH 403 message, and the staff-app `IntegrationOff`
     text, which tells admins to "turn it on" even when the plan lacks it.
   - The billing test "bills a table with sent, not-done KOTs" runs only with KDS
     off.
   - `apps/ui/src/captain-worker.test.ts` still uses `/api/kots/one/accept` as a
     sample path.
   - The Home "Kitchen" quick-link gating has no visible effect: Home shows quick
     links only to roles that never get the Kitchen link.
5. **Optional:**
   - A later migration to drop the unused `settings.require_kitchen_acceptance`
     and `kots.accepted_at` columns.
   - Decide whether `.claude/settings.json` should be gitignored. It was removed
     from the repo but isn't ignored, so a new local copy would show as
     uncommitted.

## Environment notes

- Run vitest from the repo root.
- The `captain-https` tests fail on this machine (PowerShell blocked); this is
  environmental, not a regression.
- npm blocks install scripts. Don't wipe `node_modules` (Electron would be lost).
- Fixtures:
  - `tools/e2e/sales-dashboard-server.mts`: port 4145. Use a fresh fixture per
    full gate.
  - Demo: port 4110, or use the scratch-demo approach above if the user's demo
    app is running.
- The user commits only when asked. Stage files explicitly.
