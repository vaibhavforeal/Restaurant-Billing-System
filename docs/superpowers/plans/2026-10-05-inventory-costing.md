# Inventory Costing and Profit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record weighted-average ingredient costs on the stock ledger and give Pro administrators a dish-costing view and a date-range food-cost & profit report.

**Architecture:** Cost lives on the existing append-only ledger: `stock_items` holds a running average, every new `stock_moves` row freezes the value it moved, and "set unit cost" entries go in a new append-only table. Pure cost arithmetic and report shaping live in `packages/domain/src/costing.ts`; a new `apps/server/src/costing.ts` module serves the routes; the UI adds cost columns to Inventory, a Dish costing tab, and reuses the operational-report renderer for the profit report.

**Tech Stack:** TypeScript (strict), better-sqlite3, Zod 4, Fastify 5, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-inventory-costing-design.md`

## Global Constraints

- Costing method: weighted average per stock item; purchase cost is the amount actually paid **including GST**.
- Average cost unit: `unit_cost_milli_paise` = thousandths of a paise per one unit of the item's own unit; `NULL` = unknown.
- Movement cost: `cost_paise` integer paise, same sign as `delta`; `NULL` = unknown. Never treat unknown as ₹0.
- Rounding: movement cost to whole paise, average to whole milli-paise, both half away from zero; use `BigInt` for intermediate products.
- Purchase amount: integer paise, `0` to `1_000_000_000` (₹1 crore), purchases only.
- Unit cost set: `unitCostMilliPaise` integer `> 0`; note 1–200 chars; not allowed on inactive items.
- Access: every costing route requires permission `costs.read` (admin only) **and** the `recipes` entitlement.
- Revenue basis: `bill_report_lines.taxable_paise`, bills dated by issue date via the existing `reportRange` (≤ 366 days, server local timezone).
- Cashiers and other roles must never receive any cost field from any endpoint.
- Migration number: **023** (022 is the kitchen-acceptance setting).
- Git: commits fail until a git identity is configured. Ask the user to set `user.name`/`user.email` before the first commit step; never set it yourself. Stage only the files each task lists — the working tree contains unrelated uncommitted work.

## Review Focus

1. **Cheap units lose precision** — receiving 100 ml for ₹2.34 must give 2,340 milli-paise/ml, not 0 or 2,000. Test in Task 2.
2. **Retry with a changed amount** — re-sending a purchase with the same `clientRef` but a different `costPaise` must return 409, not silently reuse the first result. Test in Task 4.
3. **Later price changes rewriting history** — a profit report for last week must not change after today's purchase or a "set unit cost". Test in Task 6.
4. **Blank service prices** — a dish with no AC/takeaway price must show those tiers at the normal price (pre-GST), not ₹0 or 100% cost. Test in Task 5.
5. **Plan downgrade leaking cost** — on Basic, the movement history must omit `costPaise` even for an admin. Test in Task 4.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/domain/src/migrations/023-stock-costing.ts` (create) | Columns, `stock_cost_changes` table and its triggers |
| `packages/domain/src/costing.ts` (create) | Pure cost math, dish cost, pre-GST price, profit report shaping, shared costing types |
| `packages/domain/src/stock.ts` (modify) | `appendStockMove` writes cost and updates average; `reverseStock` negates original cost |
| `packages/domain/src/stock-schemas.ts` (modify) | `StockAdjust.costPaise`, `UnitCostSet` schema, `StockMove.costPaise` |
| `packages/domain/src/roles.ts` (modify) | Document `costs` namespace |
| `apps/server/src/stock.ts` (modify) | Priced purchases; cost fields in history for entitled admins |
| `apps/server/src/costing.ts` (create) | Unit-cost route, stock costs, dish costs, profit report |
| `apps/ui/src/stock-costs.ts` (create) | UI formatting/conversion helpers for costs |
| `apps/ui/src/screens/Inventory.tsx` (modify) | Cost columns, amount-paid field, set unit cost, history cost, Dish costing tab |
| `apps/ui/src/screens/DishCosting.tsx` + `apps/ui/src/dish-costing.ts` (create) | Dish costing tab and its pure sort/filter |
| `apps/ui/src/screens/OperationalReports.tsx`, `apps/ui/src/operational-report.ts`, `apps/ui/src/screens/SalesReports.tsx`, `apps/ui/src/App.tsx` (modify) | Food cost & profit report entry and `percent` format |
| `docs/operations/costing.md` (create), `APPLICATION_OVERVIEW.md` (modify) | Operator guide and overview |

