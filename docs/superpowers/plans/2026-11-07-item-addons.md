# Item Add-ons (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff and QR guests pick add-on products under an item. Each add-on is billed as its own line,
with its own price and GST, kitchen station and stock. This plan covers backend only; the UI goes to Codex.

**Architecture:** A pure domain module (`addons.ts`) validates picks, mirroring `combos.ts`. Migration 62 adds
group tables, the `products.addon_only` flag and the `order_items.addon_of_item_id` link. The server prices
each pick as a normal order line linked to its item, then adds "family" rules (cancel, quantity, hold, KOT,
transfer) wherever combos already have them. Money code is untouched; tests prove totals stay right.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, zod, vitest (npm workspaces).

**Spec:** `docs/superpowers/specs/2026-11-07-item-addons-design.md`

## Global Constraints

- Worktree `E:/Softwares/masalapos-addons`, branch `feat/item-addons`. Never touch the main checkout (another session uses `feat/bill-settings`).
- First step of Task 1: `npm install` in the worktree (no `node_modules` there yet).
- Migration version **62**, name `item_addons`, registered last in `packages/domain/src/migrations/index.ts`.
- Money is integer paise. Errors use `httpError(status, message, code)`.
- Error codes, verbatim: `addon_picks` (409), `addon_only` (409), `addon_line` (409).
- An add-on line never has `parent_item_id`; a combo part never has `addon_of_item_id`.
- Add-on rows are saved with `held = 0`. They follow the item's hold through the KOT query, the same way combo parts do.
- Add-ons are on Basic and Pro with no module switch.
- **Clarification of the spec:** an archived group (`is_active = 0`) is skipped when taking orders: its options can't be picked and its `minPicks` does not apply. It still lists in `GET /api/addon-groups` and `GET /api/products` with `isActive: false`.
- Run per-file tests with `npx vitest run <path>`; finish with `npm test` and `npm run typecheck` (root).
- Commit after each task with a Conventional Commits message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Quantity change after cancelling one add-on.** The cancelled add-on keeps its qty; only non-cancelled add-ons rescale. Test in Task 5.
2. **Offline replay.** Re-sending the same item `clientRef` with `addonPicks` creates no duplicate add-on rows. Test in Task 4.
3. **Hold and fire.** A held item holds its add-ons, including ones at another station; firing the item fires them. Test in Task 6.
4. **Transfer with a cancelled add-on.** The transfer succeeds, moving the item and all its add-ons; only non-cancelled add-ons must be unsent. Test in Task 5.
5. **Archived required group.** An item whose only required group is archived can still be ordered without picks. Test in Task 4.

---

### Task 1: Migration 62 and domain add-on rules

**Files:**
- Create: `packages/domain/src/migrations/item-addons.ts`, `packages/domain/src/migrations/item-addons.test.ts`
- Create: `packages/domain/src/addons.ts`, `packages/domain/src/addons.test.ts`
- Modify: `packages/domain/src/migrations/index.ts` (append `itemAddons`), `packages/domain/src/index.ts` (`export * from "./addons.js"`), `packages/domain/package.json` exports (`"./addons": "./src/addons.ts"`, like `./combos`)

**Interfaces:**
- Produces (domain, exported):
  ```ts
  export const AddonOptionInput: z.ZodObject<{ id?: string; productId: string; variantId: string | null /* default null */ }>;
  export const AddonGroupCreate: z.ZodType<{ name: string /*trim 1..60*/; minPicks: number /*int 0..40*/; maxPicks: number /*int 1..40*/; options: AddonOptionInputValue[] /*1..40*/ }>;
  export const AddonGroupUpdate: z.ZodType<Partial<AddonGroupCreateValue> & { isActive?: boolean }>;
  export const AddonPicks: z.ZodArray<z.ZodString>; // min(1) strings, max 40
  export interface AddonOption { id: string; productId: string; variantId: string | null; name: string; unavailable?: boolean }
  export interface AddonGroup { id: string; name: string; minPicks: number; maxPicks: number; isActive: boolean; options: AddonOption[] }
  export class AddonPickError extends Error {}
  export interface AddonChoice extends AddonOption { groupId: string; groupName: string }
  export function resolveAddonPicks(groups: AddonGroup[], picks: string[]): AddonChoice[];
  export function addonsAvailable(groups: AddonGroup[]): boolean;
  ```
