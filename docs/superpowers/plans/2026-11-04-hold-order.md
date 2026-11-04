# Hold Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hold saves the cart to the hub so any device can resume it; staff can hold individual dishes back from the kitchen and fire them later; a Settings checkbox turns the feature on or off.

**Architecture:** A `held` flag on `order_items` (meaningful only while `pending`) and a `hold_orders_enabled` column on `settings`, both added in migration 45. The existing KOT send route skips held items unless called with `fire: true`. The order screen gets pure helpers in a new `apps/ui/src/hold-order.ts` (unit-tested) and wires them into `OrderScreen` and `BillingPanel`.

**Tech Stack:** TypeScript, Fastify + better-sqlite3 (server), React (UI), zod (schemas), vitest, Playwright e2e scripts in `tools/e2e`.

**Spec:** `docs/superpowers/specs/2026-11-04-hold-order-design.md`

## Global Constraints

- Branch `feat/hold-order` (based on `fix/audit-bugs`). Migration version is **45**, name `hold_orders`; Dynamic Reports owns 44 on another branch. `MIGRATIONS` here becomes `[baseline, holdOrders]`.
- `order_items.held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1))`; `settings.hold_orders_enabled INTEGER NOT NULL DEFAULT 1 CHECK (hold_orders_enabled IN (0, 1))`.
- For a combo, only the combo line carries `held`; its child items follow the parent.
- Setting off: `held: true` is refused with 409 and message exactly `Hold orders is turned off in Settings`. Firing, un-holding (`held: false`) and cancelling held items always work.
- Billing prompt copy, exactly: `Send ${n} held ${n === 1 ? "item" : "items"} to the kitchen and continue?`
- Settings label `Hold orders`; InfoTip copy: `Staff can hold an order to finish later on any device, and hold dishes back from the kitchen until they fire them.`
- POS UI outside `apps/ui/src/dynamic-dashboard/` uses its own CSS (`styles.css`, `pos.css`); no BoardUI/Tailwind classes. Tablet touch targets are at least 44px.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Hold while offline with held cart rows** — the queued punch must carry `held`, so the dishes arrive held, not ready for the next KOT. Pinned by `punchItems` test (Task 5).
2. **Stale screen sends a KOT naming an item another device has since held** — the server must skip it, not cook it. Pinned in Task 4 (`skips a named held item`).
3. **Takeaway Pay with held rows still in the cart (not yet punched)** — the prompt count and fire request must include them. Pinned by `heldTargets` cart-row test (Task 5).
4. **Setting turned off while dishes are held** — Fire and the billing prompt must still appear and work. Pinned by server test (Task 3/4) and `holdControls` test (Task 5).
5. **Another device fires an item while this one toggles Hold on it** — PATCH answers 409 `item is not pending`; the screen reloads. Pinned in Task 3.

---

### Task 1: Migration 45 and schemas

**Files:**
- Create: `packages/domain/src/migrations/hold-orders.ts`
- Create: `packages/domain/src/migrations/hold-orders.test.ts`
- Modify: `packages/domain/src/migrations/index.ts` (append `holdOrders`; comment says new migrations number from 46)
- Modify: `packages/domain/src/order-schemas.ts:56-77` (`OrderItemsAdd` item, `OrderItemUpdate`)
- Modify: `packages/domain/src/settings-schemas.ts:14-26` (`SettingsUpdate`)
- Test: `packages/domain/src/order-schemas.test.ts` (schema cases) and `hold-orders.test.ts` (migration)

**Interfaces:**
- Produces: `holdOrders: Migration` (`version: 45`, `name: "hold_orders"`); `OrderItemsAdd` items accept `held?: boolean` (default `false`); `OrderItemUpdate` accepts `held?: boolean`; `SettingsUpdate` accepts `holdOrdersEnabled?: boolean`.

- [ ] **Step 1: Write failing tests** (migration case in `hold-orders.test.ts`, schema case in `order-schemas.test.ts`):
  - `adds held to order_items and hold_orders_enabled to settings`: `openDb(":memory:")` (from `packages/domain/src/db.ts`), `migrate(db, MIGRATIONS)`; expect `PRAGMA user_version` = 45; `PRAGMA table_info(order_items)` has `held` with `dflt_value` `"0"`; `SELECT hold_orders_enabled FROM settings WHERE id = 1` = 1; inserting `held = 2` throws.
  - `schemas accept held and holdOrdersEnabled`: `OrderItemsAdd.parse({ items: [{ productId: "p", qty: 1 }] }).items[0].held` is `false`; with `held: true` is `true`; `OrderItemUpdate.parse({ held: true })` ok; `SettingsUpdate.parse({ restaurantName: "X", holdOrdersEnabled: false }).holdOrdersEnabled` is `false`.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/migrations/hold-orders.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** the migration (two `ALTER TABLE` statements from Global Constraints) and the three schema fields.
