# Compact POS UI audit and plan

Target: Electron + React, touchscreen and keyboard, 1280×720 minimum; also verify 1920×1080. Source references below describe the pre-redesign files.

## Audit

| Screen / component | Source reference | Finding and planned treatment |
|---|---|---|
| App, StaffApp | apps/ui/src/App.tsx:39 | Only tables/orders use a viewport shell. Apply shared compact staff styling without affecting guest routes. |
| NavBar, ThemeToggle, Brand, Icon | NavBar.tsx:92; ThemeToggle.tsx:20; Icon.tsx:25 | Full sidebar consumes 216px; icon rail loses labels. Use a narrow labeled rail, 16px icons, preserve accessible names and theme control. |
| ConnectionStatus | ConnectionStatus.tsx:18 | Healthy state disappears; reconnect banner uses fixed light colors and 12px padding. Use a 24px status row with expandable saved-action details. |
| WorkspaceDialog | WorkspaceDialog.tsx:28; workspace-dialog.css:1 | Large radius/padding; keep native modal focus/Escape behavior and compact dimensions. |
| QrNotifications | QrNotifications.tsx | Existing actionable pending-request banner; retain it, reduce spacing. |
| OrderScreen | OrderScreen.tsx:220,245,265; order-screen.css:24,37 | Category select costs two taps; 98px tiles; cart controls wrap beneath names. Add category rail, autofocus search, 72px tiles and 40px touch steppers; pin footer. |
| QuickTakeaway, TakeawayStart | QuickTakeaway.tsx:57,74 | Recovery and navigation locking are important. Reuse redesigned OrderScreen; preserve all recovery code. |
| BillingPanel, BillSummary | BillingPanel.tsx:16,201,213; billing-panel.css:10,18 | 820px modal, 20px padding, 38px inputs, totals details hidden. Compact two-column payment dialog; server totals in aligned rows; 40px payment actions. |
| Tables | Tables.tsx:212,236; tables-screen.css:24 | Header, request cards and toolbar consume several rows; tiles repeat action labels. Compact header/request strip, show running item subtotal and elapsed time from already-loaded orders. Keep reservations and splits discoverable. |
| Bills | Bills.tsx:25 | Heading and filters on separate rows, no sticky header, long action labels. Single toolbar, dense aligned table. |
| DayEnd | DayEnd.tsx:29,41 | Vertical summary, tax table and payments force scrolling. Two-column report sections; slim filter toolbar and export popover. |
| Home | Home.tsx:33; styles.css:205 | Large statistic cards and 76px action tiles. Compact stats and primary entry actions. |
| Kitchen | Kitchen.tsx:48 | Large tickets/padding; compact grid, retain readable kitchen content and touch action. |
| Catalog | Catalog.tsx:119,147 | Category management consumes 290px; product table has stacked metadata/actions. Narrower management column, compact table and toolbar. |
| ProductEditor | ProductEditor.tsx:119 | Description/photo and portion editor make long form. Compact two-column form, collapsible description/photo/portions; preserve save semantics. |
| CatalogTransfer | CatalogTransfer.tsx:50 | Import/export controls and preview share product area. Keep preview and validation, compact details. |
| RecipeEditor | RecipeEditor.tsx | Ingredient rows and actions use generous spacing. Compact columns; retain precision and existing save/discard behavior. |
| Inventory, stock detail, movements, product stock link | Inventory.tsx:12,71,125,161,184 | Inline 22px panel padding, 24px section margins; vertical forms. Shared compact panels and two-column forms, collapsible creation/link sections. |
| Users | Users.tsx:51 | Long form row; large shared controls. Compact labeled form and dense role-management table. |
| Settings | Settings.tsx:280,314,433,484 | Profile, printers, stations, jobs, recovery and license are one long page. Independent collapsible sections with two-column forms. |
| SystemSettings | SystemSettings.tsx:37 | Backup/connection details take vertical space. Compact inside collapsible section; retain restore cautions. |
| LicenseSettings, LicenseGate, useLicense | LicenseSettings.tsx:41,119 | Large account/device section; gate must remain visible. Compact settings only; preserve gate/activation. |
| Reservations | Reservations.tsx | Native dialog with existing two-column editor. Apply shared density, retain booking details and guards. |
| QrRequests, QrTableManager | QrRequests.tsx:31,123 | Dialog review and printed QR workflow already separate. Compact toolbar/cards; preserve printed QR layout. |
| ServiceRequests | ServiceRequests.tsx:84 | Summary has stacked headings/buttons. Inline summary in table toolbar. |
| AuthLayout, Login, Setup | AuthLayout.tsx:6; Login.tsx:25; Setup.tsx:21 | 32px card padding and large headings. Compact card; keep PIN keypad touch targets and theme toggle. |
| GuestMenu, ProductCard, GuestServices | GuestMenu.tsx:319; GuestServices.tsx:139 | Customer-facing branded mobile UI, outside cashier density scope; preserve it. |

Nonvisual modules (API/session, websocket, retry queue, navigation guard, money, UUID, product photo, report export/download, types, theme storage) remain the existing data infrastructure.

## Tokens and sequence