---

### Task 1: Migration 023 and the `costs` permission

**Files:**
- Create: `packages/domain/src/migrations/023-stock-costing.ts`, `packages/domain/src/migrations/023-stock-costing.test.ts`
- Modify: `packages/domain/src/migrations/index.ts`, `packages/domain/src/roles.ts:7`, `packages/domain/src/migrations/015-upi-payments.test.ts` (only if it snapshots `stock_items`; it snapshots `settings`, so expect no change)

**Interfaces:**
- Produces: columns `stock_items.unit_cost_milli_paise INTEGER`, `stock_moves.cost_paise INTEGER`, `stock_moves.unit_cost_after INTEGER`; table `stock_cost_changes(id, stock_item_id, old_cost_milli_paise, new_cost_milli_paise, note, created_at, created_by, client_ref UNIQUE, request_json)` with `CHECK (new_cost_milli_paise > 0)`; triggers `stock_cost_changes_no_update`, `stock_cost_changes_no_delete`; index on `(stock_item_id, created_at)`.

- [ ] **Step 1: Write the failing test** `023-stock-costing.test.ts`

```ts
it("adds nullable cost columns and an append-only cost-change log", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS.filter((m) => m.version < 23));
    db.exec(`INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Asha', 'h', 'admin', 0);
      INSERT INTO stock_items (id, name, unit, qty) VALUES ('s', 'Paneer', 'kg', 2);
      INSERT INTO stock_moves (id, stock_item_id, delta, reason, created_at, created_by) VALUES ('m', 's', 2, 'purchase', 1, 'u');`);
    migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT unit_cost_milli_paise FROM stock_items").get()).toEqual({ unit_cost_milli_paise: null });
    expect(db.prepare("SELECT cost_paise, unit_cost_after FROM stock_moves").get()).toEqual({ cost_paise: null, unit_cost_after: null });
    db.prepare(`INSERT INTO stock_cost_changes (id, stock_item_id, old_cost_milli_paise, new_cost_milli_paise, note, created_at, created_by)
      VALUES ('c', 's', NULL, 32000000, 'Opening cost', 2, 'u')`).run();
    expect(() => db.prepare("UPDATE stock_cost_changes SET note = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM stock_cost_changes").run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE stock_moves SET cost_paise = 1").run()).toThrow(/append-only/);
    expect(() => db.prepare(`INSERT INTO stock_cost_changes (id, stock_item_id, new_cost_milli_paise, note, created_at, created_by)
      VALUES ('z', 's', 0, 'bad', 3, 'u')`).run()).toThrow();
  } finally { db.close(); }
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run packages/domain/src/migrations/023-stock-costing.test.ts` → FAIL (no such column).
- [ ] **Step 3: Implement `migration023` (`version: 23, name: "stock-costing"`)** and append it to `MIGRATIONS`. Trigger messages must contain `append-only`. Add `costs` to the namespace list comment in `roles.ts`; no role other than admin (`"*"`) gains it.
- [ ] **Step 4: Run** `npx vitest run packages/domain` → PASS (fix any other migration test that asserts the final schema version or full row shape).
- [ ] **Step 5: Commit** — `git add` the files above; message `feat(domain): migration 023 for stock costing`.

---

### Task 2: Pure cost arithmetic and shared types

**Files:**
- Create: `packages/domain/src/costing.ts`, `packages/domain/src/costing.test.ts`
- Modify: `packages/domain/src/index.ts` (export everything below)

