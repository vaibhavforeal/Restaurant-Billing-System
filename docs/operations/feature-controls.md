# Feature controls

ForkFlow (the vendor) decides which parts of the POS each restaurant may use. Within
that, the restaurant's administrator can switch a module off in the **Marketplace** and
back on later. A restaurant can never switch on a module ForkFlow has not included.

## The modules

| Module | Group | Needs | Basic plan | Pro plan |
| --- | --- | --- | --- | --- |
| Takeaway | Service | — | Included | Included |
| Reservations | Service | — | Included | Included |
| QR guest ordering | Service | — | — | Included |
| Guest assistance | Service | QR guest ordering | — | Included |
| Inventory | Back office | — | Included | Included |
| Recipes | Back office | Inventory | — | Included |
| Dish costing | Back office | Recipes | — | Included |
| Reports & analytics | Back office | — | Included | Included |
| Sales dashboard | Back office | Reports & analytics | Included | Included |
| Zomato | Add-on | — | Included | Included |
| Kitchen Display (KDS) | Add-on | — | — | Included |
| CRM & Loyalty | Add-on | — | Included | Included |

The plan columns are the starting point for a new restaurant. ForkFlow can allow or
block any module for any restaurant on top of its plan.

Billing, tables, the menu catalogue, staff and settings are core: they are always on.

A module works when all three hold:

1. ForkFlow allows it (from the restaurant's licence).
2. The restaurant has not switched it off. Service and back-office modules are on as soon
   as they are allowed. Add-ons stay off until an admin switches them on, because each
   needs setting up first.
3. Every module it needs is working, for example Dish costing needs Recipes, which needs
   Inventory.

## For ForkFlow: the owner control panel

The panel is part of the licensing service at `https://<licensing-service>/owner`. Sign in
with the owner password (the `OWNER_PASSWORD` secret). A session lasts 8 hours.

- Every restaurant appears the first time its ForkFlow contacts the service. Give it a
  name so it is easy to find; search by name, email or installation id.
- Each restaurant shows its plan, whether its licence is active, in grace or expired, and
  whether it has collected the latest settings.
- For each module choose **Follow the plan**, **Allow** or **Block**, then **Save**.

Saving signs the restaurant's current licence terms (plan, dates, trial, subscription) with
the new modules as the next licence revision. The restaurant's ForkFlow collects it within
an hour, or at once when an admin presses **Check for renewal** in **Settings → Plan and
devices**. Until then the card says "Waiting for the restaurant to check in". Renaming a
restaurant issues nothing.

A restaurant whose licence has run out gets no new revision. Its next trial or payment
includes the change, because every licence the service issues carries ForkFlow's choices.
**Change history** lists every change and the licence revision it went into.

Setting the panel up (the secret, deploying) is in the
[licensing worker README](../../apps/licensing-worker/README.md). Licences issued by hand with
`tools/prepare-license.ts` take the same choices with `--allow kds,qrOrdering` and
`--deny reservations`.

## For the restaurant: the Marketplace

**Marketplace** in the sidebar has three sections: Add-ons, Service modules and Back-office
modules. Each card shows its state:

- **On** / **Enabled**: working.
- **Off** / **Disabled**: switched off here.
- **Waiting**: switched on, but a module it needs is off. The card says which.
- **Not included**: ForkFlow has not included it. Contact ForkFlow to add it.

Administrators use the switches; cashiers see the same cards read-only. A change applies to
every counter at once.

**Settings → Plan and devices** lists the modules the licence includes.

## What switching a module off does

Turning a module off never deletes anything, and work already started can be finished.

| Module off | What stops | What keeps working |
| --- | --- | --- |
| Takeaway | Starting takeaway orders (Home, Tables, the takeaway page) | Open takeaway orders can be finished and billed |
| Reservations | New bookings and editing | Seeing, seating and cancelling existing bookings |
| QR guest ordering | Guest orders from the QR menu; Table QR codes and the request inbox | Guests can still browse the menu |
| Guest assistance | Call waiter and Request bill from the QR menu | — |
| Inventory | The Inventory page and stock edits | Sales keep deducting stock |
| Recipes | Editing recipes | Saved recipes keep deducting stock |
| Dish costing | Costing pages, the profit report, entering costs on purchases | Cost keeps being recorded on sales |
| Reports & analytics | Sales, collections, item, analytics, custom and CRM reports | Bills, Day-end / GST, Cash & day close, Zomato reconciliation |
| Sales dashboard | The dashboard on the home screen | — |
| Zomato, Kitchen Display, CRM & Loyalty | See [Marketplace](marketplace.md) and [Customers & loyalty](customers-and-loyalty.md) | Saved data |

A page whose module is off explains why: not included, switched off, or waiting on another
module.

## API

- `GET /api/modules` (any signed-in user) lists every module with `allowed`, `enabled`,
  `active` and `reason`.
- `PATCH /api/modules/:id` with `{ "enabled": true | false }` (administrators). Switching
  off is always allowed. Switching on a module ForkFlow has not included returns 403.
  A change broadcasts `modules.changed`.
- A request to a module that is not working returns `code: "module_off"`: 403 when ForkFlow
  has not included it, 409 when it is switched off or waiting on another module.
- The restaurant's switches are stored in `integration_state`, keyed by module id.
- Development builds (no licence) allow every module.
