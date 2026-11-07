# Item add-ons — design

Date: 2026-11-07 · Branch: `feat/item-addons` (from `feat/bill-settings`) · Migration: 62

## Why

Billingko and most Indian POSes let staff add extras to a dish, such as extra cheese on a pizza or a raita
with a biryani. MasalaPOS cannot do this yet. Staff work around it with notes, which go unbilled, or with
separate menu items, which go untied to the dish. See `docs/research/2026-11-07-billingko-comparison.md`
(gap 1).

**Success:** an admin defines add-on groups once and attaches them to many items. Staff and QR guests pick
add-ons when adding an item. Each add-on is billed at its own price and GST rate, goes to the right kitchen
station, deducts its own stock, and can be cancelled or refunded. Bills, credit notes, GST returns and
reports stay correct without special cases.

**Split of work:** the backend (domain, server, printing) is built in this branch session. All web UI
(Catalog, counter and captain screens, QR menu) is handed to Codex, which builds against the API contract
below.

## Decisions (agreed with the owner)

1. **Add-ons are menu products.** An add-on is a catalog product with its own price (service-tier prices
   apply), GST rate, kitchen station, recipe and stock.
2. **Own line, own price and GST.** A picked add-on is its own bill line under the item, not folded into the
   item's price.
3. **Groups with min/max.** Admins create add-on groups, such as "Pizza toppings: pick 0–3" or "Choose a
   base: pick exactly 1", and attach a group to any number of items. An item can have several groups.
4. **Add-on-only flag.** A product marked `addonOnly` is hidden from the menu grid and QR menu and can only
   be picked under an item. Products without the flag can be add-ons and also be sold alone.
5. **Available on Basic and Pro**, with no Marketplace switch (same as combos).

## Rules

- Groups attach only to products with `kind = "item"` that are not `addonOnly`. Combos and add-on-only
  products have no add-on groups.
- A group option is a product (optionally one of its variants) with `kind = "item"`. Options cannot be
  combos. A product with variants must be listed per variant. One option row is one product and variant
  pair, and a pair appears at most once per group.
- No nesting: an add-on line never has add-ons of its own.
- Each option can be picked at most once per item line. The add-on's quantity always equals the item line's
  quantity (one per unit).
- Picks must satisfy each attached group's `minPicks` and `maxPicks`. Picks may only name options of groups
  attached to that item.
- An option is **unavailable** while its product is inactive or sold out, its variant is inactive, or its
  group is archived. Picking an unavailable option is rejected.
- An item **cannot be added** while one of its required groups (`minPicks > 0`) has fewer available options
  than `minPicks`. The QR menu shows such an item as sold out (same as combos).
- Changing groups or options affects new picks only. Existing order lines keep their snapshots.

## Data model (migration 62 `item_addons`)

```sql
ALTER TABLE products ADD COLUMN addon_only INTEGER NOT NULL DEFAULT 0 CHECK (addon_only IN (0, 1));

CREATE TABLE addon_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  min_picks   INTEGER NOT NULL CHECK (min_picks >= 0),
  max_picks   INTEGER NOT NULL CHECK (max_picks >= 1 AND max_picks >= min_picks),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at  INTEGER NOT NULL
);

CREATE TABLE addon_group_options (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES addon_groups(id),
  product_id  TEXT NOT NULL REFERENCES products(id),
  variant_id  TEXT REFERENCES variants(id),
  sort_order  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_addon_option_unique ON addon_group_options(group_id, product_id, COALESCE(variant_id, ''));

CREATE TABLE product_addon_groups (
  product_id  TEXT NOT NULL REFERENCES products(id),
  group_id    TEXT NOT NULL REFERENCES addon_groups(id),
  sort_order  INTEGER NOT NULL,
  PRIMARY KEY (product_id, group_id)
);

ALTER TABLE order_items ADD COLUMN addon_of_item_id TEXT REFERENCES order_items(id);
CREATE INDEX idx_order_items_addon_of ON order_items(addon_of_item_id) WHERE addon_of_item_id IS NOT NULL;
```

`addon_of_item_id` is deliberately separate from `parent_item_id`. About 13 places treat a `parent_item_id`
child as a ₹0 combo part, and an add-on is a normal priced line. `parent_item_id` and `addon_of_item_id` are
never both set on one row.

Order lines do not reference option rows. An add-on line stores its own product, variant, name, price and
GST, so editing a group replaces its option rows freely. Options sent back with their `id` keep it, which
means a cart picked before the edit still matches. A removed option is deleted, and a pending pick of it
fails with `addon_picks`.

