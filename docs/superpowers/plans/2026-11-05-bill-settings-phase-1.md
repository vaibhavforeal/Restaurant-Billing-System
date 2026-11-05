# Bill settings — Phase 1 (cards, print content, live preview) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split bill options out of Restaurant profile into a new Bill settings card (with header/footer lines, show/hide toggles and a live bill preview) and a new AI suggestions card, with no change to bill money logic.

**Architecture:** New typed columns on the `settings` singleton (migration 56) flow through the Zod `SettingsUpdate` schema and `apps/server/src/settings.ts`. At issue, `priceOrder` freezes them into `ReceiptSnapshot`; `receiptSlip`/`receiptHtml` read them through one domain helper that supplies defaults for old snapshots. A preview endpoint renders `receiptHtml` for a fixed sample bill built from the unsaved form. The UI gets two self-contained section components instead of growing `Settings.tsx`.

**Tech Stack:** TypeScript, Zod, better-sqlite3 migrations, Fastify, React, vitest, browser e2e scripts in `tools/e2e`.

**Spec:** `docs/superpowers/specs/2026-11-05-bill-settings-design.md` (sections "Settings cards" and "Phase 1").

## Global Constraints

- Migration version **56** (54 and 55 were taken by order summary and item transfers), appended to the end of `MIGRATIONS` in `packages/domain/src/migrations/index.ts`.
- Header lines and footer lines: at most **3 lines, each ≤ 48 characters**, after trimming each line; blank lines are dropped.
- Toggle defaults: FSSAI **on**, customer **on**, table **on**, served-by **off**, item GST rate **off**.
- GSTIN is never hideable.
- Bill copies stay on each printer's bill profile; Bill settings only links to the Printers card.
- Settings changes apply to **new bills only**; snapshots missing the new fields render exactly as today.
- Preview endpoint: `POST /api/settings/bill-preview`, permission `settings.manage`, body validated with `SettingsUpdate`.
- No money logic changes: `calculateBill` is untouched.
- Section ids stay kebab-case; the titles "Backups & connections" and "Plan & devices" must not change.

## Review Focus

1. **Old bills reprinted after the upgrade:** a snapshot without `receiptHeader`/`billShow`/`servedBy` must print byte-identical to today → Task 4 asserts `receiptSlip(oldBill)` equals the existing snapshot file.
2. **Footer saved before this change with more than 3 lines or lines > 48 chars:** the GET still returns it, but saving the card must then fail with a clear field error, not silently truncate → Task 1 schema test; Task 6 shows the server message.
3. **Header/footer text containing ESC/POS control bytes or HTML:** must be cleaned/escaped like the restaurant name → Task 4 test.
4. **Toggling "Served by" on an order with no known staff name** (`soldByName` null): print nothing, not "Served by: null" → Task 4 test.
5. **Preview while the form is invalid** (e.g. 4 header lines): endpoint returns 400 and the UI keeps the last good preview → Task 5 server test; Task 6 behaviour.

---

### Task 1: Domain — schema, snapshot fields, print helper, migration 56

**Files:**
- Create: `packages/domain/src/bill-print.ts`, `packages/domain/src/bill-print.test.ts`
- Create: `packages/domain/src/migrations/bill-settings.ts`, `packages/domain/src/migrations/bill-settings.test.ts`
- Modify: `packages/domain/src/settings-schemas.ts`, `packages/domain/src/billing.ts` (`ReceiptSnapshot`), `packages/domain/src/migrations/index.ts`, `packages/domain/src/index.ts` (export `bill-print`)

**Interfaces:**
- Produces (`bill-print.ts`):
  - `export interface BillShow { fssai: boolean; customer: boolean; table: boolean; servedBy: boolean; itemGst: boolean }`
  - `export const DEFAULT_BILL_SHOW: BillShow` = `{ fssai: true, customer: true, table: true, servedBy: false, itemGst: false }`
  - `export const BILL_TEXT_MAX_LINES = 3; export const BILL_TEXT_MAX_CHARS = 48;`
  - `export function billTextLines(text: string): string[]`: split on `\r?\n`, trim each line, drop empty lines.
  - `export const BillTextLines`: a Zod string that trims and refines `billTextLines(v).length <= 3 && every line <= 48`, with the message `"Use up to 3 lines of 48 characters each"`.
  - `export function billShowOf(r: Pick<ReceiptSnapshot, "billShow">): BillShow`: `{ ...DEFAULT_BILL_SHOW, ...r.billShow }`.
