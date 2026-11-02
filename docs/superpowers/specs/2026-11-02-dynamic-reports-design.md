# Dynamic Reports Add-on — Design

**Date:** 2 November 2026
**Status:** Approved in conversation; awaiting written-spec review


## Context

MasalaPOS's Home screen shows a **fixed** sales dashboard (`dashboard` module, `apps/ui/src/SalesDashboard.tsx`, fed by `useDashboard.ts`). Owners can't choose what they see. Dynamic Reports is a new paid add-on that turns Home into a **customizable live overview**. Each person drags, resizes, adds and removes widgets (KPI tiles, charts, live service status), and each widget has its own time period and comparison.

**Decisions made with the user (2026-11-02)**
- Purpose: an owner's live overview. Not a report builder, and not remote viewing.
- A new licence module `dynamicReports` in the `addon` group. When it's active, Home shows the customizable dashboard; otherwise the current fixed dashboard stays.
- One layout per person, starting from a default layout. Only people with the new `reports.dashboard` permission get the customizable dashboard (see §2a).
- Widgets in v1: KPI tiles, built-in charts, live service status. Saved custom reports are **not** widgets.
- Free 2D drag and resize on a 12-column grid, **built in-house** with no new UI dependency.
- The period is chosen per widget, together with its comparison.

**Assumptions (accepted with the design)**
- The licence allows `dynamicReports` on Pro by default and not on Basic; the portal can allow it per order or counter like other modules. As with every add-on, it stays off until an admin switches it on in the Marketplace.
- Cashiers see the fixed default dashboard unless an admin grants them "Customise own dashboard" (`reports.dashboard`) in their per-person permissions (Users → permissions). Decided by the user on 2026-11-02.
- Screens narrower than 720px (phones and tablets on LAN browsers) show the widgets read-only in one column; editing happens on wider screens.

## Architecture

### 1. Domain (`packages/domain/src/dashboard/`, pure, unit-tested)
- `widgets.ts`: the `DASHBOARD_WIDGETS` catalogue. Each entry has `id`, `title`, `kind` (`kpi` | `chart` | `status`), `defaultSize`/`minSize`, `requires: {permissions[], modules[]}`, and `options` (does it take a period, a comparison, an order type, top N).
  - **KPI**: net sales, bills, average bill, discounts, GST, credit notes/refunds, outstanding, cash/UPI/card collected, cancellations.
  - **Charts**: hourly sales, daily trend, payment mix, order-type split, top items, top categories.
  - **Status** (no period): open tables, running KOTs, pending QR requests (`qrOrdering`), low stock (`inventory` + `stock.read`), unsettled bills.
