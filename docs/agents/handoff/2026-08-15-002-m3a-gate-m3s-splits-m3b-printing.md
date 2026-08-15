# Handoff: M3a gate passed + M3s table splits + M3b printing/WS-hardening shipped

**Date:** 2026-08-15 (session ran 00:39 → ~15:45 IST)
**Session scope:** Picked up the 001 handoff → M3a browser gate (the M3b blocker) → user requested table splits mid-session → M3s spec+plan+build+merge → M3b plan+build+merge. M4 Billing is planned-next, not started.

## Goal

Clear the M3a acceptance gate that blocked M3b, then plan and execute M3b (printing + WS hardening). Mid-session the user added a feature: tables must split into two or more customer groups — designed, approved, and shipped as M3s before M3b so print templates carry split labels from day one. User also settled the M3b transport question: all three (network TCP, USB, Bluetooth), no vendor SDKs.

## Current state

- `main` at `7e4506d`, pushed to origin. **202/202 vitest green, typecheck clean, tree clean, no feature branches.** Three milestones merged today: nothing in flight.
- Working software: everything M1–M3a had, plus **table splits** (auto letters A–Z, picker on multi-split tables, "+ Split" on OrderScreen, `T1 · B` kitchen context) and **printing** (printers/stations admin in Settings, test-print, KOT + cancellation slips over TCP/USB-spooler/Bluetooth-COM, in-memory queue with visible failed jobs + retry, `print.job` live panel) on a **hardened WS layer** (first-message auth, no tokens in URLs/logs, 4401-fatal clients, session-expiry → PIN pad, revalidation sweep + close-on-logout/deactivate).
- **Never validated: a real physical printer.** The gate verified real ESC/POS bytes against a throwaway TCP socket; the Windows-spooler and COM sinks are inspection/review-verified only. First real-hardware test-print is a human step when a printer exists.
- Browser gates are committed and repeatable: `tools/e2e/gate.py` (41 steps; needs fresh scratch DB).

## What was accomplished

1. **M3a gate passed 24/24** despite the Playwright MCP being absent again — ran Python Playwright from the hermes-agent venv instead (now the sanctioned runner). Included the LAN-origin check: `typeof crypto.randomUUID === "undefined"` confirmed, uuid fallback exercised end to end. Gate script later committed as `tools/e2e/gate.py` (env: GATE_BASE, GATE_LAN optional).
2. **M3s table splits shipped** (spec `2026-08-15-table-splits-design.md`, plan `2026-08-15-m3s-table-splits.md`, 10 commits): migration 003 `orders.split_label`, `nextSplitLabel` domain helper (open+billed hold letters), `activeOrders` replacing `openOrderId`, splits picker, `+ Split` with `key={orderId}` remount (draft-bleed protection), kitchen suffix only when label ≠ 'A'. Server serializers centralized in `apps/server/src/mappers.ts` first (pure refactor) so JSON fields land in one place.
3. **M3b printing + WS hardening shipped** (plan `2026-08-15-m3b-printing-ws.md`, 26 commits): see Current state. Zero new npm dependencies — spooler RAW via PowerShell Add-Type, Bluetooth via `\\.\COMn` fs writes, TCP via node:net. Repo's first snapshot convention (renderBytes + committed `__snapshots__`).
4. **Process held at scale.** Plans subagent-written from binding contracts docs; adversarial plan review found 21 (M3s) and 35 (M3b) defects pre-execution; per-task reviews found 8 more during execution (worst: print queue shipped LIFO while claiming FIFO; TCP sink double-settlement; migration 004 FK failure; zero double-tap guards in Settings). Final whole-branch reviews: M3s 4 minors, M3b 2 Important + 8 minors, all fixed-or-ledgered.

## Files changed (map, not diff — new/changed since handoff 001)

