# MasalaPOS Cafe, Phase 2A: counter extras (staff, Delivery, customers, hold, kitchen slip)

Plan: `docs/superpowers/plans/2026-11-13-cafe-mobile-phase-2.md` (Tasks 1-9). Spec:
`docs/superpowers/specs/2026-11-13-cafe-mobile-phase-2-design.md`. Branch `feat/cafe-mobile`, worktree
`E:\Softwares\masalapos-cafe`. Not pushed after 2A.

## What was built

- **cafe-data.** Migration 4 (`staff`, `customers`, `held_carts`; staff, approver, customer, order kind and delivery
  note on bills; line notes; who voided; counter settings on `cafe`; a Phase 1 owner PIN becomes an "Owner" staff
  row). `pin-hash.ts` (PBKDF2-SHA256 from `@noble/hashes`, salted, iteration count in the hash; the Phase 1 SHA-256
  form verifies once and asks for a rehash). `roles.ts` (the spec's role table through `@masalapos/core/rbac`, a new
  phone-safe subpath). `staff.ts` (last-owner rule), `counter-settings.ts`, `customers.ts` (10-digit phone, unique among
  live rows), `held.ts`. `createBill` checks the staff member, the approver (must hold `bills.discount`), the
  cashier's limit and the customer before any number is taken; `voidBill` needs `bills.refund`. `daySummary` adds
  sales by staff and by order kind. `kitchenLines`, `listBillsForCustomer`, `getItemName`.
- **print.** `KotSlipCtx.token` (heading `TOKEN n`) and `KotSlipCtx.note`; `ReceiptSnapshot.deliveryNote` prints as
  "Deliver to:" on the slip and in HTML. Windows POS snapshots unchanged.
- **App.** Lock screen and Set owner PIN; staff session in memory; idle lock on return to the foreground and every
  30 s while open; Switch staff (Bill and More); Approve sheet and `useApproval` / `useScreenGate` (Menu, Reports,
  Printers, Staff ask once on entry; Cafe, Tax, Receipt, Counter and the kitchen slip setting always ask the owner);
  Staff screen; cart with Takeaway/Delivery, delivery note, customer, line notes (long press), discount approval
  (an amount discount's approval goes when the lines change), Hold and Held (n); Customers in More; kitchen slip after
  the receipt with its own status and Try again, Reprint kitchen slip (marked REPRINT, not for void bills), a kitchen
  printer in Printers; Counter settings; Reports by staff and by Takeaway/Delivery; the five Phase 1 fixes (midnight,
  three-way split, unreadable amount, discount above the bill, first-run crash).
- `docs/operations/cafe-app.md` covers staff, the lock, approvals, counter settings, the kitchen slip, customers,
  Delivery and held orders, and the "every owner forgot the PIN" limit.

## Verified here

- `npx vitest run packages/cafe-data packages/print apps/cafe-android tools/phone-safe-imports.test.ts`: 385 passed.
- `npm test`: 2700 passed. `npm run typecheck`: clean. `npm run build:desktop`: builds.
- `npx expo export --platform android` (in `apps/cafe-android`): bundles to Hermes, including `@noble/hashes`.

## Whole-branch review (one reviewer, Opus) and fixes

No Critical findings. Fixed, each with a test that failed first: screens outside the tabs were reachable with Back
after the lock or by a deep link (now a root guard, and locking clears the stack), `/menu/item` had no
`catalog.manage` gate, a gated tab asked again on return from a pushed screen (approvals now last while the same tab
is in front), and a cashier giving exactly their limit on an odd price was asked for a PIN (now compared in paise).
Three earlier automated security-review findings were fixed during the build (idle lock on a timer while open,
an amount discount's approval cleared when the lines change, REPRINT on reprinted kitchen slips).

Deferred (minor): "Discount is more than the bill" still sends the discount note and approver; the re-approval banner
wording after opening a held cart or Switch staff; a double tap on the PIN pad's OK can count two wrong tries; an
unreadable "Cash received" in a split can keep Paid disabled after the cash part is cleared; REPRINT only at the foot
of the kitchen slip; the customer screen shows the old name after Save.

## PIN iteration count

`PIN_HASH_ITERATIONS` is 50,000, not yet measured on the phone. More, About shows "PIN check: <ms> ms at <n> rounds".
Set it to the largest multiple of 10,000 that keeps one check at or under 300 ms (never below 20,000), rebuild, and
record the phone model, count and time here. The reviewer warns that pure-JS PBKDF2 on Hermes may exceed 300 ms even at
20,000 rounds; if so the plan's floor and the spec's ceiling conflict, and a native PBKDF2 may be needed.

## Device checks (pending: need the phone and a thermal printer)

Build `node tools/build-cafe-android.mjs --standalone` and send the APK with Taildrop (see the operations doc), or
install over adb. Record each result here.

1. Task 6: More, About, PIN check time (then set the count as above). First run creates the owner; add a cashier;
   sign in as the cashier; Reports asks for a manager or owner PIN; lock time 1 minute, background the app 70 s, reopen:
   lock screen; also leave it open untouched past the time: it locks within 30 s; five wrong PINs for the cashier lock
   only the cashier.
2. Task 7: Delivery bill for a new customer, the address fills the note; a line note; cashier 10% discount with the
   limit at 5% asks for approval, a manager approves; hold a cart, bill another, open the held one; a held cart with an
   item deleted meanwhile shows the banner.
3. Task 8: kitchen slip on "Receipt printer": Paid prints the receipt, then the `TOKEN n` slip with the line note;
   printer off: both show Try again and both work after; reprint the kitchen slip from the bill (says REPRINT).
4. Task 9, the 2A check (spec, "2A is done when"), in flight mode with Bluetooth on: the owner adds a cashier; the
   cashier signs in, makes a Delivery bill for a new customer with a line note, needs a manager's PIN for 10% with the
   limit at 5%, holds a second cart and opens it; receipt and `TOKEN n` kitchen slip print; the app locks after the
   idle time; Reports shows staff and order-kind figures. Also: Bills left open across midnight moves to the new day;
   a three-way split; the tablet layout of the new sheets; a fresh install going through first run into billing.
5. From the review: lock on a customer screen, then Back from the lock screen stays on the lock screen; as a cashier,
   a manager approves Menu, then edit an item and come back without being asked again; sheets opened from the phone's
   cart sheet (discount then approve, Hold) open and close cleanly.

## Next

Session 2B, Task 10, on Opus 5.5. Read this note first.
