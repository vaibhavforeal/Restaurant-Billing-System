# Kitchen Display (KDS) as a Paid Marketplace Add-on — Design

**Date:** 8 October 2026
**Status:** Revised in conversation (view-only KDS, no acceptance rule); awaiting written-spec review

## 1. Goal

The Kitchen Display System (the `/kitchen` ticket board, the ForkFlow Kitchen desktop app and the in-app Kitchen tab) becomes a paid add-on that an administrator turns on or off from the Marketplace, next to Zomato. The KDS only views tickets: the kitchen sees what to cook and clears finished tickets with **Done**. Billing never depends on the kitchen.

Success means:

- KDS is a licence feature (`kds`) included in the Pro plan only. Licences issued before this change do not include it.
- The Marketplace shows a Kitchen Display card. With the feature licensed, an admin can switch it on or off; without it, the card is locked and points to the licence.
- While KDS is off (switched off or not licensed), no kitchen screen shows tickets and the kitchen API refuses requests.
- The kitchen-acceptance step is removed everywhere: no **Accept order** button, no "Require kitchen acceptance" setting, and tables can be billed as soon as kitchen items are sent, on every plan.
- KOT sending and station printing work the same on every plan, whether KDS is on or off.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Purpose | Sell KDS as a paid add-on |
| Licensing | New licence feature `kds`: Basic `false`, Pro `true`, development builds `true`. Signed grants use `kds: z.boolean().default(false)`, so grants issued before this change read as not licensed (same pattern as `qrOrdering`) |
| Switch | Marketplace integration `kds` (approach A: reuse the integrations registry, `integration_state`, PATCH route and `integrations.changed` broadcast). No separate "Modules" concept |
| Effective state | `kdsActive = licence.features.kds && integration_state(kds).enabled`. Licence features are installation-wide, so the helper needs only the database: `kdsActive(db)` |
| Default | Off everywhere after the update (no `integration_state` row, no migration). The demo seed turns it on |
| KDS actions | View tickets and press **Done**. **Accept order** and `POST /api/kots/:id/accept` are removed |
| Billing | No kitchen condition at all. The acceptance check, the order's `kitchenAcceptanceRequired` flag, the "Waiting for kitchen…" message and the Preview bill / F10 lock are removed. "Send kitchen items before billing" stays |
| Acceptance setting | `requireKitchenAcceptance` is removed from the settings API and the Settings screen. The `settings.require_kitchen_acceptance` and `kots.accepted_at` columns stay in the database, unused; no migration |
| Printing | `POST /api/orders/:id/send`, KOT slips, cancel slips and table-change slips are not gated |
| Kitchen clients | Learn the state from a `403 { code: "kds_off" }` on the kitchen API and refetch on `integrations.changed`. The kitchen role gets no new permissions |
| Ready indicators | Unchanged: "Kitchen ready" (Captain) and the guest QR "ready" state come from Done. With KDS off nobody presses Done, so they never claim "ready" and the QR page stays at "Preparing" |
| Out of scope | Licence issuing tooling beyond the `kds` field, pricing pages, a generic Modules abstraction, auto-closing old tickets, dropping the unused columns |

## 3. Data model and registry

### Licence — `packages/domain/src/licensing.ts`

- `PLANS.basic.features.kds = false`, `PLANS.pro.features.kds = true`.
- `LicenseClaims.features` adds `kds: z.boolean().default(false)` (the object stays `.strict()`).
- `LicenseStatus.features` adds `kds`. The unactivated base reports `false`; development mode reports `true` (`apps/server/src/licensing.ts`).
- `assertFeature`'s 403 message becomes a lookup per feature: recipes → "recipe editing", qrOrdering → "QR ordering", kds → "the Kitchen Display".

### Registry — `packages/domain/src/integrations.ts`

- `IntegrationId` adds `"kds"`. `category` widens to `"delivery" | "kitchen"`.
- `IntegrationDef` gains `feature?: Feature`: the licence feature the integration requires.
- New entry: `{ id: "kds", name: "Kitchen Display (KDS)", description: "Show KOTs on kitchen screens and tablets so the kitchen can see what to cook and mark tickets done.", category: "kitchen", status: "available", setupPage: null, feature: "kds" }`.
- `IntegrationInfo` gains `licensed: boolean` (`true` when the entry has no `feature`).

### Storage

No migration. `integration_state` already treats a missing row as off. The acceptance columns are left in place.

## 4. Server

### Integrations — `apps/server/src/integrations.ts`, new `apps/server/src/kds.ts`

- `GET /api/integrations` fills `licensed` from the installation's licence features.
- `PATCH /api/integrations/:id` with `{ enabled: true }` on an unlicensed integration → **403** "Kitchen Display requires the Pro plan". Turning off is always allowed (a downgraded licence may leave the switch on).
- `kdsActive(db)` and `assertKdsActive(db)` live in `kds.ts`; the server registers the licence-feature lookup for its database at start-up.
- A licence that lapses or is downgraded does not change the stored switch: KDS is inactive while unlicensed and resumes when the feature returns.
- The error handler passes the `kds_off` code through to clients (today it only passes `menu_changed`).

### Kitchen routes — `apps/server/src/kots.ts`

- `GET /api/kots` and `POST /api/kots/:id/done` → **403 `{ error: "Kitchen Display is turned off", code: "kds_off" }`** while KDS is inactive.
- `POST /api/kots/:id/accept` is removed (404).
- `POST /api/orders/:id/send` (send and print a KOT) is unchanged.