- `AddonGroupCreate` and `AddonGroupUpdate` share one refinement for both create and update (when the fields are present): `minPicks <= maxPicks`, `minPicks <= options.length`, and no duplicate `productId/variantId` pair. Messages follow the combo style, e.g. `"Pizza toppings: an item is listed twice"`.
- `resolveAddonPicks` ignores groups with `isActive: false`. It throws `AddonPickError` for a duplicate pick (`"An add-on was picked twice"`), an unknown id (`"The add-ons changed. Choose them again."`), too few (`"Choose at least N from G"`, or `"Choose N from G"` when min equals max), too many (`"Choose at most N from G"`), and an unavailable option (`"<name> is not available"`). It returns the choices in group order, then option order.
- `addonsAvailable` is true when every active group has at least `minPicks` available options.

- [ ] **Step 1: `npm install` in the worktree.** Expected: completes; `npx vitest --version` prints a version.
- [ ] **Step 2: Write the failing migration test** `item-addons.test.ts` (copy the setup from `per-item-packaging.test.ts`):
  - `adds addon_only defaulting to 0`: insert a product without the column → `addon_only === 0`; inserting `2` throws `CHECK`.
  - `enforces group pick bounds`: inserting `min_picks 2, max_picks 1` throws; `max_picks 0` throws.
  - `rejects the same option twice in a group`: two `addon_group_options` rows with the same group, the same product and both `variant_id NULL` → the second throws `UNIQUE`.
  - `links an add-on line to its item`: `order_items.addon_of_item_id` accepts an existing item id.
- [ ] **Step 3: Run** `npx vitest run packages/domain/src/migrations/item-addons.test.ts`. Expected: FAIL (no migration).
- [ ] **Step 4: Implement** `itemAddons: Migration` (`version: 62, name: "item_addons"`) with exactly the SQL in the spec's "Data model" section, and register it.
- [ ] **Step 5: Run** the migration test. Expected: PASS.
- [ ] **Step 6: Write the failing tests** in `addons.test.ts`, with groups `Toppings {min 0, max 2: Cheese, Olives, Jalapeño}` and `Base {min 1, max 1: Thin, Pan}`:
  - `["cheese","thin"]` → returns names `["Cheese","Thin"]` with `groupName`s.
  - `[]` → throws `"Choose 1 from Base"`. `["cheese","olives","jal","thin"]` → `"Choose at most 2 from Toppings"`.
  - `["thin","thin"]` → `"An add-on was picked twice"`. `["nope"]` → `"The add-ons changed. Choose them again."`
  - Pan `unavailable` and `["pan"]` → `"Pan is not available"`.
  - Base `isActive:false` and `[]` → returns `[]` (Review Focus 5); `["thin"]` → `"The add-ons changed. Choose them again."`
  - `addonsAvailable`: Thin and Pan both unavailable → false; Base archived → true.
  - `AddonGroupCreate.safeParse({ name:"T", minPicks:3, maxPicks:2, options:[…2] })` → issue on `minPicks`; a duplicate pair → issue `"T: an item is listed twice"`.
- [ ] **Step 7: Run** `npx vitest run packages/domain/src/addons.test.ts`. Expected: FAIL.
- [ ] **Step 8: Implement** `addons.ts` with the interfaces above.
- [ ] **Step 9: Run** both test files. Expected: PASS.
- [ ] **Step 10: Commit** `feat(domain): add-on groups migration 62 and pick rules`.

### Task 2: Add-on group API and product flags

**Files:**
- Create: `apps/server/src/addon-groups.ts`, `apps/server/src/addon-groups.test.ts`
- Modify: `apps/server/src/server.ts` (register next to `registerItemTransfers`), `apps/server/src/catalog.ts` (product create, patch and list), `packages/domain/src/catalog-schemas.ts` (`addonOnly`, `addonGroupIds` on `ProductCreate` and `ProductUpdate`)

**Interfaces:**
- Consumes: `AddonGroup`, `AddonGroupCreate`, `AddonGroupUpdate` (Task 1).
- Produces (server):
  ```ts
  export function addonGroupsByProduct(db: Database): Map<string, AddonGroup[]>; // attached groups per product, in sort order, archived included
  export function addonGroupsFor(db: Database, productId: string): AddonGroup[];
  export function listAddonGroups(db: Database): Array<AddonGroup & { productIds: string[] }>;
  export function registerAddonGroups(app: FastifyInstance): void; // GET/POST /api/addon-groups, PATCH /api/addon-groups/:id
  export function saveProductAddonGroups(db: Database, productId: string, groupIds: string[]): void; // replace links; call in a transaction
  ```