**Interfaces:**
- Produces:
  - `blendUnitCost(oldQtyMilli: number, oldCost: number | null, addQtyMilli: number, paidPaise: number): number` — returns milli-paise per unit. If `oldQtyMilli <= 0` or `oldCost === null`: `paidPaise * 1_000_000 / addQtyMilli`. Else `(oldQtyMilli * oldCost + paidPaise * 1_000_000) / (oldQtyMilli + addQtyMilli)`. `BigInt` intermediates, round half away from zero. Throws if `addQtyMilli <= 0`.
  - `moveCostPaise(deltaMilli: number, unitCost: number | null): number | null` — `deltaMilli * unitCost / 1_000_000`, rounded; `null` when `unitCost` is `null`.
  - `preGstPaise(pricePaise: number, gstRate: number, taxInclusive: boolean): number` — exclusive: unchanged; inclusive: `round(price * 100 / (100 + gstRate))`.
  - `dishCost(links: Array<{ stockName: string; qtyPerSale: number; unitCostMilliPaise: number | null }>): { costPaise: number | null; status: "complete" | "incomplete" | "no_recipe"; missing: string[] }` — sums `moveCostPaise(stockMilli(qtyPerSale), cost)` per link.
  - Types: `StockCost { stockItemId: string; name: string; unit: StockUnit; qty: number; isActive: boolean; unitCostMilliPaise: number | null; valuePaise: number | null }`, `DishPrice { tier: PriceTier; pricePaise: number; preGstPaise: number; costPercent: number | null; marginPaise: number | null }`, `DishCost { productId: string; variantId: string | null; name: string; categoryName: string; costPaise: number | null; status: "complete" | "incomplete" | "no_recipe"; missing: string[]; prices: DishPrice[] }`, `StockCostChange { id: string; stockItemId: string; oldCostMilliPaise: number | null; newCostMilliPaise: number; note: string; createdAt: number; createdByName: string | null }`.

- [ ] **Step 1: Write failing tests** in `costing.test.ts`:

```ts
it("blends deliveries into a weighted average", () => {
  expect(blendUnitCost(10_000, 30_000_000, 10_000, 340_000)).toBe(32_000_000); // 10 kg @₹300 + 10 kg for ₹3,400 → ₹320/kg
});
it("starts fresh when stock was at or below zero, or cost unknown", () => {
  expect(blendUnitCost(-2_000, 30_000_000, 5_000, 200_000)).toBe(40_000_000);
  expect(blendUnitCost(0, 30_000_000, 5_000, 200_000)).toBe(40_000_000);
  expect(blendUnitCost(5_000, null, 5_000, 200_000)).toBe(40_000_000);
});
it("keeps cheap units precise", () => {
  expect(blendUnitCost(0, null, 100_000, 234)).toBe(2_340); // 100 ml for ₹2.34 → 2.34 paise/ml
  expect(moveCostPaise(-250_000, 2_340)).toBe(-585);        // 250 ml used
});
it("handles large values without overflow", () => {
  expect(blendUnitCost(1_000_000_000, 100_000_000_000, 1_000_000_000, 1_000_000_000)).toBe(50_000_500_000); // (1e20 + 1e15) / 2e9
});
it("values movements and treats unknown cost as null", () => {
  expect(moveCostPaise(-1_500, 32_000_000)).toBe(-48_000);
  expect(moveCostPaise(-1, 1_500)).toBe(0); // rounds to zero; normalise -0 to 0
  expect(moveCostPaise(-1_500, null)).toBeNull();
});
it("converts tax-inclusive prices to pre-GST", () => {
  expect(preGstPaise(10_500, 5, true)).toBe(10_000);
  expect(preGstPaise(10_500, 5, false)).toBe(10_500);
  expect(preGstPaise(9_900, 0, true)).toBe(9_900);
});
it("costs a dish and flags missing ingredients", () => {
  expect(dishCost([])).toEqual({ costPaise: null, status: "no_recipe", missing: [] });
  expect(dishCost([{ stockName: "Paneer", qtyPerSale: 0.15, unitCostMilliPaise: 32_000_000 }, { stockName: "Oil", qtyPerSale: 20, unitCostMilliPaise: 150 }]))
    .toEqual({ costPaise: 4_803, status: "complete", missing: [] });
  expect(dishCost([{ stockName: "Paneer", qtyPerSale: 0.15, unitCostMilliPaise: 32_000_000 }, { stockName: "Cream", qtyPerSale: 0.05, unitCostMilliPaise: null }]))
    .toEqual({ costPaise: null, status: "incomplete", missing: ["Cream"] });
});
```