### Billing and settings — `billing.ts`, `mappers.ts`, `settings.ts`, `packages/domain/src/settings-schemas.ts`

- Remove the acceptance check from `preview()` (billing.ts:79-85) and `kitchenAcceptanceRequired` from order JSON (mappers.ts:129).
- Remove `requireKitchenAcceptance` from `GET`/`PUT /api/settings` and `SettingsUpdate` (unknown keys are already stripped, so an older client sending it does not fail).

### Broadcast

Switching KDS uses the existing `integrations.changed` event, which every authenticated client receives (including kitchen screens).

## 5. Frontend

### Shared model — `integrations-model.ts`

- `isEnabled(list, id)` = `enabled && licensed`.
- `canToggle` also requires `licensed` to turn **on**; turning off stays possible for admins.
- `navTabVisible(page, role, isEnabled)`: `zomato` needs Zomato; `kitchen` needs KDS except for the kitchen role, whose only tab always shows (the board itself shows the notice).

### Marketplace — `screens/Marketplace.tsx`, `marketplace.css`

- Header: "Connect ForkFlow to delivery platforms and add-ons".
- `categoryLabel` adds `kitchen: "Kitchen"`.
- KDS card:
  - Licensed: normal switch with Disabled/Enabled status.
  - Not licensed: "Pro plan" status pill, locked switch (unless stored on, then admins may turn it off), the note "Upgrade to Pro to use the Kitchen Display", and for admins a **View licence** button opening Settings (Plan & devices).

### Staff app — `NavBar.tsx`, `App.tsx`, `Home.tsx`, `SystemSettings.tsx`

- The NavBar filter uses `navTabVisible`, replacing the hard-coded Zomato check.
- While KDS is off: hide the Kitchen tab, the Home "Kitchen" quick link and System settings' "Kitchen displays" section; the kitchen page route renders `IntegrationOff` ("Kitchen Display is turned off"), like `ZomatoRoute`.

### Billing — `BillingPanel.tsx`, `kitchen-billing.ts`, `types.ts`, `Settings.tsx`

- Delete `kitchen-billing.ts` and its test; remove its use in `BillingPanel` (blocked actions, disabled Preview bill / F10, waiting messages) and `kitchenAcceptanceRequired` from `Order`.
- Remove the "Require kitchen acceptance" checkbox and help text from Settings.

### Kitchen board — `screens/Kitchen.tsx` (used by `/kitchen`, the desktop app and the in-app tab)

- Each ticket shows its number, age, table/parcel and items, and one **Done** button. The **Accept order** button and the "Awaiting kitchen acceptance" / "Accepted by kitchen" line are removed.
- A `403` with `code: "kds_off"` replaces the board with "Kitchen Display is turned off. Ask an admin to turn it on in the Marketplace." and stops polling.
- On `integrations.changed` (and on reconnect) it refetches, so the board returns without a reload when KDS is turned on.
- A Done that fails with `kds_off` switches to the notice; nothing partial is left.

### Desktop kitchen app

No change: it loads `/kitchen`.

### Demo

`apps/server/src/demo-seed.ts` turns KDS on and no longer calls the accept route (it still marks sample tickets done).

## 6. Edge cases

- **Turned off with open tickets:** KOT rows are untouched. Turning KDS back on shows the same open tickets, which the kitchen can clear with Done.
- **Licence expires past grace:** the existing `canOperate` lock blocks everything first.
- **Old tickets never marked done while off:** not visible (the list route is refused). No auto-close, to keep history.
- **An older kitchen screen still showing Accept** (cached before the update): its accept call gets 404 and shows the error; a reload loads the new board.

## 7. Testing and verification

### Domain

- Grant parsing: a grant without `kds` parses as `false`; plan feature table.
- Registry contains `kds` with `feature: "kds"`.

### Server (`*.test.ts`, in-memory)

- `GET /api/integrations` reports `licensed`; the expected id list becomes `["zomato", "swiggy", "kds"]`.
- PATCH on while unlicensed → 403; off while unlicensed → 200.
- `GET /api/kots` and Done → 403 `kds_off` when off or unlicensed, working when on; accept → 404.
- Sending a KOT and its print job work with KDS off.
- A dine-in order with a sent, not-done KOT can be previewed and billed, with KDS on or off.
- Settings no longer return `requireKitchenAcceptance`.
- Existing kitchen tests enable KDS first; tests of the removed acceptance behaviour are deleted.

### UI (vitest)

- `integrations-model`: `isEnabled` / `canToggle` with `licensed`; `navTabVisible`.
- `isKdsOff(error)`.

### Browser (`tools/e2e`)

- `marketplace.js`: KDS card, switch, Kitchen tab appearing and disappearing, kitchen API refused while off.
- `kitchen-app.js`, `demo-kitchen.js`: turn KDS on first; board has no Accept button; live notice when turned off and tickets back when turned on.
- `kitchen-billing.js` and its README section are removed (the rule no longer exists).

### Gates

Typecheck clean; vitest passing (except the 2 known `captain-https` environment failures); e2e gates above passing.

## 8. Documentation

- `docs/operations/marketplace.md`: KDS row (needs Pro; off hides kitchen screens; printed KOTs unaffected).
- `demo-and-kitchen.md`: kitchen screen needs Pro plus the Marketplace switch; tickets are viewed and cleared with Done.
- `tables-workspace.md` and `rollout-checklist.md`: remove the kitchen-acceptance step and setting.
