# Sales and payment collections

Admins and cashiers see issued sales, collections received and bills issued cards
above the sales and collection graphs on **Home**, automatically covering the
latest seven server-local dates. Date controls and
bottom shortcuts are omitted from Home. Captain/waiter users
keep their table and service views; waiter and kitchen accounts cannot read
financial reports. This feature adds no dependencies or database migrations.

## Use

- In **Reports**, choose **Today**, **7 days**, **30 days**, or apply a custom date range of up to
  366 days. Dates use the restaurant server's calendar and displayed timezone.
- Reports show issued sales, collections received, issued bill count and current unpaid
  balances. The Home trend chart compares daily sales with daily collections. Select a
  date with the pointer, or focus the chart and use Left/Right, Home or End.
- Cash, UPI and card bars show receipt totals and their share of collections.
- Open **Reports** in the main navigation, then select **Sales** or **Collections**.
  Use **Export → Export … CSV** for the loaded report. Currency is exported as
  decimal INR with dates, server timezone and a total row.
- Select a sales date to open the existing **Day-end / GST** report. Its GST
  breakdown, cancelled-order count and CSV export remain available.

Home refreshes on order events, after reconnection and every minute, with a Retry
button only when loading fails. Reports
refresh when dates change or **Refresh** is pressed. A failed or pending request
clears the old financial result and disables export; a late response from a prior
range cannot replace the current range.

## What the figures mean

**Issued sales** (gross) sum saved bill snapshots by bill creation date, void bills
included, with their existing GST and rounding. Credit notes (voids and refunds) are
taken off on the date each credit note was made. The dashboard's **Issued sales**
card is the gross figure; the Sales report shows **Credit notes** and **Net sales**
columns beside it, per day and in total.

**Collections** sum saved payment rows by payment
receipt date, including payments for older bills, less refunds paid out that day. These are different measures
and can legitimately differ. Split payments contribute to each payment method;
the range's bill count counts distinct bills, even if a bill has receipts on
multiple dates. Complimentary bills count as sales bills without inventing a
receipt. A voided bill stays in the gross sales of its issue day; its credit note reduces
the day it was made. See [Refunds and voids](refunds-and-voids.md). This is not an
immutable historical cash ledger.

**Still unpaid** is the current unpaid balance of bills issued in the selected
period, not the restaurant's entire outstanding balance or its balance as of a
historical date. Full settlement is the existing application's payment behavior.
Zero-activity dates remain in reports and charts.

The new `GET /api/reports/sales` route uses `reports.read` and performs read-only
aggregation. Existing tax, discount, rounding, total, bill numbering, payment,
printing and day-end calculations are unchanged.

## Layout and implementation audit

The previous Home used three service-count cards and a quick-action area, with no
sales trend or collection mix. Existing reporting offered one day-end date at a
time. The new screen uses the established spacing, font, border and theme tokens:
40px report controls, up to 24px financial values and 32px report rows.
Large values reduce their font size to retain a complete decimal amount.

| Area | Result | Source |
| --- | --- | --- |
| Home | Two graphs and a read-only date/update caption; ordering actions stay in the header | `apps/ui/src/screens/Home.tsx:12`, `apps/ui/src/SalesDashboard.tsx:6` |
| Charts | Native responsive SVG, exact values and keyboard selection; no chart package | `apps/ui/src/SalesCharts.tsx:7` |
| Period and metrics | Shared controls, explicit date caption and zero states | `apps/ui/src/SalesReportControls.tsx:4` |
| Reports | Sales/collections tables with sticky header/totals and separate CSVs | `apps/ui/src/screens/SalesReports.tsx:10` |
| Existing Day-end | Optional starting date for drill-down only | `apps/ui/src/screens/DayEnd.tsx:10` |
| Data | Read-only aggregation of stored bills and payment receipts | `apps/server/src/sales-reports.ts:39` |

The dashboard fits at 1280×720 without workspace scrolling, including an empty
period. At 1920×1080 it retains the compact vertical layout. Tablet portrait
768×1024 fits; phone 390×844 stacks sections with vertical scrolling and no
horizontal page overflow. Long report tables scroll internally on desktop;
narrow displays may scroll the table horizontally to retain all currency digits.

Dashboard financial overview: three summary cards above two graphs, without selecting dates or navigating.
Reports opens in one click; select Collections for payment details. CSV export takes two clicks.
**New order** and **Quick takeaway** remain directly available. Order-entry and
payment/printing interactions are unchanged; no new standard-order steps are added.

## Verification

Twenty targeted tests across reporting, CSV export and billing passed. TypeScript
and the production UI build passed. The disposable browser fixture passed 28
checks covering the Home cards and graphs, reconciliation, dates, keyboard navigation, exports, day-end
drill-down, invalid/empty ranges, failures and reordered responses. Cashier access
and waiter denial/service overview were also checked in the browser.

Visual checks covered 1280×720, 1920×1080, 768×1024 and 390×844, light/dark themes,
and large full-decimal amounts. Evidence is under `output/sales-dashboard/`.
The fixture issues bills through existing APIs and uses an in-memory database and
fake printer. Physical printing was not exercised by this dashboard change.
