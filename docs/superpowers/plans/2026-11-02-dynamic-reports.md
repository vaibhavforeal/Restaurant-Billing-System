# Dynamic Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A licensed `dynamicReports` add-on that turns the Home screen into a dashboard each person lays out for themselves. Widgets can be dragged and resized; each has its own period and comparison and refreshes live.

**Architecture:**
- Pure logic lives in `packages/domain/src/dashboard/`: periods, grid moves, widget catalogue, layout schema, and the data request/response types.
- The server stores one layout per user (migration 44). It computes every widget in one request by calling report functions extracted from the existing report routes.
- The UI renders an in-house 12-column CSS grid, drawn only from what the domain grid functions return, and refreshes on `order.updated`.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, zod 4, React 19 (no new dependencies), vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-dynamic-reports-design.md`

## Global Constraints

- No new npm dependencies in any workspace. Charts are hand-written SVG.
- Money is integer paise end to end. The UI formats with `paiseToRupees` (`apps/ui/src/money.ts`).
- Dates are local `YYYY-MM-DD` keys from `localDateKey` (`packages/domain/src/dates.ts`). Date ranges are inclusive and at most 366 days (`reportRange`).
- New module id: `dynamicReports`, name "Dynamic Reports", group `addon`, `dependsOn: ["reports", "dashboard"]`, plans `{ basic: false, pro: true }`.
- New permission: `reports.dashboard`, labelled "Customise own dashboard", in the Reports area. No role has it except admin (through `*`).
- Every `/api/dashboard/*` route has the preHandlers `[app.requirePermission("reports.read"), app.requirePermission("reports.dashboard"), requireModule(app, "dynamicReports")]`.
- The grid has 12 columns and at most 30 widgets per layout. Below 720 px wide the dashboard is read-only and shows one column.
- Migration version 44, appended after `baseline` in `packages/domain/src/migrations/index.ts`.
- Live refresh: `order.updated` with a 400 ms debounce, a 60 s poll, and a refresh on reconnect.
- Comments and UI copy use plain words, matching the existing code style. Test names describe behaviour.
- Commit after each task, ending the message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Midnight while the dashboard is open.** "Today" must become the new date without a reload. The server resolves periods from its own clock on every data request, and the UI shows the range the response returns. Test in Task 8: `resolves "today" at request time`.
2. **Losing access to a widget between loading and saving.** `GET` hides widgets the user can't see; a later `PUT` must not delete them from storage. Test in Task 7: `keeps hidden widgets when a layout is saved`.
3. **A stored layout that no longer parses**, or that names a widget the catalogue no longer has. `GET` must not return a 500. Unknown items are dropped, and anything unparsable falls back to the default. Test in Task 7: `recovers from a stored layout it cannot read`.
4. **A new restaurant with no bills, or a comparison period that was zero.** No `NaN`, no `Infinity`, no division by zero. Tests in Task 3 (`percentChange`) and Task 8 (`averageBill with no bills is 0`).
5. **Dragging past the grid's edge**, or resizing past a widget's min or max. Items stay inside 0..12 columns and their size limits. Test in Task 2: `clamps moves and resizes to the grid and the widget's limits`.

---

## File Map

| File | Responsibility |
|---|---|
| `packages/domain/src/dashboard/periods.ts` (+ `.test.ts`) | Period presets and comparison ranges |
| `packages/domain/src/dashboard/grid.ts` (+ `.test.ts`) | Pure grid placement: collide, clamp, move, resize, compact, stack |
| `packages/domain/src/dashboard/widgets.ts` | Widget catalogue and visibility |
| `packages/domain/src/dashboard/layout.ts` (+ `.test.ts`) | Layout zod schema, default layout, `percentChange` |
| `packages/domain/src/dashboard/data.ts` | Data request schema and result types |
| `packages/domain/src/dashboard/index.ts` | Re-exports; package subpath `./dashboard` |
| `packages/domain/src/modules.ts`, `integrations.ts`, `staff-permissions.ts`, `roles.ts` | Module, Marketplace card, permission |
| `packages/domain/src/migrations/dashboard-layouts.ts` | Migration 44 |
| `apps/server/src/sales-reports.ts`, `order-analytics.ts`, `operational-reports.ts` | Extract `salesReport`, `orderAnalyticsReport`, `operationalReport` |
| `apps/server/src/dashboard.ts` (+ `.test.ts`) | Layout routes and the data route |
| `apps/server/src/dashboard-widgets.ts` (+ `.test.ts`) | Computes each widget from the report functions and status queries |
| `apps/ui/src/live-refresh.ts` | `useLiveRefresh`, extracted from `useDashboard.ts` |
| `apps/ui/src/dynamic-dashboard/*` | Hooks, grid, widgets, catalogue, settings, screen, CSS |
| `apps/ui/src/screens/Home.tsx`, `screens/Marketplace.tsx` | Home switch; Marketplace category label |
| `docs/operations/dynamic-reports.md`, `docs/operations/feature-controls.md` | Operations docs |

---

### Task 1: Period presets and comparisons

**Files:**
- Create: `packages/domain/src/dashboard/periods.ts`
- Test: `packages/domain/src/dashboard/periods.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const DASHBOARD_PERIODS = ["today","yesterday","thisWeek","thisMonth","last7","last30"] as const;
  export type DashboardPeriod = typeof DASHBOARD_PERIODS[number];
  export const DASHBOARD_COMPARES = ["none","previous","lastWeek"] as const;
  export type DashboardCompare = typeof DASHBOARD_COMPARES[number];
  export interface DateRange { from: string; to: string } // inclusive local YYYY-MM-DD
  export function periodRange(period: DashboardPeriod, today: string): DateRange;
  export function compareRange(period: DashboardPeriod, range: DateRange, compare: DashboardCompare): DateRange | null;
  export const PERIOD_LABELS: Record<DashboardPeriod, string>;   // "Today", "Yesterday", "This week", "This month", "Last 7 days", "Last 30 days"
  export const COMPARE_LABELS: Record<DashboardCompare, string>; // "No comparison", "Previous period", "Same days last week"
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe("dashboard periods", () => {
  it("resolves each preset against today (weeks start on Monday)", () => {
    // 2026-11-04 is a Wednesday
    expect(periodRange("today", "2026-11-04")).toEqual({ from: "2026-11-04", to: "2026-11-04" });
    expect(periodRange("yesterday", "2026-11-01")).toEqual({ from: "2026-10-31", to: "2026-10-31" });
    expect(periodRange("thisWeek", "2026-11-04")).toEqual({ from: "2026-11-02", to: "2026-11-04" });
    expect(periodRange("thisWeek", "2026-11-08")).toEqual({ from: "2026-11-02", to: "2026-11-08" }); // Sunday
    expect(periodRange("thisMonth", "2026-11-04")).toEqual({ from: "2026-11-01", to: "2026-11-04" });
    expect(periodRange("last7", "2026-11-04")).toEqual({ from: "2026-10-29", to: "2026-11-04" });
    expect(periodRange("last30", "2026-11-04")).toEqual({ from: "2026-10-06", to: "2026-11-04" });
  });
  it("compares with the previous period of the same length", () => {
    expect(compareRange("today", { from: "2026-11-04", to: "2026-11-04" }, "previous")).toEqual({ from: "2026-11-03", to: "2026-11-03" });
    expect(compareRange("thisWeek", { from: "2026-11-02", to: "2026-11-04" }, "previous")).toEqual({ from: "2026-10-26", to: "2026-10-28" });
    expect(compareRange("last7", { from: "2026-10-29", to: "2026-11-04" }, "previous")).toEqual({ from: "2026-10-22", to: "2026-10-28" });
  });
  it("compares month-to-date with the same days of last month, clipped to its end", () => {
    expect(compareRange("thisMonth", { from: "2026-11-01", to: "2026-11-04" }, "previous")).toEqual({ from: "2026-10-01", to: "2026-10-04" });
    expect(compareRange("thisMonth", { from: "2026-03-01", to: "2026-03-31" }, "previous")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(compareRange("thisMonth", { from: "2028-03-01", to: "2028-03-30" }, "previous")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
  it("shifts by seven days for lastWeek and returns null for none", () => {
    expect(compareRange("today", { from: "2026-11-04", to: "2026-11-04" }, "lastWeek")).toEqual({ from: "2026-10-28", to: "2026-10-28" });
    expect(compareRange("today", { from: "2026-11-04", to: "2026-11-04" }, "none")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**
  Run: `npx vitest run packages/domain/src/dashboard/periods.test.ts`
  Expected: FAIL, because the module can't be found.

- [ ] **Step 3: Implement `periods.ts`.** Do all arithmetic with `new Date(y, m - 1, d)` in local time and format with `localDateKey`. Never add 86 400 000 ms, so DST can't shift a day.

- [ ] **Step 4: Run the tests again.** Expected: PASS.

- [ ] **Step 5: Commit** with message `feat(domain): dashboard period presets and comparison ranges`.

---

### Task 2: Grid placement

**Files:**
- Create: `packages/domain/src/dashboard/grid.ts`
- Test: `packages/domain/src/dashboard/grid.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const GRID_COLUMNS = 12;
  export interface GridSize { w: number; h: number }
  export interface GridRect extends GridSize { x: number; y: number }
  export interface GridItem extends GridRect { key: string }
  export interface SizeLimits { min: GridSize; max: GridSize }
  export function collides(a: GridRect, b: GridRect): boolean;
  export function clampItem<T extends GridItem>(item: T, limits: SizeLimits): T;        // w/h within limits, 0 <= x <= 12-w, y >= 0, all integers
  export function compact<T extends GridItem>(items: readonly T[]): T[];                // each item rises as far as it can, processed in (y, x, key) order; no overlaps
  export function moveItem<T extends GridItem>(items: readonly T[], key: string, to: { x: number; y: number }, limits: SizeLimits): T[];
  export function resizeItem<T extends GridItem>(items: readonly T[], key: string, size: GridSize, limits: SizeLimits): T[];
  export function stackOrder<T extends GridItem>(items: readonly T[]): T[];             // sorted by y, then x, then key
  ```
  `moveItem`/`resizeItem` clamp the target, place it, push every colliding item down below it (repeating until there are no overlaps), then `compact`. An unknown key returns `items` unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `detects overlap only when rectangles share a cell`: edge-touching rects don't collide.
  - `compacts items upward without overlaps`: `[{a,0,3,4,2},{b,4,0,4,2}]` → `a.y === 0`, `b.y === 0`.
  - `moves an item and pushes the one underneath down`: a at (0,0,6,2), b at (0,2,6,2); move b to (0,0) → `b.y === 0`, `a.y === 2`.
  - `clamps moves and resizes to the grid and the widget's limits`: `moveItem(..., {x: 11, y: -3})` on a w=4 item gives `x === 8, y === 0`. `resizeItem` to `{w: 20, h: 0}` with limits `{min:{w:2,h:1}, max:{w:12,h:6}}` gives `w === 12, h === 1`. Fractional input such as `x: 2.6` rounds to `3`.
  - `never leaves two items overlapping after any move` (property-style): 200 random moves and resizes on 8 items using a fixed seed; after each one, assert that no pair `collides`.
  - `stacks in reading order`.

- [ ] **Step 2: Run them to make sure they fail**
  Run: `npx vitest run packages/domain/src/dashboard/grid.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement `grid.ts`** with the semantics above. Use no DOM and no randomness. The test brings its own seeded PRNG.

- [ ] **Step 4: Run the tests again.** Expected: PASS.

- [ ] **Step 5: Commit** with message `feat(domain): dashboard grid placement`.

---

### Task 3: Widget catalogue, layout schema and data types

**Files:**
- Create:
  - `packages/domain/src/dashboard/widgets.ts`
  - `packages/domain/src/dashboard/layout.ts`
  - `packages/domain/src/dashboard/data.ts`
  - `packages/domain/src/dashboard/index.ts`
- Modify: `packages/domain/package.json` (add the export `"./dashboard": "./src/dashboard/index.ts"`)
- Test: `packages/domain/src/dashboard/layout.test.ts`

**Interfaces:**
- Consumes: Task 1 (`DASHBOARD_PERIODS`, `DASHBOARD_COMPARES`, `DateRange`); Task 2 (`GRID_COLUMNS`, `collides`, `SizeLimits`, `GridSize`); `ModuleId` from `../modules.js`.
- Produces:
  ```ts
  // widgets.ts
  export const DASHBOARD_WIDGET_IDS = [
    "netSales","billCount","averageBill","discounts","gstCollected","creditNotes","outstanding","cashCollected","upiCollected","cardCollected","cancellations",
    "hourlySales","dailyTrend","paymentMix","orderTypeSplit","topItems","topCategories",
    "openTables","runningKots","pendingQr","lowStock","unsettledBills",
  ] as const;
  export type DashboardWidgetId = typeof DASHBOARD_WIDGET_IDS[number];
  export type WidgetKind = "kpi" | "chart" | "status";
  export interface WidgetDef {
    id: DashboardWidgetId; title: string; description: string; kind: WidgetKind;
    defaultSize: GridSize; limits: SizeLimits;
    requires: { permissions: readonly string[]; modules: readonly ModuleId[] };
    options: { period: boolean; compare: boolean; orderType: boolean; topN: boolean };
  }
  export const DASHBOARD_WIDGETS: readonly WidgetDef[];
  export const widgetDef: (id: DashboardWidgetId) => WidgetDef;
  export function widgetVisible(def: WidgetDef, can: (permission: string) => boolean, active: (module: ModuleId) => boolean): boolean;

  // layout.ts
  export const DASHBOARD_LIMITS = { items: 30 } as const;
  export const WidgetOptions: z.ZodType; // { period: enum default "today", compare: enum default "previous", orderType: "all"|"parcel"|"dine_in"|"zomato" default "all", topN: int 3..20 default 5 }, .strict()
  export type WidgetOptionsValue = z.output<typeof WidgetOptions>;
  export const DashboardItem: z.ZodType; // { key: string 1..40, widget: enum(DASHBOARD_WIDGET_IDS), x, y, w, h: int >= 0, options: WidgetOptions }
  export type DashboardItemValue = z.output<typeof DashboardItem>;
  export const DashboardLayout: z.ZodType; // { version: literal 1, items: DashboardItem[] max 30 } + superRefine: unique keys, x+w <= 12, w/h within widgetDef(widget).limits, no two items collide
  export type DashboardLayoutValue = z.output<typeof DashboardLayout>;
  export function defaultLayout(): DashboardLayoutValue;
  export function percentChange(current: number, previous: number): number | null; // null when previous === 0; otherwise (current - previous) / |previous| * 100, rounded to 1 decimal

  // data.ts
  export const DashboardDataRequest: z.ZodType; // { widgets: Array<{ key, widget, options: WidgetOptions }> max 30 }, .strict()
  export type DashboardDataRequestValue = z.output<typeof DashboardDataRequest>;
  export type ValueFormat = "money" | "count";
  export type WidgetValue =
    | { kind: "number"; value: number; format: ValueFormat }
    | { kind: "series"; format: ValueFormat; points: Array<{ label: string; value: number }> }
    | { kind: "ranking"; rows: Array<{ label: string; value: number; qty: number }> }
    | { kind: "status"; count: number; amountPaise?: number; detail: string[] };
  export type WidgetResult =
    | { ok: true; range: DateRange | null; current: WidgetValue; compareRange: DateRange | null; compare: WidgetValue | null }
    | { ok: false; error: string };
  export interface DashboardData { results: Record<string, WidgetResult>; today: string; timezone: string; generatedAt: number }
  ```
- Catalogue values (the implementer writes titles and descriptions in the house style):
  - **KPIs** (all 11): kind `kpi`; default size 3×2; limits min 2×2, max 6×3; options `period` and `compare` only. Requires `reports.read` and module `reports`.
  - **`hourlySales`, `dailyTrend`, `topItems`, `topCategories`**: kind `chart`; default 6×4; limits min 4×3, max 12×8; options `period`, `compare` (except `topItems`/`topCategories`, which take no compare) and `orderType`. `topItems`/`topCategories` also take `topN`.
  - **`paymentMix`, `orderTypeSplit`**: kind `chart`; default 6×4; limits min 4×3, max 12×6; options `period` and `compare`.
  - **Status widgets** (no options): default 3×2; limits min 2×2, max 6×4.
    - `openTables` requires `tables.read`.
    - `runningKots` requires `kots.read` and module `kds`.
    - `pendingQr` requires `orders.read` and module `qrOrdering`.
    - `lowStock` requires `stock.read` and module `inventory`.
    - `unsettledBills` requires `bills.read`.
- `defaultLayout()` mirrors today's fixed dashboard:
  - row 0: four KPIs (`netSales`, `billCount`, `averageBill`, `discounts`), each 3×2;
  - row 2: `hourlySales` 6×4 and `paymentMix` 6×4;
  - row 6: `orderTypeSplit` 6×4 and `topItems` 6×4;
  - row 10: `openTables` and `unsettledBills`, each 3×2.
  
  Keys are `"default-1"` … `"default-10"`, and every item uses default options.

- [ ] **Step 1: Write the failing tests** in `layout.test.ts`:
  - `the default layout is valid and fits the grid`: `DashboardLayout.parse(defaultLayout())` succeeds.
  - `fills option defaults`: parse an item with `options: {}` → `{ period: "today", compare: "previous", orderType: "all", topN: 5 }`.
  - `rejects overlaps, duplicate keys, items off the grid, sizes outside a widget's limits, unknown widgets and more than 30 items`: each case is its own `expect(() => DashboardLayout.parse(...)).toThrow()`.
  - `percentChange handles a zero or negative base`: `(150, 100) → 50`, `(0, 0) → null`, `(5, 0) → null`, `(-50, -100) → 50`, `(1, 3) → -66.7`.
  - `hides widgets whose permission or module is missing`: `widgetVisible(widgetDef("lowStock"), () => true, (m) => m !== "inventory")` is false; with everything allowed it is true.

- [ ] **Step 2: Run them to make sure they fail**
  Run: `npx vitest run packages/domain/src/dashboard`
  Expected: FAIL.

- [ ] **Step 3: Implement `widgets.ts`, `layout.ts`, `data.ts` and `index.ts`** (index re-exports all five modules), and add the package export.

- [ ] **Step 4: Run the tests again**
  Run: `npx vitest run packages/domain/src/dashboard && npx tsc --noEmit`
  Expected: PASS, and typecheck is clean.

- [ ] **Step 5: Commit** with message `feat(domain): dashboard widget catalogue, layout schema and data types`.

---

### Task 4: Licence module, permission, Marketplace card and migration 44

**Files:**
- Modify:
  - `packages/domain/src/modules.ts` (`MODULE_IDS`, `MODULES`)
  - `packages/domain/src/integrations.ts` (`IntegrationId`, the `category` union gains `"insights"`, add the card)
  - `packages/domain/src/staff-permissions.ts` (Reports area)
  - `packages/domain/src/roles.ts` (doc comment at line 7 only)
  - `packages/domain/src/migrations/index.ts`
  - `apps/ui/src/screens/Marketplace.tsx:13` (`categoryLabel` gains `insights: "Insights"`)
  - `docs/operations/feature-controls.md` (module table)
- Create: `packages/domain/src/migrations/dashboard-layouts.ts`
- Test:
  - `packages/domain/src/modules.test.ts`
  - `packages/domain/src/staff-permissions.test.ts`
  - `packages/domain/src/integrations.test.ts`
  - `packages/domain/src/migrate.test.ts`

**Interfaces:**
- Produces:
  - `ModuleId` includes `"dynamicReports"`, and `IntegrationId` includes `"dynamicReports"`.
  - The Marketplace card: `{ id: "dynamicReports", name: "Dynamic Reports", category: "insights", status: "available", setupPage: null, description: "Build your own Home dashboard: drag, resize and choose the sales, item and live service widgets you want, each with its own period." }`.
  - The `reports.dashboard` slug.
  - The table `dashboard_layouts(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, layout_json TEXT NOT NULL CHECK (json_valid(layout_json)), updated_at INTEGER NOT NULL)`.
  - `export const dashboardLayouts: Migration = { version: 44, name: "dashboard_layouts", up }`.

- [ ] **Step 1: Write the failing tests:**
  - `modules.test.ts`: `dynamic reports is a Pro add-on that needs reports and the sales dashboard`. Assert `moduleDef("dynamicReports")` matches `{ group: "addon", dependsOn: ["reports","dashboard"], plans: { basic: false, pro: true } }`, and that `resolveModuleStates` with `dashboard` off gives `reason: "Needs Sales dashboard"`.
  - `staff-permissions.test.ts`: `only admins customise their dashboard unless granted`. Assert `staffCan("cashier", {}, "reports.dashboard") === false`, `staffCan("cashier", { "reports.dashboard": true }, "reports.dashboard") === true`, `staffCan("admin", {}, "reports.dashboard") === true`, and `GRANTABLE_PERMISSIONS` contains it.
  - `integrations.test.ts`: `lists Dynamic Reports in the Marketplace`. `isIntegrationId("dynamicReports")` is true.
  - `migrate.test.ts`: `creates dashboard_layouts at version 44`. After `migrate(db, MIGRATIONS)`, `user_version === 44`, and inserting `layout_json = 'not json'` throws.

- [ ] **Step 2: Run them to make sure they fail**
  Run: `npx vitest run packages/domain/src/modules.test.ts packages/domain/src/staff-permissions.test.ts packages/domain/src/integrations.test.ts packages/domain/src/migrate.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement the domain changes and the migration.** Update the `MIGRATIONS` comment in `index.ts` so it says the next one is 45. In `docs/operations/feature-controls.md`, add a Dynamic Reports row and a sentence on `reports.dashboard`.

- [ ] **Step 4: Run every test and the full typecheck**
  Run: `npx vitest run && npm run typecheck`
  Expected: PASS. The strict `ModuleMapSchema` now needs `dynamicReports` in every signed licence. `commercialApp` builds claims from `resolveModules`, so existing licensing tests keep passing. Also check `apps/licensing-worker` tests and the portal typecheck (`OrderEditor.tsx`, `Counter.tsx` iterate `MODULES`). Fix any exhaustive `Record<ModuleId, …>` or `Record<IntegrationId, …>` maps that the typecheck flags.

- [ ] **Step 5: Commit** with message `feat(modules): Dynamic Reports add-on, reports.dashboard permission and dashboard_layouts table`.

---

### Task 5: Extract the report functions (refactor, no behaviour change)

**Files:**
- Modify:
  - `apps/server/src/sales-reports.ts`
  - `apps/server/src/order-analytics.ts`
  - `apps/server/src/operational-reports.ts`
- Test: the existing `sales-reports.test.ts`, `order-analytics.test.ts`, `operational-reports.test.ts`, `credit-note-reports.test.ts`, `zomato-reports.test.ts`, `combos.test.ts`, with no changes.

**Interfaces:**
- Consumes: `reportRange(query: unknown)` (already exported). Call it as `reportRange({ from, to })`.
- Produces:
  ```ts
  export type ReportRange = ReturnType<typeof reportRange>;
  export type SalesReport = /* the object currently returned as `report` */;
  export function salesReport(db: Database, range: ReportRange): SalesReport;                                   // sales-reports.ts
  export function orderAnalyticsReport(db: Database, range: ReportRange, orderType: AnalyticsOrderType): OrderAnalyticsReport; // order-analytics.ts
  export function operationalReport(db: Database, kind: OperationalReportKind, range: ReportRange): OperationalReport;       // operational-reports.ts
  ```
  Each function keeps its own `db.transaction(...)`. better-sqlite3 nests that as a savepoint, so Task 8 can wrap several calls in one snapshot. Each route handler becomes "parse, call, wrap in `{ report }`".

- [ ] **Step 1: Run the existing report tests to get a baseline**
  Run: `npx vitest run apps/server/src/sales-reports.test.ts apps/server/src/order-analytics.test.ts apps/server/src/operational-reports.test.ts apps/server/src/credit-note-reports.test.ts apps/server/src/zomato-reports.test.ts apps/server/src/combos.test.ts`
  Expected: PASS. Record the counts.

- [ ] **Step 2: Move each handler body into its function, unchanged**, and have the handler call it.

- [ ] **Step 3: Run the same tests again.** Expected: the same counts, all PASS. Then run `npx tsc --noEmit`, which should be clean.

- [ ] **Step 4: Commit** with message `refactor(server): report routes call exported report functions`.

---

### Task 6: Live refresh hook (UI refactor)

**Files:**
- Create: `apps/ui/src/live-refresh.ts`
- Modify: `apps/ui/src/useDashboard.ts:84-96`

**Interfaces:**
- Produces: `export function useLiveRefresh(refresh: () => void, options?: { events?: readonly string[]; debounceMs?: number; pollMs?: number }): void`. The defaults are `events: ["order.updated"]`, `debounceMs: 400`, `pollMs: 60000`. It refreshes on reconnect, not on the first connect, and calls `session.clear()` on auth failure, exactly as the current code does.

- [ ] **Step 1: Move the effect at `useDashboard.ts:84-96` into `useLiveRefresh`**, and call `useLiveRefresh(refresh)` from `useDashboard`.
- [ ] **Step 2: Check it**
  Run: `npm run typecheck -w @masalapos/ui && npx vitest run apps/ui`
  Expected: PASS.
- [ ] **Step 3: Commit** with message `refactor(ui): share the dashboard's live refresh`.

