# Dashboard Redesign and Integrations Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the admin/cashier Home dashboard in the style of Pet Pooja, show Zomato/Swiggy orders in its Alerts panel, and add an admin Marketplace page that turns integrations on and off.

**Architecture:** A static integration registry in `packages/domain` plus an `integration_state` table (migration 026) behind `GET/PATCH /api/integrations`. The UI reads one `IntegrationsProvider` context that drives the nav, route guards and the dashboard Alerts. The dashboard is recomposed from small components fed by pure, unit-tested data helpers over endpoints that already exist (`/api/reports/analytics`, `/api/reports/day-end`, `/api/reports/sales`, `/api/orders`, `/api/zomato/orders`).

**Tech Stack:** TypeScript, Fastify + better-sqlite3, zod, React 19 + Vite, vitest, native SVG charts, existing CSS tokens.

**Spec:** `docs/superpowers/specs/2026-10-06-dashboard-and-marketplace-design.md`

## Global Constraints

- No new dependencies and no new chart library.
- Migration 026 only creates `integration_state`; no seeding; every integration starts disabled.
- Roles are code: add `integrations.read` to cashier; admin already has `*`. `integrations.configure` is admin-only (not listed for cashier).
- `GET /api/integrations` sends `Cache-Control: no-store`. A change broadcasts `integrations.changed` via `app.broadcast`, only when the stored value actually changes.
- Enabling a `coming_soon` integration returns 409; unknown id returns 404; disabling never deletes data.
- `POST /api/integrations/zomato/webhook` returns 503 when Zomato is disabled in the Marketplace (in addition to its existing checks). `/api/zomato/*` read routes stay available.
- Do not touch `zomato_settings.enabled` (it means live webhook receiving, unrelated to the Marketplace).
- The waiter/captain service view in `Home.tsx` is unchanged.
- Do not commit anything unless the user asks. Where a task would normally commit, run its verification step instead.
- Resolved spec ambiguity: the Marketplace nav item is shown to admin **and** cashier; only admin can toggle (cashier sees read-only cards). Spec §5 is updated to match.
- Use existing theme tokens (`--surface`, `--line`, `--muted`, `--pos-accent`, `--space-*`, `--radius-panel`); must work in light and dark.

## Review Focus

- A bill issued 00:00–00:59 belongs to the **last** slot (21:00–01:00), not the first; midnight must not be dropped or put in 01:00–05:00.
- A day with no activity (including a future or empty date): cards show ₹0 / 0 orders, the chart renders with a zero axis, no `NaN` or empty-array crash.
- A Zomato order with no items, `paymentMode: "unknown"`, or a truncated (500+) list still renders a sensible Alerts row and badge count.
- `PATCH /api/integrations/:id` with `{}`, `{ "enabled": "yes" }` or extra keys returns 400, and rapid double-clicks on a switch send one request (switch disabled while pending).
- An admin disables Zomato on another counter while a cashier is on the Zomato page: the page switches to the "turned off" notice on the websocket event, without a reload.

---

### Task 1: Registry, permissions and migration 026

**Files:**
- Create: `packages/domain/src/integrations.ts`
- Create: `packages/domain/src/migrations/026-integration-state.ts`
- Test: `packages/domain/src/migrations/026-integration-state.test.ts`, `packages/domain/src/integrations.test.ts`
- Modify: `packages/domain/src/migrations/index.ts`, `packages/domain/src/index.ts`, `packages/domain/package.json` (add `"./integrations": "./src/integrations.ts"` export so the UI can import it without pulling in SQLite), `packages/domain/src/roles.ts`

**Interfaces:**
- Produces (from `integrations.ts`):
  - `type IntegrationId = "zomato" | "swiggy"`; `type IntegrationStatus = "available" | "coming_soon"`
  - `interface IntegrationDef { id: IntegrationId; name: string; description: string; category: "delivery"; status: IntegrationStatus; setupPage: "zomato" | null }`
  - `const INTEGRATIONS: readonly IntegrationDef[]` — Zomato (`available`, `setupPage: "zomato"`) then Swiggy (`coming_soon`, `setupPage: null`)
  - `interface IntegrationInfo extends IntegrationDef { enabled: boolean; updatedAt: number | null }`
  - `const IntegrationToggle` (zod `z.object({ enabled: z.boolean() }).strict()`), `function isIntegrationId(id: string): id is IntegrationId`
