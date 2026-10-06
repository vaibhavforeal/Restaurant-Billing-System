# Detailed reports and table captains

Admins and cashiers open **Reports → Detailed reports**. Choose a report and use
Today, 7 days, 30 days, or a custom inclusive date range (up to 366 days).
Dates use the POS server's local timezone. Export CSV downloads the displayed
snapshot, with money in rupees, report dates, timezone and calculation notes.
Refresh reloads the data; a failed refresh clears old results and disables export.

| Report | Contents and basis |
| --- | --- |
| Item / category sales | Issued bills by issue date (voids included), less credit-note quantities and values on the date each credit note was made. Grouped by saved item/variant and category, including unpaid bills: quantity, distinct bills, subtotal, discount, taxable value, GST, rounding and final sales. Voids of older bills without saved item lines are not itemised here. |
| Cashier collections | Cash, UPI, card and distinct paid bills by the staff member who settled the bill, using payment date. Includes collections for older bills. Refunds are subtracted from the cashier who requested them. |
| Hourly sales | All 24 local hours across the selected dates, with bill count, discounts, GST, sales and average bill, net of credit notes. |
| KOT performance | Kitchen summary and ticket details: completed, pending, fully cancelled, send/completion timestamps, completion duration and pending age. |
| Cancellation details | Item, quantity, original menu value, exact cancellation time, staff, reason, order reference and KOT. Whole-order cancellations appear separately, including an order cancelled by voiding its unpaid bill (it also counts in the day-end "Orders cancelled on this date"); these rows carry no money, so the void's value is counted once, in its credit note. |
| Credit notes | Every void and refund in the range: CN number, date, bill, kind, reason, requested by, approved by, refund methods, taxable value, GST and total. See [Refunds and voids](refunds-and-voids.md). |
| Stock consumption / wastage | Opening, received, consumed, cancellation reversals, wastage, count adjustments and closing quantities, plus movement details. |

Item reports allocate saved GST, discount and rounding using integer paise; totals
reconcile to issued bills. This does not change billing calculations. A category
is saved when the bill is issued. Historical bills from before this upgrade use
**Historical category unavailable**, rather than assuming today's category was
the historical one. Historical item cancellations without recorded timestamps
are counted in the calculation notes but cannot be assigned to a date range.

KOT duration is send-to-completion, not active cooking time. Fully cancelled
tickets do not affect completion averages. Status is current at refresh time,
including tickets completed after the selected date range. Stock is consumed
when sent to the kitchen, or billed for non-kitchen products. Units are never
added together and no purchase costs or profit amounts are inferred.

## Captains

1. As admin, open **Users**. Enter the captain's name and a unique 4–6 digit PIN.
2. Select **Captain / waiter** and click **Add captain**.
3. When a customer arrives, open their table/order and click **Select captain** beside **Captain**. In **Choose captain**, click the captain's name to save it. Click the current name to change it, or choose **No captain** to remove the assignment.

Captain selection belongs to the customer order, not to the table. New visits,
split orders and orders opened by seating reservations start without an inherited
captain. Staff can choose or change an active captain while the dine-in order is
open; billed and closed orders retain their saved captain. Active table cards
show the captains chosen on their current orders. There are no fixed table
assignments in Users or Manage tables. The upgrade removes old table defaults
while preserving captains already recorded on existing orders.

Captains sign in with their PIN and use the existing Captain interface. Table
assignments indicate responsibility for the current order; they do not prevent another captain from
helping at the table. Financial reports remain restricted to admins/cashiers.

## Verification

`npm run typecheck` checks both server and UI. The operational report tests cover
tax-inclusive/exclusive allocations, saved categories, void exclusion, collecting
cashier attribution, midnight boundaries, KOT averages, cancellation auditing,
stock reconciliation, empty data, invalid dates and permissions. Migration tests
exercise old-bill upgrades without inventing historical category/date data.

Build the UI and run `node --import tsx tools/e2e/operational-reports-server.mts`
for a disposable restaurant on port 4157. Sign in as admin (1234) and run
`tools/e2e/operational-reports.js` through agent-browser eval. It checks report
sections, CSV exports, API totals, empty dates and failed refresh behavior.
Cashier 2345 and captain 3456 are also available. No real data or printers are used.

Screenshots and browser results are in `output/operations/`.

The initial reports release passed 469 tests and the 42-check browser gate.
The per-order captain correction adds checks for independent customer visits,
stale concurrent changes, active-staff validation, billing locks and upgrading
old fixed assignments without changing historical orders.
The corrected build passed all 471 tests across 69 files and type checks. The
order-time selector was exercised in the Captain app and inspected at desktop
and 390px mobile sizes; screenshots are `output/operations/order-captain-*.png`.

## Return to tables after settlement

After settling a dine-in bill, choose **Go to tables** beside the receipt actions.
The same option is available in the billing footer after closing the dialog.
It appears only after the bill is confirmed paid and is disabled during saving.
It closes billing and opens Tables. Fully settled tables become available; a
table with another unpaid split order stays occupied.

`tools/e2e/settle-tables.js` passed 10 browser checks covering single and split
bills, persisted payment, dialog closure, navigation and table availability.
The UI build and workspace type checks also passed.

The desktop update is staged in `build/desktop/settle-tables` to avoid replacing
the running build. `Start ForkFlow.cmd` falls back to this complete stage when
the default `app/main.js` is absent (ahead of the previous `order-captains` and
`reports-captains` stages). Quit the running app from its tray menu before
relaunching to load it.