---

### Task 7: Layout routes

**Files:**
- Create:
  - `apps/server/src/dashboard.ts`
  - `apps/server/src/dashboard.test.ts`
- Modify: `apps/server/src/server.ts` (register next to the other report routes, around lines 133-154)

**Interfaces:**
- Consumes:
  - from Task 3: `DashboardLayout`, `defaultLayout`, `widgetDef`, `widgetVisible`, `compact`;
  - `userCan(req.user, slug)` and `permissionOverrides` from `apps/server/src/auth.ts:18-33`;
  - `moduleActive(db, id)` from `apps/server/src/modules.ts`.
- Produces:
  - `export function registerDashboard(app: FastifyInstance): void`;
  - `GET /api/dashboard/layout` → `{ layout: DashboardLayoutValue, isDefault: boolean }`;
  - `PUT /api/dashboard/layout` with body `{ layout }` → the same shape;
  - `DELETE /api/dashboard/layout` → the default.
  
  All of them send `Cache-Control: no-store`. A helper `visibleTo(app, req)` returns `(def) => widgetVisible(def, slug => userCan(...), id => moduleActive(app.db, id))`. Task 8 reuses it.
- Rules:
  - **GET** reads the stored row. Each stored item is parsed on its own with `DashboardItem.safeParse`; failures and unknown widgets are dropped. If the stored JSON doesn't parse at all, the result is `defaultLayout()` with `isDefault: true`. Hidden widgets are filtered out of the response.
  - **PUT** parses with `DashboardLayout`, and refuses any widget that isn't visible to the user with a 403. It merges back the stored items that are currently hidden, placed below the submitted ones, then runs `compact`, then upserts with `updated_at = Date.now()`.