- [ ] **Step 4: Run** the test again — PASS. Run `npx vitest run packages/domain` — all pass.
- [ ] **Step 5: Commit** `feat(domain): migration 45 adds held items and the hold-orders setting`.

### Task 2: Settings toggle on the server

**Files:**
- Create: `apps/server/src/order-settings.ts`
- Modify: `apps/server/src/settings.ts` (read/write `hold_orders_enabled`; broadcast)
- Modify: `apps/server/src/server.ts` (register `registerOrderSettings`, next to `registerSettings`)
- Test: `apps/server/src/settings.test.ts`

**Interfaces:**
- Produces: `holdOrdersEnabled(db: Database): boolean` and `registerOrderSettings(app: FastifyInstance): void` in `order-settings.ts`; `GET /api/order-settings` (permission `orders.read`) → `{ holdOrders: boolean }`; `GET/PUT /api/settings` include `holdOrdersEnabled: boolean`; `PUT /api/settings` broadcasts `settings.changed` with `{}`.

- [ ] **Step 1: Write failing tests** in `settings.test.ts`:
  - `round-trips holdOrdersEnabled`: GET shows `true`; PUT with `holdOrdersEnabled: false` returns `false`; PUT omitting it keeps `false` (COALESCE like `kotEditPrint`).
  - `order settings are readable by a waiter`: `createUser` with role `waiter`, GET `/api/order-settings` → 200 `{ holdOrders: true }`; after admin turns it off → `{ holdOrders: false }`.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/settings.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Add `hold_orders_enabled` to the SELECT/`SettingsRow`/JSON (`holdOrdersEnabled: r.hold_orders_enabled === 1`) and to the UPDATE as `COALESCE(?, hold_orders_enabled)` with `body.holdOrdersEnabled === undefined ? null : body.holdOrdersEnabled ? 1 : 0`. Call `app.broadcast("settings.changed", {})` after the update.
- [ ] **Step 4: Run** the test — PASS.
- [ ] **Step 5: Commit** `feat(server): hold-orders setting and order-settings endpoint`.

### Task 3: Held items on punch and edit

**Files:**
- Modify: `apps/server/src/order-items.ts:63-72` (`insertOrderItem` takes `held`)
- Modify: `apps/server/src/orders.ts:154-205` (items POST, item PATCH)
- Modify: `apps/server/src/mappers.ts:28-73` (`OrderItemRow.held: number`; `orderItemJson` adds `held: r.held === 1`)
- Create: `apps/server/src/hold-orders.test.ts`

**Interfaces:**
- Consumes: `holdOrdersEnabled(db)` (Task 2); schemas (Task 1).
- Produces: `insertOrderItem(db, orderId, item, ref: { clientRef: string | null; guestRequestId?: string | null; held?: boolean })` — only the combo line row gets `held`; order JSON items carry `held: boolean`.

- [ ] **Step 1: Write failing tests** in `hold-orders.test.ts`. Use the setup style of `kot-edit.test.ts` (`freshAppWithFakeSink`, `setupAdmin`, a category, a product on the first `kot_stations` row, a second product with the same station). Tests:
  - `punch stores held per item`: POST items `[{ productId: a, qty: 1, held: true }, { productId: b, qty: 1 }]` → response items `held` `true` / `false`.
  - `PATCH toggles held on a pending item`: PATCH `{ held: true }` → `held: true`; then `{ held: false }` → `false`; `qty` and `note` unchanged.
  - `PATCH held on a sent item is refused`: send, then PATCH `{ held: true }` → 409, message `item is not pending`.
  - `a held combo line carries the flag, its items do not`: create a combo product (follow the combo setup in `apps/server/src/combos.test.ts`), POST with `held: true`; DB: parent `held = 1`, children `held = 0`.
  - `setting off refuses new held items`: `PUT /api/settings` with `holdOrdersEnabled: false`; POST with `held: true` → 409 `Hold orders is turned off in Settings`; PATCH `{ held: true }` → same 409; PATCH `{ held: false }` on an already-held item → 200.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/hold-orders.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Add `held` to the INSERT column list for the line row (children always 0). In the POST route, refuse when any item has `held` and `!holdOrdersEnabled(app.db)` (check before the replay short-circuit only for new items). In PATCH, apply `held` when given (refuse `true` when off) in the same transaction as qty/note.
