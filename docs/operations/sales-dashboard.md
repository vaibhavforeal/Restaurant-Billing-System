# Sales dashboard and payment collections

Admins and cashiers see a sales dashboard on **Home**: a status strip, three
channel cards (Total Sales, Dine In, Takeaway), a sales chart by four-hour slot,
and a right-hand column with **Alerts**, **Order Statistics** and the payment
breakdown. It shows one day at a time, today by default. Captain/waiter users
keep their table and service views; waiter and kitchen accounts cannot read
financial reports. The dashboard reuses existing read-only reports and adds no
dependencies or database tables. (The Marketplace that controls the Zomato part of
Alerts is described in [Marketplace](marketplace.md).)

## Use

- **Status strip.** Shows "Updated just now / N mins ago", a single-day date picker
  and a refresh button. The date defaults to today and cannot be moved past today.
  If Home is left open past midnight while showing today, it moves on to the new
  day; a date you picked stays.
- **Channel cards.** Total Sales, Dine In and Takeaway show the net sales amount and
  the number of billed orders for the selected day. Total is Dine In plus Takeaway.
- **Sales chart.** Six four-hour slots from 01:00 to 01:00, with Dine In and
  Takeaway side by side and rupee labels. **A bill issued between 00:00 and 00:59
  belongs to the last slot (9pm-1am)**, not to 1am-5am. Hover, or focus the chart
  and use Left/Right, Home or End, to read exact values. On a narrow screen the
  labels show each slot's total and tapping a slot shows the exact values. A day with
  no sales shows a zero axis and the note "No sales on this day".
- **Alerts.** A red badge counts the rows. With Zomato turned on in the Marketplace,
  each open Zomato order is a row (channel tag, order number, status, payment mode,
  amount, age), oldest first; selecting a row opens the Zomato screen. Swiggy shows
  "Swiggy not connected". With Zomato off the panel says "Turn on Zomato or Swiggy in
  the Marketplace" (admins also get an **Open Marketplace** link; cashiers see "Ask an
  admin to turn on Zomato or Swiggy in the Marketplace."). Billed orders still
  awaiting payment follow as a counter alert. A failed Zomato request shows a hint in
  the panel and never blocks the rest of the dashboard.
- **Order Statistics.** **Successful** (bills issued that day), **Cancelled** (orders
  cancelled that day) and **In progress** (orders open right now).
- **Payment collections.** The cash (net), UPI (net) and card (net) bars for the
  selected day, with their share of the total received (net of refunds).
- In **Reports**, choose **Today**, **7 days**, **30 days**, or apply a custom date range of up to
  366 days. Dates use the restaurant server's calendar and displayed timezone.
  Reports show net sales, collections received, issued bill count and current unpaid
  balances.
- Open **Reports** in the main navigation, then select **Sales** or **Collections**.
  Use **Export → Export … CSV** for the loaded report. Currency is exported as
  decimal INR with dates, server timezone and a total row.
- Select a sales date to open the existing **Day-end / GST** report. Its GST
  breakdown, cancelled-order count and CSV export remain available.

The dashboard refreshes when an order changes (about half a second after the event),
after the connection returns, and every minute; Zomato rows also refresh on Zomato
changes and every 15 seconds while the page is visible. A **Retry** button appears
only when loading fails: the last good figures stay on screen and say they may be
incomplete. Reports refresh when dates change or **Refresh** is pressed. A failed or
pending report request clears the old financial result and disables export; a late
response from a prior range cannot replace the current range.

## What the figures mean

**Net sales** are gross sales less credit notes. Gross sales sum saved bill
snapshots by bill creation date, void bills included, with their existing GST and
rounding; credit notes (voids and refunds) are taken off on the date each credit
note was made. The channel cards and the slot chart use the order-analytics figures
(see [Order analytics](order-analytics.md)), which count bills by issue date and hour
in the server timezone, net of credit notes, so a day with more credit notes than
sales can show a negative slot. Quick takeaway means parcel orders; each dine-in
split counts as its own order. The Sales report shows gross **Sales**, **Credit
notes** and **Net sales** columns, per day and in total.

**Collections** sum saved payment rows by payment
receipt date, including payments for older bills, less refunds paid out that day.
The Collections report and CSV label the method columns **Cash (net)**, **UPI
(net)** and **Card (net)**, with **Refunds** and **Received (net)** beside them. These are different measures
and can legitimately differ. Split payments contribute to each payment method;
the range's bill count counts distinct bills, even if a bill has receipts on
multiple dates. Complimentary bills count as sales bills without inventing a
receipt. A voided bill stays in the gross sales of its issue day; its credit note reduces
the day it was made. See [Refunds and voids](refunds-and-voids.md). This is not an
immutable historical cash ledger.

**Still unpaid** (Reports) is the current unpaid balance of bills issued in the selected
period, not the restaurant's entire outstanding balance or its balance as of a
historical date. Full settlement is the existing application's payment behavior.
Zero-activity dates remain in reports and charts.