- Produces: `migration026` (`version: 26`, name `"integration-state"`) creating `integration_state(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL REFERENCES users(id))`.

- [ ] **Step 1: Write the failing tests**
  - `026-integration-state.test.ts` (style of `024-table-transfers.test.ts`): `migrate(db, MIGRATIONS.filter(m => m.version < 26))`, then `migrate(db, MIGRATIONS)` twice; assert `SELECT COUNT(*) FROM integration_state` is `{ "COUNT(*)": 0 }`; inserting `enabled = 2` throws; inserting a row with an unknown `updated_by` throws (foreign keys).
  - `integrations.test.ts`: `INTEGRATIONS.map(i => i.id)` equals `["zomato", "swiggy"]`; Swiggy `status` is `"coming_soon"`; `isIntegrationId("zomato")` true, `isIntegrationId("dineout")` false; `IntegrationToggle.safeParse({})`, `({ enabled: "yes" })` and `({ enabled: true, x: 1 })` all fail, `({ enabled: false })` passes.
  - Add to `packages/domain/src/roles.test.ts` (create it if absent): `can(roleFor("cashier"), "integrations.read")` is true, `can(roleFor("cashier"), "integrations.configure")` false, admin true for both, waiter and kitchen false for `integrations.read`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run packages/domain/src -t "integration"`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the registry and migration per the Interfaces block; register `migration026` in `migrations/index.ts` (import line and `MIGRATIONS` array); export `INTEGRATIONS`, `IntegrationToggle`, `isIntegrationId` and the types from `src/index.ts`; add `"integrations.read"` to the cashier list in `roles.ts` and add `integrations` to the namespace list in the comment.
- [ ] **Step 4: Verify** — `npx vitest run packages/domain` passes; `npx tsc --noEmit` passes.

### Task 2: Integrations API and webhook gate

**Files:**
- Create: `apps/server/src/integrations.ts`
- Test: `apps/server/src/integrations.test.ts`
- Modify: `apps/server/src/server.ts` (import and call `registerIntegrations(app)` immediately before `registerZomato(app, opts.zomatoProvider)`), `apps/server/src/zomato.ts` (webhook gate), `apps/server/src/test-helpers.ts`, `apps/server/src/zomato.test.ts`

**Interfaces:**
- Consumes: `INTEGRATIONS`, `IntegrationInfo`, `IntegrationToggle`, `isIntegrationId` (Task 1).
- Produces: `registerIntegrations(app: FastifyInstance): void` and `integrationEnabled(db: Database, id: IntegrationId): boolean` (true only when a row exists with `enabled = 1`).
- Produces (test helper): `enableIntegration(app: FastifyInstance, id: IntegrationId): void` in `test-helpers.ts` — inserts/updates `integration_state` directly with the first admin user as `updated_by`.
- Routes: `GET /api/integrations` (`integrations.read`) → `{ integrations: IntegrationInfo[] }` in registry order; `PATCH /api/integrations/:id` (`integrations.configure`), body `IntegrationToggle` → `{ integration: IntegrationInfo }`.

- [ ] **Step 1: Write the failing tests** in `integrations.test.ts` using `freshApp`, `setupAdmin`, `createUser`, `auth` (pattern in `zomato.test.ts`):
  - `GET` as admin returns two entries, both `enabled: false`, `updatedAt: null`, with header `cache-control: no-store`; anonymous → 401; waiter and kitchen → 403; cashier → 200.
  - `PATCH zomato {enabled:true}` as admin → 200 with `enabled: true` and non-null `updatedAt`; a following `GET` shows it; as cashier → 403; unknown id `dineout` → 404; `swiggy {enabled:true}` → 409; bodies `{}`, `{enabled:"yes"}`, `{enabled:true,x:1}` → 400.
  - A websocket client authenticated with `wsAuth` receives `integrations.changed` after a real change, and receives nothing for a repeated identical `PATCH` (use the helper pattern from an existing ws test such as `orders.test.ts`).
  - Disabling Zomato after importing one order keeps its `zomato_orders` row (count unchanged).
  - Webhook: with a provider supplied and `zomato_settings.enabled = 1` but the Marketplace flag off, `POST /api/integrations/zomato/webhook` → 503; with the flag on, the request proceeds (reaches the provider).
- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/server/src/integrations.test.ts`. Expected: FAIL (404 routes).
- [ ] **Step 3: Implement** `registerIntegrations`: merge `INTEGRATIONS` with rows from `integration_state`; PATCH runs in a transaction, upserts with `updated_by = req.user.id`, and broadcasts `integrations.changed` (`{}`) only when the stored value changed; use `httpError` from `http-error.ts` for 404/409. In `zomato.ts` change the webhook guard so it returns 503 (`{ error: "Zomato is turned off in the Marketplace" }`) when `!integrationEnabled(app.db, "zomato")`, checked alongside the existing `!provider || !current.enabled` test.
- [ ] **Step 4: Repair existing Zomato tests** — run `npx vitest run apps/server/src/zomato.test.ts`; every test that posts a live webhook with a provider now gets 503, so call `enableIntegration(app, "zomato")` in those tests (or in the fixture when a provider is passed). The existing "503 when not configured" assertion must still pass.
- [ ] **Step 5: Verify** — `npx vitest run apps/server/src/integrations.test.ts apps/server/src/zomato.test.ts` and `npx tsc --noEmit` pass.

