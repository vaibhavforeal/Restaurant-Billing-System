# UPI payment QR on bills

An administrator enters the restaurant's UPI ID under **Settings → Restaurant
profile → UPI ID for bill payments**, then clicks **Save**. Use the receiving
account's UPI ID (for example `restaurant@bank`), not a payment link. The app
checks its format; verify the recipient in your bank app before using it.

New unpaid bills print a **Scan & pay** QR on 58/80 mm ESC/POS thermal receipts
and in **View receipt → Print / save PDF** for A4. It contains the final amount
after discounts, GST and rounding, INR currency, restaurant name and a unique
bill reference. QR generation happens locally without an external QR service.

To collect payment without printing, open an issued unpaid bill and select
**Show UPI QR** beside **Record payment**, or inside the billing dialog. A large
on-screen QR shows the restaurant name, saved UPI ID, bill number and exact
amount. Close it to return to billing. Opening this preview neither prints nor
records a payment. The preview checks the bill every five seconds and removes
the QR after settlement or if the connection cannot confirm the bill status.

For dine-in, issue the reviewed bill and print it before collecting payment.
For **Quick takeaway**, select **UPI**, then **Print UPI bill** (thermal printer)
or **Issue UPI bill** (browser/A4). With A4, select **View receipt**, then
**Print / save PDF**. These actions leave the bill unpaid. Verify the incoming
payment in the restaurant's UPI/bank app, then record it as UPI and settle the
bill. The usual **Record payment / Pay & print** button is for payments already
received.

The QR supplies the exact amount, but a plain UPI payment link cannot guarantee
that every customer's payment app prevents editing it. It also cannot verify
successful payment, enforce expiry or stop someone reusing a printed QR.
Server-verified payments or a strictly enforced amount require a payment-provider
integration. No automatic settlement occurs from displaying, printing or scanning
a QR. Check that the amount received matches the bill before settling.

Paid, void, zero-value and unconfigured bills have no payment QR. Each bill saves
its UPI ID when issued; changing or clearing settings affects new bills only.
Existing bills and their reprints retain the original recipient. Bills issued
before this feature continue printing without a QR. Clearing the field disables
QRs on new bills. A settings change during billing requires a fresh preview.

The thermal QR uses a black-and-white raster with a quiet zone and integer-sized
pixels. ESC/POS raster support is required. Automated tests decode the generated
printer bytes at both widths; the restaurant's physical printer and payment app
still need a scan check before rollout.

For browser QA, build the UI and run `node --import tsx tools/e2e/upi-server.mts`.
It serves an in-memory restaurant at `http://127.0.0.1:4147/` (admin PIN `1234`)
with fake 58/80 mm printers and a meal priced at ₹123.45 before GST. It never
opens the restaurant database or sends a payment.
