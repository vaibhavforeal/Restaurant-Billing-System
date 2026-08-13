# AI Restaurant Billing System — Architecture & Product Plan

> Working name: **ForkFlow** (placeholder — rename freely)
> A next-generation, AI-native restaurant POS & billing platform. **We are not cloning PetPooja — we are making a product that is easier to adopt and smarter to run.** PetPooja's feature list is our floor, not our finish line. An offline-first hybrid SQLite + PostgreSQL data architecture and an AI co-pilot are the moat.

**Status:** Phase 0 (foundations) built — see [`README.md`](./README.md). Phase 1 next.
**Date:** 2026-07-09 · plan · updated 2026-08-04
**Decisions locked:** Deliverable = plan · First module = Billing/POS core · Stack = Next.js + PostgreSQL · Data = Hybrid SQLite (local) + PostgreSQL (cloud) · Sync transport = pluggable interface, engine choice deferred (§12.2)

---

## 1. Positioning & Vision

**Core principle: don't replicate — simplify and out-think.** PetPooja is feature-complete but (a) **hard to adopt and run** and (b) **reactive**. Those two weaknesses are our entire attack surface. We match the essentials so no one has to give anything up to switch, then win on **ease** and **intelligence** — not on having more features. More features is how you *become* PetPooja; that's the trap we avoid.

**One-line pitch:** *"The restaurant POS you set up yourself before lunch — offline-first billing with an AI co-pilot that reorders stock, prices your menu, and tells you the one thing to fix today."*

### 1.1 Where PetPooja is hard → where we're easier (the adoption wedge)

| PetPooja pain | Our fix |
|---|---|
| **Menu/recipe setup requires their team** (stated on their own site) → days of dependency before you can bill | **Zero-touch AI onboarding** — photo/PDF of an existing menu (or old-POS export) → AI auto-builds categories, items, variations, prices **and** recipe/ingredient mapping in minutes, fully self-serve. *Time-to-first-bill < 15 min.* **This is the #1 reason to switch.** |
| **Everything is a separate paid add-on** (Captain, KDS, loyalty, SMS, feedback, kiosk…) → a marketplace maze you assemble and pay for piecemeal | **All-in-one, one price.** Captain app, KDS, loyalty, kiosk, reports built in. No add-on shopping. |
| **100+ reports, dozens of screens, shortcodes to memorize** → analysis paralysis + learning curve | **A "Today" home screen:** one plain-English briefing + one recommended action. Progressive disclosure — surface the 5 things that matter, hide the rest. |
| **Configuration-heavy** — manual reorder points, manual menu toggling, manual campaigns, manual reconciliation review | **Conversation over configuration** — "reorder what's low," "show slow items," "why were Tuesdays down." NL replaces menu-diving. Smart per-outlet-type defaults. |
| **Reactive** — records what happened, leaves you to act | **Predictive** — forecast → auto-drafted PO, churn → auto-drafted win-back, margin-aware pricing. AI proposes, human approves. |

### 1.2 Design principles (guardrails so we stay "easy")
1. **Fewer things to learn, more things done for you.** Every feature must earn its place; anti-bloat by default.
2. **Self-serve or it doesn't ship.** No feature may require a vendor rep to configure.
3. **Propose, don't just report.** A screen that shows a problem must also offer the action.
4. **Offline-first, cheap-hardware-first.** Works with no internet on the devices restaurants already own (§5).
5. **Smart defaults > settings.** Configuration is a fallback, not the front door.

### 1.3 Defensible bets
1. **Offline-first hybrid SQLite + Postgres** as a first-class architecture, not a fallback (§5).
2. **AI as a co-pilot that acts** — forecasting, dynamic pricing, fraud detection, NL reporting that produce actions, not chat.
3. **Onboarding as the moat** — the AI menu/recipe ingestion is the hardest thing for an incumbent to retrofit and the easiest thing for a new customer to fall in love with.

---

## 2. Table-Stakes Map (essentials to make effortless)

Everything PetPooja ships, grouped. **This is the floor we match so switching costs nothing — not the source of our advantage.** For each area, the goal is *parity with less friction*, per the principles in §1.2. (Where we go beyond, see the AI layer in §3.)