- An option's `name` is `"Product (Variant)"` or `"Product"`. An option is `unavailable` when its product is inactive or sold out, or its variant is inactive (same as combos).
- Permissions: `catalog.read` for GET, `catalog.manage` for writes. After any write, broadcast the same `changed()` catalog event `catalog.ts` uses (export it or call `app.broadcast("catalog.changed", {})`, whichever `catalog.ts` does).
- Option validation (400): unknown product; `kind = 'combo'`; inactive product; a product that has variants but no `variantId`; an unknown variant, or one from another product. Options sent back with an `id` keep it; others get `uuidv7()`; options missing from the list are deleted.
- Products: `addonOnly` defaults to false. 400 for `addonOnly` on a combo, for `addonGroupIds` on a combo or an add-on-only product (including setting `addonOnly: true` on an item that still has groups), and for unknown or archived group ids. `toProduct` output gains `addonOnly: boolean` and `addonGroupIds: string[]`.

- [ ] **Step 1: Write failing tests** in `addon-groups.test.ts` (setup copied from `combos.test.ts`: products Cheese ₹30, Olives ₹20, Coke with a Large variant, Margherita ₹250, and a combo):
  - `creates, lists and edits a group, keeping option ids`: POST → 201 with option names `["Cheese","Coke (Large)"]`; PATCH with the Cheese option's id and a new Olives option → the Cheese id is unchanged and the Coke option is gone; GET lists `productIds: []`.
  - `rejects bad options and bounds`: a combo option → 400; Coke without a variant → 400; `minPicks 2` with 1 option → 400; a duplicate pair → 400.
  - `archives a group`: PATCH `{ isActive:false }` → `isActive:false` in GET.
  - `attaches groups to an item`: PATCH Margherita `{ addonGroupIds:[g] }` → GET `/api/products` shows `addonGroupIds:[g]`, and GET groups shows `productIds:[margherita]`.
  - `refuses groups on combos and add-on-only items, and archived ids`: each → 400; `{ addonOnly:true }` on Margherita while it has groups → 400; `{ addonOnly:true }` on Cheese → 200 with `addonOnly:true`.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/addon-groups.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema fields, `addon-groups.ts`, the product create/patch/list changes and the registration.
- [ ] **Step 4: Run** the test file plus `npx vitest run apps/server/src/catalog.test.ts apps/server/src/combos.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add-on groups API and product add-on flags`.

### Task 3: Item CSV `addon_only` column

**Files:**
- Modify: `packages/domain/src/catalog-csv.ts` (`CATALOG_CSV_COLUMNS` gains `"addon_only"` after `"variant_packaging"`), `apps/server/src/catalog-transfer.ts`
- Test: `packages/domain/src/catalog-csv.test.ts`, `apps/server/src/catalog-transfer.test.ts`

**Interfaces:** the parsed row gains `addonOnly: boolean`. `yes` means true; `no` or blank means false; anything else is a row error, `"Row N: addon_only must be yes or no."`. Export writes `yes` or `no`. A file without the column imports as `addonOnly: false`, the same way older optional columns behave in that parser.

- [ ] **Step 1: Write failing tests:** a domain parse of `yes`, blank, and `maybe` (error text above); a server export → import round trip keeps Cheese `addonOnly: true`.
- [ ] **Step 2: Run** both test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both test files. Expected: PASS.
- [ ] **Step 5: Commit** `feat: addon_only column in the item CSV`.

### Task 4: Taking orders with add-on picks

**Files:**
- Modify: `apps/server/src/order-items.ts`, `apps/server/src/mappers.ts`, `packages/domain/src/order-schemas.ts` (`addonPicks: AddonPicks.optional()` on `OrderItemsAdd` items)
- Test: create `apps/server/src/order-addons.test.ts` (shared fixture: Pizza station Kitchen, Cheese ₹30 at 5% with no station, Coke ₹50 at 18% at Bar, group Toppings {0..2: Cheese, Coke}, and group Base {1..1: Thin ₹0, Pan ₹40} attached to Margherita ₹250 at 5%). Tasks 5–7 add to this file.

