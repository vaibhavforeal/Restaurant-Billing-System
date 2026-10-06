# Refunds and voids

Use these actions when a bill is wrong or when money has to go back to a guest.
They are in the bill view: open an order's bill, or open **Reports → Bills** and
choose **Open bill**. Administrators and cashiers see **Void bill** and **Refund
items**. Captains and the kitchen do not.

Every void or refund creates a **credit note**: a numbered, dated record
(CN-1, CN-2, ...) that is added to the books on the day it is made. The original
bill is never edited. Available on Basic and Pro.

## Void or refund?

| Situation | Use |
| --- | --- |
| The whole bill is wrong, or the guest leaves and the bill is cancelled | **Void bill** |
| A bill is still unpaid and should simply go away | **Void bill** (it cancels the order and frees the table) |
| One or more items were wrong, cold, or not served, after payment | **Refund items** |
| An older bill from before item lines were saved | **Void bill** only |

A void credits everything that is left on the bill. If items were already
refunded, a later void credits only what remains and returns only the money still
held, so nothing is refunded twice. A bill that has been voided, or fully
refunded, cannot be voided or refunded again. A voided bill cannot be settled.

## Voiding a bill

1. Open the bill and choose **Void bill**.
2. Pick a reason (Wrong item, Quality complaint, Long wait, Guest changed mind,
   or Other), and add details if you like. A reason is required.
3. Check the credit shown under **Credit note**.
4. For a paid bill, check the refund method rows (see below).
5. Cashiers enter an admin PIN under **Admin approval**.
6. Choose **Void bill**.

An unpaid bill shows "This cancels the bill and frees the table". There are no
refund rows. The order is cancelled and its table is freed, including any tables
that were merged into it. Kitchen tickets already sent are not changed.

The bill is marked **VOID**. It still counts in the sales of the day it was
issued; the credit note takes that amount off on the day you void it.

## Refunding items

1. Open a paid bill and choose **Refund items**.
2. For each item, set how many to refund with the stepper (or **All remaining**).
   Each line shows "n billed · m refunded", so you cannot refund more than is left.
3. Pick a reason, check the credit preview, set the refund methods, add the admin
   PIN if you are a cashier, and choose **Refund ₹<total> as credit note**.

The credit is worked out from the bill as it was issued: the item's value after
discount, with its GST and round-off, split by quantity. Several partial refunds
of one item always add up to exactly the item's billed value, to the paisa, and
all credit notes on a bill never add up to more than the bill total. The bill
stays **Paid** and shows **Partly refunded**, then **Refunded** once everything has
been credited.

## Admin approval

A cashier can start a void or refund only with an administrator's approval. The
admin types their PIN into **Admin approval** on the same screen; the admin does
not need to log in. An administrator who does the void or refund themselves
approves it automatically. Both names are saved on the credit note.

- The PIN must belong to an active administrator.
- A wrong PIN shows "Admin PIN is incorrect". After 5 wrong tries from the same
  device the screen asks you to wait a few minutes. This counter is separate from
  the sign-in counter.

## Choosing refund methods

For a paid bill the screen suggests how to return the money, based on how the
guest paid (split payments are shared in proportion). You can change it:

- Staff choose the method (cash, UPI or card) and amount. **Add refund method**
  adds a row for a split refund.
- The amounts must add up exactly to the credit total (for a void, to all the
  money still held on the bill).
- A method can never be refunded more than was paid by that method, less what has
  already been refunded by it. The list shows "up to ₹..." for each method.

ForkFlow records the refund; it does not move money. Hand back the cash, or send
the UPI or card refund in your payment app, at the same time.

## What changes in the reports

A credit note is counted on its own date. A day's figures change only if a credit
note was made that day. Closed days and filed GST never change.

- **Day-end / GST** has a **Credit notes (voids and refunds)** block: how many,
  taxable value, CGST and SGST, the credited GST per rate, and refunds paid per
  payment method. Below it, **Net sales after credit notes** shows net taxable
  value, net CGST and SGST, and **Net GST per rate** (bills minus credit notes).
  **Net payments received** takes refunds off each method, so expected cash
  matches the drawer.
- **Sales report** adds **Credit notes** and **Net sales** columns. The Collections
  view shows receipts net of refunds paid out that day.
- **Item/category sales, hourly sales, cashier collections and order analytics**
  are net of credit notes. Refunds count against the cashier who made them.
- **Food cost & profit** (Pro) uses revenue net of credit notes. Ingredient cost
  is not changed.
- **Reports → Detailed reports → Credit notes** lists every credit note in the
  range: number, date, bill, kind, reason, who requested and approved, refund
  methods, taxable value, GST and total. **Export CSV** downloads it.

Example: a Monday bill is voided on Tuesday. Monday's gross sales and GST do not
change. Tuesday shows a credit note, and Tuesday's net sales are lower by that
amount.

## Printing and viewing credit notes

When a credit note is made, the result offers **Print credit note** (choose a
printer first if there is more than one) and **View**. The bill view also lists
every credit note on the bill, with date, kind, amount, reason, who requested
and approved, and **Reprint** and **View**.

The slip shows the restaurant name and GSTIN, **CREDIT NOTE CN-n**, the original
bill number and date, the items and quantities, GST per rate, the total, the
refund methods, the reason, and the approver. **View** opens the slip in the
browser, where **Print / save PDF** gives an A4 copy. Printing uses the same print
queue as bills and KOTs: check **Settings → Print jobs** if it does not print.
The original receipt reprints exactly as it was issued.

## Things to know

- **Older bills are void-only.** A bill issued before item lines were saved shows
  "This older bill can only be voided". Void it, and re-bill if needed.
- **No stock change.** Voided or refunded food was already prepared, so recipe
  stock is not returned.
- **Not covered.** Correcting the payment method of a bill, reopening a bill to
  edit the order, refunding an amount that is not tied to items, and e-invoicing
  credit notes are not available.
- **Changed meanwhile.** If another device changed the bill, the screen says "This
  bill changed — review again" and refreshes. Check the credit and try again.
- **Retries are safe.** If the connection drops, pressing the button again does
  not create a second credit note.
- Credit notes cannot be edited or deleted. They are included in backups.

See [Bill formats](bill-format.md), [Detailed reports and captains](detailed-reports-and-captains.md)
and [Sales dashboard](sales-dashboard.md) for the reports.