- [ ] **Step 2: Run** `npx vitest run packages/domain/src/costing.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement the functions and types** in `costing.ts` with the signatures above. Rounding helper: `roundDiv(n: bigint, d: bigint): bigint` rounding half away from zero; convert back with `Number()` and assert `Number.isSafeInteger`.
- [ ] **Step 4: Run** the test file → PASS.
- [ ] **Step 5: Commit** — `feat(domain): weighted-average cost arithmetic`.

---

### Task 3: Costs on the stock ledger

**Files:**
- Modify: `packages/domain/src/stock.ts` (`appendStockMove`, `reverseStock`, `StockRow`), `packages/domain/src/stock-schemas.ts` (`StockAdjust`, `StockMove`, new `UnitCostSet`)
- Test: `packages/domain/src/stock.test.ts`

**Interfaces:**
- Consumes: `blendUnitCost`, `moveCostPaise` (Task 2).
- Produces:
  - `appendStockMove(db, input & { costPaise?: number | null })`. When `costPaise` is given: `reason === "purchase"` → record `+costPaise` and replace the average with `blendUnitCost(oldQtyMilli, oldCost, delta, costPaise)`; `reason === "cancel_reversal"` → record as given (may be `null`), average unchanged; any other reason → throw. When omitted: record `moveCostPaise(delta, currentAverage)`, average unchanged. Always write `unit_cost_after` = the average after the move.
  - `reverseStock` passes `costPaise: -original.cost_paise` (or `null`).
  - `StockRow.unit_cost_milli_paise: number | null`; `stockJson` output unchanged (no cost — cashiers read it).
  - `StockAdjust` gains `costPaise: z.number().int().min(0).max(1_000_000_000).optional()`; `superRefine` rejects it unless `reason === "purchase"` with message `"Amount paid applies only to received stock"`.
  - `UnitCostSet = z.object({ clientRef, expectedVersion, unitCostMilliPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), note: 1–200 trimmed }).strict()`.
  - `StockMove` gains optional `costPaise?: number | null`.

- [ ] **Step 1: Write failing tests** in `stock.test.ts` using a migrated in-memory db and `db.transaction`:
  - `"records purchase cost and blends the average"`: set item cost to `30_000_000` with 10 kg on hand, append purchase `delta 10, costPaise 340_000` → item `unit_cost_milli_paise` `32_000_000`, move `cost_paise` `340_000`, `unit_cost_after` `32_000_000`.
  - `"values sales at the current average and leaves it unchanged"`: then `consumeStock` 1.5 kg via a linked product → sale move `cost_paise` `-48_000`; average still `32_000_000`.
  - `"reverses a sale at its original cost even after the average changed"`: after the sale, a purchase changes the average; `reverseStock` → reversal `cost_paise` `48_000`.
  - `"records null cost when the average is unknown"`: item with no cost, wastage `-1` → `cost_paise` `null`.
  - `"rejects costPaise on non-purchase movements"`: `appendStockMove(... reason: "wastage", costPaise: 10)` throws; `StockAdjust.safeParse({ ..., reason: "wastage", costPaise: 10 })` fails with the message above.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/stock.test.ts` → FAIL.
- [ ] **Step 3: Implement** the changes listed under Interfaces.
- [ ] **Step 4: Run** `npx vitest run` (whole suite; expect only the two known `captain-https.test.ts` PowerShell failures) and `npx tsc --noEmit -p .` → clean.
- [ ] **Step 5: Commit** — `feat(domain): freeze cost on every stock movement`.

---

### Task 4: Priced purchases, unit-cost route and cost visibility

