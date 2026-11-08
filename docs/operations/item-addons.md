# Item add-ons

An add-on is something picked under a dish and charged as its own line, such as extra cheese on a pizza or a
raita with a biryani. Each add-on is a menu item with its own price, GST rate, kitchen station, recipe and stock.
Available on Basic and Pro. Developers: see [docs/item-addons/README.md](../item-addons/README.md).

## Setting up add-ons (admin)

1. Create each add-on as a normal item in **Catalog**, with its price, GST rate, recipe and (optionally) kitchen station.
   Turn on **Add-on only** for items that are never sold alone, such as "Extra cheese". They are hidden from the menu
   and the QR menu.
2. Create an **add-on group**, for example **Pizza toppings: choose up to 3** or **Choose a base: choose 1**:
   - **Minimum** 0 makes the group optional. A minimum of 1 or more means staff and guests must pick.
   - **Maximum** is the most that can be picked from the group.
   - Add the items in it. An item with sizes is added per size, such as "Coke (Large)".
3. Open each dish and choose its **Add-on groups**. One group can be used by many dishes, and a dish can have several
   groups. Combos and add-on-only items have no add-on groups.

Archiving a group removes it from order taking straight away: its add-ons can no longer be picked, and its minimum no
longer applies. Changing a group affects new orders only. Lines already on an order keep their name, price and GST.

## Taking an order

- Tap a dish that has add-on groups, pick the add-ons and select **Add**. Sold-out add-ons are greyed out.
- Each add-on is its own line under the dish, at its own price. It is charged once for each unit of the dish:
  2 × Margherita with Cheese means 2 × Cheese.
- Changing the dish's quantity changes its add-ons too. An add-on line can't change quantity on its own.
- To change the add-ons on a dish, remove the dish and add it again. One add-on can be cancelled on its own.
- Cancelling the dish cancels its add-ons with the same reason.
- **Transfer items** moves a dish with its add-ons. An add-on can't be moved on its own.
- A dish can't be added while a required group has nothing available to pick. On the QR menu it shows as sold out.

## Kitchen

- An add-on without a kitchen station goes on its dish's ticket, printed under it as `+ Extra cheese`.
- An add-on with its own station, such as a drink at the bar, prints on that station's ticket as `+ 2 x Coke` with
  `(for Margherita)` under it.
- Sending or firing the dish sends its add-ons. A held dish holds its add-ons.
- Once one of its add-ons has gone to the kitchen, the dish's quantity can't change. A sent dish with add-ons is changed
  by cancelling it and adding it again.
- Each add-on takes its own recipe's stock when it is sent, or when the bill is issued if it has no station.

## Bills, refunds and reports

- The bill and receipt show each add-on as its own line with its own amount, indented under its dish (`+ Extra cheese`).
- GST, discounts, service charge and round-off treat an add-on like any other line, at the add-on's own GST rate.
- **Charge packaging per item** counts the dish's packaging only, not its add-ons'.
- Refunds and voids can credit an add-on on its own, or the dish without its add-ons.
- **Reports → Item sales** shows add-on sales under the add-on's own name. Popular badges and "ordered together"
  suggestions ignore add-ons.
- The item CSV has an `addon_only` column (`true` or `false`). Add-on groups are set up only in the catalog.

## QR menu

Guests see a dish's add-on groups with prices for their table and pick the same way staff do. The request and the
guest's receipt list the add-ons under the dish, and the subtotal includes them. When staff accept, the add-ons become
lines under the dish, exactly as if staff had added them. The guest's order status follows the dish and its add-ons
together: a dish is preparing while any of its add-ons is still being made, and an add-on cancelled by staff shows as
a change. Combos have no add-ons, so a request that sends add-ons with a combo is refused and the guest reviews the menu.
