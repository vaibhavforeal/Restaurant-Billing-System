# Takeaway billing

Takeaway gives cashiers and administrators a shorter checkout for parcel
orders. It is included in both Basic and Pro, subject to the outlet's normal
license and device access. A takeaway has no dining table.

## Open and check out a takeaway

1. Choose **Takeaway** from **Home** or **Tables & orders**. An unfinished
   takeaway saved for this staff member in this browser opens again; otherwise
   ForkFlow starts a new parcel.
2. Select menu items, portions, quantities, and any notes. Review the cart.
   Search and **Menu category** filter the compact menu. On phones, switch
   between **Menu** and **Order**, or use **View cart**. Long item lists scroll
   inside their panels while totals and checkout remain visible.
3. Choose **Pay · F10**. ForkFlow punches the cart and sends pending items assigned
   to kitchen stations before showing the GST bill preview. This action can
   create KOTs and deduct their ingredients, even before a bill is issued.
4. Review the total in the checkout dialog. **Bill options** contains the
   receipt printer and discount; **Tax details** expands the GST breakdown.
   Bill options can also be opened before checkout. Discounts need a reason, and cashiers keep
   the existing 10% limit. A changed cart or discount needs a fresh checkout
   preview before issuing the bill.
5. Choose **Cash**, **UPI**, or **Card**. For cash, enter **Cash received** to see
   the change due; leaving it blank means the exact bill total. The recorded
   payment is the bill total, excluding change.
6. After receiving payment, choose **Record payment · F10** (or **Pay & print**
   when a receipt printer is selected). This issues the bill and records the selected
   payment. Wait for the paid confirmation before moving to the next customer.
7. Print or view the receipt, close the billing dialog, then choose **Next takeaway** to start the next
   order.

Cash, UPI, and card are records of payment received by staff. This screen does
not charge a card, collect UPI payment, or verify a bank transaction. Confirm the
payment through the restaurant's normal process before recording it.

The restaurant's configured GST mode applies: menu prices include GST (shown as
an **Includes GST** line), or no GST is charged at all. Issuing the bill freezes its item prices, taxes,
discount, and restaurant details. Items without a kitchen station deduct stock
when the bill is issued. Payment and receipt printing do not deduct stock again.

## Receipts and existing orders

Choose a **Receipt printer** before confirming payment to queue the paid receipt
there. The selection is remembered by this browser. For browser printing, choose
**View receipt**, then **Print / save PDF**. Paid bills remain available in
**Bills** for history and reprints.

If printing fails or its response is lost, the payment remains recorded. Check
the printer before printing again, then use **Print receipt** or the browser
receipt. Do not record the payment a second time to obtain another receipt.

There is one **Takeaway** entry; the separate **New parcel** action has been
removed. Cashiers and administrators also get quick checkout when reopening an
existing order from **Open takeaways** in **Tables & orders**.

Use **Hold · F8** to keep an unfinished takeaway and return to tables. Its order
and cart remain saved, while **Takeaway** becomes available for the next customer.
Open the held order from **Open takeaways** to resume it; unsubmitted cart items
remain on the staff member's original browser. Using **Tables** or ordinary
navigation instead of Hold keeps the current takeaway as the one resumed by the
Takeaway button. Resolve saved order actions before holding and starting another.

Waiters use the same **Takeaway** button with their ordinary order-entry and
kitchen-send permissions; they cannot issue or settle bills. Dine-in orders
retain their table and split-bill workflow.

## Interrupted checkout and recovery

The browser saves a stable order reference before asking the server to create a
takeaway. **Retry opening takeaway**, leaving and returning to Takeaway,
or reloading uses that same reference to recover an unfinished order. A failed
response does not require a second parcel. If device storage cannot save the
reference, creation stops until storage is available.

Cart drafts and saved checkout actions belong to the staff member and browser
that created them. Keep browser storage intact and sign in as that same staff
member to resume. Another browser does not have those local drafts or pending
actions, although server-saved orders remain visible in **Tables & orders**.

Punching, kitchen send, bill issue, and payment recording use the shared saved
request queue. If the connection drops, keep the app open and allow the saved
step to finish when the server reconnects. Check **Saved actions** for anything
that needs review. Do not create another order or collect payment again merely
because the first confirmation was delayed.

Bill issue and payment are separate saved steps. If a bill was issued but payment
was not confirmed, reopening the order shows that existing unpaid bill. Choose
**Record payment** to open its form. Review the actual payment received, choose the correct
mode and amount, then use **Settle bill**. This settles the existing bill; it
does not issue another one. If payment is still queued, wait for its result
before recording it again. If the bill is already paid, review or print its
receipt.

An active takeaway remains recoverable when navigating away without choosing Hold. On returning, a
saved order that the server confirms is settled or cancelled allows a fresh
takeaway. **Next takeaway** also checks that the previous order is complete.
Navigation and logout are paused while an operation is being saved; follow any
draft or saved-action prompt before leaving.

After a database restore, the existing recovery process archives local drafts
and saved actions for review. Takeaway checks the server's restore
generation before reusing a saved order reference. Reopen the app and review
the restored open orders before continuing.

## Network requirements

The Windows restaurant hub and its local network must remain reachable to load
menus, open orders, and complete checkout. Internet loss is supported while the
local hub and license remain operational. An interrupted connection can leave
cart drafts and saved requests on the staff browser, but a disconnected browser
cannot independently issue a completed bill or confirm payment recording.

Hosted accounts, cloud synchronization, and subscription renewal remain
unfinished. Takeaway uses the same local database and licensing boundary
as the rest of ForkFlow; see [commercial licensing](commercial-licensing.md).