**Files:**
- Create: `apps/server/src/costing.ts` (`registerCosting(app: FastifyInstance): void`), `apps/server/src/costing.test.ts`
- Modify: `apps/server/src/stock.ts` (movements POST and GET), `apps/server/src/server.ts` (register after `registerStock`)

**Interfaces:**
- Consumes: Task 3 schemas and `appendStockMove`; `app.licensing.assertFeature("recipes", device)`, `app.licensing.status(device).features.recipes`, `can(roleFor(role), "costs.read")`.
- Produces:
  - `POST /api/stock-items/:id/movements` accepts `costPaise`; when present calls `assertFeature("recipes", …)` before writing; `costPaise` is part of the retry fingerprint (`request_json`).
  - `GET /api/stock-items/:id/movements` → `{ movements: StockMove[]; costChanges?: StockCostChange[] }`. `costPaise` on each movement and the `costChanges` array (same `before`/limit window by time) only when the user has `costs.read` **and** the plan has `recipes`.
  - `POST /api/stock-items/:id/unit-cost` (body `UnitCostSet`) → `201 { item: StockItem; unitCostMilliPaise: number }`, `200` on identical retry, `409` on version mismatch, reused `clientRef` with different body, or inactive item. Writes `stock_cost_changes`, sets the average, bumps `stock_items.version`, then `publishStock(app, [id])`.
  - Shared preHandler in `costing.ts`: `const costs = [app.requirePermission("costs.read"), app.requireFeature("recipes")]`, reused by Tasks 5–6.

- [ ] **Step 1: Write failing tests** in `costing.test.ts` (use `freshApp`, `setupAdmin`, `createUser`, `auth`; licensing is in development mode in tests so `recipes` is on):
  - `"sets a starting cost, receives priced stock, and shows cost in history to admins"`: create item (kg, opening 10) → `POST unit-cost { unitCostMilliPaise: 30_000_000, note: "Opening cost" }` 201 → purchase `{ reason: "purchase", quantity: 10, costPaise: 340_000, note: "Invoice 12" }` 201 → history movements include `costPaise: 340_000` and `costChanges[0].newCostMilliPaise === 30_000_000`.
  - `"retries a unit-cost change and rejects a reused reference"`: same body twice → 201 then 200; same `clientRef` with different cost → 409; stale `expectedVersion` → 409; inactive item → 409.
  - `"returns 409 when a purchase reference is reused with a different amount"` (Review Focus 2).
  - `"hides cost from cashiers"`: cashier → `POST unit-cost` 403; history has no `costPaise` key on any movement and no `costChanges`; `GET /api/stock-items` items have no key containing `cost`.
  - `"hides cost after a downgrade to Basic"` (Review Focus 5): spy `app.licensing.status` to return `features.recipes: false` with `canOperate: true` → admin history omits `costPaise` and `costChanges`; purchase with `costPaise` → 403.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/costing.test.ts` → FAIL.
- [ ] **Step 3: Implement** the routes and changes under Interfaces.
- [ ] **Step 4: Run** `npx vitest run apps/server` and `npx tsc --noEmit -p .` → PASS (known PowerShell failures only).
- [ ] **Step 5: Commit** — `feat(server): priced purchases and unit-cost changes`.

---

### Task 5: Stock value and dish costing endpoints

**Files:**
- Modify: `apps/server/src/costing.ts`, `apps/server/src/costing.test.ts`

**Interfaces:**
- Consumes: `dishCost`, `preGstPaise`, `priceForTier` (`@forkflow/domain/pricing`), `StockCost`, `DishCost` (Task 2); `costs` preHandler (Task 4).
- Produces:
  - `GET /api/costing/stock` → `{ items: StockCost[]; totalValuePaise: number }` — `valuePaise = moveCostPaise(stockMilli(qty), cost)` (null when unknown; negative stock gives negative value); total sums known values of active items.
  - `GET /api/costing/dishes` → `{ dishes: DishCost[]; taxInclusive: boolean }` — one row per active product without variants, or per active variant (name `"Product · Variant"`); recipe links are the product's; `prices` for tiers `non_ac`, `ac`, `takeaway` via `priceForTier` on the variant (or product) row; `costPercent = round(cost * 1000 / preGst) / 10` and `marginPaise = preGst − cost`, both `null` when cost is `null` or `preGst === 0`.

- [ ] **Step 1: Write failing tests:**
  - `"values stock on hand"`: 10 kg at ₹320/kg plus an uncosted item → item `valuePaise: 320_000`, other `null`, `totalValuePaise: 320_000`.
  - `"costs dishes against each service price, pre-GST"` (Review Focus 4): tax-inclusive setting on; product price ₹105.00, GST 5, AC price ₹126.00, no takeaway price; recipe 0.15 kg paneer at ₹320/kg → `costPaise: 4_800`; prices `[{ tier: "non_ac", preGstPaise: 10_000, costPercent: 48 }, { tier: "ac", preGstPaise: 12_000, costPercent: 40 }, { tier: "takeaway", preGstPaise: 10_000, costPercent: 48 }]`.
  - `"flags incomplete and unlinked dishes"`: one ingredient without cost → `status: "incomplete", missing: ["Cream"]`; a product with no links → `status: "no_recipe"`.
  - `"refuses cashiers"`: both routes 403.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run apps/server/src/costing.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(server): stock value and dish costing`.

