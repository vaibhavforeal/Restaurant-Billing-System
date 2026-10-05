# Inventory Costing and Profit — Design

**Date:** 5 October 2026
**Status:** Approved in conversation; awaiting written-spec review
**Scope:** First inventory sub-project after the stock ledger and recipes. Suppliers/purchase orders and reorder automation are later, separate sub-projects. Inter-outlet inventory is excluded until multi-outlet/cloud work exists.

## 1. Goal

An administrator can see what each dish costs to make and what the restaurant actually earned over a period, so pricing and wastage decisions rest on real numbers.

Success means:

- Each ingredient has a current weighted-average unit cost derived from priced deliveries or an explicit administrator entry.
- Every new stock movement records the cost value it moved, frozen at that moment; past reports never change when prices change later.
- A dish costing view shows recipe cost against each configured price, with cost % and margin.
- A date-range report shows revenue, ingredient cost, gross profit and food-cost %, by dish and category, with wastage and count-adjustment cost shown separately, and CSV export.
- Sales whose cost cannot be determined are reported as such, never as zero cost.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Costing method | Weighted average per stock item, updated by priced purchases |
| GST on purchases | Cost is the amount actually paid, **including** GST (restaurants on 5% without input tax credit cannot recover it) |
| Existing stock | Administrator can set a starting/corrected unit cost; until then the item's cost is unknown and its sales are flagged |
| Views | Dish costing (current prices) and a date-range profit report |
| Access | New `costs.read` permission; only administrators hold it |
| Plan | Pro only, gated by the existing signed `recipes` entitlement (no license-format change) |
| Revenue basis | Bill taxable value (after discount, excluding GST), dated by bill issue — the same basis as existing sales reports |
| Storage approach | Cost recorded on the existing append-only stock ledger |

## 3. Data model (migration 023)

### `stock_items`

- `unit_cost_milli_paise INTEGER NULL` — weighted-average cost of **one unit in the item's own unit** (per kg, per g, per pcs, per L, per ml), in thousandths of a paise. `NULL` means unknown. Thousandths are required because cheap units lose precision in whole paise (₹0.02/ml = 2 paise; ₹0.0234/ml = 2,340 milli-paise).

### `stock_moves` (append-only; columns written at insert)

- `cost_paise INTEGER NULL` — value moved, in whole paise, with the same sign as `delta` (purchases positive; sales, wastage and negative counts negative). `NULL` means unknown.
- `unit_cost_after INTEGER NULL` — the item's `unit_cost_milli_paise` after this movement, for audit.

Existing rows keep `NULL` in both. The existing update/delete triggers continue to make the table append-only.

### `stock_cost_changes` (new, append-only)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | uuidv7 |
| `stock_item_id` | TEXT NOT NULL | FK `stock_items(id)` |
| `old_cost_milli_paise` | INTEGER NULL | |
| `new_cost_milli_paise` | INTEGER NOT NULL | > 0 |
| `note` | TEXT NOT NULL | 1–200 chars |
| `created_at` | INTEGER NOT NULL | |
| `created_by` | TEXT NOT NULL | FK `users(id)` |
| `client_ref` | TEXT UNIQUE | retry reference |
| `request_json` | TEXT | retry fingerprint |

Update and delete triggers raise `ABORT`, matching `stock_moves`. A separate table is used because the movement `reason` list is a SQLite `CHECK` constraint and zero-quantity movements are rejected by design.

## 4. Cost rules

Implemented in shared domain code. Every stock write already passes through `appendStockMove`, so sales, wastage, counts and reversals gain cost without changes to their callers.

| Event | `cost_paise` | Effect on average |
| --- | --- | --- |
| Purchase with amount paid `P` for quantity `q` | `+P` | If previous quantity ≤ 0 or previous average is unknown: `P ÷ q`. Otherwise `(oldQty × oldAvg + P) ÷ (oldQty + q)`. |
| Purchase without an amount | `q × avg`, or `NULL` if unknown | Unchanged |
| Sale, wastage, count adjustment | `delta × avg`, or `NULL` if unknown | Unchanged |
| Cancel reversal | exact negation of the reversed sale's `cost_paise` (`NULL` if that was `NULL`) | Unchanged |
| Set unit cost | none (logged in `stock_cost_changes`) | Replaced |

- Movement cost is rounded to whole paise (half away from zero). The average is rounded to whole milli-paise.
- A purchase amount of ₹0 is valid (free samples) and blends in at zero cost.
- Reversals return stock at its original cost without re-blending the average. This keeps reversals exact; the resulting drift is accepted.
- Cost arithmetic uses integer milli-units and milli-paise to avoid floating-point error; overflow checks match the existing stock range limits.
- A failure in cost calculation throws inside the caller's transaction, so the whole stock write rolls back.

## 5. Recipe and dish cost

- Recipe quantities (`product_stock_links.qty_per_sale`) are already stored in the stock item's own unit; the UI's kg/g and L/ml conversion happens at entry. Dish cost is therefore `Σ qty_per_sale × unit cost` with no conversion at cost time.
- Recipes apply to every variant of a product (existing behaviour), so all portions of a dish share one recipe cost.
- A dish is **complete** when every linked ingredient has a known cost, **incomplete** otherwise (listing the missing ingredients), and **no recipe** when it has no links.
- Price comparison uses each configured price — normal (Non-AC), AC, takeaway — for the product or variant, with blank service prices falling back to the normal price as they do at ordering. When the restaurant uses tax-inclusive menu prices, each price is converted to its pre-GST value (`price ÷ (1 + gstRate/100)`, rounded to paise) before computing cost % and margin.

