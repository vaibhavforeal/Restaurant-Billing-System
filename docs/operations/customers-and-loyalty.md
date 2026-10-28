# Customers & loyalty (CRM)

Save customers by mobile number, see each customer's visits and spend, reward them with loyalty
points (optionally with tiers), collect ratings through the receipt, and pull out groups of
customers for offers. Available on Basic and Pro.

## Turn it on (admin)

CRM & Loyalty is an add-on, included on both plans unless ForkFlow has blocked it for your
restaurant (see [Feature controls](feature-controls.md)): open **Marketplace** and switch on
**CRM & Loyalty**. While it is off,
**Customers** is hidden from the menu, orders have no customer picker, and bills get no customer
discount, loyalty points or feedback QR code. Customers, points and ratings already saved are kept
and come back when it is switched on again. Installations that already had customers or loyalty
points when the add-on was introduced start with it on.

Open **Customers** in the menu. The screen has five tabs: **Customers**, **Segments**,
**Feedback**, **Insights** and (admin only) **Settings**.

## Customers (cashier or admin)

- Search by mobile number or name. Tick **Show inactive** to include customers marked inactive.
- **Add customer**: name and a 10-digit mobile number, and optionally a type, birthday, tags and
  whether they are happy to receive offers. A number can belong to one customer only; +91 and
  spaces are removed automatically.
- Choose a customer to open their profile:
  - their tier and points, and how many points expire in the next 30 days;
  - visits, total spend (refunds subtracted, void bills left out), average bill, last visit and
    the items they order most;
  - **Bills** (use **Load older bills** for more), **Points** history (with expiry dates),
    **Feedback**, and **Edit**.
- **Edit** holds the profile: email, birthday and anniversary (tick **Year known** if you have the
  year), gender, type, tags (comma-separated), notes, **Happy to receive offers** and **Active**.
  An inactive customer keeps their history but cannot be added to new orders.
- A 🎂 shows when a birthday or anniversary is within three days, in the list and on the order.

Captains can find customers but not add them.

## Add a customer to an order

In the order header choose **Add customer**, type at least three digits of the number (or part of
the name), and pick the customer. Cashiers and admins can add a new customer there by typing the
full number and a name. Use **Change** or **×** to replace or remove them while the order is open.
Zomato orders cannot have a customer. The header shows the customer's tier and any birthday or
anniversary coming up.

## Loyalty points (admin: Settings tab)

- **Points per ₹100 spent**: points earned for each full ₹100 of the bill total (after discounts).
- **Value of 1 point**: the discount one point gives.
- **Minimum points to redeem** at a time.
- **Points can pay up to (% of bill)**: the most of a bill (after other discounts) points can pay.
- **Points expire after (months)**: 0 means points never expire. Otherwise each bill's points
  expire that many months after the bill. When a customer spends points, the oldest are used
  first. A change applies to points earned from then on; points earned before keep their date.
  Points that are already past their date cannot be spent, even before they show as expired in
  the history (the server records expiries at start-up and every six hours).

Turn **Loyalty points on** to start. Points are earned when the bill is issued.

To spend points, open **Bill options** in billing and enter **Redeem points**. After the first
preview the label shows the most this bill allows. The points' value comes off the bill like a
discount (GST is worked out on the reduced amount).

The receipt shows the customer, their tier, points redeemed, points earned and the new balance.
Only the last four digits of the mobile number are printed.

## Tiers (admin, optional)

Tick **Use tiers** to give customers a tier from what they spent in the last N months
(**Tier from spend in the last**). Under **Tiers** add each tier with the spend it starts at and a
points multiplier, for example Silver from ₹0 at 1×, Gold from ₹10,000 at 1.5×, Platinum from
₹25,000 at 2×. The highest tier a customer reaches applies to the points of their next bill.
Tiers are worked out from spend each time, so a customer drops a tier when old spend leaves the
window.

Leave **Use tiers** off to run **points only**: everyone earns at the same rate and no tier shows.

## Customer types and discount slabs (admin: Settings tab)

Types are separate from tiers: an admin chooses a customer's type by hand, and the type gives an
automatic discount.

1. Add a type, for example **Regular** or **Staff**.
2. **Edit slabs**: each slab gives a percent off from a minimum bill, optionally only between two
   dates (for a festival offer). Example: 5% on any bill, 10% from ₹1,000.
3. Give customers the type on their profile.

At billing, the best slab the bill qualifies for is applied automatically, on top of any discount
staff enter. The bill's discount reason shows it (for example "Birthday · Regular 10%"). Slab
discounts do not count against staff discount limits. Turning a type off stops its discount.

## Feedback

Tick **Print a "Rate your visit" QR code on bills** in Settings. Every bill issued after that
prints a QR code (thermal slip and A4) that opens a short rating page: overall stars (required),
food, service and ambience (optional) and a comment. Each bill can be rated once, within seven
days. Zomato bills get no QR code.

The QR code points to this computer's address on the restaurant network, so **guests must scan it
while on the restaurant Wi-Fi**. If the computer's IP address changes, reprinted bills use the new
one.

Staff can also record a rating from a paper card: open the customer's profile, **Feedback**,
**Record a rating**. The **Feedback** tab lists every rating by date, with low (1–2 star) ratings
highlighted and the average for each part.

## Segments

The **Segments** tab finds groups of customers. Start from **Everyone**, a ready-made segment
(Lapsed 60 days, Regulars, New this month, Birthdays this week, Anniversaries this week, Points to
spend) or a saved one, and combine conditions: tier, type, tags, visited recently or not for a
while, joined recently, minimum visits, spend or points, a birthday or anniversary coming up,
opted in to offers, and whether to include inactive customers. The count and list update as you
change the conditions. **Save segment** keeps it for later.

Admins can **Export CSV** for use in a messaging or spreadsheet tool. By default the file holds
only customers who are happy to receive offers; tick **Include customers who did not opt in** to
export everyone in the segment. The file has name, phone, email, type, tier, tags, visits, spend,
last visit, points, birthday, anniversary and opt-in.

## Insights

The **Insights** tab shows, for the chosen dates: customers who came in, new and returning
customers, the repeat rate, the share of bills with a customer, customers on file and opted in;
points given, redeemed and expired, unspent points today and what they are worth; customers per
tier; the average rating and ratings by stars; and the top ten customers by spend.

For your own breakdowns, the custom report builder has **Customers**, **Loyalty points** and
**Feedback** sources (see [Custom reports](custom-reports.md)).

## Voids and refunds

- A **void** takes back all points the bill earned and returns any points it redeemed.
- A **refund** takes back earned points in proportion to how much of the bill has been refunded.
- Points from the bill that have already expired are not taken back a second time.

If the customer already spent the points, their balance can go below zero; it recovers as they
earn again. Admins can **Adjust points** on a customer's **Points** tab, with a reason; points
added this way expire like earned points. All points changes are kept in a history that cannot be
altered.
