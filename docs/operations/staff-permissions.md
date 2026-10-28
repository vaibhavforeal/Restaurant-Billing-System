# Staff permissions

Each staff member's role (admin, cashier, captain / waiter, kitchen) gives them a starting
set of permissions. An admin can add or remove individual permissions for one person, for
example letting one senior cashier edit the menu, or stopping one cashier from voiding bills.

## Change one person's permissions (admin)

1. Open **Users** in the sidebar.
2. Press **Permissions** next to the person. Admins have no button: they always have every
   permission.
3. Tick a permission to allow it, untick it to take it away. A change from the role is
   marked **Added** or **Removed**.
4. Press **Save**. **Reset to role defaults** removes every change for that person.

The button shows how many changes a person has, for example **Permissions (2 changed)**.
A change applies at once: the person's screens update without signing out, and the server
uses the new permissions from their next action.

Changes stay when a person's role changes and keep applying on top of the new role.

## What can be changed

| Area | Permissions |
| --- | --- |
| Orders | View; Start orders; Add and change items; Cancel items sent to the kitchen |
| Kitchen tickets | View; Send to kitchen; Mark done |
| Bills & payments | View; Issue bills; Take payment; Print; Void and refund |
| Tables | View; Manage tables and QR codes |
| Reservations | View; Book, change and seat |
| Customers | View; Add and edit; Export lists |
| Menu catalogue | View; Edit items and prices |
| Inventory | View; Edit stock and recipes; See and enter costs |
| Reports | View; Save custom reports; Close the day |
| Zomato | View; Import; Settings |
| Printers | View; Manage |
| Marketplace | View; Switch add-ons and modules |

**Managing staff and settings is admin only** and cannot be given to one person. Otherwise
someone could grant themselves everything else. Make the person an admin instead.

Some rules stay tied to roles:
- Voids, refunds and discounts above a person's limit still need an admin's PIN for anyone
  who is not an admin, even with the permission.
- Discount limits are set per person and per role under **Users**, not here.
- Captains / waiters work in the Captain app and kitchen staff on the kitchen board; extra
  permissions apply where those apps offer the screen.

What a permission opens on screen, for example:
- **Take payment** also allows takeaway quick billing and the Zomato desk.
- **Close the day** also lets a person act on someone else's cash drawer shift.
- **See and enter costs** opens costs in Inventory and the profit report.

Modules switched off in the Marketplace stay off whatever a person's permissions are; see
[Feature controls](feature-controls.md).

## API

- `GET /api/users/:id/permissions` (admin) returns the person's role, the role's defaults,
  their changes and the resulting permissions, with the list of areas.
- `PUT /api/users/:id/permissions` with `{ "overrides": { "catalog.manage": true, "bills.refund": false } }`
  replaces the person's changes. Only differences from the role are stored. An admin as the
  target returns 409; staff or settings permissions, or an unknown permission, return 400.
  A change broadcasts `user.changed`.
- `/api/me`, `/api/login` and `/api/setup` return the signed-in person's `permissions`.
- A request without the permission gets `403 { "error": "forbidden", "permission": "…" }`.
- Changes are stored in `user_permissions` (migration 041).