## 6. Profit report

For a date range (same `reportRange` rules as existing reports: up to 366 days, server local timezone, bill issue date):

- **Revenue:** `bill_report_lines.taxable_paise` for bills issued in the range.
- **Cost per billed line:** `−Σ cost_paise` of `sale` movements for that `order_item_id`, excluding sale movements that have been reversed.
- **Line status:**
  - *costed* — at least one sale movement and none with `NULL` cost;
  - *cost unknown* — any sale movement has `NULL` cost;
  - *no recipe* — no sale movements.
- **Totals:** revenue, costed revenue, ingredient cost, gross profit (costed revenue − cost), food-cost % (cost ÷ costed revenue), plus excluded revenue split into *cost unknown* and *no recipe*.
- **Below gross profit:** wastage cost and net count-adjustment cost, by movement date in the range; amounts with unknown cost are counted and reported separately.
- **Breakdowns:** by category and by dish (name snapshot + variant), each with quantity, revenue, cost, profit, cost %, status counts.

## 7. Server API

New module `apps/server/src/costing.ts`. Every costing route requires `costs.read` and the `recipes` entitlement; Basic plans receive the existing 403 entitlement message.

| Route | Behaviour |
| --- | --- |
| `POST /api/stock-items/:id/movements` (existing) | Accepts optional `costPaise` (integer paise, 0 to 1,000,000,000 — that is, up to ₹1 crore) only when `reason = purchase`. Rejected for other reasons, or without the entitlement. Included in the retry fingerprint. |
| `POST /api/stock-items/:id/unit-cost` | Body `{ clientRef, expectedVersion, unitCostMilliPaise (> 0), note }`. Version check, retry-safe, 409 on a reused reference with different data, 409 for inactive items. Bumps the item's version and publishes the existing stock event. |
| `GET /api/costing/stock` | Per item: unit cost, quantity, stock value (`qty × cost`, `NULL` when unknown); total stock value of costed items. |
| `GET /api/costing/dishes` | Per product/variant: recipe cost, status, missing ingredients, each price pre-GST, cost %, margin. |
| `GET /api/reports/profit?from&to` | The report in section 6. |

Data protection:

- `GET /api/stock-items` never includes cost.
- `GET /api/stock-items/:id/movements` adds `costPaise` and merges `stock_cost_changes` entries only for users with `costs.read` on an entitled plan.

Permission vocabulary in `packages/domain/src/roles.ts` gains `costs.read`; administrators already hold every permission and no other role receives it.

## 8. User interface

Visible only to administrators on Pro; cashiers and other roles see no change. Basic administrators see the new tab and report locked with the existing recipe upgrade prompt.

### Inventory → Stock

- Columns for average cost (e.g. "₹320.00/kg") and stock value, with total stock value; uncosted items show **Cost not set**.
- "Receive stock" gains optional **Amount paid (₹, incl. GST)** with a live per-unit hint ("= ₹34.00/kg"). Blank keeps the current average.
- Item detail gains **Set unit cost** (₹ per unit + required note).
- Movement history shows each movement's cost and interleaves "Unit cost set" entries by time.

### Inventory → Dish costing (new tab)

- One row per dish/portion: recipe cost, each configured price (pre-GST), cost %, margin per plate.
- Default sort: highest cost % first; category filter.
- **Incomplete** rows name the missing ingredients; dishes with no recipe are listed separately.

### Reports → Detailed reports → Food cost & profit (new)

- Same date-range picker as other detailed reports.
- Summary: revenue (pre-GST), ingredient cost, gross profit, food-cost %; then wastage and count adjustments; then an exclusion note, e.g. "₹4,200 of revenue excluded: cost unknown ₹3,000, no recipe ₹1,200".
- Tables by category and by dish with status.
- CSV export through the existing report-export helper, including dates, timezone and calculation notes.

## 9. Edge cases

- **Negative or zero stock before a purchase:** new average is that purchase's unit price.
- **Unknown average:** dependent movements record `NULL`; reports show "cost unknown", never ₹0.
- **History before go-live:** existing movements have no cost; ranges before go-live appear as cost unknown, and the report says so.
- **Pro → Basic downgrade:** cost continues to be recorded on sales (as recipes continue consuming stock); views and cost entry lock until re-upgrade.
- **Backups/restore:** all cost data lives in SQLite and is covered by existing backup, restore and recovery-generation handling.
- **Concurrency/retries:** existing version checks and client-reference idempotency apply to priced purchases and unit-cost changes.

## 10. Testing

- **Domain unit tests** (`packages/domain/src/costing.test.ts`): blending including negative/zero/unknown prior state; movement valuation and rounding; reversal negation; dish cost and status; tax-inclusive price conversion; profit roll-up with costed, unknown and no-recipe lines.
- **Migration test:** existing rows keep `NULL`; new triggers block update/delete on `stock_cost_changes`; `stock_moves` remains append-only.
- **Server tests:** priced purchase → sale → cancel → profit report end to end; purchase `costPaise` rejected on non-purchase reasons; unit-cost retry and conflict; cashier 403 on all costing routes and no cost fields on stock endpoints; Basic 403; report range validation.
- **UI unit tests:** profit CSV builder; dish-costing sort and status flags; amount-paid per-unit hint.
- **Browser check:** fixture flow — set a starting cost, receive stock with a price, sell a recipe dish, see dish costing and the profit report.

## 11. Out of scope

- Suppliers, purchase orders, invoice matching, GST input reports (next sub-project).
- Reorder suggestions and procurement automation.
- Per-variant recipes or portion multipliers.
- FIFO/batch costing.
- Inter-outlet inventory.