**Interfaces:**
- `ItemRequest` gains `addonPicks?: string[]`. `PricedItem` gains `addons: Array<{ productId: string; variantId: string | null; name: string; pricePaise: number; gstRate: number }>` (empty for no picks and for combos).
- `priceOrderItem`: an `addon_only` product → 409 `addon_only` `"<name> is an add-on. Add it under a dish."`. `addonPicks` on a combo → 400 `"A combo has no add-ons"`. Otherwise call `resolveAddonPicks(addonGroupsFor(db, product.id), item.addonPicks ?? [])` and map `AddonPickError` → 409 `addon_picks` `"<item>: <message>"`. Each choice is priced with `rowPrice(variant ?? product, tier)` and `effectiveGstRate(product.gst_rate, defaultRate)` of the add-on's own product. Also refuse 409 `addon_picks` when the add-on's product is sold out at the moment of pricing (an extra guard; the group options already mark it unavailable).
- `insertOrderItem`: after the item (and any combo parts), insert one row per add-on: `client_ref NULL`, `note NULL`, `held 0`, `parent_item_id NULL`, `addon_of_item_id = id`, `qty = item.qty`, and the snapshots from `PricedItem.addons`. The column list gains `addon_of_item_id`.
- `OrderItemRow` gains `addon_of_item_id: string | null`. `orderItemJson` gains `addonOfItemId`.

- [ ] **Step 1: Write failing tests:**
  - `adds the item with its add-ons as their own lines`: add Margherita qty 2 with picks `[cheese, pan]` → lines `[Margherita 25000×2 gst 5, Cheese 3000×2 gst 5, Pan 4000×2 gst 5]`; the add-ons have `addonOfItemId = margherita line id` and `parentItemId null`, and they come right after it.
  - `prices add-ons for the order's tier`: give Cheese a takeaway price of ₹35; on a parcel order its line is 3500.
  - `rejects bad picks with addon_picks`: no Base pick → 409 `addon_picks` with message `"Margherita: Choose 1 from Base"`; a pick from another item's group → 409; nothing saved (the order has 0 items).
  - `refuses add-on-only products on their own`: mark Cheese `addonOnly`, add it alone → 409 `addon_only`.
  - `replays without duplicating add-ons` (Review Focus 2): POST the same body (same `clientRef`) twice → 3 lines total.
  - `ignores an archived required group` (Review Focus 5): archive Base, add Margherita with `[]` → 200, 1 line.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/order-addons.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new test plus `npx vitest run apps/server/src/combos.test.ts apps/server/src/orders.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add items with add-on picks`.

### Task 5: Item changes, cancels, transfers and KOT edits

**Files:**
- Modify: `apps/server/src/orders.ts` (PATCH `/api/order-items/:id`, POST `/api/order-items/:id/cancel`), `apps/server/src/item-transfers.ts`, `apps/server/src/kot-edit.ts`
- Test: `apps/server/src/order-addons.test.ts`

**Interfaces / rules:**
- PATCH on an add-on line: `qty` or `held` present → 409 `addon_line` `"Change the dish, not its add-on"`; `note` alone is allowed. PATCH on an item: in the same transaction, `UPDATE order_items SET qty = ? WHERE addon_of_item_id = ? AND status != 'cancelled'`.
- Cancelling an item: `rows` also include `SELECT * FROM order_items WHERE addon_of_item_id = ? AND status != 'cancelled' ORDER BY id`. Cancelling an add-on line cancels only it; the existing sent-line permission and reason rules apply.
- Transfer: choosing an add-on line → 409 `addon_line` `"Move the dish, and its add-ons go with it."`. An item's family adds every add-on row. The "only unsent" check applies to non-cancelled rows only; all rows move.
- KOT edit: an item with any add-on, or an add-on line, is refused like a combo, with the same message style. Read `kot-edit.ts:51` and mirror it with code `addon_line`.

- [ ] **Step 1: Write failing tests:**
  - `changing the dish's qty changes its add-ons`: qty 1→3 → Cheese and Pan lines are qty 3.
  - `a cancelled add-on keeps its qty` (Review Focus 1): cancel Cheese, then set the item qty to 2 → Cheese stays 1 and cancelled; Pan is 2.
  - `add-on lines refuse qty and hold`: PATCH Cheese `{qty:2}` → 409 `addon_line`; `{note:"extra"}` → 200.
  - `cancelling the dish cancels its add-ons`: all 3 lines cancelled with the same reason.
  - `an add-on can be cancelled alone`: cancel Pan → Margherita and Cheese stay pending.
  - `transfer carries add-ons` (Review Focus 4): two dine-in orders, Margherita with Cheese and Pan; cancel Cheese; transfer Margherita → the target has all 3 rows; choosing Pan alone → 409 `addon_line`.