- [ ] **Step 1: Write the failing tests** (set up as in `custom-reports.test.ts`: `freshApp`, `setupAdmin`, `createUser`, `enableIntegration(app, "dynamicReports")`):
  - `gives each person the default layout until they save their own`
  - `keeps one layout per person and resets to the default`: the admin saves; a cashier granted `reports.dashboard` via `PUT /api/users/:id/permissions` still sees the default; `DELETE` restores it.
  - `refuses a cashier without reports.dashboard, then lets them in once granted`: 403, then 200.
  - `refuses everything while Dynamic Reports is switched off`: without `enableIntegration` → 409 with code `module_off`. Also use `commercialApp("basic")` → 403.
  - `refuses a widget the person cannot see`: a cashier granted `reports.dashboard` but with `stock.read` overridden to false PUTs `lowStock` → 403.
  - `keeps hidden widgets when a layout is saved`: the admin saves a layout with `runningKots`; turn `kds` off; GET omits it; PUT another layout; turn `kds` on again; GET includes `runningKots` again.
  - `recovers from a stored layout it cannot read`: write `'{"version":1,"items":[{"key":"x","widget":"gone"}]}'` and then `'{}'` straight into `dashboard_layouts`. GET returns 200 both times, with an empty items list for the first and the default layout for the second.
  - `rejects overlapping items with 400`.