- [ ] **Step 4: Run** the test — PASS. Run `npx vitest run apps/server` — all pass (existing tests see `held: false` on items; update any exact-object snapshot of an order item if one fails).
- [ ] **Step 5: Commit** `feat(server): mark punched items held`.

### Task 4: KOT send skips held items; fire sends them

**Files:**
- Modify: `apps/server/src/kots.ts:17-168`
- Test: `apps/server/src/hold-orders.test.ts`

**Interfaces:**
- Produces: `POST /api/orders/:id/send` body gains `fire?: boolean`. `fire: true` requires `itemIds` or `itemRefs` (zod refine). Idempotency fingerprint is prefixed `fire:` when firing.

- [ ] **Step 1: Write failing tests:**
  - `KOT skips held items`: punch a (held) and b; send with no body → one KOT containing only b; a stays `pending`, `held: true`.
  - `skips a named held item`: punch a; another request PATCHes a to held; send `{ clientRef, itemIds: [a] }` → 409 `nothing to send`; a still pending.
  - `skips the items of a held combo`: held combo with a kitchen item; send → 409 `nothing to send`.
  - `fire sends held items and clears held`: send `{ clientRef, itemIds: [a], fire: true }` → 200, one KOT; a `sent`, `held: false`; a held combo fired by its line id sends its kitchen items and the combo line becomes `sent`.
  - `fire is idempotent`: repeat the same body → same KOT ids, no new `kots` rows.
  - `fire refuses an un-held item`: `fire: true` naming b → 409 `Only held items can be fired`; `fire: true` without items → 400.
  - `fire works with the setting off`: hold a, turn the setting off, fire a → 200.
  - `billing waits for held items`: held a → `POST /api/orders/:id/bill-preview` → 409 `Send kitchen items before billing`; after fire → 200.
  - `merge keeps held`: two dine-in orders on two tables (see `table-transfer.test.ts`), hold an item on the folded order, merge → the item on the receiving order still has `held: true`.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/hold-orders.test.ts` — the new tests FAIL.
- [ ] **Step 3: Implement.** Select `oi.held` and the parent's held (`LEFT JOIN order_items parent ON parent.id = oi.parent_item_id`, `COALESCE(parent.held, 0)`) in `allPending`. Without `fire`, drop items where the item or its parent is held, after the named-items filter. With `fire`, every named item must be a held line (else 409 `Only held items can be fired`), then proceed as a named send; inside the transaction run `UPDATE order_items SET held = 0 WHERE id IN (named)`.
- [ ] **Step 4: Run** `npx vitest run apps/server` — all pass.
- [ ] **Step 5: Commit** `feat(server): KOT skips held items; fire sends them`.

### Task 5: Pure UI helpers

**Files:**
- Create: `apps/ui/src/hold-order.ts`
- Create: `apps/ui/src/hold-order.test.ts`
- Modify: `apps/ui/src/types.ts:150-165` (`OrderItem.held?: boolean`), `apps/ui/src/types.ts:90` (`SettingsData.holdOrdersEnabled: boolean`)
- Modify: `apps/ui/src/offline-cache.ts` (order-settings copy)

**Interfaces:**
- Consumes: `kitchenLines`, `cartRowForKitchen` from `apps/ui/src/combo-cart.ts`.
- Produces (all exported from `hold-order.ts`):
  - `interface HoldDraftRow { clientRef: string; productId: string; variantId: string | null; qty: number; note: string; comboPicks?: string[]; held?: boolean }`
  - `punchItems(rows: HoldDraftRow[]): Array<{ clientRef: string; productId: string; variantId: string | null; qty: number; note?: string; comboPicks?: string[]; held?: true }>` — `held` only when true.
  - `heldLines(items: OrderItem[]): OrderItem[]` — pending, top-level (`!parentItemId`), `held`.
  - `sendableLines(items: OrderItem[], catalog: Product[]): OrderItem[]` — `kitchenLines` minus held lines.
  - `heldTargets(items: OrderItem[], cart: HoldDraftRow[], catalog: Product[]): { itemIds: string[]; itemRefs: string[]; count: number }` — held lines (by `clientRef` when present, else id) plus held cart rows for the kitchen (by `clientRef`), de-duplicated by ref.
  - `holdPrompt(n: number): string` — the exact copy in Global Constraints.
  - `holdControls(enabled: boolean, heldCount: number): { showHold: boolean; showFire: boolean }` — `showHold = enabled`; `showFire = heldCount > 0`.
  - In `offline-cache.ts`: `saveOrderSettingsCopy(userId: string, s: { holdOrders: boolean }): void` and `readOrderSettingsCopy(userId: string): { holdOrders: boolean } | null` (key `${userId}.order-settings`).

- [ ] **Step 1: Write failing tests** in `hold-order.test.ts` (one `it` per function; build catalog fixtures like `combo-cart.test.ts`):
  - `punchItems` keeps `held: true`, omits `held` when false, drops empty `note`.
  - `sendableLines` excludes a held line and a held combo; keeps an un-held pending kitchen line.
  - `heldTargets` counts a held punched line by ref, a held punched line without ref by id, and a held cart row not yet punched; a stationless held cart row is not counted; a held cart row already punched is counted once.
  - `holdPrompt(1)` = `Send 1 held item to the kitchen and continue?`; `holdPrompt(3)` = `Send 3 held items to the kitchen and continue?`.
  - `holdControls(false, 2)` = `{ showHold: false, showFire: true }`; `holdControls(true, 0)` = `{ showHold: true, showFire: false }`.
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/hold-order.test.ts` — FAIL.
- [ ] **Step 3: Implement** the helpers and cache functions.
- [ ] **Step 4: Run** — PASS. `npm run typecheck -w @masalapos/ui` — clean.
- [ ] **Step 5: Commit** `feat(ui): hold-order helpers`.

