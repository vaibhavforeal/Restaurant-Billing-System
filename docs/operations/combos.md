# Combos

A combo sells several items together at one price, such as a burger, fries and a drink. It is one
line on the bill. Each item in it still goes to its own kitchen station and uses its own recipe.

## Setting up a combo (admin)

1. Open **Catalog**, choose a category and select **New combo**.
2. Enter the name, the prices (Non-AC, AC, Takeaway and Zomato work as for products), the GST rate
   and the photo.
3. Under **What is in the combo**, add slots:
   - A **fixed slot** holds items that are always included, such as the burger and fries.
   - A **choice slot** lets staff or the guest pick, such as **Choose at least 1, at most 1** from
     Coke, Coke (Large) and Mango Lassi. Set the minimum to 0 for an optional add-on.
   - Give any choice an **Extra (₹)** price. It is added to the combo price when that item is
     picked. Use **Qty** for, say, two pieces of an item in one combo.
4. Select **Save combo**.

The GST rate on the bill is the combo's own rate. Changing the slots later affects new orders only.
A combo cannot hold another combo, and it has no variants or kitchen station of its own.

## Availability

A combo cannot be added while it is sold out, while any of its fixed items is sold out, or while a
choice slot does not have enough items that are still available. Sold-out choices are greyed out.
On the QR menu such a combo shows as sold out.

## Taking an order

- Tap the combo on the menu. If it has choices, pick them and select **Add**. A combo with only
  fixed items goes straight into the cart.
- The cart shows the combo with its items underneath. Quantity and cooking notes apply to the whole
  combo.
- **KOT** sends each item to its own station, so the fries go to the kitchen and the drink to the bar.
- Once any item in a combo has been sent, the combo cannot be edited. To change it, cancel the whole
  combo (with a reason) and add it again. Cancelling returns each item's stock and prints a cancel
  slip at each station. A single item inside a combo cannot be cancelled on its own.

Guests on the QR menu see what each combo holds and pick its choices the same way. Their request
shows the combo as preparing, then ready, as the kitchen works through its items.

## Bills, refunds and reports

- The bill and receipt show one line per combo, with its items listed underneath.
- Refunds and voids treat the combo as one line.
- **Reports → Item sales** shows the combo with its sales value. A separate **Items sold in combos**
  table counts the items that went out inside combos, as quantities only, so nothing is counted
  twice.
- The profit report costs a combo from the recipes of the items in it. Dish costing lists only
  products, not combos.
- Combos are not included in the item CSV export or import. Edit them in the catalog.