- [ ] **Step 2: Run them to make sure they fail**
  Run: `npx vitest run apps/server/src/dashboard.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement `dashboard.ts` and register it.**

- [ ] **Step 4: Run the tests again.** Expected: PASS.

- [ ] **Step 5: Commit** with message `feat(server): per-person dashboard layouts`.

---

### Task 8: Widget data

**Files:**
- Create:
  - `apps/server/src/dashboard-widgets.ts`
  - `apps/server/src/dashboard-widgets.test.ts`
- Modify: `apps/server/src/dashboard.ts` (add the data route)

**Interfaces:**
- Consumes:
  - from Task 5: `salesReport`, `orderAnalyticsReport`, `operationalReport`, `reportRange`;
  - from Task 1: `periodRange`, `compareRange`;
  - from Task 3: `DashboardDataRequest`, `WidgetValue`, `WidgetResult`, `DashboardData`, `widgetDef`;
  - from Task 7: `visibleTo`.
- Produces:
  - `export function computeWidgets(db: Database, requests: DashboardDataRequestValue["widgets"], visible: (def: WidgetDef) => boolean, now: number): DashboardData`;
  - `POST /api/dashboard/data` → `DashboardData`.
- Rules:
  - Run everything inside one `db.transaction`. Memoise report calls by `` `${source}|${from}|${to}|${orderType}` ``.
  - `today = localDateKey(now)`. The route passes `Date.now()`.
  - Status widgets get `range: null` and `compare: null`.
  - When `compare === "none"` or the widget has no compare option, `compareRange` and `compare` are null.
  - A widget that isn't visible, or that throws, gives `{ ok: false, error }`. Visibility gives "You no longer have access to this widget."; anything else gives "Could not load this widget".
- How each widget maps to its data:
  - **From `salesReport`:**
    - `netSales` = `netTotalPaise`
    - `billCount` = `sales.billCount`
    - `averageBill` = `billCount ? Math.round(sales.totalPaise / billCount) : 0`
    - `discounts` = `sales.discountPaise`
    - `gstCollected` = `cgstPaise + sgstPaise`
    - `creditNotes` = `creditNotePaise`
    - `outstanding` = `sales.outstandingPaise`
    - `cash/upi/cardCollected` = `collections.cash/upi/cardPaise`
    - `paymentMix` = a series of Cash, UPI, Card, and Zomato receivable (`zomatoReceivablePaise`)
  - **From `orderAnalyticsReport(range, orderType)`:**
    - `hourlySales` = 24 points labelled `"00"`…`"23"`
    - `dailyTrend` = `daily[].totalPaise`, labelled by date
    - `orderTypeSplit` = `comparison` points labelled Dine-in, Takeaway, Zomato
    - `topItems` = the first `topN` `items` as ranking rows `{ label: name, value: totalPaise, qty }`
    - `topCategories` = the same from `categories`
  - **`cancellations`** = `operationalReport("cancellations")`: `tables[0].totals.value`, format money.
  - **Status widgets** (read-only SQL):
    - `openTables`: count of distinct `table_id` on `orders` with `status='open' AND type='dine_in'`; detail is the table names (at most 5).
    - `runningKots`: `kots WHERE done_at IS NULL`.
    - `pendingQr`: `guest_requests WHERE status='pending' AND expires_at > now`.
    - `lowStock`: `stock_items WHERE is_active=1 AND low_stock_threshold IS NOT NULL AND qty <= low_stock_threshold`; detail is the names (at most 5).
    - `unsettledBills`: `bills WHERE status='unpaid'`, with the count and `amountPaise` = the sum of `total_paise`.

- [ ] **Step 1: Write the failing tests**, building bills as `custom-reports.test.ts` does (the `bill(day, hour, qty)` helper that rewrites `created_at`):
  - `matches the sales report for the same range`: for `netSales`, `billCount`, `discounts`, `creditNotes`, `paymentMix`, compare against `GET /api/reports/sales?from&to` for the resolved range. Include a voided bill, so its credit note subtracts on its own date.
  - `matches order analytics for hourly sales, top items and order-type split, with an order-type filter`.
  - `compares with the previous period and with last week`: bills on 2026-09-28 and 2026-09-21, with `vi.setSystemTime(new Date(2026, 8, 28, 15))`.
  - `resolves "today" at request time`: set the time to 23:59, request, move it to 00:01 the next day, request again. `today` and `range.from` both advance.
  - `averageBill with no bills is 0 and no value is NaN`: walk every number in the response and assert `Number.isFinite`.
  - `counts open tables, running KOTs, pending QR requests, low stock and unsettled bills`.
  - `answers one widget's failure without failing the rest`: a cashier without `stock.read` requests `lowStock` and `netSales`; `lowStock.ok === false` and `netSales.ok === true`.
  - `rejects more than 30 widgets with 400`.

