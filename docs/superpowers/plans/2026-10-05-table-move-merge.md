# Table Move and Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff move an open dine-in order to a free table and merge two open orders into one bill, with the folded-in table staying linked and occupied until payment.

**Architecture:** A merge re-parents the folded order's items and KOTs into the receiving order and closes the folded order as `cancelled` with `merged_into`; a `table_links` row keeps the other table occupied while the combined order is open or billed. A shared table-label helper (`T3, T4`) feeds order JSON, the kitchen board, kitchen slips and the receipt snapshot. A new server module serves `move`/`merge`; the UI adds dialogs on the order screen and linked-table cards.

**Tech Stack:** TypeScript (strict), better-sqlite3, Zod 4, Fastify 5, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-table-move-merge-design.md`

## Global Constraints

- Migration number: **024**.
- Only `open` dine-in orders can be moved or merged; billed/settled/cancelled/merged orders → 409.
- Error copy (verbatim): occupied destination `"That table is occupied — merge instead"`; inactive `"Choose an active table"`; move of non-open `"Only open orders can be moved"`; merge of non-open `"Both orders must be open to merge"`; reserved-now uses the existing `assertTableNotReserved` message.
- Items keep their snapshot prices; only the order's `price_tier` changes on move (to the destination table's tier). A merge keeps the receiving order's tier and captain.
- Table label = own table name, then active linked table names in link order, joined by `", "` — e.g. `T3, T4`.
- Kitchen slip text, table names only (no KOT numbers): move `T3 → T7`; merge → the resulting label, e.g. `T3, T4`.
- Permission: existing `orders.update` (admin, cashier, waiter).
- A link is active only while its order's status is `open` or `billed`.
- Cancellation counts/reports exclude orders with `merged_into` set.
- Git: the working tree contains local items left out on purpose (`output/`, `.codex/`, `.superdesign/`, `({text`, the `.claude/settings.json` deletion) — stage only task files, never `git add -A`.

## Review Focus

1. **Double-tap / retry** — sending the same move twice must not move the order twice or consume a second split letter. Test in Task 3.
2. **Merging an order whose table is already linked to the receiving order** (T4's second group into the T3+T4 bill) — no duplicate link; label stays `T3, T4`. Test in Task 4.
3. **Paying the combined bill frees every linked table**, even when a linked table also had other bill groups that settled earlier. Test in Task 2.
4. **Stale screen** — merging into an order that another device just billed must 409, leaving both orders untouched. Test in Task 4.
5. **Guest QR request from a linked table** — accepting it into the combined order works when tiers match and is refused with the existing "different pricing" message when they don't. Test in Task 4.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/domain/src/migrations/024-table-transfers.ts` (+ test) | `orders.merged_into`, `table_links`, `order_table_events` + triggers |
| `packages/domain/src/table-transfer-schemas.ts` | `OrderMove`, `OrderMerge` Zod schemas |
| `apps/server/src/table-label.ts` (+ test) | `orderTableLabel`, `activeLinkFor` queries |
| `apps/server/src/tables.ts`, `apps/server/src/mappers.ts`, `apps/server/src/kots.ts`, `apps/server/src/billing.ts`, `apps/server/src/reports.ts`, `apps/server/src/operational-reports.ts` | link-aware status, labels, merged exclusion |
| `apps/server/src/table-transfer.ts` (+ test) | `move`/`merge` routes, event log, kitchen slips |
| `apps/server/src/print/templates.ts`, `apps/server/src/print/queue.ts`, `apps/server/src/server.ts` | `tableChangeSlip`, print kind `"table"`, registration |
| `apps/server/src/guest-ordering.ts` | accept guest request into a linked combined order |
| `apps/ui/src/table-transfer.ts` (+ test), `apps/ui/src/screens/TableTransferDialogs.tsx` | picker logic and dialogs |
| `apps/ui/src/screens/OrderScreen.tsx`, `apps/ui/src/screens/Tables.tsx`, `apps/ui/src/types.ts` | actions, linked cards, label display |
| `docs/operations/table-move-merge.md`, `docs/operations/tables-workspace.md`, `APPLICATION_OVERVIEW.md` | docs |

---

### Task 1: Migration 024 and request schemas

**Files:**
- Create: `packages/domain/src/migrations/024-table-transfers.ts`, `packages/domain/src/migrations/024-table-transfers.test.ts`, `packages/domain/src/table-transfer-schemas.ts`
- Modify: `packages/domain/src/migrations/index.ts`, `packages/domain/src/index.ts`, `packages/domain/src/migrations/001-initial.test.ts` (table list, if it enumerates tables)

**Interfaces:**
- Produces: column `orders.merged_into TEXT REFERENCES orders(id)`; table `table_links(id PK, table_id NOT NULL FK, order_id NOT NULL FK, linked_at NOT NULL, linked_by NOT NULL FK users)` with indexes on `table_id` and `order_id`; table `order_table_events(id PK, kind NOT NULL CHECK IN ('move','merge'), order_id NOT NULL, target_order_id, from_table_id, to_table_id, folded_captain_name, created_at NOT NULL, created_by NOT NULL FK users, client_ref NOT NULL UNIQUE, request_json NOT NULL)` with update/delete triggers whose messages contain `append-only`.
- Produces: `OrderMove = z.object({ clientRef: z.string().min(8).max(64), tableId: z.string().min(1) }).strict()`; `OrderMerge = z.object({ clientRef: z.string().min(8).max(64), targetOrderId: z.string().min(1) }).strict()`, both exported from `@forkflow/domain`.

- [ ] **Step 1: Write failing test** `"adds merge tracking, table links and an append-only transfer log"`: migrate to < 24, insert a user, table and order, migrate fully → `orders.merged_into` is `null`; inserting a `table_links` row succeeds; inserting an `order_table_events` row with `kind: 'swap'` throws; `UPDATE`/`DELETE` on `order_table_events` throw `/append-only/`; duplicate `client_ref` throws.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/migrations/024-table-transfers.test.ts` → FAIL.
- [ ] **Step 3: Implement** `migration024` (`version: 24, name: "table-transfers"`), register it after `migration023`, and add the schemas.
- [ ] **Step 4: Run** `npx vitest run packages/domain` → PASS (update any migration test asserting the final table list or version).
- [ ] **Step 5: Commit** — `feat(domain): migration 024 for table move and merge`.

---

### Task 2: Table labels and link-aware table status

**Files:**
- Create: `apps/server/src/table-label.ts`, `apps/server/src/table-label.test.ts`
- Modify: `apps/server/src/tables.ts`, `apps/server/src/mappers.ts` (`loadOrderJson`), `apps/server/src/kots.ts` (send context line and `GET /api/kots` board), `apps/server/src/billing.ts` (receipt snapshot), `apps/server/src/reports.ts:24`, `apps/server/src/operational-reports.ts:94`, `apps/ui/src/types.ts`

**Interfaces:**
- Consumes: Task 1 tables.
- Produces (`table-label.ts`):
  - `activeLinkedTableNames(db: Database, orderId: string): string[]` — names of tables with an active link to `orderId`, ordered by `linked_at, id`.
  - `orderTableLabel(db: Database, orderId: string): string | null` — `null` for parcels; otherwise own table name followed by `activeLinkedTableNames`, joined `", "`.
  - `activeLinkForTable(db: Database, tableId: string): { orderId: string; status: "open" | "billed"; label: string } | null`.
- Produces: `loadOrderJson(...)` gains `tableLabel: string | null`; kitchen tickets' `tableName` carries the label (so the Kitchen screen and KOT slips show `T3, T4` with no UI change); receipt snapshot `tableName` uses the label at bill issue.
- Produces: `GET /api/tables` table JSON gains `link: { orderId: string; status: "open" | "billed"; label: string; tableName: string } | null` (`tableName` = the receiving order's own table, for "with T3"). Status: occupied if any open order or `link.status === "open"`; billed if no open order and (billed order or `link.status === "billed"`). `toTables` keeps its batched queries (one extra grouped query for links). UI `TableInfo` and `Order` types gain `link` and `tableLabel`.
- Produces: cancellation count (`reports.ts`) and cancellation report (`operational-reports.ts`) add `AND o.merged_into IS NULL`.

- [ ] **Step 1: Write failing tests** (insert links/orders directly in SQL for setup):
  - `"labels an order with its active linked tables"` → `orderTableLabel` returns `"T3, T4"`; after the order is settled, `activeLinkedTableNames` is `[]`.
  - `"keeps a linked table occupied until the combined bill is paid"` (Review Focus 3): T4 has its own settled group plus an active link to an open order on T3 → `GET /api/tables` shows T4 `occupied` with `link.tableName: "T3"`; bill the T3 order → T4 `billed`; settle it → T4 `free`, `link: null`.
  - `"shows the combined label on the kitchen board and receipt"`: kitchen board ticket `tableName === "T3, T4"`; issued bill `receipt.tableName === "T3, T4"`.
  - `"excludes merged orders from cancellation counts"`: an order with `status='cancelled', merged_into` set is not counted by day-end or listed in the cancellation report.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/table-label.test.ts` → FAIL.
- [ ] **Step 3: Implement** the helpers and wire them into the files listed.
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc --noEmit -p .` → PASS (the two `captain-https.test.ts` tests may fail only for the known PowerShell reason in the main folder).
- [ ] **Step 5: Commit** — `feat(server): table labels and link-aware table status`.

---

### Task 3: Move route and kitchen slips

**Files:**
- Create: `apps/server/src/table-transfer.ts` (`registerTableTransfer(app: FastifyInstance): void`), `apps/server/src/table-transfer.test.ts`
- Modify: `apps/server/src/print/templates.ts`, `apps/server/src/print/queue.ts` (`PrintJobJson.kind` adds `"table"`), `apps/server/src/server.ts` (`enqueuePrint` kind union adds `"table"`; register after `registerKots`)

**Interfaces:**
- Consumes: `OrderMove` (Task 1); `orderTableLabel` (Task 2); `nextSplitLabel(db, tableId)` (`@forkflow/domain`); `assertTableNotReserved(db, tableId, now)` (`reservation-rules.ts`); `bestEffortPrint` (`print/best-effort.ts`); `app.enqueuePrint`.
- Produces:
  - `tableChangeSlip(ctx: { stationName: string; text: string; atMs: number }, paperWidth: 58 | 80, profile?: PrintProfileInput): Buffer` — heading "TABLE CHANGE", the station name, the text in large/bold, time; finished with the profile like `kotSlip`.
  - `notifyKitchenTableChange(app, orderId: string, text: string): string[]` (in `table-transfer.ts`) — for each distinct station with a KOT on `orderId` whose `done_at IS NULL`, render via `bestEffortPrint` and enqueue kind `"table"`, label `Table change — <text>`; returns print error messages.
  - `POST /api/orders/:id/move` (`orders.update`) body `OrderMove` → `{ order, printErrors: string[] }`. Idempotency via `order_table_events.client_ref` + `request_json` (identical → 200 with current order; different → 409 `"Table change reference already used for a different request"`). Effects and 409 copy per Global Constraints and spec §4. After commit: broadcast `order.updated`, `table.changed` for both tables, `kot.updated` for the order's KOTs.

- [ ] **Step 1: Write failing tests:**
  - `"moves an open order to a free table with a new split letter and the destination tier"`: Non-AC T3 order with a sent item (₹200 snapshot) → move to AC T7 → order `tableId` T7, `splitLabel` `"A"`, `priceTier` `"ac"`, item price still 20000; one `move` event row; T3 free.
  - `"refuses occupied, inactive, reserved-now and non-open moves"` with the exact messages.
  - `"replays an identical move without moving twice"` (Review Focus 1): same body twice → 200 both, one event row, T7 still split `"A"`; same clientRef different table → 409.
  - `"prints a table-change slip per station with open tickets"`: two stations with unfinished KOTs → two jobs of kind `"table"` whose bytes contain `T3 → T7` and not `#`; a station whose KOT is done gets none.
  - `"lets a waiter move tables"`.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/table-transfer.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/server` and `npx tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit** — `feat(server): move an order to another table`.

---

### Task 4: Merge route and guest-request acceptance

**Files:**
- Modify: `apps/server/src/table-transfer.ts`, `apps/server/src/table-transfer.test.ts`, `apps/server/src/guest-ordering.ts:225-240` (+ its test)

**Interfaces:**
- Consumes: `OrderMerge`, `orderTableLabel`, `notifyKitchenTableChange` (Tasks 1–3).
- Produces: `POST /api/orders/:id/merge` (`orders.update`) body `OrderMerge` (`:id` = folded order S, `targetOrderId` = receiving order R) → `{ order: R, printErrors }`. One transaction implementing spec §4 Merge steps 1–5 exactly (re-parent `order_items` and `kots`; close S as `cancelled` with `closed_at`, `merged_into = R`; add a link for S's table unless it is R's table or already actively linked to R; re-point active links targeting S to R, dropping self/duplicate links; log a `merge` event with S's `captain_name`). Same idempotency pattern as move. Kitchen slip text = `orderTableLabel(R)`. Broadcast `order.updated` (S and R), `table.changed` (all tables involved), `kot.updated` (R's KOTs).
- Produces (guest acceptance): when `body.orderId` names an open dine-in order that the request's table is **actively linked** to, accept it (instead of requiring `order.table_id === row.table_id`); the existing tier check still applies (`"This bill uses different pricing. Create a new bill group."`).

- [ ] **Step 1: Write failing tests:**
  - `"merges two tables into one bill and keeps the other table linked"`: T3 order (1 sent KOT, accepted) + T4 order (1 pending, 1 sent) → merge T4 into T3 → R has all 3 items, both KOTs with acceptance unchanged; S `status: "cancelled"`, `mergedInto: R`; `R.tableLabel === "T3, T4"`; T4 occupied with `link.tableName: "T3"`; stock moves for S's items still reference the same order item ids; bill R → one bill containing all items.
  - `"merges two bill groups at the same table without a link"`.
  - `"does not duplicate a link when a linked table's other group joins"` (Review Focus 2): after T4→T3 merge, merge T4's second group into R → one link row for T4, label `"T3, T4"`.
  - `"carries links when a combined order is merged or moved"`: move R to T9 → label `"T9, T4"`.
  - `"refuses to merge a billed order"` (Review Focus 4): bill R, then merge T5 into R → 409 `"Both orders must be open to merge"`, both orders unchanged.
  - `"replays an identical merge"` and 409 on reused reference with different target.
  - `"prints the merged label to each station"`: slip bytes contain `T3, T4`.
  - Guest: `"accepts a guest request from a linked table into the combined order"` (Review Focus 5): same tier → accepted into R; different tier → 409 with the existing pricing message.
- [ ] **Step 2: Run** the focused tests → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit** — `feat(server): merge orders into one bill with linked tables`.

---

### Task 5: Order screen move and merge dialogs

**Files:**
- Create: `apps/ui/src/table-transfer.ts`, `apps/ui/src/table-transfer.test.ts`, `apps/ui/src/screens/TableTransferDialogs.tsx`
- Modify: `apps/ui/src/screens/OrderScreen.tsx` (actions beside "+ Split" at :335 and in the Captain "More" menu at :326-330; header uses `order.tableLabel`)

**Interfaces:**
- Consumes: `GET /api/tables` (`TableInfo` with `link`), `GET /api/orders` (open orders), the two routes.
- Produces (`table-transfer.ts`):
  - `moveTargets(tables: TableInfo[], currentTableId: string): Array<{ table: TableInfo; selectable: boolean; note: "occupied — merge instead" | "reserved now" | null }>` — active tables except the current one; selectable only when `status === "free"`; inactive tables omitted.
  - `mergeTargets(orders: Order[], currentOrderId: string): Array<{ tableLabel: string; options: Array<{ orderId: string; label: string }> }>` — other open dine-in orders grouped by `tableLabel`, option label `"<tableName> (<split>) · <n> items · ₹<total>"` using active (non-cancelled) items.
- UI: **Move table…** opens a picker from `moveTargets`, confirm `"Move <label>-<split> to <table>?"`; **Merge…** opens `mergeTargets`, then a choice "Bill at <this table> (this order)" / "Bill at <other table>" with the help text from spec §6; the request sends `:id` = the order folded in and `targetOrderId` = the order that keeps the bill. Status line `"Moved to T7 · kitchen notified"` / `"Merged · T3, T4 billed together"`, plus any `printErrors`. Each action has its own `clientRef` and in-flight guard; on 409 show the server message and refresh. Shown only when the order is open and dine-in.

- [ ] **Step 1: Write failing tests** for `moveTargets` (free selectable; occupied/linked-occupied → `"occupied — merge instead"`; reserved → `"reserved now"`; inactive and current omitted) and `mergeTargets` (grouping, labels, excludes current/billed/parcel orders).
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/table-transfer.test.ts` → FAIL.
- [ ] **Step 3: Implement** helpers, dialogs and OrderScreen wiring.
- [ ] **Step 4: Run** `npx vitest run apps/ui`, `npm run typecheck -w @forkflow/ui`, `npm run build -w @forkflow/ui` → PASS.
- [ ] **Step 5: Commit** — `feat(ui): move and merge tables from the order screen`.

---

### Task 6: Tables screen linked cards

**Files:**
- Modify: `apps/ui/src/screens/Tables.tsx` (card body/footer around :250-256, open handler :132-150)

**Interfaces:**
- Consumes: `TableInfo.link` (Task 2), `Order.tableLabel`.
- Produces: a linked table's card shows its occupied/billed status and the note `"with <link.tableName>"`; tapping it opens `link.orderId` (if it also has its own groups, the existing split chooser lists them plus the combined order labelled with `link.label`). The receiving table's card shows the combined label. Status filter counts already follow `status` from the server.

- [ ] **Step 1: Write failing test** in `apps/ui/src/table-transfer.test.ts`: `tableCardNote(table: TableInfo): string | null` → `"with T3"` for a linked table, `null` otherwise; `tableOpenTargets(table: TableInfo): Array<{ orderId: string; label: string }>` → own groups plus the linked combined order.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** helpers and wire Tables.tsx.
- [ ] **Step 4: Run** `npx vitest run apps/ui`, UI typecheck, UI build → PASS.
- [ ] **Step 5: Commit** — `feat(ui): show linked tables on the tables screen`.

---

### Task 7: Docs and end-to-end check

**Files:**
- Create: `docs/operations/table-move-merge.md`
- Modify: `docs/operations/tables-workspace.md` (link), `APPLICATION_OVERVIEW.md` (migrations 001–024; Tables row in section 5 adds `table_links`, `order_table_events`; API table adds the two routes; section 13 Table splits row: merging is now implemented, un-merge is not)

- [ ] **Step 1: Write the guide:** moving a party; merging two tables or two bill groups; linked tables stay occupied until payment; prices (existing items keep prices, new items use the receiving table); kitchen slips; who can do it; what cannot be undone.
- [ ] **Step 2: Update** the overview and tables guide.
- [ ] **Step 3: Full checks:** `npx tsc --noEmit -p .`, `npm run typecheck -w @forkflow/ui`, `npx vitest run`, `npm run build -w @forkflow/ui`, `npm run test:packaging`.
- [ ] **Step 4: Browser check** on a scratch data dir (`FORKFLOW_DATA_DIR=.e2e-scratch/table-transfer`, server source run with tsconfig paths, built UI on port 4100): move T3→T7 and confirm the Kitchen screen label and a `"table"` print job; merge T7 with T4, confirm T4 shows "with T7"; bill and pay; confirm both tables free. Repeat the move from the Captain app (`/captain/`). Record results; stop servers and delete the scratch dir.
- [ ] **Step 5: Commit** — `docs: table move and merge guide`.