| File | What it is now |
|---|---|
| `docs/superpowers/specs/2026-08-15-table-splits-design.md` | Approved M3s spec; the split-label print rule M4 receipts must also honor. |
| `docs/superpowers/plans/2026-08-15-m3s-table-splits.md` / `2026-08-15-m3b-printing-ws.md` | Executed plans (7 + 9 tasks). |
| `packages/domain/src/split-labels.ts` / `migrations/003-order-split-label.ts` | Letter assignment (A–Z over open+billed; null when 26 used) + column/backfill. |
| `packages/domain/src/printer-schemas.ts` / `migrations/004-printer-kinds.ts` | Printer/station zod; printers table rebuild adding kind 'bluetooth' — uses `defer_foreign_keys` (see rediscover). |
| `apps/server/src/mappers.ts` | THE single home of order/KOT JSON. Add response fields here only. |
| `apps/server/src/print/escpos.ts` / `render-bytes.ts` | Byte builder; snapshot-text helper with command-aware escape counting. |
| `apps/server/src/print/templates.ts` | kotSlip/cancelSlip (80/58). Paper context is ASCII `T1 / B`; screen stays `T1 · B`. contextLine is private — export it when M4 touches templates (rule currently duplicated in kots.ts/orders.ts labels). |
| `apps/server/src/print/sinks.ts` / `queue.ts` | Three transports + fake sink; per-printer FIFO queue, snapshot semantics, retry, 100-cap. |
| `apps/server/src/printers.ts` | Printers CRUD, test-print (202+job), print-jobs list/retry (404 vs 409). Admin-only via role wildcard. |
| `apps/server/src/ws.ts` / `apps/ui/src/ws.ts` | First-message auth both sides; `wsAuth` helper in test-helpers for tests; client 4401-fatal. |
| `apps/server/src/log-redact.ts` / `main.ts` | `redactUrl` (literal `token=<redacted>`) wired into the req serializer. |
| `apps/ui/src/screens/Settings.tsx` | Grew printers/stations/print-jobs sections; single shared `busy` guard on all 9 mutating actions. |
| `apps/ui/src/screens/Tables.tsx` / `OrderScreen.tsx` / `Kitchen.tsx` / `App.tsx` / `api.ts` | Splits UI; `session.onUnauthorized` → login transition; onAuthFail wiring. |
| `apps/server/src/catalog.ts` | Station CRUD added; GET /api/kot-stations now returns ALL rows + printerId/isActive (Catalog.tsx filters inactive before ProductEditor). |
| `tools/e2e/gate.py` + `tools/e2e/README.md` | Committed 41-step browser gate incl. print scenario (TCP capture on a free port). |

## Files in flight

- Nothing uncommitted/unpushed/stashed. `main` checked out. Both SDD workspaces deleted (git is the record).
- `.e2e-scratch/` (gitignored) still holds the superseded morning-session gate script + scratch DB; `D:/scratch/forkflow-gate*` dirs hold gate scratch DBs — all disposable.
- `data/` still does not exist — no one has run the app for real.

## Failed attempts

- **A fixer subagent edited the WRONG files**: told to apply 9 findings to the assembled plan doc, it patched the scratch section files in `.e2e-scratch/m3b-plan/` instead (which lacked round-1 fixes — silent divergence). Caught by checking mtimes + grepping the real file for the defect markers; controller applied the fixes directly. Lesson: fixer dispatches must give the ABSOLUTE target path and explicitly forbid sibling scratch dirs; verify the right file changed before re-reviewing.
- **A reviewer's prescribed fix was itself wrong**: it prescribed `PRAGMA foreign_keys = OFF` inside migration 004 — a NO-OP inside a transaction (migrate.ts wraps every migration in one). Correct tool: `defer_foreign_keys = ON` (legal mid-transaction, checks at COMMIT). Don't forward reviewer prescriptions blind; the controller corrected the instruction in the fix dispatch.
- **Two implementer agents died on API errors** (connection lost mid-fix; timeout right after the gate passed). Both recovered cleanly via SendMessage resume with a "check current file state / git status first, reconcile, continue" preamble. Never re-dispatch fresh on a crash — the transcript survives.
- **Plan test-count gates drifted from reality** (+2 then +3) because fix rounds added tests the plan didn't know about. Handled by carrying an explicit offset note in every subsequent dispatch and the ledger. Future plans: state counts as "N new tests; cumulative = prior actual + N" instead of absolute totals.
- **Playwright MCP absent all session** (as in handoff 001). The hermes venv Python (`~/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe`, PYTHONIOENCODING=utf-8) is the working runner; browsers already installed and matching.
- Orphaned `tsx` child on :4100 reappeared once (the known wrapper-kill quirk) — identified via Get-CimInstance before killing; it was mine, not the user's.