- [ ] **Step 2: Run** the test file. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test file plus `npx vitest run apps/server/src/orders.test.ts apps/server/src/item-transfers.test.ts apps/server/src/kot-edit.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add-ons follow their dish on change, cancel and transfer`.

### Task 6: Kitchen routing, hold and slips

**Files:**
- Modify: `apps/server/src/kots.ts`, `apps/server/src/print/templates.ts` (`KotSlipCtx.items[]` gains `addon?: boolean; forItem?: string`), `apps/server/src/mappers.ts` (KOT item JSON gains `addonOfItemId`)
- Test: `apps/server/src/order-addons.test.ts`, `apps/server/src/print/templates.test.ts`

**Interfaces / rules:**
- The pending-items query adds `LEFT JOIN order_items ap ON ap.id = oi.addon_of_item_id LEFT JOIN products app_ ON app_.id = ap.product_id` and selects `COALESCE(p.kot_station_id, app_.kot_station_id) AS station_id`, `oi.addon_of_item_id`, and `MAX(oi.held, COALESCE(parent.held, 0), COALESCE(ap.held, 0)) AS held`.
- `namedItems` also includes rows whose `addon_of_item_id` is in `body.itemIds`. Firing an item clears only the item's `held`, which releases its add-ons.
- The kitchen slip lists, for each KOT, items in id order. An add-on row is printed as `+ <name>` with `addon: true`. When its item is not on the same KOT, `forItem` is the item's name and prints a line `  (for <item>)` under it.
- Stock: unchanged code. `consumeStock` runs on the add-on ids that are sent, and stationless leftovers are consumed at bill issue.

- [ ] **Step 1: Write failing tests:**
  - `stationless add-ons ride with their dish`: send the order → Margherita and Cheese are on the same Kitchen KOT; Coke (picked from Toppings) is on a Bar KOT.
  - `naming the dish sends its add-ons`: KOT with `itemIds:[margherita]` → its add-ons are sent too.
  - `a held dish holds its add-ons` (Review Focus 3): add the item held, send → nothing sent (409 `"nothing to send"` or no KOT); fire the item → its add-ons, including Coke at Bar, are sent.
  - `stock comes from the add-on's recipe`: link Cheese to a stock item at 0.05 kg, send → the balance drops by 0.05 × qty.
  - templates: `kotSlip` with `{ name:"Cheese", addon:true }` renders `+ Cheese`; with `forItem:"Margherita"` it renders `(for Margherita)`.
- [ ] **Step 2: Run** the test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them plus `npx vitest run apps/server/src/kots.test.ts apps/server/src/combos.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): send add-ons to the kitchen with their dish`.

### Task 7: Bills, receipts, packaging, credit notes and reports

**Files:**
- Modify: `apps/server/src/billing.ts` (receipt items gain `addon?: true` for add-on lines), `packages/domain/src/billing.ts` (`ReceiptSnapshot.items[]` gains `addon?: boolean`), `apps/server/src/print/receipt.ts` (thermal: add-on name prefixed `+ `; A4: add-on row name prefixed `+ ` with class `addon-line`), `packages/domain/src/packaging.ts` (`AND oi.addon_of_item_id IS NULL`), `apps/server/src/print/bill-preview.ts` (preview lines gain `addonOfItemId` if they carry item ids; otherwise only the `addon` flag)
- Test: `apps/server/src/order-addons.test.ts`, `apps/server/src/print/receipt.test.ts`

**Rules:** no change to `calculateBill`, credit-note or report-line code. Tests prove it.