### 2.1 Billing / POS Core
- 3-click billing; keyboard + touchscreen modes; item shortcodes
- KOT generation & **station-wise KOT printing** (assign printer per cooking station)
- Table & area management; per-area menus and tax rates; seating layouts
- Split / merge bills; hold/recall orders
- Discounts, coupons, service types (dine-in / takeaway / delivery)
- Configurable taxes (GST), per-area tax rates
- Multi-terminal billing synced to a master station
- Customizable bill format (logo, break-ups, edit customer details)
- Dynamic QR pay at counter; UPI/wallet/contactless card; e-bill (print/SMS/save)
- **Offline mode** (cloud-based but works with no internet)
- Multi-language (15+ Indian + international)

### 2.2 Inventory
- Recipe-based **auto stock deduction** (multi-stage recipes)
- Low-stock alerts; menu availability tied to stock
- Purchase Order management (raise/accept POs to suppliers & central kitchen)
- **Central Kitchen** module (supply/request stock across outlets, returns of damaged stock)
- Vendor/supplier management; frequently-ordered tracking
- Inter-outlet stock transfer; delivery routes
- e-way bill generation → GST portal upload
- Raw-material catalogue; wastage tracking; day-end inventory reports

### 2.3 Menu
- Categories, variations, add-ons with per-customization pricing
- Combos & offers; shortcodes
- Multiple menus (per dine-in area)
- One-click full-menu update
- Aggregator menu management/sync (all delivery platforms)
- Item ON/OFF toggle from billing screen (stock-driven)
- Time-based availability (open/close windows per item)
- Dynamic pricing control across physical + online menus

### 2.4 Online Order Management
- Aggregator integration: Swiggy, Zomato, Dineout, Talabat
- Accept all orders from **one screen** (no app switching)
- Online menu control: store timing, packaging charges, discounts, price sync across aggregators
- Mark food ready; collect payment; check revenue
- **Order reconciliation** — platform-wise reconciled reports (commission, surplus charges, margins, taxes) vs. aggregator payout sheets
- Rider/dispatch management (Duzno, Shadowfax, Pidge); own Razorpay gateway for website orders

### 2.5 CRM
- Unified customer data pool (online + captain + website + in-house)
- Loyalty/reward points (assigned at billing) + Loyalty Wallet
- Customer labels/segments (100+ types); group/corporate discounts
- Purchase-history insights & special notes
- SMS marketing campaigns (7+ types); promo opt-out control
- Customer feedback campaigns
- Unlimited free customer-data export

### 2.6 Reports & Analytics
- 80+ / 100+ reports; single dashboard
- Sales, item-wise consumption, online orders, staff scheduling, payment status
- **Head-office module**: multi-outlet, city/zone groupings; central menu & raw-material management
- Tax reports; day-end reports (<5 min)
- **Staff-action audit**: bill modifications, discounted/cancelled orders, cash-drawer ops
- User rights / access control (outlet-wise, owner-controlled)
- Automated report email alerts

### 2.7 Add-ons (marketplace)
| Category | Add-ons |
|---|---|
| **Operations** | Captain Ordering App, Kitchen Display System (KDS), Token Management, Table Reservation Manager, Handheld POS, Queue Management |
| **Customer Service** | Self-Service Kiosk, Scan & Order, Scan & Pay, Wireless Calling Device, Voice ordering kiosk |
| **CRM** | Loyalty Program, Customer Feedback, SMS Service, Restaurant Website builder |
| **Analytics** | Order Reconciliation, Dynamic Reports, Analytics & Insights |

**Captain App** (parity detail): multi-device sync w/ POS, offline, UPI/wallet/contactless (<₹5000), Android phone/tablet, table/area assignment, captures remarks — *already has AI upsell + AI voice item entry*.

**KDS** (parity detail): online + dine-in tickets, individual KOTs + aggregated item list, mark-ready, mark item out-of-stock, station-wise routing, Windows/Android.

### 2.8 Integrations (categories)
UPI/payment gateways · food aggregators · B2B delivery agents · loyalty programs · CRM tools · accounting (for large chains).

### 2.9 Outlet types to support (config presets)
Fine Dine · QSR · Cafe · Food Court/Canteen · Cloud Kitchen · Ice-cream/Dessert · Bakery · Bar & Brewery · Pizzeria · Large Chain.

---

## 3. The AI Upgrade Layer (module by module)

This is the product's reason to exist. Each item is scoped as **Copilot** (assists a human), **Autopilot** (acts with guardrails), or **Insight** (surfaces something).

