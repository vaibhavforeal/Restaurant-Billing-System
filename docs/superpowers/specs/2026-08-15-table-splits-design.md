# Table Splits (M3s) — Design

**Date:** 2026-08-15
**Status:** Approved (user, 2026-08-15)
**Parent spec:** `2026-08-13-desktop-pos-design.md`
**Sequencing:** Ships as milestone **M3s**, after M3a (orders/KOT, merged) and **before M3b** (printing) — so M3b's KOT and cancellation-slip templates include split labels from day one.

## Goal

A dine-in table can be split into two or more customer groups. Each split is a
full, independent order on the same table: its own punches, its own KOTs, its
own cancel flows, and (in M4) its own bill. Tables that never split look and
behave exactly as they do today, everywhere.

## Decisions (made with user)

1. **Splits happen at ordering time** as separate orders per split — not
   item-division at billing. (M4 bills each split separately for free.)
2. **Auto letters** A, B, C… — no typing, no rename. "Add split" creates the
   next letter.
3. **Ships before M3b printing.**

## Data model

Migration `003-order-split-label`:

```sql
ALTER TABLE orders ADD COLUMN split_label TEXT;          -- NULL for parcels
UPDATE orders SET split_label = 'A' WHERE type = 'dine_in';  -- backfill
```

- Every dine-in order carries a `split_label`, assigned once at creation.
  Never relabelled afterwards.
- Parcels: always `NULL`. Parcel splitting is out of scope.

## Label assignment rule

Inside the existing order-create transaction (single-writer SQLite makes this
race-free):

1. Collect `split_label` of the table's orders with status `open` **or**
   `billed`. (`billed` counts so a billed-but-unsettled group's letter is not
   reused within the same seating.)
2. Assign the first letter of `A`–`Z` not in that set.
3. All 26 taken → `409 {"error": "table has too many open splits"}`.

Letters recycle naturally: when a table fully clears (all orders settled or
cancelled), the next seating starts at `A` again.

## Server changes

- **`POST /api/orders` (dine_in):** no longer requires the table to be free —
  an occupied table accepts another order, which becomes the next split. Table
  must still exist and be active. `client_ref` idempotency is unchanged and
  checked first (replays return the existing order and do not consume a
  letter).
- **Table status derivation** (tables.ts): any `open` order → `occupied`; else
  any `billed` → `billed`; else `free`. (Replaces the "latest open/billed
  order" rule, which is wrong once a table has several orders.)
- **`GET /api/tables`:** each table gains
  `activeOrders: [{ id, splitLabel, status }]` — orders with status `open` or
  `billed`, sorted by label. This feeds the tap-picker; `billed` must be
  included or a billed-but-unsettled split becomes unreachable from Tables
  (today tapping a billed table opens that order, and M4 settle needs it).
- **Order JSON** (create/get/list): includes `splitLabel: string | null`.
- **KOT active-board payload** (kots.ts): each KOT gains `splitLabel` from its
  order.
- **WS:** no new events. Split creation broadcasts the same events order
  creation already does; implementer must verify `table.changed` (or
  `order.updated`) fires on create so open Tables screens refresh their
  picker data live.
- **roles.ts untouched:** anyone who can create orders can create splits.

## UI changes

- **Tables grid:** tap a table with no active orders → creates split A
  (today's behavior, no new UI). Tap with exactly 1 active order → opens it
  directly, whether open or billed (fast path preserved, matches today's
  billed-table behavior). Tap with 2+ → inline picker listing `Split A`,
  `Split B`, … (billed ones marked) plus `New split` and a close/back
  affordance. Status line on the table card shows `occupied · N splits` when
  the table has N ≥ 2 active orders.
- **OrderScreen (dine-in):** header becomes `{tableName} · {label} — {status}`
  (e.g. `T1 · B — open`); parcels keep `Parcel — {status}`. New `+ Split`
  button (visible while the order is open) creates the next split on the same
  table and navigates to it.
- **Kitchen board:** context line shows `T1 · B` when `splitLabel` is set and
  ≠ `'A'`; plain `T1` for split A; `Parcel` unchanged. (Split A keeps today's
  look; only extra groups grow a suffix — deterministic, no re-rendering of
  already-displayed tickets when siblings appear.)
- **Draft carts:** already keyed `forkflow.draft.{orderId}` — splits get
  independent drafts with zero changes.

## Testing

Server vitest:

- Letter sequence A→B→C on one table; letter reuse after all orders close;
  `billed` letters not reused; parcel label stays `NULL`.
- 26-splits cap → 409.
- Status derivation: open+open, open+billed, billed-only, all-closed.
- `GET /api/tables` activeOrders shape (billed splits included); order JSON
  `splitLabel`; KOT payload `splitLabel`.
- `client_ref` replay on an occupied table returns the existing order and
  consumes no letter.

Browser gate: extend the M3a click-through script (`.e2e-scratch/m3a_e2e.py`)
with a split scenario — add split B on an occupied table via the picker,
punch+send from B, kitchen shows `T1 · B`, split A's screen unaffected.

## Out of scope (deliberate)

- Parcel splits, split rename, moving/merging items between splits,
  bill-time item division (M4 decision), per-split notes.

## M4 / M3b notes

- **M4 Billing:** bills are per order, so per-split billing needs no extra
  design. A table frees when ALL its orders settle.
- **M3b Printing:** KOT + cancellation-slip templates must print the split
  label using the same rule as the kitchen board (suffix only when ≠ 'A').
