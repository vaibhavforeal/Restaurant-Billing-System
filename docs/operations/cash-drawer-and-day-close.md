# Cash drawer shifts and day close

Each cashier works a **shift** on the cash drawer: open it with the float, record cash taken out or
added, and close it by counting the drawer. At the end of the business day an admin **closes the
day**, which saves the day-end report as it was at that moment. Available on Basic and Pro.

Open **Reports → Cash & day close**.

## Open a shift (cashier or admin)

1. Count the change in the drawer.
2. Enter it as **Opening float** and choose **Open shift**.

Each person has at most one open shift.

## During the shift

- **Pay-out**: cash taken out of the drawer (for example to buy milk). Enter the amount and reason.
- **Pay-in**: cash added (for example change from the bank).

**Expected in drawer** = opening float + cash payments on bills you settled − cash refunds you
gave + pay-ins − pay-outs. UPI and card payments are not counted. Cash collected by another person
counts in their drawer.

## Close the shift

1. Count the cash in the drawer and enter it in **Cash counted in drawer**.
2. Check the **Difference** (over or short) and add a note if needed.
3. Choose **Close shift**.

The expected cash, counted cash and difference are saved and cannot be changed afterwards. An
admin can close a shift someone left open.

## Close the day (admin)

1. Choose the date under **Shifts and day close**. The list shows every shift opened that day.
2. The date can be closed only when:
   - every shift opened that day is closed,
   - every order opened that day is billed or cancelled, and
   - every bill from those orders is settled.
3. Choose **Close day**. The day-end / GST report and the day's shifts are saved with the close.

A date can be closed once, and not before it starts. Closing a day does not stop later refunds;
they appear in the reports on their own date, as before.