**Order Statistics** are counts, not money. Successful and Cancelled come from the
Day-end report for the selected date; In progress is the live number of open orders,
whatever date is selected. "Awaiting payment" in Alerts is the live number of billed
orders that have not been settled.

The `GET /api/reports/sales` route uses `reports.read` and performs read-only
aggregation. Existing tax, discount, rounding, total, bill numbering, payment,
printing and day-end calculations are unchanged.

## Layout and implementation audit

The previous Home showed three metric cards above a sales/collections trend chart. The
new screen follows the layout of a restaurant POS dashboard, using the established
spacing, font, border and theme tokens, with no chart package and no new dependency.

| Area | Result | Source |
| --- | --- | --- |
| Home | Hands the financial view to the dashboard; the waiter service view is unchanged | `apps/ui/src/screens/Home.tsx:46`, `apps/ui/src/SalesDashboard.tsx:17` |
| Status strip | Updated label, single-day date picker (max today), refresh | `apps/ui/src/DashboardStrip.tsx:5` |
| Channel cards | Total Sales, Dine In, Takeaway: amount and order count | `apps/ui/src/ChannelCards.tsx:8`, `apps/ui/src/dashboard-data.ts:38` |
| Slot chart | Native SVG, six slots, keyboard and pointer values; 00:00-00:59 in the last slot | `apps/ui/src/SlotChart.tsx:11`, `apps/ui/src/dashboard-data.ts:15` |
| Alerts | Open Zomato orders, Swiggy hint, awaiting-payment alert, error hint | `apps/ui/src/AlertsPanel.tsx:14`, `apps/ui/src/useAggregatorOrders.ts:13` |
| Order Statistics | Successful, cancelled, in progress | `apps/ui/src/OrderStatistics.tsx:4`, `apps/ui/src/dashboard-data.ts:52` |
| Payment mix | Cash/UPI/card bars moved to the right column | `apps/ui/src/SalesCharts.tsx:54` |
| Data loading | Five parallel reads, last-good figures kept on failure, stale responses ignored | `apps/ui/src/useDashboard.ts:35` |
| Reports | Sales/collections tables with sticky header/totals and separate CSVs | `apps/ui/src/screens/SalesReports.tsx:16` |
| Existing Day-end | Optional starting date for drill-down only | `apps/ui/src/screens/DayEnd.tsx:9` |
| Data | Read-only aggregation of stored bills and payment receipts | `apps/server/src/sales-reports.ts:39` |

Layout. At 1920×1080 the whole dashboard is visible without scrolling. At 1280×720
the channel cards, sales chart, Alerts and Order Statistics are fully visible and the
page never scrolls horizontally, but the dashboard does not fit that height: the
workspace scrolls vertically and the payment breakdown sits below the fold (the exact
amount depends on content, for example how many Zomato rows are shown). At 768×1024 and 390×844 the sections stack and the
workspace scrolls vertically, with no horizontal page overflow. Long report tables
scroll internally on desktop; narrow displays may scroll the table horizontally to
retain all currency digits.

**New order** and **Quick takeaway** remain directly available in the page header.
Order-entry and payment/printing interactions are unchanged; no new standard-order
steps are added.

## Verification

Run the browser gate from `tools/e2e/sales-dashboard.js` against the disposable
fixture (see `tools/e2e/README.md`). The fixture now issues dine-in and takeaway
bills at 00:30, 00:45, 06:10, 11:15 and 19:00 today in addition to its 30 days of
takeaway bills, plus one open order, one cancelled order and one open Zomato
order, with Zomato off in the Marketplace.

In the last run the gate passed **42 checks**: the status strip; channel cards,
slot chart description, payment breakdown and order statistics each reconciled
against `/api/reports/analytics`, `/api/reports/sales`, `/api/reports/day-end` and
`/api/orders`; a 00:30 bill landing in the 9pm-1am slot; the Alerts hint and badge
with Zomato off; no horizontal overflow and the key panels above the fold at
1280×720; slot-chart keyboard keys; an empty date and a refused future date;
failed refresh and Retry; and the unchanged Reports checks (presets, dates, three
CSV downloads, day-end drill-down, empty and invalid ranges, failed refresh and
reordered responses). The Alerts rows with Zomato on and the Marketplace flow are
covered by `tools/e2e/marketplace.js`.

Not verified: the gate runs as admin; cashier access was checked by the
Marketplace gate (Home and Alerts) and waiter access by sign-in (Captain view and a
403 on the integrations list), not by the full dashboard script. Physical printing
was not exercised. The browser runs used the Playwright browser tools because
agent-browser is not installed here; the scripts are the same in-page scripts.
Light and dark screenshots at 1280×720, 1920×1080, 768×1024 and 390×844 are under
`output/dashboard-marketplace/` (untracked).