### 3.0 Zero-touch onboarding ★ (the headline "easier" feature)
- **AI menu ingestion** (Autopilot) — upload a photo/PDF of an existing menu, or an export from an old POS → vision + LLM extract categories, items, variations, add-ons, and prices into a reviewable draft catalog. Minutes, self-serve, no vendor rep. Directly kills PetPooja's biggest adoption barrier.
- **AI recipe/ingredient mapping** (Copilot) — infer likely recipes and raw materials per dish from the item name/description, propose ingredient lists and units for approval → inventory is *usable on day one* instead of after a manual project.
- **Guided setup agent** (Copilot) — conversational setup ("you're a cafe, here are your suggested taxes, areas, and printer layout — approve or tweak") using per-outlet-type smart defaults.

#### 3.0.1 Menu-ingestion pipeline (design spec)
The hard part is **structure + trust**, not OCR. A menu is a hierarchy (category → item → variation/add-on → price, + veg/non-veg, spice, portion), and a misread **price is a financial bug**. Design accordingly:
1. **Vision-LLM-direct, not OCR→LLM.** Feed the image/PDF to a multimodal model (**Claude Opus 4.8 / Sonnet 5 vision**) with **forced structured JSON output against our menu schema**. Rationale: menu meaning is *spatial* (price↔item, item↔heading); plain OCR (Textract/Document AI/PaddleOCR) discards layout and forces re-inference. Keep dedicated OCR only as a fallback for degraded scans.
2. **Three input paths:** photo (skew/glare/multi-page), PDF, and **old-POS export (CSV/Excel)** — the last is most accurate; support it first for switchers.
3. **Confidence-flagged, review-required draft.** Never auto-publish. Editable draft; **prices always human-reviewed**; low-confidence fields highlighted; sanity rules flag price outliers.
4. **Recipe inference = separate, always-reviewed step.**
5. **Multi-language:** store original string + normalized name (Indian menus mix scripts + transliteration).
6. **De-risk early:** this feature carries the "easier" promise → prototype extraction on messy real menus before committing UX.

### 3.1 Billing / POS
- **Conversational & voice ordering** (Copilot) — "table 5, two butter naan, one paneer, split the bill 3 ways, comp the dessert" → parsed to order actions. Beats PetPooja's voice-item-entry by handling full commands, modifiers, and bill ops.
- **Computer-vision quick-bill** (Copilot) — camera/scan of a physical menu or table → auto-populate order; scan a handwritten chit → digitize KOT.
- **Smart upsell at billing** (Copilot) — next-item recommendation from basket + customer history + time-of-day, with margin-aware ranking.
- **Anomaly guardrails** (Insight) — flag unusual discounts/voids/comps in real time before they post (fraud prevention at the point of action, not just in month-end reports).

### 3.2 Inventory
- **Demand forecasting → auto-PO** (Autopilot) — per-item sales forecast (seasonality, weekday, weather, local events, festivals) → draft purchase orders for approval. This is the headline feature; drives PetPooja's claimed "65% wastage cut" via prediction rather than manual reorder points.
- **Spoilage / shelf-life prediction** (Insight) — flag perishables at risk; suggest specials to move them.
- **Recipe-cost optimizer** (Insight) — track raw-material price trends, suggest substitutions and re-pricing when food cost % drifts.
- **Photo-based stock count** (Copilot) — vision-assisted physical stock take.

### 3.3 Menu
- **Dynamic AI pricing** (Autopilot w/ guardrails) — time/demand/weather/inventory-driven price suggestions per item and per channel (dine-in vs. aggregator, where commissions differ).
- **Menu engineering** (Insight) — auto-classify items into Stars / Plowhorses / Puzzles / Dogs by margin × popularity; recommend layout & promotion changes.
- **AI content** (Copilot) — generate item descriptions, translations (multi-language parity), and food photography/enhancement for online menus.

### 3.4 Online Orders
- **Aggregator margin optimizer** (Insight) — recommend channel-specific pricing to protect margin after commission; auto-reconcile payouts and flag discrepancies (upgrade of PetPooja reconciliation with anomaly detection).
- **Prep-time & dispatch prediction** (Insight) — predicted ready-time per order to sequence kitchen + rider assignment.

