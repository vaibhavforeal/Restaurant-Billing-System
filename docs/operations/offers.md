# Offers

An offer is a deal the till applies by itself: buy one get one free, 20% off cold drinks, 10% off a bill above ₹500. You
set it up once. After that, every bill that matches it gets the discount, and the cashier sees it before the bill is
issued. Available on Basic and Pro. Offers is a Marketplace add-on and starts **off**: an administrator turns it on in the
**Marketplace**. Developers: see [docs/offers/README.md](../offers/README.md).

## Setting up an offer (admin)

Open **Catalog**, select **Offers**, then **New offer**. Pick the kind first; the form then asks only what that kind needs.
Every offer has a **name** (up to 40 characters, printed on the bill) and an on/off switch.

| Kind | Example | What it does |
|---|---|---|
| **Buy and get** | Buy 1 get 1 free on pizzas | The customer pays for the **buy** items and gets the **get** items at a discount. 100% off means free; 50% means half price |
| **Discount on items** | 20% off beverages, or ₹30 off each cold coffee | Takes a percent, or a fixed ₹ amount, off **each** unit of the items. A ₹ discount never takes an item below ₹0 |
| **Discount on the bill** | 10% off a bill above ₹500, up to ₹150 | Takes a percent or a ₹ amount off the whole bill. Optional **minimum bill**; for a percent, an optional **maximum discount** |

Buy and get, and discount on items, apply to the **items** you pick: whole categories, single items, or both. A single
item covers all of its sizes. A discount on the bill has no items; it covers everything.

**Buy and get details.** The discount always goes to the cheapest units, so a customer never gets a dearer item free:
with one ₹349 pizza and two ₹299 pizzas on a "buy 1 get 1 free" offer, one ₹299 pizza is free. Switch on **Same item only** when
the units must be the same dish and size (two Margherita, not a Margherita and a Farmhouse). Otherwise any items from
the set count together.

### When an offer applies

All of these are optional. Leave one blank and it does not limit the offer.

- **Dates:** a first and last day, both included.
- **Days and times:** tick the days of the week, and give a start and end time if the offer runs only part of the day.
  A window can pass midnight, such as 22:00 to 02:00. The 1 am part still counts as the day the window started, so
  1 am on Saturday belongs to Friday's 22:00 to 02:00 offer.
- **Order types:** dine-in, takeaway and so on. Leave it empty for all. Zomato orders can't have offers.

## How offers combine

1. **Item offers add up, but each item counts toward one offer only.** If two offers want the same pizza, the one that
   saves more takes it, and the other offer uses what is left. If two save the same, the one made first wins.
2. **Then one bill offer at most.** The best one applies, worked out on the total after the item offers.
3. **Your other discounts come after.** A customer's type discount, loyalty points and a discount the cashier types in
   are worked out on what the offers leave. Offers never count against a cashier's discount limit and need no admin PIN.
   A discount the cashier types in still follows the limit, and above it needs an admin PIN (see
   [Discount limits](discount-limits.md)).

### Example

A bill of 2 × Margherita ₹299, 1 × Farmhouse ₹349 and 2 × Coke ₹60 is ₹1,067.00. With these offers:

| Offer | Discount | How |
|---|---|---|
| **BOGO Pizza** (buy 1 get 1 free, Pizzas) | −₹299.00 | One Margherita is free |
| **Cool Drinks** (20% off Beverages) | −₹24.00 | 20% of ₹60, twice |
| **Big Bill** (10% off, bill of ₹500 or more, at most ₹150) | −₹74.40 | 10% of the ₹744.00 left |

The offers come to ₹397.40, so the bill is ₹669.60, rounded to ₹670.00. The bill prints each offer by name:

```
Subtotal (5 qty)          1,067.00
Offer: BOGO Pizza          -299.00
Offer: Cool Drinks          -24.00
Offer: Big Bill             -74.40
Round off                     0.40
TOTAL Rs.                   670.00
```

GST is worked out on what is left after the offers, at each item's own rate.

## At the counter

- When the cashier previews the bill, each offer that applies is listed above the discount box with its amount, such as
  **BOGO Pizza −₹299.00**.
- To leave an offer off **this bill only**, tap **✕** next to it. It moves to **Removed: tap to restore**; tap it there to
  bring it back. The total updates each time. Other bills are not affected.
- Offers work from the time the bill is previewed. If an offer switches off or its time window ends before the bill is
  issued, the cashier is asked to review the bill again.
- The receipt prints each offer by name, and the bill's discount total includes them. Staff activity does not count offers
  as a discount the staff member gave.

## Changing and removing offers

- Editing an offer changes **new bills only**. Each issued bill keeps the offer's name and amount as they were.
- An offer that is on any bill **can't be deleted**, so old bills and reports always find it. **Switch it off** instead; it
  stops applying and stays in the list. An offer that has never been on a bill can be deleted.
- The list shows how many bills each offer was on in the last 30 days (voided bills are not counted).
- If the administrator switches Offers off in the Marketplace, no offers apply and the screen is hidden. Bills already
  issued keep their offers and still print them.

## Reports and refunds

- **Reports → Offers** lists, for a date range, each offer with the number of bills and the total discount it gave.
  Voided bills are left out.
- **Day end** shows **Offer discounts** as part of the day's discounts. Day end counts every bill issued that day,
  including voided ones, so on a day with a voided offer bill it can be higher than the Offers report.
- Item and category reports show each offer's discount against the items it came from, and GST returns use the amounts
  after offers.
- **Refunds** follow the same split: refunding one unit of a "buy 1 get 1 free" pair gives back half of what the pair cost
  (₹149.50 for two ₹299 pizzas billed at ₹299.00).