### Task 6: Order screen — Hold saves the cart, hold and fire dishes

**Files:**
- Modify: `apps/ui/src/screens/OrderScreen.tsx`
- Modify: `apps/ui/src/pos.css` (HELD badge, Hold toggle pressed state, Fire buttons; 44px targets inside the captain layout)

**Interfaces:**
- Consumes: everything from Task 5; `GET /api/order-settings`; `settings.changed` WS event; send body `fire: true` (Task 4); PATCH `{ held }` (Task 3).

- [ ] **Step 1: Settings load.** Add `holdOrders` state, initialised from `readOrderSettingsCopy(user.id)?.holdOrders ?? true`. In `reload()`, fetch `/api/order-settings` alongside the order (failure keeps the cached value; success saves the copy). In the WS handler, reload on `settings.changed`.
- [ ] **Step 2: Hold saves the cart.** `DraftItem` gains `held?: boolean`. `punchDraft` builds its `items` with `punchItems(fresh)`. `holdOrder()` becomes async through `run`-style locking: if the draft is non-empty, `await punchDraft()`; when `saved`, carry the message `Items saved on this device · sends when the connection returns` with `carryStatus`; on a thrown error, set the error and stay. Then leave as today. The captain menu's "Hold & return to tables" calls `holdOrder()` too. Both Hold buttons render only when `holdControls(holdOrders, …).showHold`.
- [ ] **Step 3: KOT leaves held items out.** In `sendPending`, use `sendableLines` instead of `kitchenLines`, and drop cart rows with `held` from `itemRefs`. `hasKitchenPending` uses `sendableLines` plus un-held kitchen cart rows, so the KOT button disables when only held dishes wait.
- [ ] **Step 4: Toggles and fire.** Cart rows that pass `cartRowForKitchen` get a `Hold` button with `aria-pressed={!!d.held}` (shown when `showHold`; disabled while queued like the other row controls) calling `updateDraft(clientRef, { held })` (widen `updateDraft`'s Pick to include `held`). Pending top-level kitchen lines get the same toggle calling `queued({ method: "PATCH", path: /api/order-items/${id}, body: { held }, lane: orderId, label })`; on `ApiError` 409 reload and show `${name} was already sent to the kitchen`. Held lines show `<span className="status held">held</span>` and a `Fire` button. When `heldTargets(...).count > 0`, show `Fire all held (${count})` next to KOT (captain: next to Send to kitchen). Firing posts `{ clientRef: uuid(), itemIds | itemRefs, fire: true }` (one request per non-empty list, like `sendPending`) through `queued` with label `Fire held items`; message `Fired · N tickets` or `Fire saved · prints when the connection returns`. Add `async function fireHeld(): Promise<{ saved: boolean }>` that punches the draft first, then fires `heldTargets` — Task 7 uses it.
- [ ] **Step 5: Verify.** `npm run typecheck -w @masalapos/ui` clean; `npx vitest run apps/ui` all pass.
- [ ] **Step 6: Commit** `feat(ui): hold an order to any device; hold and fire dishes`.

### Task 7: Billing prompt and Settings checkbox

**Files:**
- Modify: `apps/ui/src/screens/BillingPanel.tsx:51` (props), `:168-185` (`getPreview`)
- Modify: `apps/ui/src/screens/OrderScreen.tsx` (`prepareCheckout`, BillingPanel props)
- Modify: `apps/ui/src/screens/Settings.tsx:21-23,300-309`

**Interfaces:**
- Consumes: `fireHeld()` and `heldTargets` (Task 6/5); `holdPrompt` (Task 5); `holdOrdersEnabled` in settings (Task 2).
- Produces: `BillingPanel` props `heldCount?: number` and `onFireHeld?: () => Promise<void>`.

- [ ] **Step 1: Dine-in bill.** In `getPreview`, when `!onPrepare && heldCount > 0`: `if (!window.confirm(holdPrompt(heldCount))) throw new Error("Billing cancelled. The held dishes are still waiting.")`, then `await onFireHeld?.()`. OrderScreen passes `heldCount={heldTargets(order.items, draft, products).count}` and `onFireHeld` that runs `fireHeld()` and throws `Saved on this device. Connect to the hub to review the bill.` when `saved`.
- [ ] **Step 2: Takeaway Pay.** In `prepareCheckout`, before `sendPending`, compute `heldTargets` with the current draft; if `count > 0`, confirm with `holdPrompt(count)` (No → throw the same "Billing cancelled…" error), then `punchDraft` and fire, then `sendPending` as today.
- [ ] **Step 3: Settings.** `SettingsData.holdOrdersEnabled` default `true` in `EMPTY_SETTINGS`; add it to the `Exclude<…>` in `SETTINGS_FIELDS`; render a checkbox labelled `Hold orders` with the InfoTip copy from Global Constraints, after the kitchen-slip select; it saves with the profile.
- [ ] **Step 4: Verify.** `npm run typecheck` (root) clean; `npx vitest run` all pass.
- [ ] **Step 5: Commit** `feat(ui): billing asks to fire held dishes; Hold orders setting`.

### Task 8: Browser check and docs

**Files:**
- Create: `tools/e2e/hold-order.js` (follow `tools/e2e/m10-takeaway.js` and `tools/e2e/README.md` for server start and login)
- Modify: `tools/e2e/README.md` (list the script)
- Modify: `docs/operations/quick-takeaway.md`, `docs/operations/tables-workspace.md`, `docs/operations/keyboard-shortcuts.md`, `docs/operations/captain-app.md`

- [ ] **Step 1: Write the e2e script** covering:
  1. Dine-in: open a table, add a starter and a main, toggle Hold on the main, KOT → one ticket without the main; the main shows HELD; Fire → second ticket; Bill works.
  2. Dine-in hold-prompt: hold a dish, click the bill preview → confirm dialog text `Send 1 held item to the kitchen and continue?`; accept → bill preview shows.
  3. Takeaway shared cart: in page A add two dishes, press Hold (F8); in page B (second browser context, same user) open the takeaway from Open takeaways → both dishes listed under Punched items.
  4. Setting off: uncheck Hold orders in Settings, save; reload the order → no Hold button, F8 does nothing; an already-held dish still shows Fire.
- [ ] **Step 2: Run it** per the README; expected: all steps pass. Capture failures with screenshots per the existing scripts.
- [ ] **Step 3: Docs.** quick-takeaway.md (Hold · F8 now saves the cart for every device; setting), tables-workspace.md (hold and fire dishes; billing prompt; setting), keyboard-shortcuts.md (F8 only when Hold orders is on), captain-app.md (Hold & return saves the cart; per-dish Hold/Fire).
- [ ] **Step 4: Full verification.** `npx vitest run` and `npm run typecheck` — both clean.
- [ ] **Step 5: Commit** `test(e2e): hold order; docs`.

Manual, not automated here: the captain flow on the real Android tablet (no emulator on this VM).