- [ ] **Step 2: Run them to make sure they fail**
  Run: `npx vitest run apps/server/src/dashboard-widgets.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement `computeWidgets` and the route.**

- [ ] **Step 4: Run the server suite**
  Run: `npx vitest run apps/server`
  Expected: PASS.

- [ ] **Step 5: Commit** with message `feat(server): dashboard widget data in one snapshot`.

---

### Task 9: Grid component

**Files:**
- Create:
  - `apps/ui/src/dynamic-dashboard/DashboardGrid.tsx`
  - `apps/ui/src/dynamic-dashboard/grid-pointer.ts`
  - `apps/ui/src/dynamic-dashboard/grid-pointer.test.ts`
  - `apps/ui/src/dynamic-dashboard/dynamic-dashboard.css`

**Interfaces:**
- Consumes: from Task 2, `moveItem`, `resizeItem`, `stackOrder`, `GRID_COLUMNS`; from Task 3, `widgetDef`.
- Produces:
  ```ts
  // grid-pointer.ts (pure)
  export const ROW_HEIGHT_PX = 56; export const GAP_PX = 12;
  export function cellFromPointer(dx: number, dy: number, cellWidth: number, start: GridRect, mode: "move" | "resize"): { x: number; y: number } | GridSize;
  export function keyboardChange(key: string, shift: boolean, item: GridRect): { move?: { x: number; y: number }; size?: GridSize } | null; // Arrow keys move by 1; Shift+Arrow resizes by 1; anything else null
  // DashboardGrid.tsx
  export function DashboardGrid(props: {
    items: DashboardItemValue[]; editing: boolean; narrow: boolean;
    onChange(items: DashboardItemValue[]): void;
    renderItem(item: DashboardItemValue): ReactNode;
    renderTools(item: DashboardItemValue): ReactNode; // settings and remove buttons, shown only while editing
  }): JSX.Element;
  ```
- How it behaves:
  - It's a CSS grid with `grid-template-columns: repeat(12, 1fr)` and `grid-auto-rows: 56px`. Each item sets `grid-column: x+1 / span w` and `grid-row: y+1 / span h`.
  - While editing, a drag handle (the item header) and a bottom-right resize grip use pointer events with `setPointerCapture`, so mouse and touch both work. `touch-action: none` applies only to the handle and the grip.
  - A dashed placeholder shows the snapped target while the pointer is down. `onChange` fires on release, with the `moveItem`/`resizeItem` result.
  - Each item is focusable while editing (`tabIndex=0`, `aria-label` = "<title>, column x, row y, w by h") and handles `keyboardChange`.
  - When `narrow` is true, it renders a single column in `stackOrder` with no tools.

- [ ] **Step 1: Write the failing tests** for `grid-pointer.ts`:
  - `snaps a drag to the nearest cell`: a 100 px cell, start (2,1), dx 160, dy -70 → `{ x: 4, y: 0 }`.
  - `snaps a resize from the corner`.
  - `maps arrows to moves and shift-arrows to resizes`: `keyboardChange("ArrowLeft", true, {x:2,y:0,w:4,h:2})` → `{ size: { w: 3, h: 2 } }`; `keyboardChange("a", false, …)` → null.
  
  Plus `DashboardGrid` with `renderToStaticMarkup`: `places items by grid column and row, and stacks them on narrow screens`. Assert that `grid-column:1 / span 3` appears, and that the narrow markup lists items in reading order.

- [ ] **Step 2: Run them to make sure they fail**
  Run: `npx vitest run apps/ui/src/dynamic-dashboard`
  Expected: FAIL.

- [ ] **Step 3: Implement `grid-pointer.ts`, `DashboardGrid.tsx` and the grid CSS**, using the existing CSS variables from `styles.css`.

- [ ] **Step 4: Run the tests again.** Expected: PASS. Then run `npm run typecheck -w @masalapos/ui`.

- [ ] **Step 5: Commit** with message `feat(ui): drag-and-resize dashboard grid`.

---

### Task 10: Widget renderers

**Files:**
- Create:
  - `apps/ui/src/dynamic-dashboard/charts.tsx` (`LineChart`, `BarChart`)
  - `apps/ui/src/dynamic-dashboard/widgets.tsx` (`WidgetBody`)
  - `apps/ui/src/dynamic-dashboard/widgets.test.ts`
- Modify: `apps/ui/src/OrderAnalyticsCharts.tsx`, so that `OrderTrend`/`BusyHours` render through `LineChart`/`BarChart`. Keep their props, and keep the markup visibly equivalent.

**Interfaces:**
- Consumes: `WidgetResult`, `WidgetValue`, `percentChange` from Task 3; `paiseToRupees`.
- Produces:
  - `export function LineChart(props: { points: Array<{ label: string; value: number }>; format: ValueFormat; compare?: Array<{ label: string; value: number }> }): JSX.Element`
  - `export function BarChart(props: { points: …; format: ValueFormat; compare?: … }): JSX.Element`
  - `export function WidgetBody(props: { def: WidgetDef; result: WidgetResult | undefined; onRetry(): void }): JSX.Element`
  
  How `WidgetBody` renders:
  - **KPI**: a big number, plus a change chip "▲ 12.5% vs Previous period" (or "—" when `percentChange` is null).
  - **series**: `kind === "chart"` uses `LineChart` for `dailyTrend` and `BarChart` otherwise.
  - **ranking**: a list showing the value and the quantity.
  - **status**: the count, the amount if present, and the detail list.
  - **undefined**: a skeleton.
  - **`ok: false`**: the error plus a Retry button.

- [ ] **Step 1: Write the failing tests** (`renderToStaticMarkup`):
  - `shows a KPI with its change against the comparison`: 15000 vs 10000 paise → contains `150.00` and `50%`.
  - `shows a dash when the comparison is zero`
  - `shows an error with a retry button`
  - `draws one bar per point and scales to the largest value`
  - `formats negative money from credit notes`

- [ ] **Step 2: Run them to make sure they fail**
  Run: `npx vitest run apps/ui/src/dynamic-dashboard/widgets.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement.** Move the SVG drawing out of `OrderAnalyticsCharts.tsx` into `charts.tsx`, instead of writing new chart code.

