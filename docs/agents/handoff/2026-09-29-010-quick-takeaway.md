# Quick takeaway billing

User requested quick billing for parcel/takeaway and selected automatic kitchen
sending during checkout.

## Implemented

- Cashiers and administrators can choose Quick takeaway from Home or Tables &
  orders. New parcel remains available for separate orders. Both Basic and Pro
  include this billing flow. Waiters retain the ordinary parcel workflow.
- QuickTakeaway persists and verifies a per-user, per-browser create reference
  before contacting the server. Re-entry recovers the unfinished parcel; Next
  takeaway advances only after the saved order is settled or cancelled. The
  saved reference participates in the existing restore-generation protection.
- Checkout saves the cart through the retry queue, fetches current pending
  items, sends the captured kitchen item IDs, then fetches a GST bill preview.
  Items without a station remain pending until bill issue, preserving normal
  stock timing. No separate Punch or Send to kitchen click is needed.
- Staff review the total and choose Cash, UPI, or Card. Cash received computes
  change while the recorded payment equals only the bill total. One explicit
  confirmation issues the bill and records payment through the existing APIs.
- A configured printer receives the paid receipt after settlement. Browser
  printing remains View receipt then Print / save PDF. Next takeaway is offered
  after settlement. Printing errors never undo or re-record payment.
- During writes, cart controls, navigation, and logout are locked. Bill reads
  cannot overwrite a newer confirmed bill with an older response. Semantic
  item changes invalidate previews while equivalent refreshes preserve them.
- Existing parcels also use quick checkout for cashiers/admins; dine-in keeps
  its existing split/order/billing flow.

## Recovery boundary

No new billing endpoint or database migration was introduced. Add, kitchen send,
bill, and settlement use existing exact queued payloads. Item-add retries are
only valid while the order remains open; recovery resumes the saved step rather
than starting the whole checkout again. If a browser reload interrupts the gap
between bill issue and payment enqueue, the existing unpaid bill is recovered
and staff use Record payment. Already queued settlements retain their original
identity. UPI/card entries record payment received; they do not call a gateway.

## Verification

- Full Vitest suite: 340 tests passed across 46 files, including 12 new
  quick-takeaway integration tests.
- TypeScript, UI build, and whitespace checks passed during implementation.
- `tools/e2e/m10-takeaway.js` passed 56 real browser assertions across four
  actual page reloads on isolated signed-license port 4121. Coverage includes
  Cash/UPI/Card, Basic billing, draft recovery, and exact recovery after lost
  create, bill, and settlement responses.
- Focused review fixed two refresh races: order reloads now discard older
  responses, and a view refresh cannot prevent payment enqueue after bill
  issue. Post-payment view refresh is best effort so it cannot skip printing.
- The final-build `m10-takeaway-get-failure.js` gate passed 8 additional browser
  assertions while forcing six order-refresh failures: one UPI payment and
  one bill, settled order, empty retry queue, preserved paid confirmation,
  clear reopen guidance, and a loadable paid receipt.

## Running desktop update

The runtime backend and schema did not change for this feature. Latest UI assets
were copied into `build/desktop/app/ui`, and the running server on port 4100
was verified to serve the exact current index and `index-CT8MuDwQ.js` asset.
The existing native app stays running; **Ctrl+R** loads the updated UI. This
preserves the user's current editing session until they choose to refresh.

Verified pre-update backup in the existing desktop data folder:
`backups/forkflow-pre-update-1790668924976-258e339f-3d48-439b-8ce0-af379bf1fff5.db`.
SQLite integrity and foreign-key checks passed at schema 11. The user's current
counts were preserved: users 1, products 1, orders 2, order_items 0, bills 0,
stock_items 0, stock_moves 0. QA data was isolated from the desktop.

The existing development desktop remains in exec session 78996. No installer,
commercial package, server deployment, or git commit was produced.

See [quick takeaway operations](../../operations/quick-takeaway.md) for staff
instructions and interrupted-checkout recovery.
