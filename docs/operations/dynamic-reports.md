# Dynamic Reports

Dynamic Reports is an add-on that lets a person build their own **Home** dashboard.
They drag and resize widgets on a grid, choose a period for each one (and a
comparison where it makes sense), and save the layout. Layouts belong to the person,
so each user has their own. The widgets read the same figures as **Reports**; no
figure is calculated separately. The module and permission are described in
[Feature controls](feature-controls.md). The fixed dashboard it replaces is described in
[Sales dashboard](sales-dashboard.md).

## Turn it on

All three steps are needed.

1. **Licence or portal allowance.** The restaurant's licence must include Dynamic
   Reports. Pro plans include it by default. On Basic, MasalaPOS can allow it for a
   single order or counter in the [MasalaPOS Portal](vendor-portal.md).
2. **Marketplace switch.** An admin opens **Marketplace** and switches on **Dynamic
   Reports** (under Insights). Add-ons stay off until someone switches them on. It
   also needs Reports & analytics and Sales dashboard to be on.
3. **Permission for staff.** Admins can customise by default. For anyone else, an
   admin opens **Users**, opens the person's permissions and grants **Customise own
   dashboard** (`reports.dashboard`). The person also needs **View** under Reports
   (`reports.read`). After the grant, the person signs in again.

Operator note: update the licensing worker and the POS app together. The licence
format now lists `dynamicReports`, and the app only accepts a licence that lists every
module it knows about.

- After the worker is redeployed, reissue every existing licence. A licence saved
  before that does not list Dynamic Reports, so a counter running this version
  rejects it. Until it is reissued, the portal allowance has no effect.
- If the counter is updated before its licence is reissued, licensing shows
  "The saved license is invalid. Import a valid license." and the counter cannot be
  used until a reissued licence is imported.
- The reverse also fails. A counter on an older version rejects licences signed by
  the redeployed worker, so do not reissue licences to counters that have not been
  updated.

Cashiers see the fixed Sales dashboard unless they have been granted **Customise own
dashboard**. Captain/waiter and kitchen accounts are unchanged.

## Use

- **Customise** (top right of Home) opens the editor. **+ Add widget** opens the
  catalogue; **Settings** on a widget sets its period, comparison, order type or the
  number of rows, where the widget has them; **Remove** takes it off.
- Drag a widget to move it, and drag its corner to resize it. Each widget has a
  smallest and largest size. With the keyboard, focus a widget and use the arrow
  keys to move it and Shift plus the arrow keys to resize it.
- **Save** stores the layout. **Cancel** drops the changes. **Reset to default**
  asks first, then replaces the saved layout with the default one.
- A layout holds at most 30 widgets. Widgets hidden from the person (see below) count
  towards the 30. When it is full, **+ Add widget** is disabled and a save that goes
  over the limit says "Your dashboard is full".
- Each widget header shows its period and the dates it covers; status widgets show
  "Live". The footer says when the figures were last updated.

The figures refresh about half a second after an order, kitchen ticket, QR request,
stock level or table changes, after the connection returns, and every 60 seconds. The
saved layout is read again when the person's access changes, after a reconnect and
once an hour, but not while they are editing.

### Narrow screens

Below 720 px wide the dashboard is read-only and shows one column. **Customise** is
hidden. If the window is made narrower while editing, the unsaved changes are dropped.
Use a wider window or a laptop to change the layout.

## Widgets

A widget shows only when the person has every permission it needs and every module it
needs is on. "Reports" below means Reports & analytics.

