# Table Move and Merge — Design

**Date:** 5 October 2026
**Status:** Approved in conversation; awaiting written-spec review
**Builds on:** `2026-08-15-table-splits-design.md` (bill groups per table)

## 1. Goal

Staff can move a running dine-in order to another table, and combine two orders — on different tables or two bill groups on the same table — into one bill, without disturbing prices already quoted or confusing the kitchen.

Success means:

- A party moving from T3 to T7 keeps its order, items, kitchen tickets and prices; the kitchen sees and receives a slip showing the new table.
- Two orders merged into one bill produce exactly one bill; the second table stays occupied and linked to the combined order until that bill is paid.
- Billing, receipts, GST, stock, costing and reports keep working unchanged because one order still sits behind one bill.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Merged second table | Stays **linked and occupied** until the combined bill is paid; both tables open the combined order |
| Same-table merge | Merging two bill groups at the same table is supported (no link needed) |
| Prices | Items already ordered keep their prices; new items use the receiving/destination table's AC/Non-AC tier |
| Kitchen | Kitchen screen updates live; each affected station prints a slip with **table names only** — move: `T3 → T7`; merge: `T3, T4` (no KOT numbers) |
| Who | Cashiers, admins and captains/waiters (existing `orders.update` permission); staff name logged |
| Allowed states | Open orders only; nothing billed, settled or cancelled can be moved or merged |
| Move destination | Must be a free, active table that is not reserved right now; an occupied destination is offered as a merge instead |
| Move granularity | One bill group at a time; it takes the next split letter at the destination |
| Un-merge | Not supported in this version |
| Storage approach | Fold the merged order into the receiving order; record table links separately |

## 3. Data model (migration 024)

### `orders`

- `merged_into TEXT NULL REFERENCES orders(id)` — set on an order that was folded into another. That order closes with `status = 'cancelled'` and `closed_at` set, so no new order status is introduced.

### `table_links` (new)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | uuidv7 |
| `table_id` | TEXT NOT NULL | FK `dining_tables(id)` |
| `order_id` | TEXT NOT NULL | FK `orders(id)` — the combined order |
| `linked_at` | INTEGER NOT NULL | |
| `linked_by` | TEXT NOT NULL | FK `users(id)` |

A link is **active** only while its order's status is `open` or `billed`; settling or cancelling the order deactivates every link without clean-up. Index on `(table_id)` and `(order_id)`. When a combined order moves, its links are kept (they describe the other tables, not the order's own table).

### `order_table_events` (new, append-only)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | uuidv7 |
| `kind` | TEXT NOT NULL | `CHECK (kind IN ('move','merge'))` |
| `order_id` | TEXT NOT NULL | the order acted on (moved order, or the folded-in order) |
| `target_order_id` | TEXT NULL | receiving order for a merge |
| `from_table_id` | TEXT NULL | |
| `to_table_id` | TEXT NULL | |
| `folded_captain_name` | TEXT NULL | captain of the folded-in order, for the record |
| `created_at` | INTEGER NOT NULL | |
| `created_by` | TEXT NOT NULL | FK `users(id)` |
| `client_ref` | TEXT UNIQUE NOT NULL | retry reference |
| `request_json` | TEXT NOT NULL | retry fingerprint |

Update and delete triggers raise `ABORT` (message contains `append-only`).

## 4. Rules

### Move — order O to table D

Allowed when O is open and dine-in, D is active, D has no open/billed order and no active link, and D is not reserved right now (existing `assertTableNotReserved`). Otherwise 409:

- occupied: `"That table is occupied — merge instead"`
- reserved now: existing reservation message
- inactive: `"Choose an active table"`
- not open: `"Only open orders can be moved"`

Effect, in one transaction: `orders.table_id = D`; `split_label` = first free letter at D using the existing split-label rule (A when empty); `orders.price_tier = D.price_tier` (new items only; existing `order_items` keep their snapshot prices); captain unchanged; log a `move` event.

### Merge — order S folded into receiving order R

Allowed when S ≠ R, both are open dine-in orders, and neither is merged. Otherwise 409 `"Both orders must be open to merge"`.

Effect, in one transaction:

