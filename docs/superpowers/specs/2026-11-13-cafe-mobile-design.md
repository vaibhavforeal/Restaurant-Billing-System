# MasalaPOS Cafe: a standalone Android app for cafes and takeaway

Date: 2026-11-13. Branch: `feat/cafe-mobile`, from `main` (329d31c). Worktree: `E:\Softwares\masalapos-cafe`.

## Purpose

A cafe or takeaway counter bills from a phone or tablet with a Bluetooth printer. There is no Windows PC, no tables
and no dine-in flow. The phone is the whole POS and keeps working with no internet. A cloud account backs the data
up, lets the owner look in from another device, and later allows more counters.

Who it is for: owners of small cafes, tea and juice counters, bakeries and takeaway kitchens, who find MasalaPOS on
Google Play and set it up themselves.

Success: an owner installs the app, signs in with Google, enters a menu, pairs a printer and prints a correct GST
bill in three taps (item, Charge, Cash), in flight mode, with the same totals the Windows POS would give.

## Decisions already made

| Topic | Decision |
|---|---|
| Data home | On the phone, fully usable offline, plus a MasalaPOS cloud account |
| Platform | Android only |
| Devices per cafe | One billing device at release; the data is shaped so more can be added later |
| Technology | React Native (Expo) in TypeScript, sharing the existing pricing, GST, offers and receipt code |
| First-release extras | Add-ons and offers, kitchen slip, staff logins and roles, customer details and bill sharing |
| Onboarding | Self sign-up from Google Play |
| Sign-in | Google sign-in for the owner; staff use PINs on the device |
| Paying for the app | Google Play subscription after a free trial |
| Model for coding | Opus 5.5, in each phase's own build session |
| Relation to the Windows POS | A separate product and a separate build. A cafe that later moves to the Windows POS starts fresh there; nothing is migrated, and its old bills stay viewable in the phone app |
| Play Console | Last. Everything that needs the account is in Phase 5 |

Assumptions the owner of this project accepted with the plan, and can still change:

- The name is `MasalaPOS Cafe` and the application id is `app.masalapos.cafe`.
- The free trial is 7 days, as for Windows POS trial orders. Prices are set before Phase 5.
- The cloud side is a new module in the existing licensing service, with its own database.
- The UI is in English at release. It has phone and tablet layouts and prints on 58 mm and 80 mm paper.

## Not in this product

Tables, dine-in, captains, the kitchen display, stock and recipes, Zomato, reservations, loyalty points, combos,
B2B tax invoices with a buyer GSTIN, partial refunds, and any migration of data to the Windows POS. Any of these can
be proposed later as its own piece of work.

## Why Google Play Billing

Google's Payments policy lists "cloud software and services (such as ... business productivity software)" among the
purchases that must use Google Play's billing system when sold inside a Play-distributed app. For users in India a
second billing system may be offered beside it, with Google's fee reduced by 4 points, and every such payment must
be reported to Google within 24 hours. A self sign-up app with a Buy button therefore uses Play Billing. Razorpay
beside it is left out: it needs both integrations and saves little.
Sources: `support.google.com/googleplay/android-developer/answer/10281818` and `/answer/13306652`, read 2026-11-13.

## What already exists and is reused

- Bill arithmetic: `calculateBill` and the `Bill`, `BillTotals` and `ReceiptSnapshot` types in
  `packages/domain/src/billing.ts`. It is pure integer-paise code.
- GST modes and rates: `packages/domain/src/gst.ts`. Rounding: `round-off.ts`.
- Invoice number format and financial year: `financialYear`, `formatInvoiceNo` and `formatCreditNoteNo` in
  `packages/domain/src/invoice-numbers.ts`.
- Add-ons: `packages/domain/src/addons.ts`. Offers: `packages/domain/src/offers.ts` (`applyOffers`).
- Permissions: `packages/core/src/rbac.ts` and `packages/domain/src/staff-permissions.ts`.
- Ids: `uuidv7` in `packages/domain/src/id.ts`.
- Receipt and slip bytes: `EscPos` (`apps/server/src/print/escpos.ts`), `receiptSlip` (`receipt.ts`), `kotSlip`
  (`templates.ts`), `finishSlip` (`profile.ts`), `billUpiPayment` and `upiQrRaster` (`upi.ts`).