## API contract (for the backend and for Codex)

All money is integer paise. Errors use the existing `httpError(status, message, code)` shape. The response body is
`{ error, code }`, where `error` is the message to show.

### Catalog

`GET /api/addon-groups` (permission: catalog read) →
```ts
{ groups: Array<{
    id: string; name: string; minPicks: number; maxPicks: number; isActive: boolean;
    options: Array<{ id: string; productId: string; variantId: string | null; name: string /* "Coke (Large)" */;
                     unavailable?: true }>;
    productIds: string[];            // items this group is attached to
}> }
```

`POST /api/addon-groups` (catalog manage) body
`{ name: string(1..60); minPicks: int>=0; maxPicks: int>=1; options: Array<{ id?: string; productId: string; variantId?: string | null }> (1..40) }`
→ `201 { group }`.

`PATCH /api/addon-groups/:id` (catalog manage) body: any of `name`, `minPicks`, `maxPicks`, `isActive`,
`options`. `options` replaces the list, and options sent back with their `id` keep it. → `{ group }`.

Validation errors (400): `maxPicks < minPicks`; `minPicks` greater than the option count; a duplicate
product and variant pair; an option that is a combo, an inactive product, or a product with variants given
without a variant; an unknown variant or one belonging to another product.

**Products:** the existing `POST /api/products` and `PATCH /api/products/:id` gain:
- `addonOnly?: boolean` (default false). Rejected for combos.
- `addonGroupIds?: string[]`, which replaces the item's attached groups in the given order. Rejected for
  combos and add-on-only products. Unknown group ids → 400. An archived group id → 400, unless the item already has
  that group. Setting `addonOnly: true` on an item that has groups needs `addonGroupIds: []` in the same request.
- Archived groups are skipped when taking orders: their add-ons can't be picked and their minimum doesn't apply.

`GET /api/products` returns each product with `addonOnly: boolean` and `addonGroupIds: string[]`.

### Orders (staff, captain WebView, offline queue)

`POST /api/orders/:id/items` item entries gain `addonPicks?: string[]` (option ids, max 40, unique).
- Each picked option becomes its own `order_items` row: `product_id` and `variant_id` from the option,
  `name_snapshot` set to the option's display name, `price_paise_snapshot` set to the add-on's own price for
  the order's price tier (the same pricing as a normal line), `gst_rate_snapshot` set to the add-on product's
  effective GST rate, `qty` equal to the item's qty, `addon_of_item_id` equal to the item's id, and
  `held` following the item. The add-on row has no `note` and
  no `client_ref`. Replaying the item's `clientRef` replays the whole family.
- 409 `addon_picks` with a readable message for: a pick on an item that has no groups, a pick not in the
  item's groups, a duplicate pick, a group under `minPicks` or over `maxPicks`, an unavailable option, or an
  item whose required group cannot be filled.
- 400 if `addonPicks` is sent for a combo or for an add-on-only product. Adding an add-on-only product as a
  top-level line → 409 `addon_only`.

Order item responses (`orderWithDetails` items) gain `addonOfItemId: string | null`. An item's add-ons are
the lines whose `addonOfItemId` equals its id. They appear right after it in the items list, in the order
they were picked.

`PATCH /api/order-items/:id`:
- On an item: `qty` changes rescale its non-cancelled add-ons to the same qty. Once any of its add-ons has been sent,
  the item's `qty` cannot change (409 `addon_line`). `held` is read through the item: add-on rows are saved with
  `held = 0` and follow their item's hold. `note` stays on the item only.
- On an add-on line: `qty` and `held` → 409 `addon_line` ("Change the dish, not its add-on"). `note` is
  allowed.

`POST /api/order-items/:id/cancel`:
- On an item: cancels the item and all its non-cancelled add-ons with the same reason, returns their stock,
  and prints cancel slips per station (same as cancelling those lines one by one).
- On an add-on line: cancels only that add-on, with the usual reason and permission rules for sent lines.

Item transfer (`item-transfers`) and table move and merge carry an item's add-ons with it. Choosing an
add-on line on its own for transfer → 409 `addon_line`. KOT edit treats an item with add-ons like a combo:
it can't be edited after sending, and is changed by cancelling and adding again.

### QR guests