1. `UPDATE order_items SET order_id = R WHERE order_id = S` (pending, sent and cancelled items alike).
2. `UPDATE kots SET order_id = R WHERE order_id = S` — acceptance/done timestamps unchanged.
3. S: `status = 'cancelled'`, `closed_at = now`, `merged_into = R`.
4. If S's table ≠ R's table and S's table has no active link to R already: insert a `table_links` row (S's table → R). Also re-point any active links that targeted S to R (dropping any that would point a table at its own order's table or duplicate an existing link).
5. Log a `merge` event with S's captain name.

Item prices, stock movements (keyed by order item) and costs are untouched. R keeps its own captain and price tier; new items use R's tier.

### Table status

A table is **occupied** if it has an open order or an active link to an open order; **billed** if it has no open order but has a billed order or an active link to a billed order; otherwise free/reserved as today. `GET /api/tables` reports, per table, its active orders plus `linkedOrderId` (the combined order this table is linked to, if any) and, for an order with links, `linkedTableNames`.

### Table label

An order's table label is its own table name followed by its active linked tables' names, comma-separated, in link order: `T3, T4`. Used by the order header, Tables cards, Kitchen screen, kitchen slips, and the receipt snapshot taken at bill issue (issued bills never change afterwards).

## 5. Server API

Both routes use the existing `orders.update` permission and the usual licensing checks.

| Route | Body | Response |
| --- | --- | --- |
| `POST /api/orders/:id/move` | `{ clientRef, tableId }` | `{ order, printErrors }` |
| `POST /api/orders/:id/merge` | `{ clientRef, targetOrderId }` — `:id` is S, `targetOrderId` is R | `{ order: R, printErrors }` |

- Idempotent by `clientRef`: identical replay returns the current result with 200; same reference with a different body → 409. Not added to the offline retry queue.
- After commit: broadcast `order.updated` (affected orders), `table.changed` (every affected table), `kot.updated` (each moved ticket).
- Kitchen slip: one per station that has unfinished tickets on the resulting order, via the station's printer and KOT print profile, as a new print-job kind `"table"`. Text: move → `T3 → T7`; merge → the new label (`T3, T4`). Slip rendering is best-effort (as KOT/cancel slips are); a print problem is returned in `printErrors` and never rolls back the change.

### Related behaviour

- **Guest QR requests:** pending requests keep their table. When accepting one from a linked table, the selectable bill groups include the combined order it is linked to.
- **Service calls:** unchanged (keep their table).
- **Reservations:** a seated reservation keeps pointing at its original order; moves/merges don't alter reservations.
- **Kitchen acceptance gate:** applies to the receiving order's full set of tickets.
- **Reports:** sales/costing/profit follow bills (unchanged). Cancellation report and day-end cancellation count exclude orders with `merged_into` set.

## 6. User interface

Same controls on the counter POS and in the Captain app (shared order screen).

- **Order screen** (open dine-in orders only): **Move table…** and **Merge…** beside "+ Split" (counter) and in the "More" menu (Captain).
  - Move picker: active tables; free ones selectable; occupied ones marked "occupied — merge instead"; reserved-now ones marked "reserved now". Confirm "Move T3-A to T7?".
  - Merge picker: every other open bill group grouped by table, e.g. "T4 (A) · 3 items · ₹540". Then choose where the bill goes — "Bill at T3 (this order)" / "Bill at T4" — with help text that the other table stays linked until payment and new items use the receiving table's prices.
  - Result status: "Moved to T7 · kitchen notified" / "Merged · T3, T4 billed together", plus any print problem.
- **Tables screen:** a linked table shows occupied with "with T3"; tapping it opens the combined order. The receiving table's card shows "T3, T4". Status filters count linked tables.
- **Kitchen screen:** ticket headers update live to the new label.
- **Receipt/bill:** table text shows the label at bill issue (`T3, T4`).

## 7. Edge cases

- Moving a combined order: links stay (`T9, T4`); further merges add links.
- A linked table with other bill groups stays occupied while its link is active; all linked tables free when the combined bill is paid.
- Cancelling a combined order follows existing rules (sent items cancelled first); links deactivate with it.
- Concurrency: each action re-validates inside its transaction; stale screens get 409 and refresh.
- Merging onto a table that is reserved now is allowed (the party is already seated); moving onto it is blocked.
- Backups/restore: all data in SQLite.

## 8. Testing

- **Migration/domain:** migration 024 (columns, tables, triggers); link-aware table status; split letter on move; table label builder.
- **Server:** move success and each refusal; merge across tables and same table; chained merges and moving a combined order; items/KOTs/acceptance/prices/stock moves preserved; linked table occupied then freed after settlement; retry and conflict; cancellation counts exclude merged orders; guest-request acceptance offers the combined order; slips queued per station with the exact text; waiter allowed; receipt label `T3, T4`.
- **UI unit tests:** move-picker classification (free/occupied/reserved/inactive); merge-target grouping and labels.
- **Browser check (scratch database):** move T3→T7 (kitchen screen + fake-printer slip); merge T7 with T4; bill and pay; both tables free; repeat key steps in the Captain app.

## 9. Out of scope

- Un-merging or splitting a combined order back apart.
- Moving individual items between orders.
- Takeaway (parcel) moves or merges.
- Repricing existing items on move/merge.