### Task 3: Integrations context, Marketplace page, navigation and route gating

**Files:**
- Create: `apps/ui/src/integrations-model.ts`, `apps/ui/src/integrations.tsx`, `apps/ui/src/screens/Marketplace.tsx`, `apps/ui/src/marketplace.css`
- Test: `apps/ui/src/integrations-model.test.ts`
- Modify: `apps/ui/src/NavBar.tsx` (`Page` union gains `{ name: "marketplace" }`; nav tab; Zomato tab gating), `apps/ui/src/Icon.tsx` (add `marketplace` icon path), `apps/ui/src/App.tsx` (provider, route, Zomato guard)

**Interfaces:**
- Consumes: `IntegrationInfo` from `@forkflow/domain/integrations`; `apiFetch`, `connectWs`.
- Produces (`integrations-model.ts`, pure): `isEnabled(list: IntegrationInfo[], id: IntegrationId): boolean`; `statusLabel(info: IntegrationInfo): "Enabled" | "Disabled" | "Coming soon"`; `canToggle(info: IntegrationInfo, role: User["role"]): boolean` (admin only, and only when `status === "available"`).
- Produces (`integrations.tsx`): `IntegrationsProvider({ user, children })` and `useIntegrations(): { integrations: IntegrationInfo[]; ready: boolean; isEnabled(id: IntegrationId): boolean; setEnabled(id: IntegrationId, enabled: boolean): Promise<void>; refresh(): void }`. The provider fetches `/api/integrations` only for admin/cashier (other roles: empty list, `ready: true`); refetches on the `integrations.changed` event and on websocket reconnect; while loading or on error `isEnabled` is false.
- Produces: `Marketplace({ user }: { user: User })` screen; `IntegrationOff({ name, canManage, onOpenMarketplace })` notice component exported from `Marketplace.tsx`.