- [ ] **Step 4: Run the tests and the UI build**
  Run: `npx vitest run apps/ui && npm run build -w @masalapos/ui`
  Expected: PASS.

- [ ] **Step 5: Commit** with message `feat(ui): dashboard widget renderers on shared SVG charts`.

---

### Task 11: Dynamic dashboard screen and the Home switch

**Files:**
- Create:
  - `apps/ui/src/dynamic-dashboard/useDashboardLayout.ts`
  - `apps/ui/src/dynamic-dashboard/useDashboardData.ts`
  - `apps/ui/src/dynamic-dashboard/WidgetCatalogue.tsx`
  - `apps/ui/src/dynamic-dashboard/WidgetSettings.tsx`
  - `apps/ui/src/dynamic-dashboard/DynamicDashboard.tsx`
  - `apps/ui/src/dynamic-dashboard/editing.ts`
  - `apps/ui/src/dynamic-dashboard/editing.test.ts`
- Modify: `apps/ui/src/screens/Home.tsx:50`

**Interfaces:**
- Consumes: Tasks 3, 6, 9 and 10; `apiFetch`, `useCan`, `useModules`.
- Produces:
  ```ts
  export function useDashboardLayout(): { layout: DashboardLayoutValue | null; isDefault: boolean; error: string; save(layout): Promise<void>; reset(): Promise<void> };
  export function useDashboardData(items: DashboardItemValue[]): { data: DashboardData | null; error: string; refresh(): void }; // POSTs only when there are items; keeps the last good results per key on failure; useLiveRefresh(refresh)
  // editing.ts (pure)
  export function addWidget(items: DashboardItemValue[], widget: DashboardWidgetId, key: string): DashboardItemValue[]; // default size and options, placed at y = bottom of the grid, then compact
  export function removeWidget(items, key): DashboardItemValue[];
  export function updateOptions(items, key, options: Partial<WidgetOptionsValue>): DashboardItemValue[];
  ```