| Widget | What it shows | Needs permission | Needs module |
| --- | --- | --- | --- |
| Net sales | Value of bills issued, less credit notes. | `reports.read` | Reports |
| Bills | Bills issued in the period, including any later voided. | `reports.read` | Reports |
| Average bill | Average value of the bills issued, before credit notes. | `reports.read` | Reports |
| Discounts | Total discount given on bills. | `reports.read` | Reports |
| GST collected | GST (CGST and SGST) on the bills issued in the period. | `reports.read` | Reports |
| Credit notes | Value of refunds issued through credit notes. | `reports.read` | Reports |
| Outstanding | Value of bills issued in the period that are still unpaid. | `reports.read` | Reports |
| Cash collected | Cash received, less cash refunds paid out. | `reports.read` | Reports |
| UPI collected | UPI received, less UPI refunds paid out. | `reports.read` | Reports |
| Card collected | Card payments received, less card refunds paid out. | `reports.read` | Reports |
| Cancellations | Value of items cancelled after ordering, at menu price. | `reports.read` | Reports |
| Sales by hour | Sales for each hour of the day. | `reports.read` | Reports |
| Daily trend | Sales for each day in the period. | `reports.read` | Reports |
| Payment mix | How much was paid by each payment method. | `reports.read` | Reports |
| Order types | Sales split between dine-in, takeaway and Zomato. | `reports.read` | Reports |
| Top items | Best selling items by sales. | `reports.read` | Reports |
| Top categories | Best selling categories by sales. | `reports.read` | Reports |
| Open tables | Tables with a running order right now. | `tables.read` | None |
| Running KOTs | Kitchen tickets still being cooked. | `kots.read` | Kitchen Display (KDS) |
| Pending QR orders | QR orders waiting to be accepted. | `orders.read` | QR guest ordering |
| Low stock | Ingredients at or below their reorder level. | `stock.read` | Inventory |
| Unsettled bills | Bills raised but not yet paid. | `bills.read` | None |

The first eleven are single-number tiles, the next six are charts or rankings, and the
last five are live counts of what is happening now. Status widgets have no period.

## Periods and comparisons

Each tile and chart has its own period: **Today**, **Yesterday**, **This week**,
**This month**, **Last 7 days** and **Last 30 days**. Dates use the restaurant
server's calendar and timezone. Weeks start on Monday.

Widgets that allow a comparison offer **No comparison**, **Previous period** or **Same
days last week**:

- **Previous period** is the block of days of the same length right before the period.
  For This month it is the same days of last month, cut short at the end of that month
  (on 31 July it compares with 1 to 30 June). For This week it is the same days of
  last week.
- **Same days last week** moves the period back seven days.

Top items and Top categories have no comparison. Charts and rankings may also offer
an order type filter, and rankings a row count.

## How the figures match the reports

The tiles for sales and collections come from the same calculation as **Reports →
Sales**. The charts and rankings come from the same order analytics as **Reports →
Analytics** (see [Order analytics](order-analytics.md)). For the same dates and order
type, a widget and the report show the same number. The rules are the ones in
[Sales dashboard](sales-dashboard.md):

- Credit notes subtract on the date they were made, not the date of the bill.
- Collections are net of refunds paid out.
- **Bills** includes bills that were voided later.
- **Cancellations** is the value of the cancelled items at menu price.
- **Outstanding** is the unpaid balance today of bills issued in the period.

Live status widgets read the current state, whatever the date.

## Hidden widgets and permissions

If a person loses a permission, or a module a widget needs is switched off, the widget
is hidden from them. It is not deleted. It stays in their saved layout and comes back
when the permission or module does. Saving never removes a hidden widget, but it
counts towards the 30-widget limit. The server also refuses to show a widget the
person cannot see, so a stale browser tab cannot display it.

If Dynamic Reports itself is switched off, or the person loses
**Customise own dashboard**, Home goes back to the fixed Sales dashboard. Saved
layouts are kept.

## Troubleshooting

**Home still shows the fixed dashboard.** Check each of these:

1. The licence includes Dynamic Reports (**Settings → Plan and devices**), and the
   counter has checked in since the portal change.
2. The **Dynamic Reports** switch is on in Marketplace.
3. The person has **Customise own dashboard**, and has signed in again since it was
   granted.
4. The person has **View** under Reports (`reports.read`).
5. **Sales dashboard** is on in Marketplace. Dynamic Reports depends on it and shows
   "Waiting" while it is off.

**A widget disappeared.** The person lost a permission it needs, or a module it needs
was switched off (for example Kitchen Display for Running KOTs). It comes back when
access is restored. Nothing was deleted.

**Save says the dashboard is full.** A layout holds 30 widgets, and widgets hidden
from the person count. Remove a widget you do not need and save again.

**A widget shows an error with Retry.** Only that widget failed; the others keep
their figures. Press **Retry** or wait for the next refresh.

**Dragging on a tablet.** Touch dragging and resizing have not been tested on a real
tablet yet. Test on the tablet over the LAN before relying on it: dragging and
resizing should work without scrolling the page. Below 720 px the layout cannot be
edited at all.