- Produces (`ReceiptSnapshot`, all optional): `receiptHeader?: string; billShow?: BillShow; servedBy?: string`.
- Produces (`SettingsUpdate`, all optional): `receiptHeader: BillTextLines`, `receiptFooter` changes from `max(500)` to `BillTextLines.default("")`, `billShowFssai`, `billShowCustomer`, `billShowTable`, `billShowServedBy`, `billShowItemGst` (all `z.boolean().optional()`).
- Produces (DB, migration `billSettings`, version 56, name `"bill_settings"`): on `settings`, `receipt_header TEXT NOT NULL DEFAULT ''`, `bill_show_fssai INTEGER NOT NULL DEFAULT 1 CHECK (bill_show_fssai IN (0,1))`, and the same for `bill_show_customer` (1), `bill_show_table` (1), `bill_show_served_by` (0) and `bill_show_item_gst` (0).

- [ ] **Step 1: Write failing tests**
  - `bill-print.test.ts`:
    - `billTextLines("  A \n\n B ")` → `["A","B"]`.
    - `BillTextLines` accepts 3 lines of 48 chars; rejects 4 lines and a 49-char line with the message above.
    - `billShowOf({})` equals `DEFAULT_BILL_SHOW`; `billShowOf({ billShow: { ...DEFAULT_BILL_SHOW, fssai: false } }).fssai === false`.
  - `migrations/bill-settings.test.ts` (pattern: `migrations/gst-returns.test.ts`):
    - After `migrate`, `user_version >= 56`.
    - A SELECT of the six columns returns `{ receipt_header: "", bill_show_fssai: 1, bill_show_customer: 1, bill_show_table: 1, bill_show_served_by: 0, bill_show_item_gst: 0 }`.
    - `UPDATE settings SET bill_show_fssai = 2` throws.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/bill-print.test.ts packages/domain/src/migrations/bill-settings.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the interfaces above; register `billSettings` last in `MIGRATIONS`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `npx vitest run packages/domain`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(domain): bill print settings, snapshot fields and migration 56`.

### Task 2: Server — settings round-trip

**Files:**
- Modify: `apps/server/src/settings.ts`, `apps/server/src/settings.test.ts`

**Interfaces:**
- Consumes: the Task 1 `SettingsUpdate` fields.
- Produces: `GET`/`PUT /api/settings` → `settings` gains `receiptHeader: string`, `billShowFssai`, `billShowCustomer`, `billShowTable`, `billShowServedBy`, `billShowItemGst` (booleans). Also export `readSettings(db: Database)` from `settings.ts` (move it out of the closure) so Task 5 can reuse it.

- [ ] **Step 1: Write failing tests** in `settings.test.ts`:
  - Update the first test's `toEqual` to include `receiptHeader: ""`, `billShowFssai: true`, `billShowCustomer: true`, `billShowTable: true`, `billShowServedBy: false`, `billShowItemGst: false`.
  - New test "saves bill header lines and print toggles, and keeps toggles a PUT leaves out": PUT `receiptHeader: "Pure veg\nSince 1998"`, `billShowFssai: false`, `billShowServedBy: true` → GET returns them. A second PUT without the toggles keeps `billShowFssai: false`.
  - New test "refuses a footer of 4 lines with a 400".
- [ ] **Step 2: Run** `npx vitest run apps/server/src/settings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the columns to `SettingsRow`, the SELECT, the mapping (`=== 1` for booleans) and the UPDATE. `receipt_header = ?` is a full replace like `receipt_footer`; toggles use `COALESCE(?, col)` with `undefined → null`, exactly like `hold_orders_enabled`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): save bill header and print toggles`.

### Task 3: Server — freeze print settings into the bill snapshot

**Files:**
- Modify: `apps/server/src/billing.ts` (`priceOrder`, the settings SELECT and the `receipt` object), `apps/server/src/billing.test.ts`

**Interfaces:**
- Consumes: `BillShow`, the Task 1 snapshot fields, and `order.soldByName` from `loadOrderJson` (`apps/server/src/mappers.ts`).
- Produces: every new bill's `receipt` has `receiptHeader` (string, `""` when unset), `billShow` (all five flags from settings), and `servedBy` (only when `order.soldByName` is non-null).

- [ ] **Step 1: Write a failing test** in `billing.test.ts`, "freezes header, print toggles and served-by into the bill":
  - Set `receiptHeader: "Pure veg"`, `billShowItemGst: true` via `PUT /api/settings`, then issue a bill. `bill.receipt` should match `{ receiptHeader: "Pure veg", billShow: { fssai: true, customer: true, table: true, servedBy: false, itemGst: true }, servedBy: <the admin's name> }`.
  - Change the settings again; the reprint (`GET /api/bills/:id`) still has `receiptHeader: "Pure veg"`.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/billing.test.ts -t "freezes header"`. Expected: FAIL.
- [ ] **Step 3: Implement.** Extend the settings SELECT in `priceOrder` with `receipt_header` and the five `bill_show_*` columns, then build `billShow` from them.
- [ ] **Step 4: Run** the test, then `npx vitest run apps/server/src/billing.test.ts`. Expected: PASS. The preview fingerprint includes `receipt`, so it now also covers these fields; that's intended.
- [ ] **Step 5: Commit** `feat(server): freeze bill print settings into the receipt snapshot`.

### Task 4: Renderers honour header, footer lines and toggles

**Files:**
- Modify: `apps/server/src/print/receipt.ts`, `apps/server/src/print/receipt.test.ts`

**Interfaces:**
- Consumes: `billShowOf`, `billTextLines`.
- Produces: no new exports. `receiptSlip` and `receiptHtml` behave as follows:
  - **Header lines** print (centred on thermal; `<p class="header-line">` in HTML) right after the restaurant name, before the address.
  - **Footer** prints `billTextLines(receiptFooter)` one per line, or the existing "Thank you for visiting…" fallback when there are none.
  - **`fssai: false`** hides the FSSAI line.
  - **`customer: false`** hides the `customerLines` output.
  - **`table: false`:**
    - Dine-in thermal context line becomes `DINE-IN`.
    - HTML drops the "Table / Group" row for dine-in.
  - **`servedBy: true` with `r.servedBy` set:**
    - Thermal adds `Served by: <name>` after the context line.
    - HTML adds a `<div><dt>Served by</dt><dd>…</dd></div>` meta row.
  - **`itemGst: true`:**
    - Thermal appends `  GST <rate>%` as an extra line under each item (keeps the fixed numeric columns intact).
    - HTML adds a "GST" column between Rate and Amount.

- [ ] **Step 1: Write failing tests** in `receipt.test.ts`, reusing the file's `bill` fixture:
  - Old snapshot: `renderBytes(receiptSlip(bill, w))` still matches the existing snapshot for both widths, with no snapshot update.
  - Header `"Pure veg\nSince 1998"`:
    - Thermal output has "Pure veg" after the restaurant name and before "12 Market Road".
    - HTML contains `class="header-line">Pure veg`.
  - Footer `"Line one\nLine two"`: both lines appear and "Thank you for visiting" doesn't.
  - Each toggle off/on per the behaviour above, asserting presence or absence of `FSSAI:`, `Customer:`, `T1 / B`, `Served by: Ravi`, `GST 5%` on thermal (58 and 80) and the matching HTML.
  - `servedBy` flag on with no `servedBy` name: no "Served by" text anywhere.
  - Header `'<b>x</b>\x1b@'`: HTML escaped, and no ESC @ bytes after the init bytes (pattern: the existing "escapes markup" test).
  - All thermal lines stay ≤ 32/48 chars with the header, footer and item GST on.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/print/receipt.test.ts`. Expected: new tests FAIL; the old snapshot tests pass.
- [ ] **Step 3: Implement** in `receipt.ts`. Compute `const show = billShowOf(r)` once per renderer. Add a `.header-line` rule to `apps/server/src/print/restaurant-receipt-style.ts` (same font as `.address`).
- [ ] **Step 4: Run** the same command. Expected: PASS with no snapshot files rewritten (`git status` shows no `__snapshots__` change).
- [ ] **Step 5: Commit** `feat(print): bill header and footer lines and show/hide toggles`.

### Task 5: Bill preview endpoint

**Files:**
- Create: `apps/server/src/print/bill-preview.ts`
- Modify: `apps/server/src/settings.ts` (register the route), `apps/server/src/settings.test.ts`

**Interfaces:**
- Consumes: `readSettings(db)` (Task 2), `formatRestaurantAddress`, `calculateBill`, `receiptHtml`, `billShow` mapping (same as Task 3).
- Produces:
  - `export function sampleBill(settings: SettingsUpdateInput & { stateCode: string; city: string; pincode: string; phone: string }): Bill`. It's a fixed `unpaid` bill, billNo `1`, `createdAt` fixed at 2026-04-01 13:30 local, gstMode from the form (default `"included"`), dine-in table `"T4"`, and:
    - items `Paneer Tikka` ₹280 × 1 @ 5% and `Fresh Lime Soda` ₹90 × 2 @ 18%;
    - customer `{ name: "Asha", phone: "******3210" }` and `servedBy: "Ravi"`;
    - `upiId`, `receiptStyle`, header, footer and `billShow` from the form;
    - no payments or credit notes.
  - `POST /api/settings/bill-preview`. The body is parsed with `SettingsUpdate`; address, city, state, PIN and phone not in the body come from `readSettings`. It returns `{ html: string }`; an invalid body returns 400 with the Zod message (same error path as `PUT`); it requires `settings.manage`.

- [ ] **Step 1: Write failing tests** in `settings.test.ts`, "previews an unsaved bill":
  - POST `{ restaurantName: "Cafe Test", address: "12 MG Road", receiptHeader: "Pure veg", billShowFssai: false, fssai: "11223344556677" }` → 200. `html` contains "Pure veg" and "Paneer Tikka", and doesn't contain "FSSAI:".
  - GET `/api/settings` afterwards still has `receiptHeader: ""` (nothing saved).
  - 4-line header → 400.
  - A cashier token (`createUser` helper) → 403.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/settings.test.ts -t "previews"`. Expected: FAIL (404).
- [ ] **Step 3: Implement** `sampleBill` and the route.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): live bill preview endpoint`.

### Task 6: UI — Bill settings, AI suggestions and a slimmer Restaurant profile

**Files:**
- Create: `apps/ui/src/screens/BillSettings.tsx`, `apps/ui/src/screens/AiSuggestionSettings.tsx`, `apps/ui/src/bill-settings.css`
- Modify:
  - `apps/ui/src/settings-sections.ts` and `apps/ui/src/settings-sections.test.ts`
  - `apps/ui/src/types.ts` (`SettingsData`)
  - `apps/ui/src/screens/Settings.tsx` (profile section; render the new sections; `EMPTY_SETTINGS`)
  - `tools/e2e/ai-assistant.js` (open "AI suggestions" instead of "Restaurant profile")
- Create: `tools/e2e/bill-settings.js` and a `## Bill settings` entry in `tools/e2e/README.md`

**Interfaces:**
- Consumes: Task 2 fields, the Task 5 endpoint, and `useAction` (`apps/ui/src/use-action.ts`).
- Produces:
  - `SETTINGS_SECTIONS` order: `profile` ("Restaurant profile", "Name, address, GSTIN and FSSAI"), `bill` ("Bill settings", "Tax, printed bill and order handling", icon `bills`), `ai-suggestions` ("AI suggestions", "Popular items, pairings and the AI assistant", icon of your choice from `IconName`), then `order-types`, `printers`, `jobs`, `backups`, `plan`, `updates`, `shortcuts`, `support`.
  - `export function BillSettings({ onOpenPrinters }: { onOpenPrinters: () => void })` and `export function AiSuggestionSettings()`. Each loads `GET /api/settings` itself and saves the full object with `PUT` (same blank-dropping rule as `profileForSave`, moved to `apps/ui/src/settings-save.ts` as `export function settingsForSave(form: SettingsData): Partial<SettingsData>` and reused by all three cards).

- [ ] **Step 1: Write a failing test.** Update `settings-sections.test.ts` to the new id list above. Add `apps/ui/src/settings-save.test.ts`: `settingsForSave` drops blank `city/stateCode/pincode/phone` and keeps every other key.
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/settings-sections.test.ts apps/ui/src/settings-save.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `Settings.tsx` profile section keeps only the `SETTINGS_FIELDS` inputs (with "Receipt footer" removed), the state select, Save, and `<ActivityAlertSettings />`.
  - **`AiSuggestionSettings`** holds the popular items, time of day, ordered together and customer's usual checkboxes (copy and InfoTips moved verbatim), its own Save, and `<AiAssistantSettings />`.
  - **`BillSettings`:**
    - **Layout:** two-column (form | preview), stacked under 900px, in `bill-settings.css`.
    - **Fieldset "Tax":** GST, default rate, SAC and Zomato's GSTIN, moved verbatim with the same GSTIN condition.
    - **Fieldset "Printed bill":**
      - Bill style, header lines textarea (rows 3), footer lines textarea (rows 3) and the UPI ID, each with hint "Up to 3 lines, 48 characters each".
      - Five checkboxes: "Show FSSAI number", "Show customer name and phone", "Show table", "Show 'Served by'", "Show each item's GST rate".
      - A link button "Bill copies are set per printer" calling `onOpenPrinters`.
    - **Fieldset "Order handling":** kitchen slip on edit and hold orders, moved verbatim.
    - **Preview:** debounce form changes 300 ms → `POST /api/settings/bill-preview` → `<iframe sandbox="allow-same-origin" srcDoc={html} title="Bill preview">`. On error, keep the previous `html` and show the message in a `role="alert"` under the form.
    - **Save:** shows "Saved ✓" or the error, like the profile card.
  - In `Settings.tsx`, render `{active === "bill" && <BillSettings onOpenPrinters={() => setActive("printers")} />}` and `{active === "ai-suggestions" && <AiSuggestionSettings />}`.
- [ ] **Step 4: Run** `npx vitest run apps/ui` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: E2E.**
  - Write `tools/e2e/bill-settings.js` in the style of `tools/e2e/staff-activity.js`. It runs against the demo (`npm run dev`, admin / demo1234):
    - Open Settings and assert the "Bill settings" and "AI suggestions" cards exist.
    - Open Bill settings and type "Pure veg" into the header lines; the preview iframe's document contains "Pure veg" within 2 s.
    - Untick "Show FSSAI number", Save, reload; the box is still unticked.
    - Open AI suggestions and assert the "Show popular items" checkbox exists.
  - Run it and `tools/e2e/ai-assistant.js`. Stop the dev server by PID afterwards.
- [ ] **Step 6: Commit** `feat(ui): Bill settings and AI suggestions cards with live preview`.

### Task 7: Full verification

- [ ] `npm test`. Expected: all suites pass (baseline before this phase: domain + server + UI green on `codex/UI-change`).
- [ ] `npm run typecheck`. Expected: no errors.
- [ ] Manual check in the dev app:
  - Set a header line, untick FSSAI, tick Served by and item GST, then issue a dine-in bill.
  - The thermal print job (Settings → Print jobs), the A4 receipt in the billing panel and the digital bill all show the header, hide FSSAI, and show "Served by" and item GST.
  - Reprint a bill issued before the change: it's unchanged.
- [ ] Update `docs/operations/bill-format.md` with a short "Bill settings" section listing the new options and the new-bills-only rule. Commit `docs: bill settings options`.
