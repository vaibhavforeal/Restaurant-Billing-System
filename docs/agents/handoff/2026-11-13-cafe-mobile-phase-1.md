# MasalaPOS Cafe, Phase 1: offline billing core

Plan: `docs/superpowers/plans/2026-11-13-cafe-mobile-phase-1.md`. Spec: `docs/superpowers/specs/2026-11-13-cafe-mobile-design.md`.
Branch `feat/cafe-mobile`, worktree `E:\Softwares\masalapos-cafe`. Not pushed.

## What was built

- Shared code made phone-safe: `uuidv7` takes random bytes from Web Crypto; the pure print files moved from
  `apps/server/src/print` to `packages/print` and return `Uint8Array` (the server queue turns them into a `Buffer`
  where it stores them); receipts print an optional `TOKEN n` in large type. Windows POS receipts are unchanged: the
  moved snapshot tests pass with no change to their expected text.
- `tools/phone-safe-imports.test.ts` walks every import the phone can reach and fails on `node:` modules,
  `better-sqlite3`, `db.ts` or unexported workspace paths.
- `packages/cafe-data`: synchronous `SqlDriver`; migrations 1 (schema) and 2 (`local_state`); sequences; device-offset
  business date and financial year; cafe settings and owner PIN hash; menu (categories, items, variants, soft deletes,
  ordering, sample menu); `createBill` (idempotent by caller id, one transaction, numbers taken only after every check),
  `voidBill` with credit-note numbers, `daySummary`; printers (one per role).
- `apps/cafe-android` (Expo SDK 58, React Native 0.88, Expo Router): first run; Bill (category chips, search, tiles,
  variant sheet, custom item keypad, cart with steppers and discount; bottom bar and cart sheet on a phone, side panel
  and side rail from 840 dp); payment (cash with note suggestions and change, UPI QR, card, split; Paid is idempotent);
  token screen with print status and Try again; Bills (date control, search, receipt view, reprint, void with owner PIN
  and reason); Reports (day summary, print summary); Menu editor; More (cafe, tax, receipt, printers, owner PIN,
  about). Kotlin printer module (`modules/printer`): Bluetooth SPP and TCP 9100, bytes passed as base64.
- Owner PIN: wrong tries lock entry (30 s, doubling) and the lock is stored on the phone, so neither reopening the
  prompt nor restarting the app resets it.
- `tools/build-cafe-android.mjs` (`npm run build:cafe-android`, `--install`), `tools/generate-cafe-icons.mjs`,
  `docs/operations/cafe-app.md`.

## Verified here

- `npm test`, `npm run typecheck` (now includes the app), `npm run build:desktop`: see the ledger results in the
  final commit message of this phase.
- `node tools/build-cafe-android.mjs`: debug APK builds, including the Kotlin module.
- `expo export --platform android`: the whole app bundles and compiles to Hermes bytecode; the bundle has exactly one
  React (the app's 19.3), includes `qrcode`, and contains no `better-sqlite3` or `db.ts`.

## Phone test, 2026-11-13

The build machine is a VM, so the phone was reached over Tailscale and the standalone test APK
(`node tools/build-cafe-android.mjs --standalone`) was sent with Taildrop. The owner tried the app and found it good.
They once saw a problem checking out a bill with a variant but could not capture the message; the error log
(More, Error log, with Share) was added, and the problem did not come back. Not yet run on a phone: a thermal
printer, flight mode and the tablet layout.

## Pending: needs a real phone and a thermal printer (still to do)

Run `node tools/build-cafe-android.mjs --install`, `adb reverse tcp:8081 tcp:8081`, `npm run dev:cafe`, then:

1. Task 8: first run completes and lands on Bill; reopening goes straight to the tabs; More, Self-check shows 3600,
   a byte count above 0, a QR that a UPI app reads, and a readable date (settles spec risks 2 and 3 on the device).
2. Task 9: pair a printer, test print (the ruler fills exactly one line); printer off shows the unreachable message
   and Try again works when it is back; denying the Bluetooth permission shows the permission message.
3. Task 10: categories and items with and without variants, unavailable, reorder, delete; data survives a restart.
4. Task 11: item, Charge, Paid prints `TOKEN 1` in three taps; variant; custom item; percent discount; cash + UPI
   split; UPI QR opens a payment app with the right payee and amount (do not pay); an item made unavailable while in
   the cart is named; a fast double tap on Paid makes one bill.
5. Task 12: reprint; void with the PIN shows and prints VOID and leaves the day's sales; Reports matches the bills;
   print the summary. Five wrong PINs lock entry, also after restarting the app.
6. Task 13: the full spec checklist in flight mode with Bluetooth on (fresh install, empty menu, bill without menu,
   items, three-tap bill, variant, discount, split, UPI QR, reprint, void, report, summary print, printer off
   mid-sale then Try again), and a tablet or wide window shows the side rail and the cart panel.
7. Opening `masalapos-cafe://first-run` after setup lands on Bill.
8. Saving More, Cafe details (for example a new UPI ID), Tax or Receipt asks for the owner PIN first.

Record each result in this note.

## Whole-branch review (one reviewer, Opus) and fixes

Fixed, each with a test that failed first where code allowed it:
- The template's React Compiler cached reads of the cart store, so the cart never updated on screen. It is off
  (`src/app-config.test.ts` pins that), and screens price an explicit cart snapshot (`useSyncExternalStore`).
- Saving and printing are separate (`src/payment/complete.ts`): a receipt problem never hides a saved bill, and a
  repeated Paid prints one receipt.
- With no printer the token screen shows the receipt on screen.
- The printer module closes a failed socket before its one retry, and network printing retries too.
- From the automated security review: first run cannot reopen after setup; the owner PIN lock persists; saving
  Cafe details, Tax or Receipt needs the owner PIN.

Deferred (minor), for a later phase:
- An unparseable "Another amount" leaves Paid enabled (it pays the exact total).
- An amount discount above the bill is capped at 100% without a message.
- Split payment covers two ways to pay, not three.
- Finished print jobs stay in memory until the app restarts.
- Bills and Reports keep yesterday's date if the app stays open past midnight.
- The unprintable-character warning covers item and variant names only.
- Retrying a multi-copy job reprints copies that already printed.
- A crash between saving the cafe and its PIN in first run leaves no PIN and no way to set one.
- Credit-note numbers carry no device letter; fix in the Phase 3 sync design before two devices bill.
- The owner PIN hash (SHA-256 with the device id) is to be replaced with the Phase 2 staff-PIN hash.

## Next

The Phase 2 spec addendum, then its plan, in a new session on Opus 5.5.
