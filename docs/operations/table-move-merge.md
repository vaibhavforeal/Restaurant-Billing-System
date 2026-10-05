# Moving and merging tables

Use these actions when a party changes seats or when two parties settle one
bill. They are on the order screen for open dine-in orders: **Move table…** and
**Merge…** appear beside **+ Split** at the counter and in the **More** menu in
the Captain app. Administrators, cashiers, and waiters/captains can use them.
Each change records the staff member who made it. Takeaway orders cannot be moved
or merged, and neither can bills that are already issued, settled, or cancelled.

## Moving a party

Open the party's order and choose **Move table…**. Pick the new table and confirm
(for example "Move T3-A to T7?"). The order, items, kitchen tickets, and prices
travel with the party.

- The destination must be an active, free table that is not reserved right now.
  Occupied tables are shown as "occupied — merge instead", and tables with a
  booking in progress as "reserved now".
- One bill group moves at a time. It takes the next free split letter at the
  destination (**A** when the table is empty).
- Items already ordered keep their prices. New items use the destination
  table's AC or Non-AC prices.
- The captain stays the same.

The result line reads "Moved to T7 · kitchen notified".

## Merging into one bill

Choose **Merge…** on one of the orders. The list shows every other open bill
group, grouped by table, with its item count and amount. This works for two
different tables and for two bill groups on the same table. Then choose where the
bill goes: **Bill at** this order's table or **Bill at** the other table. The
order at that table keeps the bill, its captain, and its prices.

- All items (including pending and cancelled ones) and kitchen tickets move to
  the combined order. Their prices, stock deductions, and costs do not change.
- New items on the combined order use the table that keeps the bill.
- Guest QR requests already accepted move with the items. A request still waiting
  keeps its table; accepting it from a linked table lets you add it to the
  combined bill, unless that table uses different (AC/Non-AC) pricing. In that
  case the screen says "This bill uses different pricing. Create a new bill
  group."
- Merging is blocked while the cart has unsaved items. Send them to the kitchen
  (or punch them) first, or discard them: "Save or discard the cart items before
  merging."
- Both orders must still be open. If one was billed or changed meanwhile, the
  screen shows the error and reloads the list itself.

The result line reads "Merged · T3, T4 billed together". Order headers, table
cards, the Kitchen screen, kitchen slips, and the receipt show the combined name
(`T3, T4`). The receipt keeps the name it had when the bill was issued.

## Linked tables

A table whose order was folded into another stays linked to the combined order:
occupied, then billed, until paid. On the Tables screen its card shows
"with T3", and tapping it opens the combined order. The receiving card shows the
combined name. A second device still showing the merged-away bill sees "Merged
into T3, T4" and opens the combined bill. Once the bill is paid or the order is
cancelled, every linked table becomes free again. Reservations are not changed
by a move or merge; a table with a booking in progress can still be merged onto,
because the party is already seated.

If a combined order is moved, its linked tables stay linked. Further merges add
more linked tables.

## Kitchen

The Kitchen screen updates live to the new table name. Each kitchen station that
still has unfinished tickets on the order prints a short slip with table names
only, and no KOT numbers. A move prints `T3 -> T7`. A merge prints the combined
name, `T3, T4`. If a slip cannot print, the order screen shows the problem and
the change still stands; check the printer and tell the kitchen directly. A
station with no active printer gets no slip, so tell that station directly.
Kitchen acceptance before billing applies to all tickets on the combined order.

## What cannot be undone

There is no un-merge. A combined order cannot be split back into the original
bills, and individual items cannot be moved between orders. Moving a party back
to its old table is a new move, and only works while the old table is free.
Existing items are never repriced. Check the two orders before confirming a
merge. Merged-away orders are excluded from the
cancellation report and the day-end cancellation count.

See [Tables & orders](tables-workspace.md) for the Tables screen and
[Table reservations](table-reservations.md) for booking rules.
