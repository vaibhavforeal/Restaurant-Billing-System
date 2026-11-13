# MasalaPOS Cafe, Phase 2: counter extras (spec addendum)

Date: 2026-11-13. Branch: `feat/cafe-mobile`. Parent spec: `2026-11-13-cafe-mobile-design.md` (its "Phase 2 in
outline" section is replaced by this addendum). Phase 1 handover: `docs/agents/handoff/2026-11-13-cafe-mobile-phase-1.md`.

## Purpose

Phase 1 made the phone a working till for one person. Phase 2 makes it fit a real counter: more than one person uses
it, dishes come with add-ons, the owner runs offers, the kitchen gets a slip, regular customers and delivery orders are
recorded, a second customer can be served while the first decides, and a bill can be sent to a customer's phone.

Everything stays on the device and works offline. Nothing in this phase talks to a server; sync is Phase 3. New
synced tables follow the parent spec's rules (UUIDv7 `id`, `updated_at`, `deleted_at`) so Phase 3 can carry them.

## Decisions made for this phase

| Topic | Decision |
|---|---|
| Roles | Three fixed roles: Owner, Manager, Cashier. No per-person permission switches |
| When a PIN is asked | When the app opens and after a set idle time, plus a **Switch staff** button. Each bill records who made it |
| Higher permission needed | An **Approve** sheet takes a manager's or the owner's name and PIN for that one action, and records who approved |
| PIN hash | PBKDF2-SHA256 from `@noble/hashes`, a random salt per person, the iteration count stored in the hash |
| Order types | Two fixed ids, `takeaway` (the default) and `delivery`; there is no order-type editor |
| Line note | A short note per cart line ("less sugar"), printed on the kitchen slip. Added in this addendum |
| Share format | The receipt as a PNG image through Android's share sheet |
| Build sessions | One plan, two build sessions: 2A, then 2B, each ending with a commit and a handover note |
| Phase 1 debt | Five deferred items are fixed in 2A (listed below) |

## Session 2A

### 1. Staff and PINs

**Data.** Migration 4 adds:

| Table | Synced | Columns beyond the common ones |
|---|---|---|
| `staff` | yes | name, role (`owner`, `manager`, `cashier`), pin_hash, active (0/1), sort |

and these columns:

- `bills.staff_id` (who made the bill) and `bills.approved_by` (who approved a discount above the cashier's limit; null
  when no approval was needed).
- `bill_voids.staff_id` (who voided, or approved the void).
- `cafe.cashier_discount_bp` (basis points, default 0) and `cafe.lock_after_minutes` (default 5; 0 means never).

`cafe.owner_pin_hash` is no longer read. The migration creates an owner staff row named "Owner" from it, keeping the
old hash string. The old format (SHA-256 of `deviceId:pin`) is recognised by its lack of the `pbkdf2-sha256$` prefix,
is accepted once, and is replaced by a new hash on that successful entry. This only matters for the test phone; no
cafe uses the app yet.

**Roles** are code, in `packages/cafe-data/src/roles.ts`, as `Role` objects checked with `can` from `@masalapos/core`:

| Permission | Owner | Manager | Cashier |
|---|---|---|---|
| `bills.create` (bill, hold, take payment) | yes | yes | yes |
| `bills.print` (reprint, share) | yes | yes | yes |
| `bills.discount` (any discount above the cashier limit) | yes | yes | no |
| `bills.refund` (void) | yes | yes | no |
| `customers.manage` | yes | yes | yes |
| `reports.read` | yes | yes | no |
| `catalog.manage` (menu, add-ons, offers) | yes | yes | no |
| `printers.manage` | yes | yes | no |
| `staff.manage` | yes | no | no |
| `settings.manage` (cafe, tax, receipt, kitchen slip, lock time, cashier limit) | yes | no | no |

The owner role is `["*"]`. A cashier's discount is checked with `withinDiscountCap`, using a cashier role whose
`limits.max_discount_percent` comes from `cafe.cashier_discount_bp`. A discount above it asks for approval.

**PIN hashing** moves from the app into `packages/cafe-data/src/pin-hash.ts` so it runs under vitest:

```ts
hashPin(pin: string, opts?: { iterations?: number; salt?: Uint8Array }): Promise<string>
verifyPin(pin: string, stored: string, legacy?: { deviceId: string }): Promise<{ ok: boolean; rehash: boolean }>
```

The stored form is `pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>`, with a 16-byte salt from
`crypto.getRandomValues`. It uses `pbkdf2Async` so the screen does not freeze. The default iteration count is set in
the plan after measuring on the test phone, with 300 ms for one check as the ceiling. Raising it later costs nothing:
`verifyPin` reports `rehash: true` for a stored count below the current default. A PIN is 4 to 6 digits. Two people may
have the same PIN, because the name is picked first.

**Lock screen.** A route outside the tabs that shows the active staff as tiles, then a PIN keypad. It appears:

- when the app starts, after the database opens;
- when the app comes back to the foreground after `lock_after_minutes` without a touch;
- when **Switch staff** is tapped (on the Bill screen's header and in More).

The current staff member is held in memory only. Wrong tries lock that person's entry exactly as the Phase 1 owner
PIN does (30 s, doubling, stored in `local_state` under `pin:<staffId>:*`), so restarting the app does not reset it.

**Approve sheet.** When the current person lacks a permission, the action opens a sheet listing the active staff whose
role holds it; one of them picks their name and enters their PIN. The approval is for that one action only. Its id
goes into `approved_by` or `bill_voids.staff_id`. Menu, Reports and the protected parts of More ask once on entry and
stay open until the screen is left.

**Staff screen** (More, owner only): add a person (name, role, PIN entered twice), change name or role, reset a PIN,
deactivate. The last active owner cannot be deactivated or demoted. Deactivated staff stay on their old bills.

**Receipt and report.** `createBill` freezes the staff name into `ReceiptSnapshot.servedBy`; whether it prints follows
the cafe's receipt settings. `daySummary` gains sales by staff (bill count and total, voids excluded).

### 2. Takeaway or Delivery

- The cart has a two-way switch, Takeaway by default, and holds `orderKind` and `deliveryNote` (up to 200 characters,
  only with Delivery). The switch goes back to Takeaway when the cart is cleared.
- Migration 4 adds `bills.order_kind` (`takeaway` or `delivery`, default `takeaway`) and `bills.delivery_note`.
- The snapshot gets `orderTypeKind` set to match, and `orderTypeName` "Takeaway" or "Delivery". `ReceiptSnapshot`
  gains an optional `deliveryNote?: string`, which `receiptSlip` and `receiptHtml` print under the order line when
  set. A test proves a Windows POS bill without it prints exactly as before.
- `daySummary` gains sales by order kind.

### 3. Customers

- Migration 4 adds a synced `customers` table: name, phone (stored as 10 digits after removing spaces, `+91` and a
  leading 0; unique among live rows), address_note (up to 200 characters).
- The cart has a **Customer** button. It opens a sheet that searches by phone or name as you type, with **Add
  customer** when nothing matches. A chosen customer shows on the cart and can be removed.
- `bills.customer_id` is stored. `ReceiptSnapshot.customer` gets `{ name, phone }` with the phone masked as the Windows
  POS masks it (last four digits). With Delivery and an empty note, the customer's address fills the note.
- More, **Customers**: a searchable list, edit, and the customer's bills (newest first, opening to the bill screen).
  A customer with bills can be deleted; their old bills keep the frozen name.

### 4. Hold order

- Migration 4 adds `held_carts`, not synced: id, cart_json, note, staff_id, created_at.
- **Hold** (enabled when the cart has lines) asks for an optional note (up to 40 characters), saves the cart and
  clears the screen. The cart JSON holds item and variant ids, quantities, custom lines, line notes, the discount as
  entered, the order kind, the delivery note and the customer id. It holds no prices.
- **Held (n)** on the Bill screen lists held carts oldest first with the note, line count, who held it and its age.
  Opening one deletes its row and loads it into the cart. If the cart already has lines, the choice is **Hold this one
  and open** or **Cancel**. A held cart can be deleted after a confirm.
- Prices, availability, add-ons and offers are worked out when the cart is opened, the same as a live cart, so an
  item made unavailable meanwhile is named in the usual way.
- Held carts never expire on their own; Held shows "yesterday" or the date for old ones.

### 5. Kitchen slip and line notes

- Migration 4 adds `cafe.kitchen_slip` (`off`, `kitchen`, `receipt`; default `off`). More, Printers, shows the choice;
  `kitchen` needs a printer with the `kitchen` role, else the choice is disabled with a reason.
- Cart lines get an optional `note` (up to 60 characters), set from a long press on the line. Migration 4 adds
  `bill_lines.note`. Notes do not print on the receipt.
- `KotSlipCtx` gains an optional `token?: number`. When set, the heading reads `TOKEN n` in double size instead of
  `KOT #n`. The Windows output does not change; a test proves it.
- After **Paid**, the kitchen slip is queued after the receipt: `orderType: "parcel"`, `orderTypeName` "Takeaway" or
  "Delivery", the delivery note as a final line, and the bill's lines with their notes (custom lines included).
- The token screen shows the receipt and kitchen slip as two print statuses, each with its own **Try again**. A
  failed slip never affects the saved bill. Bills, a bill, gets **Reprint kitchen slip** when the setting is on.

### 6. Phase 1 fixes

1. **Midnight.** Bills and Reports follow today's date when the app is open across midnight, unless another date was
   picked.
2. **Three-way split.** The payment screen's split covers cash, UPI and card together. The rules stay: the payments add
   up to the total, and only cash can be tendered with change.
3. **Unreadable amount.** "Another amount" that cannot be read disables **Paid** and says why.
4. **Discount above the bill.** An amount discount above the bill shows "The discount is more than the bill" and is not
   applied, in place of a silent cap.
5. **First run.** If the cafe exists but no active owner does, the app opens on **Set owner PIN** before anything else.

### 2A is done when

On the phone, in flight mode: the owner adds a cashier; the cashier logs in with a PIN, makes a Delivery bill for a new
customer with a line note, needs a manager's PIN to give a 10% discount when the limit is 5%, and holds a second cart
then opens it; the receipt and a `TOKEN n` kitchen slip print; the app locks after the idle time; Reports shows staff
and order-kind figures.

## Session 2B

### 7. Add-ons

**Data.** Migration 5 adds synced tables matching the Windows POS model:

| Table | Columns beyond the common ones |
|---|---|
| `addon_groups` | name, min_picks, max_picks, active, sort |
| `addon_group_options` | group_id, item_id, variant_id (null for an item without variants), sort |
| `item_addon_groups` | item_id, group_id, sort (`id` is a UUIDv7, so the row can sync) |

and `items.addon_only` (0/1, default 0): an add-on-only item ("Extra shot") is hidden from the Bill tiles and search
but can be chosen as an add-on. `bill_lines.addon_of_line_id` points an add-on line at its dish line.

**Rules.** Groups are checked with `AddonGroupCreate` and `AddonGroupUpdate` from `@masalapos/domain/addons`. An option
is an item (and variant) on the menu. Its price and GST rate are the item's own, and it is unavailable when the item
or variant is.

**Bill screen.** Tapping an item with variants or add-on groups opens one sheet: the variant choice first (when it has
variants), then each active group with its "choose 1" or "up to 3" rule. **Add** stays disabled until the picks meet
every minimum. An item with neither is added straight away, as now.

**Cart and bill.** A cart line holds `addonOptionIds`. Its dish and add-ons move together: the stepper changes the
dish's quantity, and every add-on line has the same quantity. `createBill` loads the dish's groups, calls
`resolveAddonPicks` (an `AddonPickError` becomes a `BillError` with code `addon_invalid` and the domain's message), and
writes the dish line, then one line per add-on in group and option order with `addon_of_line_id` set. Receipt items
for add-ons carry `addon: true`, so they print as `+ name` under their dish; the kitchen slip does the same.

**Menu.** Menu gets **Add-on groups** (list, add, edit: name, min, max, options picked from the menu, active) and the
item screen gets **Add-on groups** (attach, detach, order) and an **Add-on only** switch. Deleting an item that is an
option removes it from its groups; a group left with no options becomes inactive.

**Reports.** Item-wise figures count add-on lines like other lines.

### 8. Offers

**Data.** Migration 5 adds a synced `offers` table with one column per `OfferInputValue` field: name, active, kind,
buy_qty, get_qty, same_item_only, percent_bp, amount_paise, min_bill_paise, max_discount_paise, category_ids (JSON),
product_ids (JSON, holding item ids), valid_from, valid_until, days (JSON), time_from, time_until, order_type_ids (JSON,
`takeaway` and/or `delivery`), created_at. Rows are checked with `OfferInput` before saving.

**Clock.** `cafeOfferClock(now, tzOffsetMinutes)` in `packages/cafe-data/src/time.ts` returns the local date, weekday
(Monday = 0) and minutes from midnight in the device's zone. The domain's `offerClock` is not used, because it reads the
running machine's zone.

**Pricing.** `previewBill` and `createBill` take `pricedAt`, `orderKind` and `removedOfferIds`. Both build `OfferLine`s
from the resolved lines (add-on lines included, each with its own item and category), call `applyOffers` with the live
offers, and pass each line's discount to `calculateBill` as `offerDiscountPaise`. `createBill` stores it in
`bill_lines.offer_discount_paise` and puts `{ name, discountPaise }` per applied offer in `receipt.offers`.

The payment screen fixes `pricedAt` when it opens and passes it to `createBill`, so an offer whose time window ends
while the customer is paying does not change the total under them. Opening the payment screen again prices it again.

**Bill screen.** The cart lists the applied offers with their saving. Each has a remove button, which puts its id into
the cart's `removedOfferIds`; **Restore** brings it back. Removing an offer needs no permission, since it only raises
the price. The bill discount applies after offers, as `calculateBill` already does.

**Menu, Offers** (`catalog.manage`): a list with an on/off switch and the rule in words ("Buy 2 get 1 free on
Coffee, weekdays 4-6 pm"), and an editor with the kind, amounts, items or categories, dates, days, times and order
kinds. Messages come from `OfferInput`'s issues.

**Reports.** `daySummary` gains discount per offer name, voids excluded.

### 9. Bill sharing

- Adds `react-native-view-shot` and `expo-sharing`, checked against the current Expo SDK documentation in the plan's
  first 2B task.
- **Share** on the token screen and on a bill's screen renders the existing `ReceiptView` off screen at a fixed width,
  captures it as a PNG into the cache folder, and opens Android's share sheet. The file is deleted on the next share.
- A voided bill shares with its VOID mark, as it shows on screen.

### 2B is done when

Phase 2 is done when, on a real phone and printer, in flight mode: a cashier logs in with a PIN; makes a
Delivery bill for a saved customer with a dish and two add-ons and a time-window offer; a manager's PIN approves a
discount above the cashier's limit; the receipt and the `TOKEN n` kitchen slip print with the add-ons under their dish;
the receipt is shared to WhatsApp as an image; the day report shows the staff, order-kind and offer figures; and the
bill's totals equal `calculateBill`'s, because they come from it.

## Errors and edge cases

| Case | Behaviour |
|---|---|
| Wrong PIN | "Wrong PIN"; after five, that person's entry locks for 30 s, doubling, across restarts |
| All owners locked out of their PIN | Not solved here; Phase 3's Google sign-in resets the owner PIN. Until then the owner reinstalls. The operations doc says so |
| Last owner deactivated or demoted | Refused with a message |
| Cashier gives a discount above the limit with nobody to approve | The discount is not applied; the bill can go ahead without it |
| An add-on or its dish made unavailable while in the cart, or held | The line is named and **Charge** is disabled until it is removed or changed |
| An add-on group edited while a cart holds picks from it | `createBill` rejects with the domain's "The add-ons changed. Choose them again."; the line opens its sheet again |
| An offer's window ends during payment | The bill keeps the price shown when payment opened |
| Kitchen slip fails | The bill is saved; the slip's own **Try again**; reprint from the bill |
| Two customers share a phone number | Refused; the sheet offers the existing customer |
| Share target app missing or share cancelled | Nothing happens; no error is logged for a cancel |

## Testing

Tests are written first for `cafe-data` and `print`, in Node under vitest on `better-sqlite3`:

- Migrations 4 and 5 from empty and from a Phase 1 database, including the owner row made from `owner_pin_hash`.
- `pin-hash`: round trip, wrong PIN, a legacy hash verifies once and asks for a rehash, a low iteration count asks for
  a rehash.
- Roles: every cell of the table above; `withinDiscountCap` with the cafe's limit.
- Staff repository: the last-owner rule, deactivation, lockout keys.
- Customers: phone normalising, uniqueness, search, bills by customer.
- Held carts: save, list order, open-and-delete, survive a restart.
- `createBill`: staff, approver, customer, order kind and delivery note in the row and the snapshot; line notes; add-on
  lines in order with the dish's quantity; each `resolveAddonPicks` failure; offers of each kind, with removal, an
  order-kind target and a time window at the edge of `pricedAt`; offers together with add-ons and a bill discount.
- `daySummary`: sales by staff, by order kind and by offer, voids excluded.
- `print`: `TOKEN n` kitchen slip; delivery note on the receipt and the slip; Windows receipts and KOTs unchanged.
- `tools/phone-safe-imports.test.ts` stays green with `@noble/hashes` and the new screens.

On a real phone and printer, by hand: each session's "done when" list, plus the lock after idle time, a tablet layout
of the new sheets, and a fresh install going through first run into the lock screen.

## Not in this phase

Per-person permission switches, more order types, customer loyalty and points, combos, item notes on the receipt,
add-on prices different from the item's own, sharing as PDF or a link (the link is Phase 3), and anything that needs a
server.