`GET /api/guest/menu`: add-on-only products are left out of `products`. Each item product gains
`addonGroups: Array<{ id; name; minPicks; maxPicks; options: Array<{ id; productId; variantId; name;
pricePaise /* table's tier */; isVeg; unavailable?: true }> }>`. An item whose required group cannot be
filled is shown with `isSoldOut: true`.

`POST /api/guest/requests` item entries gain `addonPicks?: string[]`, with the same rules and the
`addon_picks` error code. Accepting a request inserts the add-on lines exactly as staff orders do. The guest
receipt and status show add-ons under their item.

## Kitchen

- The KOT station for an add-on line is the add-on product's own `kot_station_id`. If that is null, it uses
  the item's station.
- Sending an item sends its pending add-ons with it, even when only the item's id is named. Naming an add-on sends
  its whole item family. A held item holds its add-ons, and firing the item fires them.
- KOT item JSON (`kot.created`, `kot.updated`, `GET /api/kots`) carries `addonOfItemId` and `addonOfItemName`, the
  item's name even when the item is on another ticket.
- The station slip prints add-ons under their item as `  + Extra cheese`. An add-on printed at a different
  station from its item shows `  (for Margherita)`.
- Stock follows today's rule, using the add-on line's effective station: an add-on deducts from its own
  recipe when it is sent. An add-on whose effective station is null deducts when the bill is issued.

## Bills, GST, refunds, reports

- An add-on line is a normal priced line: subtotal, discounts allocated proportionally across GST rates,
  service and other charges, round-off, GST by rate, GSTR-1 and 3B all treat it like any other line. No
  money code changes are expected. Tests prove this.
- **Per-item packaging** skips add-on lines (`addon_of_item_id IS NOT NULL`).
- **Receipts and bill preview:** thermal and A4 print add-ons indented under their item
  (`  + Extra cheese   30.00`), with their own amount. Receipt and bill-preview items carry `addon: true` on add-on
  lines (`receipt.items[]`). Order items carry `addonOfItemId`.
- **Credit notes:** add-on lines are refundable and voidable like any line. Refunding an item does not
  force its add-ons. The form shows them so the cashier chooses.
- **Reports:** item sales count the add-on product's revenue under its own name. The cancellation report
  lists a cancelled add-on as its own row. Food cost uses the add-on's recipe. The popular-items and
  ordered-together menu hints ignore add-on lines and add-on-only products.
- **Item CSV:** gains an `addon_only` column (`yes`/`no`, blank = no). Groups are edited only in the
  catalog (same as combos).

## Out of scope

All web UI (Codex). Zomato order mapping (Zomato add-ons stay notes). Option price overrides (an add-on
always costs its catalog price). Changing add-ons on a pending item (remove and add the item again). Add-on
groups on combos.

## Error handling

Every rejection names the item and group in the message, for example "Margherita: choose at most 3 from
Pizza toppings". All new writes run in one transaction with the item insert, so a bad pick saves nothing.
The offline queue replays `addonPicks` through the same path. A pick that became invalid while offline fails
with `addon_picks`, like a sold-out item does today.

## Testing

TDD for each unit.
- **Domain:** migration 62 (columns, constraints, unique option index); a pure `resolveAddonPicks(groups,
  picks)` covering min/max, duplicates, foreign picks, unavailable options and an unfillable required group.
- **Server:** the addon-group CRUD validation; the product flags; add items with picks (snapshots, tier
  prices, GST, hold, clientRef replay); qty and held cascades; add-on-line PATCH rejected; cancelling the item
  cascades while cancelling an add-on alone does not; KOT station fallback, add-ons sent with their item,
  slip text; stock deduction (station and no-station); item transfer carries add-ons; bill totals with mixed
  GST rates and a discount; per-item packaging skips add-ons; a credit note refunding just an add-on; report
  lines and item sales; guest menu shape, guest submit and accept; CSV `addon_only` round trip; popular items
  exclude add-ons.

## Handoff to Codex (UI)

Codex builds in its own worktree, against this contract:
1. Catalog: an add-on groups screen (list, create, edit, archive, options picker with variants, min/max) and,
   in the product editor, an "Add-on only" toggle and an "Add-on groups" multi-select.
2. Order taking (counter, captain WebView): when an item has groups, a picker sheet with per-group min/max
   hints, prices, and sold-out options greyed out. Cart lines show add-ons indented under their item, with
   their own price. Qty changes on the item, and add-on lines can be cancelled.
3. QR menu: the same picker using `addonGroups`. Add-on-only products are hidden.
4. Bill, credit-note and KOT previews show add-on lines indented.