- [ ] **Step 1: Write the failing tests** in `integrations-model.test.ts`: `isEnabled` true only for an enabled entry, false for a missing id or empty list; `statusLabel` returns "Coming soon" for Swiggy even if `enabled` were true, else "Enabled"/"Disabled"; `canToggle` is true for admin + available, false for cashier, false for admin + coming soon.
- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/ui/src/integrations-model.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the model and provider.** `setEnabled` sends `PATCH /api/integrations/:id`, replaces that entry from the response, and rejects with the server message on failure so the page can show it.
- [ ] **Step 4: Implement `Marketplace.tsx`** per spec §5: header and subtitle; responsive card grid; each card shows name, category tag, description and status pill; admin sees a `role="switch"` with `aria-checked`, disabled while its request is pending (one request per click) and for coming-soon cards; a failed PATCH shows `role="alert"` text and leaves the previous state; enabled cards show a **Set up** button that calls `onNavigate` for the `setupPage`; cashier sees the same cards without a usable switch. Style in `marketplace.css` with existing tokens; one column under 640px.
- [ ] **Step 5: Wire navigation.** Add the `marketplace` nav tab for admin and cashier (label "marketplace", icon `marketplace`); show the `zomato` tab only when `useIntegrations().isEnabled("zomato")`; in `App.tsx` wrap the `in` branch content in `IntegrationsProvider`, add `{page.name === "marketplace" && (admin || cashier) && <Marketplace .../>}`, and replace the Zomato route with: while `!ready` show a status line; if disabled render `IntegrationOff` (Marketplace link only for admin); otherwise the existing lazy `Zomato`. Add `marketplace` to `activeTab` handling if needed (it equals its own name).
- [ ] **Step 6: Verify** — `npx vitest run apps/ui/src/integrations-model.test.ts`; `npm run typecheck`; `npm run build -w @forkflow/ui`. Then run the dev stack (`npm run dev`), log in as admin and confirm: Marketplace lists Zomato and Swiggy, the Zomato nav item is absent until the toggle is on, Swiggy's switch is disabled, and a second browser tab updates live when toggled.

### Task 4: Dashboard data helpers

**Files:**
- Create: `apps/ui/src/dashboard-data.ts`
- Test: `apps/ui/src/dashboard-data.test.ts`

**Interfaces:**
- Consumes: `OrderTypeAnalytics`, `AnalyticsHour` from `@forkflow/domain/operational-reports`; `ZomatoOrder` from `@forkflow/domain/zomato`; `Order` from `./types`.
- Produces:
  - `const SLOTS: readonly { label: string }[]` — six labels `"01:00am - 05:00am"`, `"05:00am - 09:00am"`, `"09:00am - 01:00pm"`, `"01:00pm - 05:00pm"`, `"05:00pm - 09:00pm"`, `"09:00pm - 01:00am"`.
  - `slotIndex(hour: number): number` — `Math.floor(((hour + 23) % 24) / 4)`.
  - `interface SlotBar { label: string; dineInPaise: number; takeawayPaise: number; totalPaise: number }`; `slotBars(dineIn: AnalyticsHour[], takeaway: AnalyticsHour[]): SlotBar[]` (always six entries).
  - `interface ChannelCard { amountPaise: number; orderCount: number }`; `channelCards(comparison: OrderTypeAnalytics[]): { total: ChannelCard; dineIn: ChannelCard; takeaway: ChannelCard }`.
  - `orderStats(input: { billCount: number; cancelledCount: number; orders: Pick<Order, "status">[] }): { successful: number; cancelled: number; inProgress: number; awaitingPayment: number }` — `inProgress` counts `open`, `awaitingPayment` counts `billed`.
  - `type AlertRow = { channel: "zomato" | "swiggy"; orderId: string; status: string; amountPaise: number; placedAt: number; paymentMode: "prepaid" | "cod" | "unknown" }`; `aggregatorAlerts(zomato: ZomatoOrder[]): AlertRow[]` (oldest first); `ageLabel(placedAt: number, now: number): string` ("just now", "12m", "2h 5m", "1d").