1. Spacing: 2/4/6/8/12/16/24px; controls: 28px default, 24px small, 32px primary, 40px cashier touch controls. Base/secondary/headings/total: 13/12/16/24px. Radius 4px (6px panels), 1px borders, one accent, tabular numerals.
2. Shared native button/input/select/table/dialog/tabs/tile styling, plus small reusable QtyStepper and segmented choice components. No dependencies.
3. Billing first: 40px header, category rail + search, menu grid, 380px cart. Preserve punch/KOT/preview/issue/pay sequence; no automatic new API calls. After server preview display authoritative discount/tax/rounding/total.
4. Tables, payment, history/reports, then settings and secondary staff screens.
5. Verify in an isolated database with a local receipt capture printer. Compare identical orders before/after, output amounts and receipt bytes, keyboard/touch controls, light/dark, 1280×720 and 1920×1080.

## Explicit boundaries

- Only dine-in/parcel exist. No delivery, order customer editor, shifts or service charge will be invented. Reservation guest details remain available.
- Printer preference already persists. Persist payment choice and last-used order entry route locally. The F2 shortcut opens the corresponding existing entry screen; it never converts an existing order.
- Draft quantity input uses the existing 1–99 API limits. Saved items retain the existing cancellation/reason/permission workflow.
- Hold means leaving a locally saved draft/open order, not a new server status. Confirmations for server cancellation and discarding unsaved administrative forms remain because no server undo exists.
- No finite screen fits an unlimited menu/cart. Normal-order verification will use 24 menu tiles and eight cart rows; overflow remains independently scrollable for larger orders.
- No tax/discount/rounding formulas, API calls, schemas, bill numbering or receipt/KOT templates will change.

## Verification results

- TypeScript and production UI build pass. No dependencies added.
- 51 targeted tests pass across domain billing, server billing, quick takeaway, receipts, print queue, money, and CSV export.
- All 126 server/domain/core source files match their baseline hashes. TypeScript AST comparison finds no changed apiFetch/reliablePost/fetch calls in edited UI components.
- Before/after eight-item order: subtotal 83,000 paise, discount 2,500, CGST 3,304, SGST 3,304, rounding −8, total 87,100. Both 5% and 18% GST rows match exactly. Both flows generated KOT and receipt bytes through the existing print queue into a disposable capture sink.
- At 1280×720, the old draft list measured 522px content in a 452px viewport (scroll required). The new eight-row draft fits its 434px viewport; after checkout all eight saved rows fit the 482px viewport. The payment dialog fits without scrolling.
- 24 menu tiles fit alongside the full cart. Both 1280×720 and 1920×1080 were visually inspected in light/dark themes. No horizontal page overflow on Home, Tables, Bills, Reports, Inventory, Catalog, Settings, Users or Kitchen.
- Verified quantity typing, Enter-to-add, Escape-to-clear search, remove/undo, Hold (F8), return via New (F2), Punch (F6), KOT (F9), preview/issue/settle (F10), and printer preference retention.
- Verified dine-in separately: three items, KOT, ₹278.00 bill, ₹100.00 cash + ₹178.00 UPI split settlement. UPI preference retained.
- Visible payment text passed a 4.5:1 contrast check in dark mode. A scan of all staff screens in light mode found legacy filter/timer/help colors, which were corrected to the shared accessible tokens.
- Browser console and runtime error checks are clean.
- The explicitly invoked Vercel auth guidance was reviewed; the user confirmed keeping local PIN sign-in. Authentication and role permissions remain unchanged.

### Per-screen result

- Billing: vertical category rail, five menu columns at the minimum width, single-row draft/saved items, typed quantities, undo, pinned subtotal/actions, local date/time and operator metadata, visible connection and selected-printer status.
- Payment: compact native dialog; server subtotal/discount/GST/rounding/total rows; Cash/Card/UPI segments; exact/quick tender amounts and change; existing split-payment editor preserved for issued bills.
- Tables: compact status tiles with running item subtotal and elapsed time from the existing order list. Reservations, QR requests, table management, parcels and splits remain reachable.
- Bills/reports: slim toolbars, 32px rows, sticky headers, right-aligned amounts, two-column report sections, export disclosure.
- Settings/catalog/inventory: compact two-column forms, narrower category management, collapsible printer/KOT/backup/license sections, description/photo/variants and stock creation/link editors. Existing inline editing remains.
- Other staff screens share 28px controls, 12–16px typography, reduced spacing and accessible status colors. PIN keypad touch targets and theme switch remain.

### Before / after

| Measure | Before | After |
|---|---|---|
| Default controls | 40–42px globally | 28px; 24px small; 32px primary |
| Cashier touch controls | 26–38px in several cart/payment controls | 40px minimum |
| Menu tiles | 98px | 72px |
| Panel spacing/radius | 20–32px / 8–14px | 8–16px / 4–6px |
| Eight-row normal cart | Scrolling required | Full draft and saved cart visible |
| Category selection | Open select + choose (2 clicks) | Choose category (1 click) |
| Repeat three-item takeaway, same category, printer selected | 6 clicks from dashboard through payment/print | 6 clicks; also available via search/Enter and F2/F10 without a mouse |

The two billing confirmation steps stay intact to preserve the existing preview/issue/payment sequence. First-time printer selection, discounts and split payments add their existing optional steps. Very large menus/orders and expanded administrative sections still scroll internally. Physical printer hardware and extreme data volumes were not tested; receipt and KOT output were captured locally.

Evidence: output/compact-ui/comparison.json and the before/after screenshots in output/compact-ui/. Browser fixture: .e2e-scratch/compact-fixture.ts; UI acceptance runner: tools/e2e/compact-ui.js.
