# Table reservations

Open **Tables & orders → Reservations**. Admins and cashiers can create, edit,
cancel, mark no-shows, and seat bookings. Waiters can view bookings and open
their existing orders. Kitchen accounts have no reservation access.

Choose **New reservation**, enter the guest name, optional phone number, party
size, table, date/time, duration, and optional notes. The default duration is
90 minutes; allowed durations are 15–480 minutes. Dates use the restaurant
server's timezone, displayed above the form. Check the table has enough seats
for the party. Use the date and table filters to review bookings.

Overlapping bookings for the same table are rejected. Adjacent bookings are
allowed. Future bookings may be made while a table is occupied, so staff must
allow enough time for its current party to leave. Table cards show the next
booking; a physically free table becomes **Reserved** during the booked period.
Click its card to open that table's reservations. Table availability refreshes
after changes and every 30 seconds.

Use **Seat & open bill** from 30 minutes before the booking until its end. The
table must have no open or billed orders, and early seating must not overlap
another reservation. Seating creates one dine-in order and opens its order and
billing workspace. Add dishes, send kitchen tickets, issue the bill, and collect
payment through the existing workflow. Reopening or retrying a seated booking
uses the same order.

While a booking is active, ordinary orders and new QR bill groups cannot consume
its table. Seat the booking, move it, or cancel it first. QR items can then be
accepted into the seated party's existing order.

Use **Edit** to reschedule or move a booked party. Changes made at another counter
cause a conflict: return to the list, refresh, and reopen the booking to review
the latest details. Unsaved changes prompt before leaving; saving blocks
navigation until the request finishes. If a save response is lost, retry the
unchanged form to recover the saved booking without duplicating it.

**Cancel reservation** releases the slot immediately. **No-show** is available
once the booking's start time arrives. Expired bookings stop holding the table
but stay visible for review; mark them as no-shows or reschedule them. Cancelled
and no-show entries stay in history. Seated bookings keep their original slot
while their linked order is open or billed. An open order still occupies its
table after the reservation period ends.

An active or future booking prevents table deactivation. Move or cancel those
bookings first. Bookings that cross midnight appear on both relevant dates.
Reservation data is stored in SQLite and included in the existing database
backup and restore flow; migration 12 adds the table without replacing existing
restaurant records.