- Screen behaviour:
  - **View mode:** each widget header shows its title, the period label, and the resolved range from `data.results[key].range` (e.g. "Today · 2 Nov"). The page footer says "Updated N min ago" (`updatedLabel` from `dashboard-view.ts`).
  - **Customise:** shown only when not narrow, i.e. `matchMedia("(min-width: 720px)")`. It copies the items into a draft and shows:
    - "+ Add widget": `WidgetCatalogue` lists the visible widgets, grouped by kind;
    - "Reset to default": confirms, then calls `reset()`;
    - "Cancel": discards the draft;
    - "Save": calls `save()`. On error the screen stays in edit mode and shows the message.
  - **New keys** come from `crypto.randomUUID()` when available, with a fallback of `Date.now().toString(36) + Math.random().toString(36).slice(2)` for older WebViews.
  - **`WidgetSettings`** shows only the options that `widgetDef(...).options` enables.
  - **Losing access:** if a layout call returns 403 or 409 (`module_off`, or the permission removed), the component calls `onUnavailable()`.
- Home change: `{financial && modules.isActive("dashboard") && (modules.isActive("dynamicReports") && can("reports.dashboard") && !unavailable ? <DynamicDashboard onUnavailable={() => setUnavailable(true)} /> : <SalesDashboard … />)}`.

