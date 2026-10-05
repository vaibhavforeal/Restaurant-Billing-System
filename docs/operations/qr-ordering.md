# Table QR menus and order requests

Guests scan a table's QR code to browse the menu on their phones. On Pro, they can
submit items for staff review. The request becomes an order only after staff
accept it; customers pay at the restaurant using the usual billing flow.

## Plans and network

Basic includes menu browsing. Pro includes browsing, guest order requests, and
waiter/bill calls through the `qrOrdering` entitlement. The development build
enables these features. Old
signed licenses that omit `qrOrdering` remain valid but default this entitlement
to `false`, including old Pro licenses. Issue a newer signed license revision
with the entitlement enabled to unlock ordering.

Guest phones do not register as staff devices or consume Basic's two or Pro's
five device slots. Staff reviewing requests still use licensed, registered
devices and their own PIN roles. Administrators, cashiers, and waiters can review
requests; only administrators manage table codes.

This version runs on the restaurant's local network. The main PC must be running,
and guest phones must join restaurant Wi-Fi that can reach its server address
and configured port (normally 4100). A guest network that isolates phones from
the main PC will need access configured before QR menus work. Internet loss is
supported while the hub and local license remain operational; loss of Wi-Fi or
the hub prevents loading menus and sending requests.

Hosted ordering, cloud synchronization, remote accounts, and subscription renewal
are unfinished. Do not expose the existing single-outlet POS server to the public
internet as a substitute for a hosted service.

## Set up table codes

1. Sign in as an administrator and open **Tables & orders > Table QR codes**.
2. Select an active table and the restaurant network address. A LAN address is
   selected by default when one is available. `localhost` and `127.0.0.1` work
   only on the main PC; they cannot be printed for guest phones.
3. Choose **Enable QR code**. Open or copy the menu link, then test it on a phone
   connected to restaurant Wi-Fi.
4. Choose **Print QR code** and place the printed code on the matching table.
   Reserve the main PC's LAN address in the router so printed links keep working.

**Disable QR code** blocks browsing and new requests through that table link.
Enabling it again keeps the same code. **Replace QR code** creates a new link and
invalidates the old code after confirmation; replace the printed code too.
Deactivating the table also makes its menu unavailable.

Disabling or replacing a code does not delete already submitted requests or
their receipts. Staff can still review pending requests for an active table,
subject to the plan's ordering entitlement. If an update fails, use **Refresh
codes** to check the saved state before retrying or printing.

## Descriptions, photos, and sold-out items

In **Catalog**, edit a product to add a menu description of up to 500 characters
and a photo. Choose a local JPEG, PNG, or WebP file no larger than 10 MiB. The
browser resizes the longest side to at most 1200 pixels and converts the upload
to JPEG at no more than 400 KiB. The server accepts only JPEG data within 400 KiB
and 1600 pixels per side; external image URLs are not supported.

The photo is stored with the product in the local database, works without
internet while the hub is reachable, and is included in database backups. Choose
**Save product** to commit description or photo changes. **Remove photo** also
requires saving; **Keep saved photo** discards an unsaved photo change. If the
saved preview cannot load, saving other product details preserves that photo.

Use **Mark sold out** or **Mark available** in the Catalog list, or the
**Sold out** checkbox in the product editor. Sold-out items remain visible with
their descriptions/photos, but guest and staff add controls are disabled. The
server also rejects new sold-out selections. Already entered order items remain
unchanged; pending guest requests are still checked before staff acceptance.
Active/inactive status is separate: deactivating hides the product from menus.

## Review requests

**Tables & orders** shows a pending count beside **QR requests**. Choose
**Review requests** to see the table, submitted time, items, options, guest notes,
and menu subtotal. Live updates refresh the inbox, with polling every 15 seconds
as a fallback. The history tabs show pending, accepted, rejected, or expired
requests, up to the latest 500 in each view.

To accept a request, explicitly select **New bill group** or an existing open
group at that same table, then choose **Accept & open order**. Billed or closed
groups cannot receive items. Acceptance adds pending order items; it does not
send a KOT, deduct ingredients, settle a bill, or take payment. Review the order
and use **Send to kitchen** when ready. Items without a kitchen station follow
the existing deduction step at bill issue.

Use **Reject…**, enter a reason, and choose **Reject request** to decline it.
The guest sees that reason. A Basic downgrade preserves request history and
allows staff to reject pending requests, but disables acceptance and new guest
submissions until ordering is enabled again.

Menu prices, options, availability, and tax mode are checked on submission and
again on acceptance. If a guest's cart is stale, they must reload the menu and
review it. If staff cannot accept because the requested items or prices changed,
reject the request and ask the guest to review the current menu and resubmit.

## Interrupted requests and receipts

