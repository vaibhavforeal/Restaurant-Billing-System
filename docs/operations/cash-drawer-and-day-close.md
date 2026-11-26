# Cash drawer shifts and day close

Each cashier works a **shift** on the cash drawer: open it with the float, record cash taken out or
added, and close it by counting the drawer. At the end of the business day an admin **closes the
day**, which saves the day-end report as it was at that moment. Available on Basic and Pro.

Open **Reports → Cash & day close**.

## Open a shift (cashier or admin)

1. Count the change in the drawer.
2. Select the available drawer. An admin can add named drawers on this screen. Enter the count as **Opening float** and choose **Open shift**.

Each person has at most one open shift.

## During the shift

- **Pay-out**: cash taken out of the drawer (for example to buy milk). Enter the amount and reason.
- **Pay-in**: cash added (for example change from the bank).

**Expected in drawer** = opening float + cash payments on bills you settled − cash refunds you
gave + pay-ins − pay-outs. UPI and card payments are not counted. Cash collected by another person
counts in their drawer.

## Settle and hand over

1. Choose the incoming cashier under **Settle and hand over**. At closing, select **Final handover to admin** and choose the receiving admin.
2. Count the whole drawer, explain any difference and choose **Submit handover**. Cash payments, refunds and drawer movements are frozen for this drawer.
3. For a shortage or excess, an admin signs in, opens **Cash & day close**, and chooses **Approve difference**.
4. The named recipient signs in and enters their own count. A mismatch sends the drawer back for recount. Refresh the drawer to see the latest status.
5. Matching counts close the outgoing shift. The incoming cashier receives the full count as the new opening float. A final admin receipt releases the drawer without opening a shift.

## Close the day (admin)

1. Choose the date under **Shifts and day close**. The list shows every shift opened that day.
2. The date can be closed only when:
   - every shift opened that day is closed,
   - every order opened that day is billed or cancelled, and
   - every bill from those orders is settled.
3. Choose **Close day**. The day-end / GST report and the day's shifts are saved with the close.

A date can be closed once, and not before it starts. Closing a day does not stop later refunds;
they appear in the reports on their own date, as before.
