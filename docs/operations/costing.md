# Inventory costing and profit

Costing shows what each dish costs to make and what the restaurant actually
earned over a period. It builds on stock items and recipes: every ingredient has
a current average cost, every stock movement records the cost value it moved, and
two administrator views turn that into dish margins and a profit report.

## Access

Costing is for administrators on the Pro plan. It needs the `costs.read`
permission, which only administrators hold, and the signed `recipes`
entitlement. Cashiers and other roles see no cost columns, no **Dish costing**
tab and no **Food cost & profit** report, and the server refuses their requests
with 403 (`/api/stock-items` never includes cost). On Basic, administrators
still see the **Dish costing** tab and the **Food cost & profit** report option,
but each shows only an upgrade note ("Ingredient costing and profit reports are
part of the Pro plan."), and they cannot enter costs. All costing is Pro,
whatever the number of ingredients in a recipe.

Costing runs on the restaurant's local server. It adds database migration 023
and no new dependencies. Backups, restores and recovery already cover the cost
data because it lives in the same SQLite database.

## What the average cost means

Each stock item has one weighted-average cost per unit in its own unit: per kg,
per g, per pcs, per L or per ml. A priced delivery blends into the average by
quantity. Example for paneer:

- You hold 5 kg at ₹300.00/kg (₹1,500 of stock).
- You receive 5 kg and pay ₹1,750 including GST.
- The new average is (₹1,500 + ₹1,750) ÷ 10 kg = **₹325.00/kg**.

Sales, wastage and count adjustments then take stock out at the current average.
A dish that uses 100 g of paneer costs ₹32.50 for that ingredient.

- If stock was zero or negative before a delivery, or the previous average was
  unknown, the new average is simply that delivery's price per unit.
- A delivery priced at ₹0 (free samples) is valid and lowers the average.
- Each movement stores its own cost when it happens. Later price changes never
  alter earlier movements or reports.
- Cancelling a sent item returns stock at exactly the cost it was taken out at.
  It does not recalculate the average.
- Each movement's cost is rounded to whole paise; the average is kept to a
  thousandth of a paise so cheap units such as ml stay accurate.

## Enter costs

### Receive stock with an amount paid

In **Inventory → Stock**, choose **Receive stock** and fill **Amount paid (₹,
incl. GST)**. Enter the total you paid for the whole delivery, not the price per
unit. The form shows the per-unit result, for example `= ₹34.00/kg`. GST is
included because a restaurant on 5% GST generally cannot claim input tax credit,
so GST is part of the real cost.

Leave the amount blank to receive the stock without changing the average. The
amount is available only for **Receive stock** (not wastage or counts) and is
optional.

### Set a starting or corrected unit cost

Stock that existed before costing has no cost, so its sales are reported as
unknown. Open the stock item and choose **Set unit cost**. Enter ₹ per unit in
the item's unit (for example ₹320 per kg) and a short note. This replaces the
current average, is recorded in the item's history as **Unit cost set**, and is
needed again only if the average becomes wrong. It does not change past
movements. Archived items cannot be changed.

An opening balance entered when you create a stock item has no cost, so the
item starts as **Cost not set**; set a starting unit cost to value it. Opening
balances are not counted as count adjustments in the profit report.

### Read stock cost

The **Stock** list gains **Avg cost** and **Stock value** columns plus a
**Total value of costed active items**. An item without a cost shows **Cost not
set** and is left out of the total (never counted as ₹0); a note under the total
says how many active items have no cost and are not included. Movement history shows each movement's cost and the **Unit cost set**
entries in time order.

## Dish costing

Open **Inventory → Dish costing**. Each row is a dish, or one portion of a dish
that has variants, with:

- **Recipe cost** at today's average ingredient costs. All portions of a dish
  share the same recipe, so they share one cost.
- For each configured price (Non-AC, AC, takeaway): the price before GST, the
  cost as a percentage of that price, and the margin per plate. A blank service
  price uses the normal price, as it does at ordering. If menu prices include
  GST, GST is removed first so that cost % and margin compare like with like.
- A free item (price ₹0 before GST) shows **no price** for that service
  instead of a cost % and margin.
- **Status**: **Complete**, or **Incomplete — missing cost for** the named
  ingredients (the recipe cost is then unknown, never a partial total).

Rows are sorted by highest cost % first and can be filtered by category. Dishes
with no recipe are listed separately under **No recipe linked**.

## Food cost and profit report

Open **Reports → Detailed reports → Food cost & profit** and choose a date range
(up to 366 days, by the server's calendar, like other reports). The report has a
Summary, a By category table and a By dish table, and **Export CSV** includes the
dates, timezone and calculation notes.

- **Revenue (pre-GST)** is the bill taxable value after discount, excluding GST,
  by bill issue date. Void bills are excluded.
- **Ingredient cost** is the cost recorded when the dish's ingredients were taken
  from stock, less any that were reversed by cancellations.
- **Gross profit** is costed revenue minus ingredient cost. **Food cost %** is
  ingredient cost divided by costed revenue.
- **Wastage cost** and **Count adjustments (net)** appear below gross profit by
  the date of the movement. They do not reduce gross profit.

Only fully costed sales count toward gross profit and food cost %. Two kinds of
sales are shown as excluded revenue instead of as zero cost:

- **Excluded: cost unknown** — at least one ingredient had no cost when the sale
  was recorded.
- **Excluded: no recipe** — the dish consumes no stock.

The By category and By dish tables show **Revenue** (all sales in the row) and
**Costed revenue** (only its fully costed sales). **Cost**, **Gross profit** and
**Food cost %** use costed revenue, so on every row Costed revenue − Cost =
Gross profit. The By dish table starts with the dish's **Category**, so dishes
with the same name in different categories stay separate.

Rows in the tables carry a status so you can see which dishes are affected.
Wastage or count movements with no recorded cost are counted in a note and left
out of the totals.

## Before go-live and after downgrade

Movements recorded before costing was set up have no cost and are never
back-filled. A report range that includes earlier dates will show those sales as
cost unknown. Set unit costs and receive priced stock to start recording costs;
only sales from then on are costed.

Downgrading from Pro to Basic keeps recording cost on sales, as recipes keep
consuming stock. The cost columns, **Dish costing**, **Food cost & profit** and
cost entry are locked until Pro is enabled again, and nothing is lost.

## Not included

Suppliers, purchase orders, invoice matching and GST input reports, reorder
suggestions, per-variant recipes or portion multipliers, FIFO or batch costing,
and inter-outlet inventory are not part of costing.
