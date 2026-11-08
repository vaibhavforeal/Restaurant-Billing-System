# Item add-ons

Item add-ons let a restaurant sell extras with a dish: extra cheese on a pizza, a raita with a biryani, a drink with
a meal. Admins put add-on items into groups with a minimum and maximum pick and attach the groups to dishes. Staff,
captains and QR guests pick add-ons when they add the dish. Each add-on is billed as **its own line**, with its own
price, GST rate, kitchen station and stock.

This README is for developers. For how staff and admins use the feature, see
[docs/operations/item-addons.md](../operations/item-addons.md).

| | |
|---|---|
| Built | 2026-11-07, as gap 1 from the [Billingko comparison](../research/2026-11-07-billingko-comparison.md) |
| Branch / PR | `feat/item-addons`, [PR #22](https://github.com/vaibhavforeal/Restaurant-Billing-System/pull/22) |
| Spec | [docs/superpowers/specs/2026-11-07-item-addons-design.md](../superpowers/specs/2026-11-07-item-addons-design.md) |
| Plan | [docs/superpowers/plans/2026-11-07-item-addons.md](../superpowers/plans/2026-11-07-item-addons.md) |
| Migration | 62 `item_addons` (the next free number is 63) |
| Plans | Basic and Pro, with no Marketplace switch (same as combos) |
| Who built what | Backend: Claude, test-first, plus one whole-branch review. UI: Codex, building against the spec's API contract. |

## How it works

Example: Margherita offers two groups, **Toppings** (pick 0–2: Cheese ₹30 add-on only, Coke ₹50 at the Bar, 18%)
and **Base** (pick exactly 1: Thin ₹0, Pan ₹40). A cashier adds 2 × Margherita with Cheese, Coke and Pan:

```
Order lines (order_items)                         Kitchen                    Bill
Margherita  qty 2  ₹250  5%                       Kitchen: 2 x Margherita    Margherita      2 x 250.00
  Cheese    qty 2  ₹30   5%   addon_of → dish              + Cheese            + Cheese      2 x  30.00
  Coke      qty 2  ₹50   18%  addon_of → dish              + Pan               + Coke        2 x  50.00
  Pan       qty 2  ₹40   5%   addon_of → dish     Bar:     + 2 x Coke          + Pan         2 x  40.00
                                                             (for Margherita)
```

- **An add-on is an ordinary catalog product.** It has its own price (including the AC, takeaway and Zomato tiers),
  GST rate, kitchen station, recipe and stock. `addon_only` hides it from the menu and the QR menu.
- **Each pick is saved as its own `order_items` row.** The row stores the add-on's own price and GST and links to the
  dish through `addon_of_item_id`. Its quantity always equals the dish's quantity (one add-on per unit).
- **Bill, GST, discount, round-off, credit-note and report code is unchanged.** An add-on line is a normal priced
  line, so the existing money code handles it, and tests prove the totals.
- **Family rules** keep add-ons with their dish wherever combos already had similar rules: quantity, hold, send,
  cancel, transfer and KOT edit.

### Why `addon_of_item_id` and not `parent_item_id`

`parent_item_id` marks a combo's ₹0 component lines. About 13 places treat such a child as a ₹0 combo part. Report
lines, for example, write zero revenue for it. An add-on is a priced line, so it gets its own column, and existing
code treats it as a normal line by default. A row never has both columns set.

## Data model (migration 62)

| Table / column | Purpose |
|---|---|
| `products.addon_only` | `1` = picked only under a dish; hidden from the menu grid and QR menu |
| `addon_groups` | `name`, `min_picks`, `max_picks`, `is_active` (archive), `created_at` |
| `addon_group_options` | One row per product and variant in a group, with `sort_order`; unique on `(group_id, product_id, variant_id)` |
| `product_addon_groups` | Which groups a dish offers, in order; primary key `(product_id, group_id)` |
| `order_items.addon_of_item_id` | Set on an add-on line; points at its dish line. Indexed where not null |

Order lines don't reference option rows; each add-on line stores its own name, price and GST. That's why editing a
group can rewrite its option rows freely. Options sent back with their `id` keep it.

## API

All money is integer paise. Errors are `{ error, code }`, where `error` is the message to show. The add-on codes are
`addon_picks`, `addon_only` and `addon_line`, all 409.

### Catalog (`catalog.read` to list, `catalog.manage` to change)

| Endpoint | Body / result |
|---|---|
| `GET /api/addon-groups` | `{ groups: [{ id, name, minPicks, maxPicks, isActive, options: [{ id, productId, variantId, name, unavailable? }], productIds }] }` |
| `POST /api/addon-groups` | `{ name, minPicks, maxPicks, options: [{ productId, variantId? }] }` → `201 { group }` |
| `PATCH /api/addon-groups/:id` | Any of `name`, `minPicks`, `maxPicks`, `isActive`, `options` (replaces the list; send an option's `id` back to keep it) |
| `POST` / `PATCH /api/products[/:id]` | Accept `addonOnly` and `addonGroupIds` (ordered; replaces the dish's groups) |
| `GET /api/products` | Each product gains `addonOnly` and `addonGroupIds` |

Validation (400): `min > max`; `min` greater than the option count; the same item twice; an option that is a combo
or a switched-off item; an item with sizes added without a size; groups on a combo or an add-on-only item; an unknown
group; an archived group the dish doesn't already have. To make a dish add-on only, send
`{ addonOnly: true, addonGroupIds: [] }` in one request.

### Orders (counter, captain WebView, offline queue)

```http
POST /api/orders/:id/items
{ "items": [{ "clientRef": "…", "productId": "<margherita>", "qty": 2,
              "addonPicks": ["<cheese option id>", "<pan option id>"] }] }
```

- Order item JSON gains `addonOfItemId`. Add-on lines come straight after their dish.
- `addon_picks` covers: a group under its minimum or over its maximum, an unknown, repeated or sold-out pick, and a
  pick on a dish without groups. `addon_only` means an add-on-only item was added on its own. `addonPicks` on a combo
  gives a 400.
- Replaying the dish's `clientRef` replays the whole family, so no duplicate add-ons are created.

| Action | Rule |
|---|---|
| `PATCH /api/order-items/:dish` `qty` | Rescales the dish's non-cancelled add-ons. Refused (`addon_line`) once any add-on has been sent. |
| `PATCH /api/order-items/:addon` | `note` is allowed; `qty` and `held` are refused (`addon_line`). |
| `POST /api/order-items/:dish/cancel` | Cancels the dish and its add-ons with the same reason. |
| `POST /api/order-items/:addon/cancel` | Cancels only that add-on. |
| `POST /api/orders/:id/transfer-items` | The dish moves with its add-ons. Choosing an add-on alone is refused (`addon_line`). |
| `POST /api/order-items/:id/edit-sent` | Refused for a sent dish with add-ons and for an add-on line (cancel and re-add). |

### QR guests

- `GET /api/guest/menu`: add-on-only items are left out. A dish gains `addonGroups` (active groups only, options
  priced for the table's tier). A dish whose required group can't be filled shows `isSoldOut: true`.
- `POST /api/guest/requests`: items accept `addonPicks`. The request's items gain `addons: [{ name, pricePaise }]`,
  and the subtotal includes them. Bad picks, or add-on picks sent with a combo, give 409 `menu_changed`.
- When staff accept, the add-ons become order lines, exactly as staff orders do. The guest's status folds each
  dish's add-ons into the dish's state.

## Kitchen, billing and reports

- **KOT station:** the add-on's own station, falling back to its dish's station. The KOT query also takes the dish's
  `held` flag, so a held dish holds its add-ons, including at other stations. Naming a dish, or any of its add-ons,
  in a send or fire covers the whole family.
- **Slips:** an add-on on the same ticket prints as `  + Cheese`. On another station's ticket it prints as
  `+ 2 x Coke` with `  (for Margherita)` under it. KDS JSON carries `addonOfItemId` and `addonOfItemName`.
- **Stock:** each add-on deducts from its own recipe when it is sent, or when the bill is issued if it has no
  station. The existing code does this.
- **Bills:** `receipt.items[].addon = true` on add-on lines. The thermal and A4 receipts print `+ ` before the name.
  Per-item packaging skips add-on lines.
- **Refunds:** add-on lines are credited like any line, alone or with the dish.
- **Reports:** item sales count add-on revenue under the add-on's name. Popular badges, "ordered together", the
  customer's usual dishes, repeat last order and favourites all ignore add-on lines and add-on-only items.
- **Item CSV:** a new `addon_only` column (`true`/`false`; blank keeps the current value). Groups are set up only in
  the catalog.

## Code map

| Area | Files |
|---|---|
| Pick rules (pure) | `packages/domain/src/addons.ts`: `resolveAddonPicks`, `addonsAvailable`, `AddonGroupCreate`/`Update`, `AddonPicks` |
| Migration | `packages/domain/src/migrations/item-addons.ts` |
| Group API and dish links | `apps/server/src/addon-groups.ts`: `addonGroupsFor`, `addonGroupsByProduct`, `listAddonGroups`, `saveProductAddonGroups` |
| Product flags | `apps/server/src/catalog.ts`, `packages/domain/src/catalog-schemas.ts` |
| Pricing and insert | `apps/server/src/order-items.ts`: `priceOrderItem` (add-on pricing), `insertOrderItem` (add-on rows) |
| Family rules | `apps/server/src/orders.ts`, `item-transfers.ts`, `kot-edit.ts`, `kots.ts` |
| Printing | `apps/server/src/print/templates.ts` (KOT), `print/receipt.ts` (bill), `mappers.ts` (KOT JSON) |
| Billing and packaging | `apps/server/src/billing.ts`, `packages/domain/src/packaging.ts` |
| QR | `apps/server/src/guest-ordering.ts`, `packages/domain/src/guest-ordering.ts` |
| Hints | `packages/domain/src/menu-insights.ts`, `customer-usual.ts`, `apps/server/src/customers.ts` |
| CSV | `packages/domain/src/catalog-csv.ts`, `apps/server/src/catalog-transfer.ts`, `apps/ui/src/catalog-template.ts` |
| UI (Codex) | `apps/ui/src/screens/AddonGroupsManager.tsx`, `AddonChoices.tsx`, `addon-cart.ts`, `product-addon-payload.ts`, `addons.css`, plus the order, table, guest, billing, refund and kitchen screens |

## Tests

```bash
npx vitest run packages/domain/src/addons.test.ts packages/domain/src/migrations/item-addons.test.ts \
  apps/server/src/addon-groups.test.ts apps/server/src/order-addons.test.ts
npm test            # 2,173 tests at the last run
npm run typecheck
```

| File | Covers |
|---|---|
| `packages/domain/src/addons.test.ts` | Min/max, repeated, unknown and unavailable picks, archived groups, schema checks |
| `packages/domain/src/migrations/item-addons.test.ts` | Columns, checks and the unique option index |
| `apps/server/src/addon-groups.test.ts` | Group create, edit and archive, option ids, product flags, archived groups kept, option swaps |
| `apps/server/src/order-addons.test.ts` | Picks and pricing, replay, quantity, hold and cancel cascades, transfer, kitchen routing and slips, stock, bills and GST, packaging, refunds, report lines |
| `apps/server/src/guest-ordering.test.ts` (`add-ons`) | Guest menu, sold out, submit and accept, bad picks, combos, guest status |
| `apps/server/src/customer-usual.test.ts`, `packages/domain/src/menu-insights.test.ts` | Hints ignore add-ons |
| `apps/server/src/catalog-transfer.test.ts`, `packages/domain/src/catalog-csv.test.ts` | The `addon_only` CSV column |

## Decisions made while building

These go beyond the spec or adjust it. Each is cheap to change.

1. **Archived groups are skipped when taking orders.** Their options can't be picked and their minimum no longer
   applies, so archiving never makes a dish impossible to order. A dish can still keep an archived group it already has.
2. **The CSV boolean** follows the file's existing `true`/`false` convention rather than `yes`/`no`.
3. **Error bodies** use the existing `{ error, code }` shape. The three new codes were added to the server's allow-list.
4. **A dish's quantity is locked once any of its add-ons is sent.** Otherwise a stationless dish's quantity change
   could alter a sent add-on without the cancel-sent permission. This came from a security review.
5. **Naming an add-on in a send or fire covers the whole family,** so an add-on never reaches the kitchen without
   its dish.
6. **A transfer may carry along only add-ons cancelled before they reached the kitchen.** A sent-then-cancelled
   add-on blocks it, so cancellation reports stay with the right table.
7. **Add-on rows are saved with `held = 0`** and take the dish's hold through the KOT query, the way combo parts do.

## Known limits (out of scope)

- Add-ons can't be changed on a pending dish; remove the dish and add it again.
- An option can't have its own price; an add-on always costs its catalog price.
- Combos have no add-on groups, and add-ons can't have add-ons of their own.
- Zomato orders don't map to add-ons; Zomato add-ons stay in the notes.
- The UI has passed its unit tests and type check but hasn't been tried by hand in a browser or on a real tablet.