---

### Task 6: Food cost & profit report

**Files:**
- Modify: `packages/domain/src/costing.ts` (+ tests), `apps/server/src/costing.ts` (+ tests)

**Interfaces:**
- Consumes: `reportRange` (`apps/server/src/sales-reports.ts`), `OperationalReport`, `ReportTable` (`@forkflow/domain/operational-reports`).
- Produces:
  - Domain: `ProfitLine { categoryName: string; name: string; qty: number; revenuePaise: number; costPaise: number | null; saleMoves: number }` and `buildProfitReport(input: { from: string; to: string; today: string; timezone: string; generatedAt: number; lines: ProfitLine[]; wastage: { costPaise: number; unknownCount: number }; adjustments: { costPaise: number; unknownCount: number } }): Omit<OperationalReport, "kind"> & { kind: "profit" }`.
    - Line status: `saleMoves === 0` → no recipe; `costPaise === null` → cost unknown; else costed.
    - Tables (titles exact): `"Summary"` (columns `metric`, `amount` money, `percent` percent), `"By category"`, `"By dish"` (columns `name`, `qty` quantity, `revenue` money, `cost` money, `profit` money, `costPercent` percent, `status`).
    - Summary rows, in order: `Revenue (pre-GST)`, `Costed revenue`, `Ingredient cost`, `Gross profit`, `Food cost %` (percent only), `Wastage cost`, `Count adjustments (net)`, `Excluded: cost unknown`, `Excluded: no recipe`.
    - `notes` include: revenue basis ("Revenue is bill taxable value after discount, excluding GST, by bill issue date."), the exclusion sentence when any revenue is excluded, and "Sales before costing was set up have no recorded cost." when any cost-unknown line exists; plus unknown-count notes for wastage/adjustments when non-zero.
    - `ReportColumn.format` gains `"percent"` in `packages/domain/src/operational-reports.ts`.
  - Server: `GET /api/reports/profit?from&to` (`costs` preHandler) → `{ report }`. Lines: one per `bill_report_lines` row of bills whose `created_at` is in `bounds`, with `costPaise = −SUM(m.cost_paise)` over `stock_moves m WHERE m.order_item_id = line.order_item_id AND m.reason = 'sale' AND NOT EXISTS (reversal)`, `null` if any such `cost_paise IS NULL`, `saleMoves = COUNT(m)`. Wastage/adjustments: `−SUM(cost_paise)` and `COUNT(*) WHERE cost_paise IS NULL` for `reason IN ('wastage')` / `('adjustment')` by `created_at` in `bounds`.