- [ ] **Step 1: Write the failing tests:**
  - `slotIndex(0) === 5`, `slotIndex(1) === 0`, `slotIndex(4) === 0`, `slotIndex(5) === 1`, `slotIndex(12) === 2`, `slotIndex(21) === 5`, `slotIndex(23) === 5`.
  - `slotBars` over a 24-entry hourly array puts hour 0 and hour 21–23 in the last bar and sums per channel; with two all-zero arrays returns six bars with every value `0`.
  - `channelCards` totals are the sum of both types; an empty comparison gives zeros.
  - `orderStats` counts `open`/`billed` correctly and passes `billCount`/`cancelledCount` through.
  - `aggregatorAlerts` maps `{restaurantId, orderId, placedAt, status, totalPaise, paymentMode, items: []}` to rows with `channel: "zomato"`, sorts oldest first, and keeps an order with empty `items` and `paymentMode: "unknown"`.
  - `ageLabel(now - 30_000, now) === "just now"`, `(now - 12 * 60_000) === "12m"`, `(now - 125 * 60_000) === "2h 5m"`, `(now - 26 * 3_600_000) === "1d"`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/ui/src/dashboard-data.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions per the Interfaces block (pure; no React, no `fetch`).
- [ ] **Step 4: Verify** — `npx vitest run apps/ui/src/dashboard-data.test.ts` passes; `npm run typecheck`.

### Task 5: Dashboard UI

**Files:**
- Create: `apps/ui/src/useDashboard.ts`, `apps/ui/src/useAggregatorOrders.ts`, `apps/ui/src/DashboardStrip.tsx`, `apps/ui/src/ChannelCards.tsx`, `apps/ui/src/SlotChart.tsx`, `apps/ui/src/AlertsPanel.tsx`, `apps/ui/src/OrderStatistics.tsx`, `apps/ui/src/dashboard.css`
- Modify: `apps/ui/src/SalesDashboard.tsx` (recompose), `apps/ui/src/screens/Home.tsx` (pass `onNavigate` through; keep the header actions and the non-financial view unchanged), `apps/ui/src/sales-dashboard.css` (remove rules made obsolete by the recomposition)

**Interfaces:**
- Consumes: Task 4 helpers; `useIntegrations()` (Task 3); `PaymentBreakdown` from `SalesCharts.tsx`; `apiFetch`, `connectWs`, `localDay`, `reportMoney`.
- Produces:
  - `useDashboard(date: string): { analytics: { dineIn: OrderAnalyticsReport; takeaway: OrderAnalyticsReport } | null; dayEnd: { sales: { billCount: number }; cancellations: { orderCount: number } } | null; sales: SalesReport | null; orders: Order[]; error: string; loading: boolean; updatedAt: number | null; refresh(): void }` — one refresh fetches `/api/reports/analytics?from=D&to=D&type=dine_in`, the same with `type=parcel`, `/api/reports/day-end?date=D`, `/api/reports/sales?from=D&to=D`, `/api/orders`; guards against out-of-order responses like `useSalesReport`; refreshes on `order.updated` (400 ms debounce), on websocket reconnect, and every 60 s.
  - `useAggregatorOrders(enabled: boolean): { rows: AlertRow[]; truncated: boolean; error: string }` — when enabled, loads `GET /api/zomato/orders`, refreshes on `zomato.changed` and every 15 s while `document.visibilityState === "visible"`; when disabled returns no rows and makes no request.
  - Components: `DashboardStrip({ date, today, updatedAt, loading, onDate, onRefresh })`; `ChannelCards({ cards })`; `SlotChart({ bars })`; `OrderStatistics({ stats })`; `AlertsPanel({ rows, operational, zomatoEnabled, canManage, error, onOpenZomato, onOpenMarketplace })`.