## Key decisions (and what was ruled out)

- **Split model**: separate order per split at ordering time (not billing-time item division), auto letters A–Z (no rename), shipped BEFORE M3b so slip templates include labels from day one. Letters recycle only when the table fully clears; billed-but-unsettled splits hold their letter.
- **No vendor printer SDKs** — raw ESC/POS over three transports with zero new npm deps: TCP :9100, Windows spooler RAW via PowerShell Add-Type winspool (temp files, uniquified names), Bluetooth SPP as `\\.\COMn` fs writes (no baud config in v1; no timeout yet — follow-up). User explicitly opted into Bluetooth (beyond the spec).
- **GST receipt template deliberately NOT built** — it ships with M4 billing.
- **WS vocabulary grew by exactly two events** (`auth.ok`, `print.job`) as a deliberate milestone decision; the M3a freeze otherwise stands.
- **Print jobs are in-memory only** (restart loses them) — accepted v1 per spec's "visible failed jobs" intent.
- **contextLine rule ASCII on paper** (`T1 / B`) vs `T1 · B` on screens — printers' codepages can't render the middle dot; same reason templates print `Rs.` (in future) never `₹`.

## What a fresh agent would otherwise rediscover

- **Gate run recipe**: `npm run build -w @forkflow/ui` → `FORKFLOW_DATA_DIR="D:/scratch/<fresh>" npx tsx apps/server/src/main.ts` (background) → `PYTHONIOENCODING=utf-8 <hermes-python> tools/e2e/gate.py` with `GATE_LAN=http://192.168.180.24:4100`. KOT-number assertions require a FRESH DB. Stop the server via netstat-PID + `powershell Stop-Process`, never the task wrapper.
- **`PRAGMA foreign_keys=OFF` is a no-op inside a transaction; `defer_foreign_keys=ON` is the in-transaction tool** (see migration 004's comment).
- **Snapshot convention** (first in repo): tests snapshot `renderBytes(buffer)` via `toMatchSnapshot()`; `__snapshots__/*.snap` are committed. renderBytes is command-aware (per-command parameter counts) — extend its maps if EscPos grows new commands.
- **Fresh installs have zero printers**; the seeded 'Kitchen' station has `printer_id = NULL` until assigned in Settings — send-to-kitchen silently skips printing then (kitchen display is the fallback).
- **M3b follow-up ticket (all non-blocking, from the final review)**: export contextLine from templates.ts (rule in 4 places); bluetooth sink timeout; queue 100-cap can evict live jobs; PowerShell breaks on printer names containing `"`/`$`; station dropdown renders an inactive assigned printer as "No printer"; auth-timeout reuses close reason "unauthenticated" (sleep/wake force-logout edge).
- Memory files at `~/.claude/projects/D--Software-Ideas-Restauarant-Billing-System/memory/` are current (project-overview has the full state + M4 pointers).

## Next steps

1. **(Human, when hardware exists) Real-printer smoke test** — add the printer in Settings, Test print, then a KOT. USB and Bluetooth paths have never touched hardware.
2. **Write the M4 Billing plan** (subagent pattern: groundwork Explore → contracts → parallel writers → adversarial review → fixer → user sign-off). Scope from spec: GST bills (gapless `bill_no` via the seeded sequence, CGST/SGST per-rate table), settle with payments (cash/UPI/card), receipt template (80/58, reuse EscPos/templates/queue — export contextLine while there), stationless `pending` items swept at billing, table frees when ALL its orders settle (derivation already handles it), day-end report. `bills`/`payments`/`bill_taxes` tables exist since migration 001. Bills are per order → splits bill separately for free.
3. **Execute M4** subagent-driven (haiku transcription implementers / sonnet reviewers / top-tier plan+final reviews — division held again today; use sonnet implementers for 1000+-line briefs and operational tasks).
4. Fold the M3b follow-up ticket into M4's plan where it touches the same files (templates/queue), or as a small M4-adjacent cleanup task.
5. After M4: M5 stock, M6 packaging (electron-rebuild deferred there since M1).