- [ ] **Step 1: Write failing domain test** `"builds profit totals, statuses and notes"`: three lines — costed (revenue 10_000, cost 4_800), unknown (5_000, null, 1 move), no recipe (2_000, null, 0 moves); wastage 1_000 → Summary `Revenue (pre-GST)` 17_000, `Costed revenue` 10_000, `Ingredient cost` 4_800, `Gross profit` 5_200, `Food cost %` 48, `Excluded: cost unknown` 5_000, `Excluded: no recipe` 2_000; a note mentions both exclusions.
- [ ] **Step 2: Write failing server test** `"reports profit from frozen costs and never rewrites the past"` (Review Focus 3): set paneer ₹320/kg; dish uses 0.15 kg; order, send, bill (taxable ₹100) → report food cost 48%; then purchase at a new price and `unit-cost` change → same range report unchanged. Also: range over 366 days → 400; cashier → 403.
- [ ] **Step 3: Run** both → FAIL. **Step 4: Implement.** **Step 5: Run** `npx vitest run` and `npx tsc --noEmit -p .` → PASS (known failures only).
- [ ] **Step 6: Commit** — `feat: food cost and profit report`.

---

### Task 7: Inventory screen — costs, amount paid, set unit cost, history

**Files:**
- Create: `apps/ui/src/stock-costs.ts`, `apps/ui/src/stock-costs.test.ts`
- Modify: `apps/ui/src/screens/Inventory.tsx`, `apps/ui/src/App.tsx` (pass `canSeeCosts`), `apps/ui/src/types.ts` if a local type is needed

**Interfaces:**
- Consumes: `GET /api/costing/stock`, `POST /api/stock-items/:id/unit-cost`, movements `costPaise`/`costChanges` (Tasks 4–5); `useLicense().status.features.recipes`.
- Produces (`stock-costs.ts`):
  - `formatUnitCost(milliPaise: number | null, unit: StockUnit): string` → `"₹320.00/kg"`, `"₹0.0234/ml"` (2 decimals, up to 4 when below ₹1), `"Cost not set"` for null.
  - `rupeesPerUnitToMilliPaise(text: string): number | null` — accepts up to 4 decimals of rupees; `null` for invalid/≤ 0.
  - `perUnitHint(amountRupees: string, quantity: string, unit: StockUnit): string | null` → `"= ₹34.00/kg"`; `null` when either input is blank/invalid/zero quantity.
- Visibility: cost UI renders only when `user.role === "admin" && status?.features.recipes === true`; otherwise the screen is unchanged.

- [ ] **Step 1: Write failing tests** for the three helpers, including `formatUnitCost(2_340, "ml") === "₹0.0234/ml"`, `rupeesPerUnitToMilliPaise("320") === 32_000_000`, `rupeesPerUnitToMilliPaise("0") === null`, `perUnitHint("340", "10", "kg") === "= ₹34.00/kg"`, `perUnitHint("340", "0", "kg") === null`.
- [ ] **Step 2: Run** `npm run test -- apps/ui/src/stock-costs.test.ts` (or `npx vitest run apps/ui/src/stock-costs.test.ts`) → FAIL. **Step 3: Implement** helpers.
- [ ] **Step 4: Wire the screen:** stock table columns "Avg cost" and "Stock value" plus a total line; "Receive stock" gains **Amount paid (₹, incl. GST)** (optional) with the hint, sent as `costPaise` via `rupeesToPaise`; item detail gains **Set unit cost** (₹ per unit + note) with its own `clientRef`/in-flight guard like the existing movement form; history shows a Cost column and interleaves "Unit cost set" rows by `createdAt`. Refresh costs on `stock.changed`.
- [ ] **Step 5: Run** `npx vitest run apps/ui` and `npm run typecheck -w @forkflow/ui` → PASS.
- [ ] **Step 6: Commit** — `feat(ui): ingredient costs in inventory`.

---

### Task 8: Dish costing tab

**Files:**
- Create: `apps/ui/src/dish-costing.ts`, `apps/ui/src/dish-costing.test.ts`, `apps/ui/src/screens/DishCosting.tsx`
- Modify: `apps/ui/src/screens/Inventory.tsx` (third tab `"costing"`, label **Dish costing**, same keyboard tab behaviour)