### 3.5 CRM
- **Churn prediction & win-back** (Autopilot) — score customers likely to lapse; auto-draft personalized win-back offer (channel + message + incentive).
- **Next-best-offer per customer** (Copilot) — RFM + purchase graph → individualized promo instead of blast SMS.
- **AI campaign studio** (Copilot) — describe a goal ("fill Tuesday lunches") → generated segment + message + timing.
- **Feedback sentiment & theme mining** (Insight) — cluster feedback, detect emerging complaints (e.g., "service slow after 9pm"), alert manager.

### 3.6 Reports
- **Chat with your data** (Copilot) — natural-language BI: "why were Tuesdays down last month?" → query + chart + narrative, over the Postgres warehouse.
- **Daily plain-English briefing** (Insight) — auto morning summary: sales vs. forecast, top movers, anomalies, one recommended action.
- **Fraud/anomaly detection** (Insight) — statistical + ML detection across voids, discounts, cash-drawer, staff patterns.

### 3.7 Kitchen / Ops
- **AI KDS sequencing** (Autopilot) — order-firing sequence to optimize table-turn & minimize wait; predicted cook times per station; bump-bar + timers (features PetPooja's KDS lacks).
- **Staff scheduling** (Copilot) — roster from forecasted footfall; flag over/under-staffing.
- **Table-turn optimization** (Insight) — reservation + live-floor model to seat and pace.

---

## 4. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| **Frontend / app** | **Next.js 15 (App Router) + React + TypeScript** | One framework for web dashboard, kiosk, captain PWA; SSR for reports, RSC for data. |
| **Styling/UI** | Tailwind CSS + shadcn/ui; TanStack Query for data | Fast, consistent, accessible. |
| **Local terminal shell** | **Tauri** (or Electron) desktop app wrapping the Next.js UI + embedded SQLite | Native printer/cash-drawer/USB access, runs the POS fully offline. Tauri = smaller/faster than Electron. Kiosk/captain use the PWA variant. |
| **API** | Next.js Route Handlers + tRPC (typed) or REST; Node runtime | Shared types front-to-back. |
| **ORM** | **Drizzle ORM** | **One schema definition compiles to both SQLite and PostgreSQL dialects** — critical for the hybrid model (§5). |
| **Local DB** | **SQLite** (per terminal, embedded) | Zero-latency, offline source of truth during service. |
| **Cloud DB** | **PostgreSQL** (Neon / Supabase / RDS) | Central system of record, multi-outlet, reporting warehouse, RLS multi-tenancy. |
| **Sync engine** | **PowerSync** or **ElectricSQL** (Postgres ⇄ SQLite), or custom outbox+CDC | Handles the offline-first replication & conflict resolution. |
| **Realtime** | WebSockets (KDS, captain, live floor) via cloud; LAN-local broker on-prem | Kitchen/captain need sub-second updates even offline on the local network. |
| **AI** | **Claude (Opus 4.8 / Sonnet 5 / Haiku 4.5)** via Anthropic API for reasoning, NL-reporting, campaign/content gen, voice-command parsing; a small **forecasting service** (Python: Prophet/LightGBM/temporal models) for inventory/demand | Claude for language/reasoning/agents; classical ML for numeric forecasting. |
| **Vector/RAG** | pgvector in Postgres | Menu/customer/feedback embeddings for "chat with your data" & recommendations. |
| **Queue/jobs** | BullMQ (Redis) or Postgres-based queue | Async: reconciliation, forecasts, campaigns, e-way bills. |
| **Infra** | Vercel/Node for web; Postgres managed; object storage (S3/R2) for receipts, images, menu photos | — |
| **Observability** | OpenTelemetry + Sentry | — |

> **Payments/compliance note:** GST, e-way bill, and payment-gateway (Razorpay/UPI) integrations are region-specific and PCI-sensitive — treated as integration modules with certified providers, never hand-rolled.

---

## 5. Hybrid SQL / Offline-First Architecture ★ (core differentiator)

This is the part you explicitly asked for, and it's the backbone of the whole system.

### 5.1 The principle
Restaurants **cannot** stop billing when the internet drops. So the **local SQLite database on each terminal is the source of truth during service**, and **PostgreSQL in the cloud is the system of record for the business** (all outlets, history, reporting, CRM). They converge continuously when a connection exists.

```
   ┌─────────────────────── OUTLET (works with zero internet) ───────────────────────┐
   │                                                                                  │
   │   [POS Terminal 1]      [POS Terminal 2]      [Captain PWA]     [KDS Screen]      │
   │    SQLite (local) <──────── LAN sync ────────> SQLite  ...        (subscribes)    │
   │        │  writes: orders, KOTs, payments, stock deductions                       │
   │        │                                                                         │
   │        └──────────────► Local Sync Agent (outbox / event log) ◄──────────────────┤
   │                                    │                                             │
   └────────────────────────────────── │ (when online) ─────────────────────────────┘
                                        ▼
                          ┌──────────────────────────────┐
                          │      Sync Service (cloud)     │  push outbox ▲ / pull changes ▼
                          │  PowerSync / Electric / CDC   │
                          └──────────────┬───────────────┘
                                         ▼
                          ┌──────────────────────────────┐
                          │   PostgreSQL (central cloud)  │  ← system of record, all outlets
                          │   + pgvector + reporting      │
                          └──────────────┬───────────────┘
                                         ▼
                   Reports · Head-office · CRM · AI/forecasting · Aggregators · Accounting
```

### 5.2 What lives where
| Concern | SQLite (local terminal) | PostgreSQL (cloud) |
|---|---|---|
| Live order entry, KOT, table state | ✅ authoritative in-service | mirror |
| Payments captured offline | ✅ queued | reconciled on sync |
| Stock deduction during service | ✅ local | aggregated |
| Menu / prices / taxes | cached read-replica | ✅ authoritative (pushed down) |
| Customers / loyalty | cached subset (recent/local) | ✅ full pool |
| Multi-outlet, reports, forecasts, campaigns | ❌ | ✅ |

**Direction of authority:** *transactional writes flow up* (order/bill/stock born on the terminal), *configuration flows down* (menu, price, tax, user rights born in cloud). This split makes conflict handling tractable.

### 5.3 How the hybrid is implemented
- **Single schema, two dialects:** Drizzle ORM defines each table once; we generate the SQLite DDL for terminals and the Postgres DDL for cloud. Business logic (TypeScript) is written once against the Drizzle client and runs in both places.
- **IDs:** UUIDv7 (time-ordered) generated **client-side** so offline terminals never collide and inserts stay index-friendly.
- **Change capture:** every local mutation also appends to a local `outbox` table (op, entity, payload, hlc_timestamp). The sync agent drains the outbox to the cloud; the cloud streams relevant changes back (menu updates, other terminals' orders).
- **Off-the-shelf option (recommended to start):** **PowerSync** or **ElectricSQL** give Postgres⇄SQLite sync + conflict handling out of the box, so we don't build replication from scratch. Custom outbox+CDC is the fallback if we need finer control.

### 5.4 Conflict resolution
- **Append-only events** (new orders, KOTs, payments) → no conflict; just merge by UUID.
- **Config pushed down** (menu/price/tax) → cloud wins; terminals are read replicas for these.
- **Counters** (stock on hand) → treat deductions as **deltas** (event-sourced), not absolute overwrites, so two terminals selling the last units reconcile correctly (and can flag oversell). CRDT-style counter.
- **Editable records** (customer profile, open-table edits) → last-write-wins by **Hybrid Logical Clock (HLC)** timestamp, with an audit trail so nothing is silently lost.

### 5.5 Consequences (why this is worth it)
- Billing survives total internet loss; syncs the moment it's back.
- Sub-10ms local reads/writes → the "3-click billing" feels instant.
- Cloud is free to be the heavy analytical/AI brain without ever blocking the floor.
- LAN sync between terminals means an outlet stays consistent internally even while cut off from cloud.

---

## 6. Core Data Model (first pass)

Multi-tenant from day one. Top-level tenant = **Organization** (a brand/chain) → **Outlets**.

**Identity & tenancy:** `organizations`, `outlets`, `users`, `roles`, `permissions`, `user_outlet_access`, `audit_log`
**Menu:** `menu_categories`, `menu_items`, `item_variations`, `item_addons`, `combos`, `menus` (per-area), `item_availability` (time/stock), `price_lists` (channel-specific), `taxes`, `tax_groups`
**Floor:** `areas`, `tables`, `table_sessions`, `reservations`
**Ordering/billing:** `orders`, `order_items`, `order_item_modifiers`, `kots`, `kot_items`, `bills`, `bill_splits`, `discounts`, `coupons`, `payments`, `payment_methods`, `cash_drawer_events`
**Inventory:** `raw_materials`, `recipes`, `recipe_components` (multi-stage), `stock_ledger` (event-sourced deltas), `purchase_orders`, `po_items`, `suppliers`, `stock_transfers`, `wastage`, `central_kitchen_requests`
**CRM:** `customers`, `customer_labels`, `loyalty_accounts`, `loyalty_transactions`, `campaigns`, `feedback`
**Online:** `channels` (Swiggy/Zomato/…), `online_orders`, `reconciliation_records`, `rider_assignments`
**AI/analytics:** `forecasts`, `price_recommendations`, `anomalies`, `embeddings` (pgvector), `ai_action_log`
**Sync:** `outbox`, `sync_state` (local only)

Every transactional table carries: `id (uuidv7)`, `org_id`, `outlet_id`, `created_at`, `updated_at`, `hlc`, `synced_at`, `deleted_at` (soft delete).

---

## 7. AI Infrastructure

- **Reasoning/language:** Anthropic Claude — **Opus 4.8** for hard reasoning (chat-with-data, agentic auto-PO drafting, anomaly explanations), **Sonnet 5** for everyday copilots (upsell, campaign copy), **Haiku 4.5** for high-volume/low-latency (voice-command parsing, quick classifications). Model IDs pinned in config for easy migration.
- **Forecasting service:** separate Python microservice (LightGBM / temporal models / Prophet) trained per-outlet per-item on the Postgres history; exposes forecast + confidence to the auto-PO and dynamic-pricing engines.
- **RAG:** pgvector over menu, customers, feedback, and historical reports powers "chat with your data" and next-best-offer.
- **Guardrails:** every Autopilot action (auto-PO, dynamic price, win-back offer) is **proposed for approval by default**, logged in `ai_action_log`, with per-feature autonomy settings a manager can dial up.
- **Voice pipeline:** speech-to-text → Claude intent/slot parsing → order actions; runs against a local grammar cache so common commands work with degraded connectivity.

---

## 8. Security, Multi-tenancy & Compliance

- **Multi-tenant isolation:** Postgres Row-Level Security keyed on `org_id`; every query scoped by tenant.
- **RBAC:** granular permissions (bill edit, void, discount cap, reports, settings) mirroring PetPooja's user-rights + staff-action audit; enforced on both terminal and cloud.
- **Audit everything:** immutable `audit_log` for voids, discounts, comps, cash-drawer, price changes, AI actions — feeds the fraud/anomaly AI.
- **Payments:** delegate to certified gateways (Razorpay/UPI); never store PANs; PCI-DSS scope minimized.
- **Tax/GST & e-way bill:** region-specific integration modules with the official portals.
- **Data residency & export:** unlimited customer-data export (parity), region-pinned Postgres.

---

## 9. Phased Roadmap

| Phase | Focus | Outcome |
|---|---|---|
| **0 — Foundations** ✅ *built 2026-08-04* | Monorepo, Drizzle dual-dialect schema, auth/RBAC, org/outlet model, SQLite⇄Postgres sync (outbox + HLC conflict resolution, transport behind an interface). *Tauri shell deferred to Phase 1 — nothing to wrap until there is a UI.* | A terminal that boots, logs in, and syncs a trivial table offline→online — `npm run demo`. |
| **1 — Billing/POS core** ← *first build* | **AI zero-touch onboarding (menu ingestion)**, menu, tables/areas, order entry, KOT + station printing, split/merge, taxes/discounts, payments, e-bill, offline-first, "Today" home screen. **+ AI: smart upsell + anomaly guardrail.** | A restaurant **onboards itself in minutes** and bills offline, with AI hooks live. |
| **2 — Kitchen & floor ops** | KDS (with AI sequencing), Captain PWA (voice ordering), token/queue, reservations | Full front-of-house + back-of-house. |
| **3 — Inventory + AI forecasting** | Recipes, stock ledger, POs, central kitchen; **demand forecast → auto-PO**, spoilage alerts | The wastage-reduction story. |
| **4 — Online orders + menu AI** | Aggregator integration, reconciliation, dynamic pricing, menu engineering | Omnichannel + margin optimization. |
| **5 — CRM + campaign AI** | Loyalty, segments, feedback sentiment, churn/next-best-offer, AI campaign studio | Customer growth engine. |
| **6 — Reports + BI AI** | Report suite, head-office multi-outlet, chat-with-your-data, daily briefing, fraud detection | The analytics moat. |
| **7 — Marketplace & integrations** | Kiosk, Scan & Order/Pay, wireless caller, plugin API, accounting/payment integrations | Ecosystem parity. |

---

## 10. Phase 1 Build Scope — Billing / POS Core (detailed)

**Goal:** a restaurant **onboards itself in minutes** (no vendor rep), a cashier runs a full service offline and settles bills, owner sees it in the cloud, and AI is live from the first order. *Ease is the deliverable, not just billing.*

**Must-have user stories**
1. **AI onboarding:** upload a menu photo/PDF → review the AI-extracted catalog (categories, items, variations, prices) → go live. Guided setup picks tax/area/printer defaults from outlet type.
2. Log in with role; access scoped to outlet.
3. See menu loaded locally.
4. Open a table / start a takeaway order; add items by tap or shortcode.
5. Fire **KOT** → route to correct station printer/KDS; modify/cancel with audit.
6. Apply discounts/coupons (within permission caps), taxes auto-computed per area.
7. **Split / merge** bills; hold/recall.
8. Take payment (cash / UPI-QR / card); print + SMS **e-bill**.
9. **Everything above works with the network cable unplugged**; syncs to Postgres when back.
10. **"Today" home screen:** the day's sales at a glance + one recommended action (no report-hunting).
11. **AI — Smart upsell:** contextual "add-on" suggestion on the order screen.
12. **AI — Anomaly guardrail:** unusual discount/void prompts a supervisor confirm.

**Phase-1 tables:** organizations, outlets, users/roles, menu_* , areas, tables, table_sessions, orders, order_items, order_item_modifiers, kots, kot_items, bills, bill_splits, payments, discounts, taxes, audit_log, outbox, sync_state.

**Phase-1 exit criteria**
- **A new user goes from a menu photo to a printed first bill in under 15 minutes, unaided.** (The "easier" proof.)
- Offline order→KOT→bill→payment→sync round-trips correctly, including a conflict test (two terminals editing one table).
- Sub-100ms interaction on order screen.
- Audit log captures voids/discounts; RBAC blocks an unauthorized void.
- "Today" screen shows sales + one action; upsell suggestion renders; guardrail fires on a threshold breach.

---

## 11. Proposed Repo Structure (Phase 0/1)

```
forkflow/
├─ apps/
│  ├─ pos/            # Next.js UI (POS) + Tauri shell (terminal)
│  ├─ kds/            # Kitchen Display (Phase 2)
│  ├─ captain/        # Captain PWA (Phase 2)
│  └─ web/            # Cloud dashboard / head-office / reports
├─ packages/
│  ├─ db/             # Drizzle schema (dual dialect), migrations, seed
│  ├─ sync/           # outbox, sync agent, conflict resolution (HLC/CRDT)
│  ├─ core/           # domain logic: pricing, tax, KOT, split/merge (shared)
│  ├─ ai/             # Claude clients, prompts, upsell, anomaly, NL-report
│  ├─ ui/             # shadcn components, design system
│  └─ types/          # shared TS types / tRPC contracts
├─ services/
│  ├─ sync-service/   # cloud sync endpoint (PowerSync/Electric or custom)
│  └─ forecasting/    # Python ML microservice (Phase 3)
└─ infra/             # IaC, docker, CI
```

---

## 12. Open Decisions (for you)

1. **Terminal shell:** Tauri (recommended, lighter) vs. Electron (more mature ecosystem) vs. pure PWA (no native printer access)?
2. **Sync engine:** adopt **PowerSync/ElectricSQL** (faster to ship) vs. **custom outbox+CDC** (max control)?
3. **Primary region/compliance:** India-first (GST, e-way bill, UPI, ₹) or multi-region from the start?
4. **AI autonomy default:** ship Autopilot features as approve-first (recommended) or let power users enable full auto?
5. **Product name** (ForkFlow is a placeholder).

---

*Next step once you approve direction: I scaffold Phase 0 (monorepo + Drizzle dual-dialect schema + auth + a working SQLite⇄Postgres offline sync spike), then build the Phase 1 billing core.*
