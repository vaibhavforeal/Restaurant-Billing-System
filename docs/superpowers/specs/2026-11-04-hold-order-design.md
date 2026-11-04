# Hold order: shared held carts and kitchen hold

Date: 2026-11-04 · Branch: `feat/hold-order` (from `fix/audit-bugs`, for the migration baseline) · Status: approved in chat, awaiting spec review

## Why

Counter staff and captains need to hold an order while ordering, for both dine-in and takeaway:

1. **Resume a held order from any device.** Today Hold (F8) parks a takeaway or returns to tables, but cart items that were not
   punched stay in that browser's localStorage (`masalapos.draft.<userId>.<orderId>`). Another counter or a captain tablet
   cannot see them.
2. **Hold individual items back from the kitchen** (send starters now, mains later) and fire them later.
3. **A restaurant setting** turns the whole feature on or off.

## What exists today (and is kept)

- Every order is a server row from the moment it opens (`POST /api/orders`). Dine-in orders stay `open` across any number of
  KOTs; takeaways can be parked and resumed from "Open takeaways".
- **Punch** saves cart rows as `order_items` with status `pending` (visible to every device). **KOT** (`sendPending`) punches
  and then sends every pending kitchen item via `POST /api/orders/:id/send`, which already accepts a subset (`itemIds` or
  `itemRefs`).
- Billing refuses while kitchen items are unsent (`billing.ts`, "Send kitchen items before billing"). Quick takeaway checkout
  (`prepareCheckout`) sends everything first.
- Hold today: `holdOrder()` in `OrderScreen.tsx` (takeaway: `releaseHeldTakeaway` + back; dine-in: back). Captain menu has
  "Hold & return to tables". Shortcut id `hold` (F8).

## Design

### 1. Hold saves the cart to the hub