- [ ] **Step 1: Hooks.** Implement both hooks per the Interfaces block. Failures set `error` and keep the dashboard rendering; the aggregator error never blocks the sales side.
- [ ] **Step 2: Components and layout** per spec §5: status strip ("Updated N min ago" refreshing each minute, single-day `<input type="date" max={today}>`, refresh button); three channel cards with tinted icon, ₹ amount and "N Orders"; `SlotChart` as native SVG with six slot groups, dine-in and takeaway bars in `--pos-accent` and a second token colour, ₹ labels above non-zero bars, a legend, a zero baseline, and an `aria-label`/`<desc>` that lists exact values; right column with `AlertsPanel` (red count badge; rows show channel tag, order ID, status, amount, `ageLabel`, prepaid/COD; row click calls `onOpenZomato`; Swiggy "not connected" line with a Marketplace link for admins; "Turn on Zomato or Swiggy in the Marketplace" when none enabled; operational alert "N billed orders awaiting payment" from `orderStats`), `OrderStatistics`, and the existing `PaymentBreakdown`. Two columns above 1100px, stacked below; styles in `dashboard.css`.
- [ ] **Step 3: Recompose** `SalesDashboard.tsx` (props: `onNavigate`, `canManage`) using the hooks and components; date state defaults to `localDay()`; Home passes `user.role === "admin"` as `canManage`.
- [ ] **Step 4: Verify** — `npm run typecheck`, `npm run build -w @forkflow/ui`, `npx vitest run apps/ui`. Then `npm run dev`, load the dashboard as admin and cashier: with seeded bills the cards and chart match `GET /api/reports/analytics` values; empty day shows zeros with no console errors; enable Zomato in the Marketplace, import a Zomato order via the Zomato screen, and confirm the Alerts row appears and the badge counts it; switch light/dark; check 1280×720, 768×1024 and 390×844 for no horizontal page overflow.

### Task 6: End-to-end checks and documentation

**Files:**
- Modify: `tools/e2e/sales-dashboard.js`, `tools/e2e/sales-dashboard-server.mts` (only if the fixture lacks bills in more than one slot/channel or a Zomato order), `docs/operations/sales-dashboard.md`, `tools/e2e/README.md`
- Create: `tools/e2e/marketplace.js`, `docs/operations/marketplace.md`
- Modify: `docs/superpowers/specs/2026-10-06-dashboard-and-marketplace-design.md` (§5: the Marketplace nav item is shown to admin and cashier; only admin toggles)

- [ ] **Step 1: Update `sales-dashboard.js`** — replace the checks tied to the old layout (`.sales-metrics-overview`, three metric cards above two graphs, `.sales-chart` trend) with checks for the new one: the status strip date input defaults to today; the three channel cards reconcile with `/api/reports/analytics?from=today&to=today`; the slot chart `<desc>` lists the same totals; the payment breakdown still reconciles with `/api/reports/sales`; the workspace fits 1280×720 without vertical scroll; keyboard behaviour that still exists is kept. The Reports-page checks stay unchanged.
- [ ] **Step 2: Add `marketplace.js`** following the same agent-browser `eval --stdin` style against the disposable fixture, asserting the Marketplace flow from Global Constraints and the Review Focus: toggle Zomato on shows the nav item and the Alerts "Zomato" state; toggle off hides both; the Swiggy switch is disabled; a cashier session sees no enabled switch; with Zomato disabled a hash/route to the Zomato screen shows "Zomato is turned off"; a rapid double-click produces one `PATCH` (count via a wrapped `fetch`).
- [ ] **Step 3: Run the e2e flows** as described in `tools/e2e/README.md` for the sales-dashboard fixture; capture screenshots at 1280×720, 1920×1080, 768×1024 and 390×844 in light and dark under `output/dashboard-marketplace/` (this folder is intentionally untracked).
- [ ] **Step 4: Docs.** Rewrite `docs/operations/sales-dashboard.md` for the new Home layout (status strip, channel cards, slot chart, Alerts, Order Statistics, payment mix; keep the "what the figures mean" definitions that still apply; update the file/line audit table and verification notes). Write `docs/operations/marketplace.md`: what the Marketplace does, who can change it, what enabling hides or shows, Zomato's webhook gate, why Swiggy is "coming soon", and how to add an integration (one registry entry, its screen, its data source). Edit spec §5 as noted above.
- [ ] **Step 5: Final gates** — `npm run typecheck`, `npx vitest run` (report the known `captain-https` failures in this folder separately as pre-existing), `npm run build -w @forkflow/ui`, and the e2e flows from Step 3 all pass. Do not commit; summarise the changed files for the user.
