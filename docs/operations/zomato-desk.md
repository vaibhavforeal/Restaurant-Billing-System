# Zomato desk

The **Zomato desk** handles Zomato orders at the counter, next to the open takeaways.
A cashier punches each Zomato order into the POS using its Zomato order ID. The order
is priced at Zomato prices, sends KOTs to the kitchen, moves through **Preparing**,
**Ready** and **Picked up**, and closes on its own as money Zomato owes the restaurant.

It works without any Zomato API access. ForkFlow does not talk to Zomato in this
release: statuses, prices and accept/reject are not sent to Zomato. Keep accepting
orders in the Zomato partner app and punch each accepted order in here.

## Turn it on

An administrator turns **Zomato** on in the [Marketplace](marketplace.md). Admins and
cashiers then see a **Zomato** section on **Tables & orders**. Waiters, captains and
kitchen staff never see it, and the server refuses them if they ask for it directly.

The Zomato card in the Marketplace has a **Settings** button (admin only) that opens
the connection form: the Zomato restaurant ID and name. Save the restaurant ID before
you import payout sheets. See [Zomato setup and reconciliation](zomato.md).

The same form sets how fast an order should move. **Amber after (minutes)** and
**Red after (minutes)** are counted from punch-in; a card turns amber, then red, once
its age passes each value. They start at 15 and 25 minutes. Each is a whole number from
1 to 240 and red must be later than amber. A change shows on every counter within seconds.

If Zomato is turned off while orders are still open, the section stays until they are
closed and **Ready** and **Picked up** keep working. Only **+ New** is refused.

## Punch in an order

1. On **Tables & orders**, press **+ New** in the **Zomato** section.
2. Type the Zomato order ID exactly as the Zomato app shows it (1 to 40 letters,
   numbers or dashes) and press **Open order**.
3. The order screen opens with the header **Zomato #<id>**. The menu shows Zomato
   prices. Add the items and press **KOT**.

Each Zomato order ID can be used once. If you punch an ID that is already on the desk,
the dialog says so (with an **Open order** button when that order is still open). An ID
stays reserved after the order is cancelled, so after a typo cancel the order and punch
it again with the correct ID.

An item's Zomato price is optional. Set it in **Catalog**, in the product (and each
variant) next to Takeaway; **blank means the Takeaway price**, and a blank Takeaway
price means the normal price. A Zomato price of 0 is a real price of ₹0.

## Statuses

Every open Zomato order is a card in the Zomato section, oldest first, with the order
ID, its age in minutes, the item total, a status pill and one button.

| Status | Meaning | Button |
| --- | --- | --- |
| New | Punched in, nothing sent to the kitchen yet | **Add items**, or **Ready** once it has items |
| Preparing | A KOT went to the kitchen | **Ready** |
| Ready | Food is packed and waiting for the rider | **Picked up** |
| Picked up | The rider took it; the order is closed | none |

- Sending the first KOT moves the order from New to Preparing.
- If the Kitchen Display is on, marking every ticket of the order **Done** moves it to
  Ready by itself. Otherwise press **Ready**.
- **Ready** is refused while items are still unsent. An order whose items need no kitchen
  station (for example cold drinks only) can go from New straight to Ready.
- Items added after Ready must be sent first. Sending them moves the order back to
  Preparing.
- **Picked up** asks "Close Zomato #<id>?". It creates the bill and records the payment
  in one step. Pressing it twice, or from two counters, closes the order once.
- To cancel an order that has not sent anything to the kitchen, use **Cancel order** on
  the order screen.
- Once a KOT has gone out, **Cancel order** is hidden. Cancel each sent item first (an
  admin or cashier gives a reason); the kitchen gets a cancel slip labelled with the
  Zomato order ID, and the stock those items used is returned. When no sent item is
  left, **Cancel order** appears again. The cancelled order still appears in
  reconciliation, with value 0.