The guest browser saves the request identity and its private receipt credential
before submitting. If the response is lost, use **Retry the same request** in
that same browser and original menu page. An identical retry retrieves the
existing request instead of duplicating it. The submitted cart stays locked
until receipt recovery or a definitive rejection permits further action.

Keep the original browser storage and menu page while a request is unresolved.
Scanning a replaced code or using another browser opens a separate saved state;
clearing browser storage loses the local receipt credential. Check with staff
before placing another request if the first one's status is uncertain.

Receipts show acceptance, rejection, or expiry and keep tracking preparation
after acceptance. The receipt remains recoverable with its saved credential even
after the table code is disabled/replaced or the plan is downgraded. A receipt
confirms the guest request; the restaurant's issued bill remains the payment and
tax record. Staff can reopen accepted orders from the inbox's **Accepted** history.

## Preparation and ordering more

Preparation updates describe the items from that particular guest request,
even when staff add it to a bill group containing other requests. Kitchen-linked
items move from **Queued** to **Preparing** when staff send them, then **Ready**
when the kitchen marks their KOT done. Items without a kitchen station show
**With staff**. These are preparation updates, not a payment or serving guarantee.

Cancelled requested items show **Cancelled**. If staff change the requested
items, quantities, or notes, the receipt shows an update indicator and asks the
guest to check with staff about the changes and final bill.

**Order more** keeps the earlier accepted receipt under **Your earlier order
requests**, including live preparation updates while a newer request is pending.
Reloading the same menu page restores that history from the browser. It retains
up to 20 earlier accepted requests, prioritizing those still awaiting preparation
or staff attention and then the most recent completed requests. Older completed
entries may leave the browser's list; the restaurant's saved records remain.

If 20 accepted requests still need preparation or staff attention, starting
another request is blocked so active tracking is not silently dropped. The guest
should check with staff before ordering more. Keep browser storage intact until
all requests are reconciled.

## Call waiter and request the bill

Pro guests can choose **Call waiter** or **Request bill** in **Need a hand?**.
These actions send table notifications to **Tables & orders > Table service
requests**. After assisting the guest, staff choose **Mark handled**. The guest
then sees that the team marked the request handled.

These notifications do not create an order, issue a bill, settle a payment, or
send a KOT. Staff still use normal billing and kitchen actions. Guest calls use
no staff-device slot.

There can be one pending waiter call and one pending bill request per table,
shared across its guest phones. A call expires after ten minutes if it is not
marked handled. New calls of the same kind at that table have a 60-second
cooldown measured from the previous call's creation, even if staff handle it
sooner. If another guest already sent that call, ask staff rather than resending.

The browser saves service-call identity and receipt credentials before sending.
If confirmation is lost, use **Retry waiter request** or **Retry bill request**;
the same saved call is recovered without creating another notification. Existing
call tracking and staff resolution remain available after a Basic downgrade;
new calls require Pro. Saved receipts also remain recoverable after code rotation
or disablement. Keep the original menu page and browser storage for recovery.

## Staff order alerts

Signed-in admins, cashiers, and waiters see a pending QR order banner on every
staff screen. **Review QR orders** opens the pending inbox. New requests play a
short chime; requests already waiting at sign-in or reload appear silently.
Accepting, rejecting, and repeated refreshes do not ring again.

Under **Tables & orders > Review requests**, **Sound for new QR orders** toggles
the chime for this browser/device. It starts enabled. Click **Test sound** to
activate and check audio after opening the app. Normal clicks and keyboard use
also activate browser audio where permitted.

Choose **Enable desktop alerts** in the same inbox and allow the browser prompt
to receive system notifications while ForkFlow is in the background. If already
allowed, they work automatically. Blocked notifications must be allowed in the
browser/system settings. In-app alerts remain available regardless of that
permission. The app must stay open and signed in; these are not push messages
delivered after quitting. Each signed-in staff window monitors independently.

The live connection triggers updates immediately, with a 15-second polling
fallback and refresh on focus. Failed reads show **Updates delayed** and retry
automatically. Review navigation respects the existing save guards.

## Request limits

Pending requests expire after two hours. A table can have at most ten pending
requests at once. Each request supports up to 30 menu selections, 1–20 units per
selection, and notes up to 200 characters. Ask staff to enter larger orders.

The hub applies these one-minute limits separately for each client IP:

| Operation | Requests per minute |
|---|---:|
| Menu reads | 240 |
| Guest submissions and retries | 30 |
| Receipt status reads | 600 |
| Waiter/bill submissions and retries | 30 |
| Waiter/bill status reads | 600 |

The waiter/bill allowances are separate from food-order allowances. Devices
sharing an IP share each allowance. If a limit is reached, wait a
minute or ask staff for help. These counters live in the server process and
reset on restart; they are local abuse protection, not a hosted rate-limiting
service.