- [ ] **Step 1: Write the failing tests** in `editing.test.ts`:
  - `adds a widget below the others with its default size and options`
  - `removes a widget and closes the gap`
  - `changes one widget's options and leaves the rest alone`

- [ ] **Step 2: Run them to make sure they fail**
  Run: `npx vitest run apps/ui/src/dynamic-dashboard/editing.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement the hooks, `editing.ts`, the catalogue and settings dialogs, `DynamicDashboard`, and the Home switch.**

- [ ] **Step 4: Run everything**
  Run: `npx vitest run && npm run typecheck && npm run build -w @masalapos/ui`
  Expected: all PASS.

- [ ] **Step 5: Commit** with message `feat(ui): customisable Home dashboard for Dynamic Reports`.

---

### Task 12: Operations doc and an end-to-end check

**Files:**
- Create: `docs/operations/dynamic-reports.md`. Cover what it is, how to enable it (portal allowance, then the Marketplace switch, then granting `reports.dashboard`), the widget list with each widget's permission and module, periods and comparisons, how the figures match the existing reports, and the narrow-screen behaviour. Follow the layout of `docs/operations/sales-dashboard.md`.

- [ ] **Step 1: Write the doc.**

- [ ] **Step 2: Manual check in the app**
  Run: `npm run dev`, then open the UI as admin.
  1. Marketplace: switch on Dynamic Reports. Home now shows the default layout.
  2. Customise: drag `paymentMix` to the top, resize `hourlySales` to full width, add `lowStock`, set `netSales` to This month vs Previous period, then Save. Reload and confirm the layout persisted.
  3. Settle a takeaway bill in a second tab. Tiles update within about 1 s.
  4. As a cashier: Home shows the fixed dashboard. Grant "Customise own dashboard" in their permissions. After a re-login, the cashier sees their own default layout.
  5. Narrow the window below 720 px. The widgets stack and Customise is hidden.
  6. Tablet touch drag: on the real tablet over the LAN (there's no emulator on this machine), check that dragging and resizing work and don't scroll the page.

- [ ] **Step 3: Commit** with message `docs(operations): Dynamic Reports`.