The same status pill and next-step button are on the order screen, where the bill,
discount and payment controls are replaced by them. Zomato orders cannot be billed,
discounted or paid from the cashier payment screen.

## Printing

**Only KOTs print.** The kitchen slip reads `ZOMATO #<id>` and the print job is labelled
`KOT #n — Zomato #<id>`. Zomato bills are never printed, automatically or on request,
and the server refuses a print request. Zomato issues the customer's invoice. The
Kitchen Display shows the ticket as **Zomato #<id>** with a Zomato colour tag.

## Bills, GST and refunds

**Picked up** issues a bill for the item value with no discount and **no GST charged**,
whatever the restaurant's GST setting (Settings > Restaurant profile > GST). The bill is marked
**GST paid by Zomato (section 9(5))** and the payment mode is **Zomato**.

For these supplies Zomato, as the e-commerce operator, is responsible for collecting and
paying the GST under section 9(5) of the CGST Act. **This guide is not tax advice.
Confirm the treatment with your accountant before going live.**

Find a Zomato bill in **Reports → Bills** (show **All bills**); it appears as
"Zomato #<id>". It has no Print, Reprint, Void or Credit note button, and credit notes
are refused: **Zomato handles refunds for Zomato orders**.

## Reports and the dashboard

- **Home:** a **Zomato** card next to Dine In and Takeaway, a Zomato series in the
  sales-by-slot chart, and the open Zomato orders in **Alerts** (oldest first) while
  Zomato is on. Zomato sales are part of Total Sales.
- **Day-end:** a line **Zomato receivable (outstanding)** with the total of the Zomato
  bills closed (picked up) that day. It is the amount Zomato owes for that day's orders;
  it is not reduced when Zomato pays out, so check payouts in **Zomato reconciliation**.
  It is not part of expected drawer cash or of the cash, UPI and card totals.
- **Day-end GST:** Zomato bills are left out of the GST breakdown and the net taxable
  value, so GST payable is unaffected. Their value is shown on one line, **Supplies under
  section 9(5) (GST paid by Zomato)**. The day-end CSV export has both Zomato lines.
- **Reports → Sales:** when Zomato bills closed in the period, a **Zomato receivable
  (outstanding)** card sits beside **Collections received**. Zomato bills count in sales
  but never in collections, so for bills paid on the day they are issued, sales =
  collections + Zomato receivable + still unpaid (before refunds).
- **Reports → Item / category sales:** a table **Aggregator supplies — GST paid by Zomato
  (section 9(5))** lists the Zomato bills and their values for the period, for your accountant.
- **Reports → Order analytics** reports Zomato orders as their own order type.

## Reconciliation

Open **Reports → Zomato reconciliation** (admins and cashiers, whether or not Zomato is
turned on in the Marketplace). It compares the POS Zomato orders with Zomato's payout sheet:

- The order side is the POS Zomato orders in the period, closed or cancelled. A cancelled
  order has value 0 and is flagged **Review cancellation** if the sheet still pays it.
- Imported order history only fills in order IDs that are not in the POS.
- Import payout sheets here too. Rows, states and CSV templates are described in
  [Zomato setup and reconciliation](zomato.md).

A new order shows **Awaiting statement** until the payout sheet that includes it is
imported. Receivables from closed Zomato orders still show on day-end and in
reconciliation after Zomato is turned off.

## Not done yet

This is part 1 of 3. These are **not** available:

- Accepting or rejecting orders, and the auto/manual accept setting (part 2).
- Sending the menu, prices or stock to Zomato.
- Live orders from Zomato and live status updates (part 3). Zomato's direct POS
  integration requires 500 outlets or 50,000 orders a month, so a single restaurant
  would connect through an approved integration provider.
- Customer and rider details, promised times, and Swiggy.

## Checking it

`tools/e2e/zomato-desk.js` runs this flow in a browser against a disposable restaurant;
see `tools/e2e/README.md`. Use only that disposable fixture.