- Signed entitlements checked offline: `packages/core/src/signed-license.ts` (Ed25519).
- The licensing service and Portal: `apps/licensing-worker`, `apps/licensing-node`, `apps/portal`.
- The Android build pattern: `tools/build-captain-android.mjs` finds a JDK 17+ (this machine has JDK 21 and Android
  Studio's JBR) and the SDK at `E:\Android\Sdk`.

What stops this code running on a phone today:

| Blocker | Where | Fix | Phase |
|---|---|---|---|
| `node:crypto` for random bytes | `packages/domain/src/id.ts` | Use `globalThis.crypto.getRandomValues` (Node 24 has it; the app adds the Expo polyfill) | 1 |
| `Buffer` in the byte builder | `apps/server/src/print/escpos.ts` and its callers | Build `Uint8Array`; the server wraps the result where it needs a `Buffer` | 1 |
| Print code lives in the server app | `apps/server/src/print/` | Move the pure files to `packages/print` | 1 |
| The database layer is `better-sqlite3` | `packages/domain/src/db.ts` | The phone gets its own data layer, `packages/cafe-data` | 1 |
| `node:crypto` for Ed25519 | `packages/core/src/signed-license.ts` | A second verifier on a pure-JS Ed25519 library, tested against the same vectors | 4 |

`packages/core/src/password.ts` (scrypt on `node:crypto`) is not used by the app. Staff PINs are hashed on the
phone with a hash chosen in the Phase 2 plan.

## Architecture

```
apps/cafe-android        The Expo React Native app: screens, navigation, the printer module (Kotlin),
                         and later Google sign-in and Play Billing.
packages/cafe-data       New. The phone's data layer: schema, migrations, repositories, the bill flow,
                         and later the sync outbox. It talks to a small SqlDriver interface.
packages/print           New. The receipt, slip and UPI QR byte builders, moved out of apps/server.
packages/domain          Existing pure rules, imported through their subpath exports.
packages/core            Existing RBAC; gains a phone-safe licence verifier in Phase 4.
apps/licensing-worker    New module src/cafe/: accounts, devices, sync, entitlements, Play verification.
apps/portal              A list of cafes with their trial and subscription state.
```

Each unit has one job:

- `packages/print` turns a `Bill` or a slip context into bytes. It does no I/O.
- `packages/cafe-data` turns user actions into rows and rows into domain objects. It knows SQL and the domain
  rules. It does not know React, Expo or Bluetooth, so it runs in Node under vitest against `better-sqlite3`.
- The printer module moves bytes to a printer. It knows nothing about bills.
- The app's screens call `cafe-data` and `print`, then hand bytes to the printer module.

### Rules that keep "one device now, several later" cheap

- Every synced row has a UUIDv7 `id`, an `updated_at` and a `deleted_at`. Nothing depends on auto-increment ids.
- A bill is written once, when it is paid, and never changes. A void is a separate row.
- Invoice numbers carry a per-device series. Tokens are a per-device daily counter.
- Bills only travel up to the cloud. Menu, settings, staff and customers travel both ways.
- At release the cloud allows one billing device per cafe plus owner-view devices. Allowing more is a limit change.

## Phases

Each phase has its own implementation plan and its own build session on Opus 5.5, run inline, with commits at the
end and a note of where to pick up. Phase 1's plan is `docs/superpowers/plans/2026-11-13-cafe-mobile-phase-1.md`. Phases 2 to 5 each get a short spec addendum in this folder before their plan.

| Phase | Result |
|---|---|
| 1. Offline billing core | A working POS on the phone with no account and no internet |
| 2. Counter extras | Add-ons, offers, kitchen slip, staff PINs and roles, customers and bill sharing, hold order, Takeaway or Delivery |
| 3. Cloud account and sync | Google sign-in, backup, restore, owner view on a second device, bill link |
| 4. Trial, Portal and menu from a photo | Free trial, signed entitlement, cafes visible and extendable in the Portal, menu entry from a photo |
| 5. Play Console: subscription and release | Play subscription, signing, listing, policy forms, production |

Everything that needs a Google Play Console account is in Phase 5, which waits for the owner's legal work
(business registration, and the D-U-N-S number if the account is an Organization account). Phases 1 to 4 are
built and tested with APKs installed directly on a phone and need no Play account.

## Phase 1 in detail: offline billing core

### Shared-code preparation

1. `packages/domain/src/id.ts` takes its random bytes from `globalThis.crypto.getRandomValues`. Its tests stay as
   they are.
2. `packages/print` is created with every pure print file: `escpos.ts`, `profile.ts`, `templates.ts`, `upi.ts`,
   `render-bytes.ts`, `restaurant-receipt-style.ts` and all of `receipt.ts`, including `receiptHtml` (it shares
   private helpers with the slip, and the phone can use it later for sharing a bill). Their tests and snapshots move
   with them. `receipt-style.ts` (used by credit notes) stays in `apps/server`. All builders return `Uint8Array`.
   `apps/server/src/print/` imports from `@masalapos/print`; the queue, sinks and HTML preview do not move, and the
   queue turns the bytes into a `Buffer` where it stores them.
3. `ReceiptSnapshot` gains an optional `token?: number`. `receiptSlip` prints it in double size under the header
   when it is set. Windows POS bills do not set it, so their output is unchanged, and a test proves that.
4. A guard test in `apps/cafe-android`, in the style of `apps/ui/src/domain-imports.test.ts`, fails if the app or
   `packages/cafe-data` imports the `@masalapos/domain` root, `db.ts`, or any `node:` module.

### `packages/cafe-data`

The driver interface is synchronous, so repositories read the same in tests and on the phone:

```ts
export interface SqlDriver {
  run(sql: string, params?: readonly unknown[]): void;
  get<T>(sql: string, params?: readonly unknown[]): T | undefined;
  all<T>(sql: string, params?: readonly unknown[]): T[];
  transaction<T>(fn: () => T): T;
}
```

`apps/cafe-android` supplies an `expo-sqlite` adapter; tests supply a `better-sqlite3` adapter. The first task of
the Phase 1 plan confirms from the current Expo documentation that `expo-sqlite` still offers synchronous calls and
a synchronous transaction. If it does not, the interface becomes async everywhere before any repository is written.

Tables. Money is integer paise. Times are epoch milliseconds. "Synced" tables carry `id`, `updated_at`, `deleted_at`.

| Table | Synced | Columns beyond the common ones |
|---|---|---|
| `cafe` (one row) | yes | name, address, phone, gstin, fssai, gst_mode, default_gst_rate, round_off, invoice_prefix, receipt_header, receipt_footer, receipt_style, upi_id, owner_pin_hash |
| `device` (one row) | no | name, series_letter |
| `categories` | yes | name, sort |
| `items` | yes | category_id, name, price_paise, gst_rate (null means the cafe default), available, sort |
| `item_variants` | yes | item_id, name, price_paise, sort |
| `bills` | yes | device_id, bill_no, invoice_no, token, business_date, created_at, discount_paise, discount_note, total_paise (so reports can sum in SQL), totals_json, receipt_json |
| `bill_lines` | yes | bill_id, item_id, variant_id, name, price_paise, qty, gst_rate, offer_discount_paise, sort |
| `payments` | yes | bill_id, mode (`cash`, `upi`, `card`), amount_paise, ref_note, created_at |
| `bill_voids` | yes | bill_id, credit_note_no, reason, created_at |
| `sequences` | no | name, value |
| `printers` | no | name, transport (`bluetooth`, `network`), address, paper_width, role (`receipt`, `kitchen`), profile_json |

Notes on the schema:

- An item with variants takes its price from the chosen variant; `items.price_paise` is used only when it has none.
- `bill_lines.item_id` is null for a custom line, one typed into the bill without a menu item. The line still
  holds its own name, price and GST rate, so bills, receipts and reports treat it like any other line. Item-wise
  reports group custom lines by name.
- `bills.totals_json` is the `BillTotals` from `calculateBill`. `bills.receipt_json` is the frozen `ReceiptSnapshot`
  with `orderType: "parcel"`, `orderTypeKind: "takeaway"`, `tableName: null` and the token. A reprint a year later
  shows what was printed on the day.
- A bill's status is derived: void when a `bill_voids` row exists, otherwise paid. There is no unpaid bill.
- Invoice numbers use `formatInvoiceNo(prefix + series_letter, fy, n)`; `bills.bill_no` stores `n`. The cafe's prefix is at most three
  characters here, so prefix plus letter stays within the four characters `InvoicePrefix` allows and the number
  within GST's sixteen. The sequence name is `invoice:<prefix><letter>:<fy>`.
- Tokens use the sequence `token:<business_date>` and restart at 1 each day. `business_date` is the calendar date
  in the device's time zone.
- A void takes a credit-note number from `formatCreditNoteNo` and the sequence `cn:<fy>`.
- Migrations are numbered TypeScript modules in `packages/cafe-data/src/migrations/`, applied in order inside a
  transaction, with the applied version in `PRAGMA user_version`.

The bill flow is one function and one transaction:

```ts
createBill(db, { lines, discountPaise, discountNote, payments, now }): Bill
```

It reads the cafe settings, resolves each line's price and GST rate, calls `calculateBill`, rejects payments that
do not add up to the total, takes the next invoice number and token, freezes the receipt snapshot, writes the bill,
its lines and its payments, and returns a domain `Bill`. Cash tendered and change are worked out on screen and are
not stored. `voidBill(db, { billId, reason, now })` writes the void row and returns the updated `Bill`.

Reports are queries in `cafe-data`: for a date, the bill count, gross sales, discounts, tax by rate, totals by
payment mode, item-wise quantities and amounts, and voids.

### The app

`apps/cafe-android` is an Expo app inside the npm workspace. The `android/` folder is generated by
`expo prebuild` and is not committed; configuration lives in `app.json` and config plugins. A script,
`tools/build-cafe-android.mjs`, follows `tools/build-captain-android.mjs`: find the JDK, run prebuild, run Gradle,
sign with a key kept outside the repo. Development uses a debug build on a real phone over USB with
`adb reverse`, because this machine has no emulator.

Navigation is bottom tabs on a phone and a side rail on a tablet: **Bill**, **Bills**, **Reports**, **Menu**, **More**.

| Screen | What it does |
|---|---|
| First run | Cafe name, address, phone, GSTIN (optional), tax mode and default rate, owner PIN; then an empty menu or a small sample menu; then printer setup, which can be skipped |
| Bill | Category rail, item tiles, search. Tapping an item adds it; an item with variants opens a picker. The cart shows lines with quantity steppers, a bill discount (amount or percent) and the total. On a phone the cart is a bottom sheet; on a tablet it is a right-hand panel. **Charge** opens payment |
| Payment | **Cash** (exact, or tendered with change shown), **UPI** (a QR code for the exact amount from the cafe's UPI id), **Card**, or a split across them. **Paid** saves the bill, prints the receipt, shows the token in large type and returns to an empty cart |
| Bills | Today's bills, newest first; search by invoice number or token; pick another date. A bill opens to its receipt with **Reprint** and **Void** (owner PIN and a reason) |
| Reports | The day summary described above, a date picker, and **Print summary** |
| Menu | Categories, items and variants: add, edit, reorder, and a quick "not available today" switch |
| More | Cafe details, tax, receipt header and footer, receipt style, printers (pair, pick paper width, test print), owner PIN, app version |

**Billing without a menu.** The Bill screen has a **Custom item** button that opens a keypad: price, an optional
name (it defaults to "Item"), quantity and GST rate (the cafe default). It adds a line to the cart, with a switch
to also save it to the menu. When the menu is empty the Bill screen opens on this keypad, so a new owner can print
a first bill before entering any items, and the first-run menu step can be skipped.

The fastest path is three taps: item, **Charge**, **Cash** with the exact amount pre-filled. Touch targets are at
least 48 dp. The visual design uses the MasalaPOS orange and is drawn up in the Phase 1 plan with the project's
mobile design skills.

The cart lives in memory in one store. Lists re-read from `cafe-data` when it reports a change.

### The printer module

A local Expo module in Kotlin at `apps/cafe-android/modules/printer`, with three calls:

```ts
pairedPrinters(): Promise<Array<{ name: string; address: string }>>
print(target: { transport: "bluetooth"; address: string } | { transport: "network"; host: string; port: number },
      bytes: Uint8Array): Promise<void>
bluetoothState(): Promise<"ready" | "off" | "no_permission" | "unsupported">
```

- Bluetooth is Classic serial (SPP, UUID `00001101-0000-1000-8000-00805F9B34FB`), which is what low-cost thermal
  printers use. Pairing is done in Android's Bluetooth settings; the app lists paired devices. Android 12 and later
  need `BLUETOOTH_CONNECT` at run time; earlier versions use the legacy `BLUETOOTH` permission.
- Network is a TCP socket to port 9100 with a connect timeout.
- Each job connects, writes, flushes and closes, with one retry.

Print jobs go through a queue in the app that runs one job at a time. The bill is saved before its job is queued,
so a printer that is off or out of paper never loses a sale: the payment screen says the receipt did not print and
offers **Try again**, and the bill can be reprinted from **Bills**.

### Errors and edge cases

| Case | Behaviour |
|---|---|
| Printer off, out of range or out of paper | Bill is saved; a clear message and **Try again**; billing continues |
| No printer set up | Bill is saved; the receipt is shown on screen |
| Payments do not add up to the total | **Paid** stays disabled; `createBill` also rejects it |
| Empty cart | **Charge** is disabled |
| Invoice counter reaches 99,999 in a year | `createBill` refuses with a message to change the prefix |
| Device clock moved back past the last bill | A warning before billing; bills are still allowed, and ids stay ordered because `uuidv7` never goes backwards |
| A migration fails | It rolls back; the app shows the error and does not open the till |
| Item edited or deleted after it was billed | Old bills are unaffected: lines and the receipt snapshot hold their own copies |

### Testing

- `packages/cafe-data`, in Node with vitest on `better-sqlite3`: migrations from empty; menu repositories; `createBill`
  totals for included, exclusive and no-GST modes; split payments; rejection of wrong payments; invoice numbers
  across a financial-year change; token restart at midnight; void and credit-note numbers; every report figure;
  a bill made only of custom lines, and one mixing custom and menu lines.
- `packages/print`: the moved server tests pass unchanged apart from the byte type; a new test for the token line;
  a test that a bill without a token prints as before.
- `apps/server`: the full existing suite passes after the move, and `npm run typecheck` is clean.
- The guard test for phone-safe imports.
- On a real phone and printer, by hand: first run; a bill with no menu entered; a one-item cash bill in three taps; a variant; a discount; a
  split payment; UPI QR scanned by a payment app; reprint; void; the day report; all of it again in flight mode;
  printer switched off mid-sale.

### Phase 1 is done when

On a real Android phone with a thermal printer, in flight mode, a bill is made, paid, printed and shown in the day
report, and its totals equal `calculateBill`'s for the same items, because they come from it.

### Risks to settle at the start of Phase 1

- **React versions.** `apps/ui` and `apps/portal` use React 19.2.8 and React Native pins its own version. Check the
  current Expo SDK's requirement; if they differ, keep the app's React from being hoisted.
- **`qrcode` under Hermes.** `upiQrRaster` uses the `qrcode` package. Confirm its matrix API runs without Node
  built-ins, or produce the matrix with a library that does.
- **Synchronous `expo-sqlite`.** As above.
- **Bluetooth permissions and reconnect time** on the test phone and printer. Print a test slip in the first week.

## Phase 2 in outline: counter extras

- **Add-ons.** Tables for add-on groups and options matching `AddonGroup` and `AddonOption`; a picker after an item
  is tapped; `resolveAddonPicks` validates; add-on lines print under their dish as the Windows POS prints them.
- **Offers.** A table matching `Offer`; an editor; `applyOffers` runs on the cart and its discounts go to
  `calculateBill` as `offerDiscountPaise`.
- **Kitchen slip.** A printer with the `kitchen` role, or the receipt printer; `kotSlip` gains the token; printed
  when the bill is paid.
- **Staff.** A staff table with a PIN hash and a role; the lock screen asks for a PIN; discount, void, reports and
  menu editing are checked with `can` from `packages/core`.
- **Customers and sharing.** A customers table (name, phone); the bill can carry a customer; **Share** renders the
  receipt as an image and opens Android's share sheet.
- **Hold order.** **Hold** on the Bill screen parks the cart with an optional note and clears the screen for the
  next customer. A **Held** list shows parked carts, oldest first; opening one puts it back in the cart. A held
  order is a saved cart in its own table, kept on the device and not synced. It is not a bill: it has no invoice
  number or token until it is paid, so the rule that a bill is written once still holds.
- **Takeaway or Delivery.** The cart has an order-type switch, Takeaway by default. The choice is stored on the
  bill, printed on the receipt and kitchen slip through `orderTypeKind` and `orderTypeName`, and split out in the
  day report. Delivery adds an optional address note that prints on the slip.

## Phase 3 in outline: cloud account and sync

- **Service.** `apps/licensing-worker/src/cafe/` with its own database: `cafe.db` on the Node host, a separate D1
  binding on Cloudflare. Cafe sales data never sits in the licensing database.
- **Sign-in.** The app gets a Google ID token; the service verifies it and returns a session. The first sign-in
  creates the cafe; a later sign-in on another phone offers restore or owner view.
- **Sync.** `cafe-data` gains an outbox filled by the same transaction as each change. Push is idempotent by row id.
  Pull returns rows after a server sequence number. Bills, lines, payments and voids are insert-only. Menu,
  settings, staff and customers use last-write-wins by server sequence.
- **Devices.** One billing device per cafe is enforced by the service. Owner-view devices read reports and edit
  the menu. Each billing device is given its `series_letter` by the service.
- **Bill link.** A read-only web page for one bill, reached by an unguessable link, for sharing.
- **Tests.** An in-process end-to-end test of the sync client against the module, in the style of
  `apps/licensing-node/src/connector-e2e.test.ts`: offline bills arrive after reconnecting, a wiped device
  restores, a menu change crosses devices, a repeated push changes nothing.
- **Billing never waits for the network.** With sync on and no internet, the app makes, prints and voids bills
  and edits the menu exactly as it does online, and uploads when the connection returns. This is tested on a real
  phone in flight mode for a full day's bills, and it is a point to sell on.

## Phase 4 in outline: trial, Portal and menu from a photo

- The trial starts when the cafe is created. The service issues a signed entitlement with an expiry and a grace
  period, in the same envelope format as the Windows licence. The app verifies it offline and refreshes it on sync.
- When the entitlement lapses the app still shows past bills and reports, and blocks new bills.
- The entitlement has a source: `trial`, `portal` or `play`. This phase builds the first two. Phase 5 adds `play`
  without changing the app's entitlement check.
- The Portal lists cafes with owner contact and entitlement state, and lets MasalaPOS staff extend or end a cafe's
  access. This is how test cafes are kept running before the Play subscription exists.
- **Menu from a photo.** In **Menu**, the owner photographs a printed menu, one or more pages. The app uploads the
  photos to the cafe service, which reads them with the AI model the licensing service already manages for the
  Windows POS assistant (`apps/licensing-worker/src/ai`) and returns categories, items, variants and prices.
  Nothing is saved until the owner has checked and corrected the list on a review screen. It needs internet, has a
  daily limit per cafe, and the photos are not kept after the reply.
- Needed before this phase starts: the trial length.

## Phase 5 in outline: Play Console, subscription and release

This phase starts when the owner's legal work is done and the Play Console account exists.

- **Account type.** Organization if there is a registered business, otherwise Personal. Per Google's Play Console
  help (read 2026-11-13): an Organization account needs a D-U-N-S number, which is free and can take up to 30
  days, a website and a public phone number. A Personal account created after 13 November 2023 must run a closed
  test with 12 testers opted in for 14 continuous days before it can publish, and shows the owner's full address
  on Google Play once the app is monetised.
- **Subscription.** The Play subscription is bought in the app. The service verifies the purchase token with the
  Google Play Developer API and follows renewals and cancellations from Play's server notifications, then issues
  an entitlement with source `play`. Test purchases need the app on a Play testing track, which is why this work
  sits here and not in Phase 4.
- **Release.** A new release key stored outside the repo, and Play App Signing. Store listing, privacy policy, the
  data-safety form, and account deletion in the app and on the web, which Play requires of apps with accounts.
  Then the testing track the account type requires, and production.
- Needed before this phase starts: the Play Console account and the prices.

## After the first release

Planned, and each gets its own short spec when it is picked up:

- **USB printers.** A third transport in the printer module, using Android's USB host support, for counters where
  a tablet is wired to a thermal printer.
- **Hindi.** The app's screens in Hindi, chosen in **More**. Receipts are a separate question: thermal printers
  print Latin text from their built-in fonts, so Hindi item names on paper mean printing the receipt as an image,
  which is decided in that spec.

## Working method

- One phase per session; the plan is executed inline; one review at the end; commit at the end of the phase.
- Build sessions run on Opus 5.5. `ANTHROPIC_MODEL` on this machine is set to Sonnet 5.5, so each build session
  chooses Opus 5.5 before its first prompt (`/model`, or `claude --model claude-opus-5-5`). Models are not switched
  mid-session.
- Tests are written first for `cafe-data`, `print` and the service module.
- Android is checked on a real device; there is no emulator on this machine.
