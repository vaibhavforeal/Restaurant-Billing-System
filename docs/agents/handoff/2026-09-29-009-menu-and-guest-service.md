# Menu experience and guest service requests

Continued the agreed QR customer-experience milestone. The development desktop
has been rebuilt and restarted with these changes on port 4100.

## Delivered behavior

- Administrators edit dish descriptions, upload/replace/remove photos, and mark
  products sold out from Catalog. Browser uploads normalize JPEG/PNG/WebP to a
  bounded JPEG stored in SQLite. Draft guards preserve unsaved changes and an
  unavailable preview does not erase an existing image.
- Sold-out dishes remain visible, with guest/staff additions disabled. Server
  checks also reject new additions and QR approval. Existing punched items and
  exact retry requests remain usable.
- Accepted guest receipts show only their linked items: queued, preparing,
  ready, cancelled, or with staff. Actual kitchen send/Done operations drive
  the status. Items without a kitchen station never claim kitchen readiness.
- Order more retains earlier receipts and polls unfinished preparation. History
  is capped at 20 by pruning finished requests first; reaching 20 unfinished
  requests blocks starting another request without discarding their receipts.
- Pro guests can call a waiter or request their bill. Tables & orders shows a
  staff inbox with Mark handled and recent history. Calls are notifications;
  they do not create orders, bills, KOTs, payments, or stock moves.
- Service receipts use private secrets and durable exact retries. One pending
  call per table/kind, a 60-second cooldown, and 10-minute expiry limit repeats.
  Earlier receipts and staff handling remain available after plan downgrade.
- A replaced image can recover from a previous image-load failure without
  requiring a page reload or a pricing menuVersion change.

## Data and access

Migration 010 adds product metadata and order-item guest-request links. Legacy
backfill requires a canonical reference, accepted request, matching order, and
valid item index. Migration 011 creates service requests with a unique pending
table/kind index. Images live in the database and participate in normal backups.

New order/service submissions require qrOrdering. Basic remains menu browsing
only, and guest phones consume no staff-device slots. Catalog editing keeps its
administrator permission. The development build explicitly bypasses commercial
activation as before.

## Verification

- Full Vitest suite: **328 tests passed in 45 files**.
- Full TypeScript check, desktop/UI build, and git diff whitespace checks passed.
- `tools/e2e/m9-menu.js`: **33 real browser checks** on disposable signed-Pro
  port 4120, including upload normalization, failed-preview preservation,
  removal/undo, draft/busy guards, and base/variant sold-out handling.
- `tools/e2e/m9-guest-flow.js`: **14 live integration checks**, including service
  create/resolve, staff acceptance, KOT send/Done, history after reload, earlier
  readiness while a new request stays pending, and no added guest device slots.
- Isolated UI harness: **31 mocked-response checks** for lost responses, exact
  retry recovery, downgrade, storage failure, capacity, and terminal pruning.
  A separate narrow check confirmed replacement-photo recovery after failure.
- Desktop and 390px mobile editor review passed with no page overflow. Browser
  page-error reports were empty. Synthetic images were used only in QA data.

The flow gate initially needed fixes to wait for a new iframe document after
reload and return to the Tables screen. The final complete run passed.

## Desktop refresh

Existing data directory:
`C:\Users\AR\AppData\Roaming\forkflow-desktop\data`.

Verified pre-update backup:
`backups/forkflow-pre-update-1790667026012-d0285d0c-5004-46cd-b4ab-7a2cda2d0a7b.db`.

Startup migrated schema 9 to **11**. SQLite quick-check and foreign-key checks
passed. Preserved baseline counts: users 1, products 0, orders 1, order_items 0,
bills 0, stock_items 0, stock_moves 0. No QA catalog entries, guests, service
requests, or payments were added to the user's desktop data.

The standard Electron launcher is running in exec session **78996**, with the
native ForkFlow POS window open. Browser verification at port 4100 confirmed
the sign-in screen, current UI assets, no page errors, and authenticated staff
routes. This is the refreshed development app; no installer was produced.

## Still separate work

Cloud hosting, tenant accounts, subscription renewal, and local/cloud data sync
remain unfinished. QR ordering currently requires a reachable restaurant hub
over restaurant Wi-Fi. Real-phone network/firewall setup and printer hardware
checks remain deployment checks. No deployment or git commit was requested.