- `layout.ts`: zod `DashboardLayout = {version: 1, items: [{key, widget, x, y, w, h, options}]}` with limits (at most 30 items, 12 columns, sizes within the widget's min/max), plus a `defaultLayout()` that mirrors today's fixed dashboard.
- `periods.ts`: presets `today | yesterday | thisWeek | thisMonth | last7 | last30` → `{from, to}` local date keys (reusing `localDateKey` from `dates.ts`), and comparisons `none | previous` (the previous period of the same length; month-to-date compares with the same number of days last month) `| lastWeek` (shifted 7 days).
- `grid.ts`: `collides`, `moveItem`, `resizeItem`, `compact` (vertical gravity), `clampToGrid`, `stackOrder` (the order for narrow screens). The UI grid only renders what these return.

### 2. Licence module
- Add `dynamicReports` to `MODULE_IDS` and `MODULES` in `packages/domain/src/modules.ts`: group `addon`, `dependsOn: ["reports", "dashboard"]`, plans `{basic: false, pro: true}`.
- Add a Marketplace card in `packages/domain/src/integrations.ts`.
- The portal's order editor and the counter module table read `MODULES`, so they pick it up automatically. Verify `apps/portal/src/screens/OrderEditor.tsx` and `Counter.tsx`. The licensing worker must be redeployed so it signs the new key.
- Update the module table in `docs/operations/feature-controls.md`.

### 2a. Permission
- New slug `reports.dashboard`, labelled "Customise own dashboard", added to the Reports area of `PERMISSION_AREAS` in `packages/domain/src/staff-permissions.ts`. It then shows up automatically in the per-person permissions screen (`apps/ui/src/screens/StaffPermissions.tsx`, served by `apps/server/src/users.ts`).
- Roles (`packages/domain/src/roles.ts`): admin has it through `*`; cashier, waiter and kitchen do **not**. Admins grant it to a single person with the existing per-person overrides (`user_permissions`), which are cleared when the person's role changes, as they are today.
- The UI checks it with `useCan("reports.dashboard")`; the server checks it with `requirePermission`.

### 3. Database: migration 44 (`packages/domain/src/migrations/`, registered in `index.ts`)
```sql
CREATE TABLE dashboard_layouts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  layout_json TEXT NOT NULL CHECK (json_valid(layout_json)),
  updated_at INTEGER NOT NULL
);
```
A user with no row gets `defaultLayout()`.

### 4. Server (`apps/server/src/dashboard.ts`, registered in `server.ts`)
Every route needs `requirePermission("reports.read")`, `requirePermission("reports.dashboard")` and `requireModule(app, "dynamicReports")`.
- `GET /api/dashboard/layout`: the user's saved layout or the default, with widgets the user can't currently see filtered out (their position is kept in storage).
- `PUT /api/dashboard/layout`: validate with zod and `compact`, refuse widgets the user isn't allowed, upsert.
- `DELETE /api/dashboard/layout`: reset to the default.
- `POST /api/dashboard/data`: body `{widgets: [{key, widget, options}]}`, response `{results: {[key]: {current, compare?} | {error}}, generatedAt, timezone}`.
  - Everything runs in one `db.transaction` snapshot, like the existing reports.
  - Identical (source, range, order type) computations are done once per request.
  - Permission and module checks run per widget, and a failure becomes an error for that key only.
- **Reuse, not copy.** Pull the SQL out of the existing route handlers into exported functions, and have both the old routes and the widgets call them:
  - `salesSummary(db, range)` from `sales-reports.ts` (it already exports `reportRange`);
  - `orderAnalytics(db, range, type)` from `order-analytics.ts`;
  - `dayEndReport` is already exported from `reports.ts`;
  - status counts from the queries the current Home already uses (`/api/orders`, guest requests, stock).
  
  The existing endpoint tests guard against behaviour changes.

### 5. UI (`apps/ui/src/dynamic-dashboard/`)
- `DynamicDashboard.tsx`:
  - **View mode** shows the grid. Each widget shows its period and comparison chip, plus "updated N min ago" (`useNow`).
  - **Customise** turns on edit mode: drag handle, corner resize grip, ⚙ settings, ✕ remove, "+ Add widget", "Reset to default", then Save or Cancel.
- `DashboardGrid.tsx`: a CSS grid with each item placed by `grid-column`/`grid-row`.
  - Pointer events handle mouse and touch, showing a snapped placeholder while dragging and calling `domain/dashboard/grid.ts` on every move.
  - Keyboard: arrow keys move a widget, Shift+arrow resizes it.
  - Below 720px it becomes a read-only column in `stackOrder`.
- `WidgetCatalogue.tsx` (the add dialog, listing only widgets the user can see) and `WidgetSettings.tsx` (period, comparison, order type, top N).
- Renderers `KpiTile`, `LineChart`, `BarChart`, `RankList`, `StatusTile`. Build them by extracting generic SVG pieces from `OrderAnalyticsCharts.tsx`, `SlotChart.tsx` and `SalesCharts.tsx` rather than writing new chart code. Styles go in `dynamic-dashboard.css`, using the existing CSS variables.
- `useDashboardLayout()` and `useDashboardData(items)`:
  - one POST per refresh;
  - keep the last good values when a refresh fails, as `useDashboard` does;
  - live refresh on `order.updated` with a 400 ms debounce, a 60 s poll, and a refresh on reconnect (copy the pattern at `useDashboard.ts:84-96`);
  - reload the catalogue on `modules.changed`.
- `screens/Home.tsx`: when `isActive("dynamicReports")` and the user can both `reports.read` and `reports.dashboard`, render `<DynamicDashboard>`; otherwise keep today's `<SalesDashboard>`, the fixed default dashboard.

### Error handling
- A widget whose data fails shows an inline "Couldn't load" with a retry. The other widgets are unaffected.
- A widget whose module or permission has gone away disappears from view but stays in the saved layout, so it comes back if access returns.
- A layout save that fails keeps edit mode open with the error shown.
- If the module is switched off, the server returns 403 `module_off` and Home falls back to `SalesDashboard`. If `reports.dashboard` is taken away, the server returns 403 and Home falls back the same way; the saved layout is kept for when it is granted again.

## Delivery
1. Branch `feat/dynamic-reports` from the current `fix/audit-bugs` tip, which holds the report refactors, and rebase once PR #8 merges.
2. This spec is reviewed, then **writing-plans** produces the task-by-task implementation plan, built test-first.
3. Rough build order:
   1. domain (periods, grid, layout, catalogue) with tests;
   2. module, migration and docs;
   3. extract the server report functions, with the existing tests still green;
   4. dashboard routes, with tests;
   5. UI grid;
   6. widgets and Home switch;
   7. operations doc `docs/operations/dynamic-reports.md`.

## Verification
- **Domain unit tests:** grid collisions, compaction and bounds; period edges (month end, week start, leap day, `lastWeek`); layout schema limits; the default layout is valid.
- **Server tests** (existing vitest patterns):
  - layouts are kept separate per user and reset works;
  - disallowed widgets are refused on PUT and dropped from GET;
  - a cashier without `reports.dashboard` gets 403 on every dashboard route, and gets through once a per-person override grants it;
  - `/api/dashboard/data` figures equal `/api/reports/sales` and `/api/reports/analytics` for the same range, including credit notes subtracting on their own date;
  - one failing widget doesn't fail the others;
  - the module switched off gives 403 `module_off`.
- **Whole repo:** the full vitest suite, root `tsc` typecheck, and `apps/ui` `vite build`.
- **Manual:**
  - run the server and Electron app in licensing-dev mode, where every module is allowed;
  - turn on Dynamic Reports in the Marketplace;
  - drag, resize, add, remove, save and reset;
  - settle a bill and watch the tiles update within about 1 s;
  - check a narrow browser window;
  - test touch drag on the **real tablet** (there's no emulator on this machine).