**Interfaces:**
- Consumes: `GET /api/costing/dishes` (Task 5), `DishCost`.
- Produces: `sortDishes(dishes: DishCost[], category: string | "all"): { costed: DishCost[]; noRecipe: DishCost[] }` — `noRecipe` holds `status === "no_recipe"`; `costed` holds the rest sorted by highest non-AC `costPercent` first, incomplete rows (null percent) last, then by name.
- Basic administrators see the tab with the existing recipe upgrade prompt; non-admins don't see the tab.

- [ ] **Step 1: Write failing tests** for `sortDishes`: ordering by cost %, incomplete last, category filter, no-recipe split.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `sortDishes` and `DishCosting.tsx` (table: dish, recipe cost, one column per tier showing pre-GST price · cost % · margin, status/missing list; category filter; separate "No recipe linked" list).
- [ ] **Step 4: Run** `npx vitest run apps/ui` and the UI typecheck → PASS.
- [ ] **Step 5: Commit** — `feat(ui): dish costing tab`.

---

### Task 9: Food cost & profit in Reports

**Files:**
- Modify: `apps/ui/src/screens/OperationalReports.tsx`, `apps/ui/src/operational-report.ts` (+ its test), `apps/ui/src/screens/SalesReports.tsx`, `apps/ui/src/App.tsx`

**Interfaces:**
- Consumes: `GET /api/reports/profit` (Task 6).
- Produces: `OperationalReports` accepts `kind: OperationalReportKind | "profit"`; fetch path is `/api/reports/profit?…` for `"profit"`, otherwise unchanged; title "Food cost & profit". `operationalCell` handles `format: "percent"` → `"48.0%"` on screen, `"48.0"` in CSV (CSV header gets `" %"`). `SalesReports` gains prop `canSeeCosts: boolean`; when true the picker lists "Food cost & profit" after the operational reports. If `useLicense().status?.features.recipes` is not true, selecting it shows the existing recipe upgrade prompt instead of fetching (spec: Basic administrators see it locked).

- [ ] **Step 1: Write failing test** in `operational-report.test.ts`: `operationalCell(48, { key: "p", label: "Food cost", format: "percent" }, "UTC")` → `"48.0%"`; CSV cell `"48.0"`; `null` → `""` (existing null behaviour).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the changes under Interfaces; App passes `canSeeCosts={user.role === "admin"}`.
- [ ] **Step 4: Run** `npx vitest run apps/ui`, UI typecheck, and `npm run build -w @forkflow/ui` → PASS.
- [ ] **Step 5: Commit** — `feat(ui): food cost and profit report`.

---

### Task 10: Docs and end-to-end verification

**Files:**
- Create: `docs/operations/costing.md`
- Modify: `APPLICATION_OVERVIEW.md` (migrations 001–023; inventory feature list; `stock_cost_changes` in the table groups; costing routes in the API table; remove "costing/profit features" from the inventory row of section 13), `README.md` (one paragraph), `docs/operations/recipes.md` (link to costing guide)

- [ ] **Step 1: Write `docs/operations/costing.md`:** what weighted average means with the paneer example; GST-inclusive entry; setting starting costs; reading Dish costing; reading the profit report and its exclusions; admin + Pro only; behaviour after downgrade; costs before go-live are unknown.
- [ ] **Step 2: Update** the overview, README and recipes guide as listed.
- [ ] **Step 3: Full checks:** `npx tsc --noEmit -p .`, `npm run typecheck -w @forkflow/ui`, `npx vitest run` (only the two known `captain-https.test.ts` failures), `npm run build -w @forkflow/ui`, `npm run test:packaging`.
- [ ] **Step 4: Browser check** with a disposable database: set `FORKFLOW_DATA_DIR` to `.e2e-scratch/costing`, `npm run dev`, then as admin: create a stock item, set a starting cost, receive stock with an amount paid, link it to a dish, order → send → accept → bill, open Dish costing and Food cost & profit, export CSV. Sign in as a cashier and confirm no cost column, tab or report appears. Record what was checked.
- [ ] **Step 5: Commit** — `docs: inventory costing guide and overview`.
