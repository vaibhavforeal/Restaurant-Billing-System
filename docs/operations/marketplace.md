# Marketplace

The **Marketplace** is where an administrator turns online-order integrations on or
off. It is in the sidebar for administrators and cashiers. Waiters and the kitchen do
not see it, and the server refuses them (403) if they ask for it directly.

Every integration starts **off** after an upgrade. Nothing is shown or requested for
an integration until an administrator turns it on, and its live webhook events are
refused. Only live events are refused: CSV imports are still accepted.

## What you see

Each integration is a card with its name, a **Delivery** tag, a short description, a
status (**Enabled**, **Disabled** or **Coming soon**) and an on/off switch. An enabled
card also has a **Set up** button that opens the integration's own screen (for Zomato,
the existing Zomato workspace).

- **Administrators** can use the switch. It is disabled while a change is being saved,
  so a double-click sends only one request. If saving fails, the card shows the error
  and keeps its previous state.
- **Cashiers** see the same cards read-only: every switch is disabled and the page says
  that only an admin can turn integrations on or off. Changes an administrator makes on
  another counter appear on the cashier's screen without a reload.
- Changes apply to everyone at once. The server broadcasts the change, and open
  screens refresh on it (and on reconnection).

## What turning Zomato on or off does

| | Zomato off | Zomato on |
| --- | --- | --- |
| Sidebar | No **Zomato** item | **Zomato** item (admin and cashier) |
| Zomato screen | Shows "Zomato is turned off". Admins get an **Open Marketplace** button; cashiers are told to ask an admin | The existing Zomato workspace |
| Home Alerts | "Turn on Zomato or Swiggy in the Marketplace" (cashiers see "Ask an admin to turn on Zomato or Swiggy in the Marketplace.") and no Zomato requests | Open Zomato orders as rows, plus "Swiggy not connected" |
| Zomato webhook | Answers 503 "Zomato is turned off in the Marketplace" | Gate lifted; the existing checks still apply |

If an administrator turns Zomato off while someone is on the Zomato screen, that
screen switches to the "turned off" notice at once, without a reload. While the
Marketplace list is still loading, or if it cannot be loaded, gated items stay hidden;
the Marketplace page itself stays reachable.

Turning an integration off **never deletes data**. Imported orders, settlements and
settings stay in place, and every `/api/zomato/*` route keeps working, including CSV
import and connection settings changes. The
**Zomato webhook gate** only governs live receiving: `POST /api/integrations/zomato/webhook`
is refused with 503 while the Marketplace switch is off, before the existing live
integration checks. Even with the switch on, live receiving still needs an approved
Zomato adapter and its settings, as described in [Zomato setup and reconciliation](zomato.md).

The Marketplace switch is separate from the **enabled** setting inside Zomato's
connection settings. That setting means "live webhook receiving is on" and is not
changed by the Marketplace.

## Why Swiggy is "Coming soon"

Swiggy is in the list so the layout and Alerts are ready for it, but there is no Swiggy
integration yet. Its switch is always disabled, and the server returns 409 if a client
tries to enable it. Alerts shows "Swiggy not connected" only when Zomato is on.

## Add an integration

An integration is one registry entry plus the screen and data source behind it.

1. **Registry.** Add an entry to `INTEGRATIONS` in `packages/domain/src/integrations.ts`
   and its id to `IntegrationId`: `id`, `name`, `description`, `category`, `status`
   (`available` or `coming_soon`) and `setupPage` (the page opened by **Set up**, or
   `null`). Only on/off state is stored, in the `integration_state` table (no migration
   is needed for a new id).
2. **Screen.** Add the page, make it reachable only when
   `useIntegrations().isEnabled("<id>")` is true, and show `IntegrationOff` otherwise,
   as `ZomatoRoute` does in `apps/ui/src/App.tsx`. Hide its sidebar item in
   `apps/ui/src/NavBar.tsx` the same way.
3. **Data source.** Server routes for the integration should check
   `integrationEnabled(app.db, "<id>")` (`apps/server/src/integrations.ts`) wherever it
   receives live data, as the Zomato webhook does. To surface open orders in Home
   Alerts, extend `useAggregatorOrders` and `aggregatorAlerts`
   (`apps/ui/src/dashboard-data.ts`) to map them to an `AlertRow`.

## Permissions and API

- `integrations.read` (administrators and cashiers) lists integrations:
  `GET /api/integrations`, sent with `Cache-Control: no-store`.
- `integrations.configure` (administrators only) changes one:
  `PATCH /api/integrations/:id` with exactly `{ "enabled": true | false }`. A body that
  is empty, not a boolean or has extra keys returns 400; an unknown id returns 404;
  enabling a "Coming soon" integration returns 409.
- A change broadcasts `integrations.changed` only when the stored value actually
  changes. The record keeps the time and the user who made the change.
- Migration 026 only creates `integration_state`; it adds no rows and no dependencies.

## Rollback

Turn the integration off in the Marketplace. Nothing else needs to be undone.

## Verification

`tools/e2e/marketplace.js` runs in the browser against the disposable sales-dashboard
fixture, once signed in as admin and once as cashier. The admin run (27 checks) covered:
the API contract (no-store list, 400/404/409 and unchanged state, webhook 503 off and
on); the Marketplace cards and statuses; Swiggy's disabled switch; a single PATCH for
clicks while a save is pending and for a rapid double-click; the nav item and **Set up**
appearing; Alerts showing the open Zomato order with badge, Swiggy hint and Marketplace
link; a row opening the Zomato screen; the live "Zomato is turned off" notice
without a reload; a failed save keeping the old state; and the hint returning when off.
The cashier run (12 checks) covered the 403 on PATCH, every switch disabled with the
admin-only note, live enable and disable from another counter, the Alerts row without
an Open Marketplace link, and the live notice on the Zomato screen without a reload.
Real Space and Enter keystrokes toggled the switch (checked with the browser tool, not
in the script, because an in-page script cannot send trusted key presses). A waiter
login gets the Captain app and a 403 on the integrations list.

Known behaviours and limits:

- After a switch is toggled by keyboard, keyboard focus moves to the page body (the
  switch is disabled while the save is in flight), so Tab has to be used again to
  return to it.
- There is no URL for individual pages, so "a link to the Zomato page while it is off"
  is checked by turning Zomato off while the Zomato screen is open.
- Not exercised: a real Zomato account or webhook, and any Swiggy behaviour beyond the
  disabled switch.