- [ ] **Step 1: Write failing tests:**
  - `bills add-ons as their own lines with their own GST`: dine-in, Margherita (5%) with Cheese (5%) and Coke (18%), qty 1, discount ₹28 → expected totals come from `calculateBill` on the same three lines: assert `bill.subtotalPaise === 33000` and that the taxes array has a 5% and an 18% row matching `calculateBill`'s output.
  - `receipt shows add-ons under their dish`: the receipt items are `[Margherita, {name:"Cheese", addon:true}, …]`; the thermal text contains `+ Cheese`.
  - `per-item packaging skips add-ons`: packaging on with Margherita ₹10 and Cheese ₹5 per item, takeaway → packaging charge 1000 × qty only.
  - `refunds just an add-on`: issue and settle, then a credit note for the Coke line only → its credit equals the Coke line's taxable + GST; the bill's other lines are untouched.
  - `item sales count add-on revenue`: report lines have a Coke row with its value and `parent_order_item_id NULL`.
- [ ] **Step 2: Run** the test files. Expected: FAIL (receipt flag and packaging; the totals tests may already pass, which is expected and proves the money path).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them plus `npx vitest run apps/server/src/billing.test.ts apps/server/src/credit-notes.test.ts apps/server/src/print`. Expected: PASS (update snapshots only if the change is the intended `addon` field).
- [ ] **Step 5: Commit** `feat: add-on lines on bills, receipts and credit notes`.

### Task 8: QR guest ordering

**Files:**
- Modify: `packages/domain/src/guest-ordering.ts` (`GuestSubmission` items gain `addonPicks: z.array(z.string().uuid()).max(40).optional()`; `GuestMenu.products[]` gains `addonGroups?: GuestAddonGroup[]`; `GuestRequestItem` gains `addonPicks?: string[]; addons?: Array<{ name: string; pricePaise: number }>`), `apps/server/src/guest-ordering.ts`
- Test: `apps/server/src/guest-ordering.test.ts`

**Interfaces / rules:**
- `GuestAddonGroup = { id; name; minPicks; maxPicks; options: Array<{ id; productId; variantId; name; pricePaise; isVeg; unavailable?: true }> }`. Prices use the table's tier, like `menu()` variants. Only active groups are included.
- `menu()` leaves `addon_only` products out of `products`. `isSoldOut` also becomes true when `!addonsAvailable(groups)`. `addonGroups` is omitted when an item has none, so the menu version doesn't change for restaurants without add-ons.
- `snapshotItems`: `addonPicks` on a product without groups → 409 `menu_changed`. Otherwise `resolveAddonPicks` (an error → 409 `menu_changed` `"<item>: <message>"`), and the item gets `addons` (name and price per option). The request's `subtotalPaise` adds `Σ addon.pricePaise × qty`. Find where the subtotal is computed (`requestJson` or the submit handler) and include the add-ons there.
- Accept passes `addonPicks` through to `priceOrderItem` (the accept path's `items.map(...)` keeps `addonPicks` like `comboPicks`).

- [ ] **Step 1: Write failing tests:**
  - `guest menu hides add-on-only products and lists add-on groups`.
  - `guest menu shows an item sold out when its required group cannot be filled`.
  - `guest submits picks, sees add-ons and subtotal, and staff accept them as lines`: submit Margherita with `[cheese, thin]` → the receipt item has `addons:[{name:"Cheese",pricePaise:3000},{name:"Thin",pricePaise:0}]` and subtotal 28000; accept → the order has 3 lines with `addonOfItemId`.
  - `guest bad picks → menu_changed`.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/guest-ordering.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add-on picks on the QR menu`.

### Task 9: Menu hints, docs and full verification

**Files:**
- Modify: `packages/domain/src/menu-insights.ts` (`popularProductIds` and `orderedTogether`: join `products` and require `addon_only = 0`; exclude report lines whose order item has `addon_of_item_id IS NOT NULL` via `JOIN order_items oi ON oi.id = l.order_item_id`)
- Test: `packages/domain/src/menu-insights.test.ts`
- Create: `docs/operations/item-addons.md` (admin setup, taking orders, kitchen, bills, QR, limits; style like `combos.md`). Modify: `README.md` (one paragraph with the link, near the combos mention, or after "Multiple item prices")

- [ ] **Step 1: Write failing tests:** add-on-only Cheese with the most sales is never a popular id; Coke sold only as an add-on doesn't pair with Margherita.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/menu-insights.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, then run again. Expected: PASS.
- [ ] **Step 4: Write the docs.**
- [ ] **Step 5: Full verification:** `npm test` (all pass; report the count) and `npm run typecheck` (exit 0).
- [ ] **Step 6: Commit** `feat: menu hints skip add-ons; add-ons docs`.
