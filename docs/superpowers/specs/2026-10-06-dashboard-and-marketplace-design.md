# Dashboard Redesign and Integrations Marketplace — Design

**Date:** 6 October 2026
**Status:** Approved in conversation; awaiting written-spec review

## 1. Goal

The admin/cashier Home dashboard looks and works like the Pet Pooja dashboard (reference: `Screenshots/Screenshot 2026-10-06 080023.png`), shows live Zomato and Swiggy orders in its Alerts panel, and an administrator can turn online-order integrations on or off from a new Marketplace page, with room for more integrations later.

Success means:

- Home shows a status strip, channel cards, a time-slot sales chart and a right-hand column (Alerts, Order Statistics, payment mix), using existing theme tokens in light and dark.
- The Alerts panel lists open aggregator orders tagged by channel. Zomato rows are real; Swiggy rows appear automatically once a Swiggy data source exists.
- A new Marketplace page lets an admin enable/disable each integration. Disabled integrations are hidden from navigation and from the dashboard; the cashier sees the page read-only.
- Adding a future integration is one registry entry plus its own screen and data source.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Dashboard scope | Home content only; the existing sidebar, the waiter/captain service view and the Pet Pooja promo/video banner and AI Agent button are out of scope |
| Channel cards | Total Sales, Dine In, Takeaway (this app's order types are `dine_in` and `parcel`) |
| Chart | Native SVG bars per four-hour slot, coloured by channel; no chart dependency |
| Alerts | Open aggregator orders plus operational alerts (e.g. unpaid bills), so the panel is useful with no aggregator data |
| Swiggy | No Swiggy code or data exists. The panel and registry are channel-agnostic and "Swiggy-ready"; Swiggy is `coming_soon` and cannot be enabled yet |
| "Enable" | An admin on/off switch stored locally in the database. No licence gating, no setup wizard; the existing Zomato screen keeps its own Connection tab |
| Storage | Static code registry plus a small `integration_state` table (approach A) |
| Enforcement | UI hides disabled integrations; the Zomato webhook refuses events when disabled; `/api/zomato/*` read routes stay available |
| Naming | `zomato_settings.enabled` already means "live webhook receiving on" (needs partner approval). It is unrelated to the Marketplace flag |
| Existing data | The app is not live, so there is nothing to migrate: all integrations start disabled |
| Out of scope | Sidebar redesign, promo banner, AI Agent, Swiggy ingestion, licence-gated add-ons, setup wizards, search/category filters on the Marketplace |

## 3. Data model and registry

### Registry (code) — `packages/domain/src/integrations.ts`

A typed list. Each entry has `id`, `name`, `description`, `category`, `status` (`available` | `coming_soon`) and the `Page` it sets up. Initial entries: Zomato (`available`, category delivery, sets up `zomato`) and Swiggy (`coming_soon`, category delivery).

### `integration_state` (migration 026)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | registry id |
| `enabled` | INTEGER NOT NULL | `CHECK (enabled IN (0,1))` |
| `updated_at` | INTEGER NOT NULL | epoch ms |
| `updated_by` | TEXT NOT NULL | FK `users(id)` |

No rows means disabled. The migration only creates the table.

## 4. API and permissions

New permissions in `packages/domain/src/roles.ts`: `integrations.read` (admin via `*`, cashier) and `integrations.configure` (admin only). The permission namespace list in the file's comment is updated.

| Route | Permission | Behaviour |
| --- | --- | --- |
| `GET /api/integrations` | `integrations.read` | Registry merged with state: `{ id, name, description, category, status, enabled, updatedAt }[]` |
| `PATCH /api/integrations/:id` | `integrations.configure` | Body `{ enabled: boolean }`. 404 unknown id; 409 when enabling a `coming_soon` integration; disabling is always allowed |

- Disabling never deletes data; Zomato orders, settlements and imports are untouched.
- Each change broadcasts `integrations.changed` through `app.broadcast`.
- `POST /api/integrations/zomato/webhook` returns 503 when Zomato is disabled in the Marketplace, in addition to its existing `settings.enabled` and adapter checks. Responses use `Cache-Control: no-store`, like the Zomato routes.

## 5. Frontend

### Shared state

`useIntegrations()` (provided once from `App.tsx` by context) loads `GET /api/integrations`, refetches on `integrations.changed` and on websocket reconnect. While loading or on error, integration-gated items are hidden; the Marketplace page stays reachable.

### Marketplace page — `screens/Marketplace.tsx`, `marketplace.css`

- Header and subtitle, then a responsive card grid.
- Each card: name, category tag, description, status pill (Enabled / Disabled / Coming soon).
- Admin sees a `role="switch"` toggle, disabled while its request is pending; a failed PATCH shows an alert and leaves the previous state. Coming-soon cards have the toggle disabled.
- Enabled cards show **Set up**, which navigates to the integration's page (Zomato → existing screen).
- Cashier sees the same cards read-only.

### Navigation and routes

- `Page` gains `{ name: "marketplace" }`; a nav item with a new icon, shown to admin and cashier (only admin can toggle; cashier is read-only).
- The Zomato nav item and route are shown only when Zomato is enabled. A deep link to a disabled Zomato page shows "Zomato is turned off" with a Marketplace link (admins only).

### Dashboard (`Home.tsx`, `SalesDashboard.tsx` and new components)

1. **Status strip:** "Updated … ago", single-day date picker (default today), refresh button.
2. **Channel cards:** Total Sales, Dine In, Takeaway — amount and order count, tinted icon. Data from the sales and `/api/reports/analytics` order-type comparison.
3. **Sales chart:** four-hour slots (six groups of bars), channel colours, legend, ₹ labels; hourly data from `/api/reports/analytics`; keyboard-focusable like the existing trend chart.
4. **Right column:**
   - **Alerts:** red count badge; rows of open aggregator orders (channel tag, order ID, status, amount, age, prepaid/COD) from `GET /api/zomato/orders` when Zomato is enabled; refreshed on `zomato.changed` and every 15 s while visible; row click opens the Zomato screen. Rows use a channel-agnostic type (`channel: "zomato" | "swiggy"`). Swiggy shows a "not connected" hint linking to the Marketplace (admin). With nothing enabled the panel says "Turn on Zomato or Swiggy in the Marketplace". Operational alerts (unpaid bills) follow the aggregator rows. A failed or forbidden Zomato call shows a hint inside the panel and never breaks the dashboard.
   - **Order Statistics:** successful, cancelled and in-progress counts; average table-turn time only if the data supports it, otherwise omitted.
   - **Payment mix:** the existing cash/UPI/card breakdown, moved from the main area.
5. Two columns on desktop, stacked on tablet and phone; existing spacing, font, border and theme tokens; no new dependencies.

The waiter/captain service view in `Home.tsx` is unchanged. The server is touched only if cancelled or in-progress order counts are missing from existing endpoints; that is checked in planning and flagged before any change.

## 6. Testing and verification

### Server (existing in-memory `*.test.ts` style)

- Migration 026 creates the table and nothing is enabled.
- List merges registry and state; admin can toggle; cashier gets 403 on PATCH but can GET; waiter and kitchen get 403 on GET; unknown id 404; enabling Swiggy 409; a change broadcasts `integrations.changed`; disabling Zomato leaves orders and settlements untouched.
- The Zomato webhook returns 503 when disabled in the Marketplace.

### Browser (`tools/e2e`)

- Update `sales-dashboard.js` selectors for the new layout.
- New Marketplace flow: enabling Zomato shows the nav entry and Alerts rows, disabling hides them; cashier is read-only; the Swiggy switch is disabled; a deep link to a disabled Zomato page shows the notice.
- Screenshots at 1280×720, 1920×1080, 768×1024 and 390×844, light and dark, under `output/`.

### Gates

Type-check, UI production build, targeted server tests and the e2e flows. The known `captain-https` failures in this folder are a pre-existing baseline issue and are reported separately.

## 7. Documentation and rollout

- New `docs/operations/marketplace.md`; `docs/operations/sales-dashboard.md` rewritten for the new Home layout.
- One additive migration, no new dependencies. Turning an integration off in the Marketplace is the rollback. No version bump.
- Nothing is committed until the user asks.

## 8. Build order

1. Registry, migration 026, API, permissions, webhook gate and tests.
2. `useIntegrations()`, Marketplace page, navigation and route gating.
3. Dashboard redesign and Alerts panel.
4. Docs and e2e updates.

## 9. Open items

None blocking. Delivery of Swiggy orders (import, webhook or manual) is a separate future spec; the registry entry flips from `coming_soon` to `available` when it ships.