`holdOrder()` (and the captain's "Hold & return to tables") calls `punchDraft()` before leaving. Held cart rows keep their
kitchen-hold flag (section 2) through the punch.

- Online: rows become `pending` order items; any device opening the order sees them under "Punched items" / "Saved items".
- Offline: the punch is queued in the existing retry queue (lane = order id). The screen shows
  "Items saved on this device · sends when the connection returns" and still leaves. The existing rule stays: a quick
  takeaway is not held while the order has queued actions that need review.
- If the punch fails with a server error, Hold stops and shows the error (the cart stays).
- "← Tables" is unchanged: it does not punch.

### 2. Hold items back from the kitchen

**Data** — migration `hold-orders`, **version 45** (Dynamic Reports owns 44; versions only need to ascend):

```sql
ALTER TABLE order_items ADD COLUMN held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1));
ALTER TABLE settings ADD COLUMN hold_orders_enabled INTEGER NOT NULL DEFAULT 1 CHECK (hold_orders_enabled IN (0, 1));
```

`held` only means something while the item is `pending`. A flag (not a new `status`) avoids rebuilding the
`order_items.status` CHECK and touching every `status = 'pending'` check (cancel, edit, billing, merge). It is set on the
line staff toggled; for a combo, the combo line carries the flag and its child items follow it.

**Server**

- `POST /api/orders/:id/items`: each item accepts optional `held: boolean` (default false).
- `PATCH /api/order-items/:id`: accepts `held: boolean`; pending items only (sent items: 409, as for other edits).
- `POST /api/orders/:id/send`:
  - Without `fire`, held items are skipped: an item is skipped when it is held or its combo parent is held. When the
    request names items, a named held item is skipped too (the counter's view may be stale). If nothing is left to send, the
    existing 409 "nothing to send" stands.
  - With `fire: true`, the request must name items (`itemIds` or `itemRefs`); only held items may be named (409 otherwise).
    They are sent as a normal KOT and `held` is cleared in the same transaction. `fire` is part of the idempotency
    fingerprint in `kot_requests`.
- Setting off (`hold_orders_enabled = 0`): `held: true` on new items or via PATCH is refused with 409
  "Hold orders is turned off in Settings". Firing and cancelling already-held items still work, so nothing is stuck.
- Billing: unchanged. Held kitchen items are pending, so the existing "Send kitchen items before billing" check blocks the bill
  until they are fired or cancelled.
- Merge and move: held items are ordinary pending rows and travel with the order; the flag is preserved.

**UI** (`OrderScreen.tsx`; cashier and captain share it)

- Cart rows for kitchen items (`cartRowForKitchen`) get a **Hold** toggle (a pressed-state button, 44px target on tablets).
  `DraftItem` gains `held?: boolean`; punch sends it.
- Punched pending lines that are held show a **HELD** badge and a **Fire** button. A pending line that is not held gets a Hold
  toggle too (PATCH).
- When the order has held items, a **Fire all held (n)** button sits next to KOT (captain: next to Send to kitchen).
- KOT / Send to kitchen leaves held items out (both punched lines and cart rows). Its button is enabled only when something
  un-held is waiting.
- Fire actions go through the retry queue like KOT, with their own `clientRef`.

### 3. Billing with held items

- Dine-in **Bill** (BillingPanel preview/issue) and quick takeaway **Pay · F10** (`prepareCheckout`): when the order has held
  items, ask `Send N held items to the kitchen and continue?`. Yes fires them (one KOT request), then continues; No returns
  to the order unchanged.
- BillingPanel gets `heldCount` and `onFireHeld` props; `prepareCheckout` asks before its send.
- The server check in section 2 is the backstop.

### 4. Settings toggle

- **Settings → Restaurant profile**: a "Hold orders" checkbox next to "Kitchen slip when a sent item is changed", with an
  InfoTip: "Staff can hold an order to finish later on any device, and hold dishes back from the kitchen until they fire them."
  Saved with the profile (`PUT /api/settings`, `holdOrdersEnabled` in `SettingsUpdate`). On by default.
- `PUT /api/settings` broadcasts `settings.changed` so open screens refresh.
- Order screens cannot read `/api/settings` (it needs `settings.manage`), so a new `GET /api/order-settings`
  (`orders.read`) returns `{ holdOrders: boolean }`. OrderScreen loads it with the order, keeps the last value in its offline
  catalog copy, and reloads on `settings.changed`.
- When off: the Hold · F8 button, the captain's "Hold & return to tables", the per-item Hold toggles and Hold on pending lines
  are hidden. The F8 shortcut does nothing. **Fire**, **Fire all held** and the billing prompt still show for items that are
  already held.

## Error handling

- Hold punch fails (server error): stay on the order, show the error, keep the cart.
- Fire fails: show the error; items stay held. A queued fire shows "Fire saved · prints when the connection returns".
- Hold toggled on an item that was sent meanwhile: 409 → reload and show "already sent to the kitchen".
- Stale screen after the setting is turned off: server 409 explains; the screen reloads settings on `settings.changed`.

## Testing

- **Domain**: migration 45 adds both columns with defaults on a baseline database.
- **Server** (`apps/server/src/*.test.ts`):
  - items POST / PATCH store and toggle `held`; PATCH on a sent item is 409.
  - send without `fire` skips held items and combo children of a held combo; only-held → 409 "nothing to send".
  - send with `fire` sends named held items, clears `held`, is idempotent on `clientRef`; naming an un-held item → 409.
  - billing is refused while a held kitchen item exists, and works after fire.
  - setting off: `held: true` refused (POST and PATCH); fire and cancel of existing held items still work.
  - settings round-trip `holdOrdersEnabled`; `GET /api/order-settings` for a waiter.
- **UI** (vitest): Hold punches the cart (online and queued); a held draft row keeps `held` through punch; KOT excludes held
  rows; the billing confirm fires then continues; with the setting off, the Hold controls are hidden and Fire still shows.
- **Browser** (Playwright, desktop UI): dine-in hold starters/fire mains/bill; takeaway hold on one tab and resume on another.
- **Manual**: captain flow on the real Android tablet (no emulator on this VM).

## Docs

Update `docs/operations/quick-takeaway.md` (Hold · F8, including the setting), `tables-workspace.md` (kitchen hold and
fire), `keyboard-shortcuts.md` (F8 depends on the setting) and `captain-app.md`. There is no general settings guide; the
setting is described in `tables-workspace.md` and `quick-takeaway.md`.

## Out of scope

- Course-based firing (starter/main/dessert).
- Saving the cart to the hub on "← Tables" or on every change.
- Takeaway token numbers, named holds.
- Kitchen display changes (held items are not on the KDS until fired).

## Merge note

Version 45 sits after Dynamic Reports' 44. A dev database that runs 45 before 44 exists would skip 44 later; start such
databases fresh (nothing is live yet).
