# Browser Recovery and Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close findings #3, #6, and #7: actions must settle across windows, historical charts must include recorded sales, and live updates must preserve loaded bill history.

**Architecture:** Durable per-attempt queue completions with explicit recovery when evidence is missing; report loading independent of operational integration toggles; bill-history refresh through a saved keyset boundary.

**Tech Stack:** TypeScript, React, localStorage/storage events, existing REST APIs, Vitest and disposable browser fixtures.

**Spec and Global Constraints:** Apply the [master plan](<E:/Softwares/Restaurant Billing Software/Restaurant Billing Software/docs/superpowers/plans/2026-10-11-audit-remediation.md>). Do not depend on Web Locks, BroadcastChannel, or secure-context hashing. Retain server idempotency and existing user/database-generation boundaries.

## C1. Complete Actions Across Windows — Finding #3

**Files:** Modify `apps/ui/src/retry-queue.ts`, `apps/ui/src/retry-queue.test.ts`, `apps/ui/src/ConnectionStatus.tsx`, `apps/ui/src/screens/OrderScreen.tsx`, and `apps/ui/src/screens/BillingPanel.tsx`. Add `apps/ui/src/retry-queue.cross-window.test.ts`, `apps/ui/src/queue-completion.ts`, and `apps/ui/src/queue-completion.test.ts`. Add browser gate `tools/e2e/queue-cross-window.js`; update `tools/e2e/README.md` through its shared owner.

- [x] Port the audit's `ui-queue-cross-window.cjs` into a two-context regression using shared storage and separate module state. Pause window A's generation check, enqueue in A, allow B to POST and remove the request, then resume A. The producer must settle with a usable response and release its action lock. Run `npm test -- apps/ui/src/retry-queue.cross-window.test.ts` and confirm this fails against current code. Keep the harness independent of real time with controlled promises/timers.
- [x] Isolate record parsing/matching, print-evidence classification, result selection, and retention in `queue-completion.ts`. Use distinct storage prefixes `forkflow.queue-result.v1.` and `forkflow.queue-recovery.v1.` so older queue readers do not interpret them as work. The record contract is:

```ts
type PrintOutcome = "not_requested" | "reported" | "unknown";
type CompletionIdentity = {
  version: 1; requestId: string; attemptId: string;
  userId: string; generation: string; path: string; body: string;
  completedAt: number;
};
type QueueCompletion = CompletionIdentity & (
  | { outcome: "success"; response: unknown; printOutcome: PrintOutcome }
  | { outcome: "rejected"; status: number; message: string; code?: string }
  | { outcome: "dismissed" }
);
type ReliableResult<T> = T & {
  queueMeta: { requestId: string; printOutcome: PrintOutcome };
};
```

Keep all existing response fields, arguments, and call patterns; return `Promise<ReliableResult<T>>` from `reliablePost<T>`. Validate records and match request ID, actor, generation, path, and exact serialized body. No credentials or session tokens belong in completion metadata. Each POST attempt gets an immutable distinct key; a late failure or replay must not overwrite a successful original response.

- [x] Extend in-memory waiters with the original request and a queue lifecycle identifier. Add `reconcileWaiters()` on storage events, startup, and each existing three-second pump tick, including when another request is running. Before sending a queued snapshot entry, recheck current storage and completions. Resolve once from confirmed matching success; reject matching persisted terminal errors or dismissal; keep transient network failures queued.
- [x] Implement completion ordering: retain a successful HTTP response in memory, persist and read back its completion, clean only acknowledged draft client references, then remove the pending entry and notify/settle callers. Draft cleanup must be idempotent. A storage or cleanup failure keeps the pending request and successful evidence, stops automatic continuation, and exposes recovery rather than deleting evidence or repeatedly posting a known success. Subsequent reconciliation may finish persistence/cleanup without sending again.
- [x] Persist failure/dismissal records before removal. A missing pending entry without a matching completion must reject `QueueReconciliationRequiredError`, retain the original request as a recovery record when possible, and say: “This action may have completed in another window. Review the order before trying again.” Do not infer success, recreate the POST, or continue a multi-step checkout. Make `OrderScreen`, `BillingPanel`, and `ConnectionStatus` refresh current server state, release local navigation/action locks, and expose review. Recovery must not silently authorize a fresh duplicate operation.
- [x] Preserve printing uncertainty when duplicate workers race. Actual endpoint contracts differ: `/send` replay omits `printErrors`; `/bill` replay returns null `job`/`printError` even if the original attempt printed or failed. Classify items/settlement and a bill without requested printing as `not_requested`; send with its own array-valued `printErrors`, or bill with a job/nonempty print error, as `reported`; other print-requested successes as `unknown`. This is transport/job evidence, not paper confirmation.
- [x] Resolve a committed operation with the best evidence currently available; prefer reported printing evidence over an unknown replay. If unknown, show “Order saved; printing could not be confirmed. Check the printer before printing again.” A later original completion may update printing feedback through a request-ID-keyed notification, but must never replace current order/bill state with an older snapshot, resolve a promise twice, repeat checkout continuation, or auto-reprint. A late successful attempt after a rejected/recovery result triggers review of current state, not automatic continuation.
- [x] Fence writes and UI notifications after each `await` against lifecycle, actor/token, and database generation. Logout rejects local waiters; a stale worker cannot advance another session. Generation changes archive pending requests, completions, recovery records, and drafts together before clearing them. If archival fails, retain evidence and stop processing. Preserve legacy empty-KOT cleanup through the new dismissal path.
- [x] Bound completion retention to 24 hours, 100 completed request groups, or 1 MiB of serialized completions, evicting oldest eligible groups when any limit is exceeded. Evict whole request groups, not individual attempts; never evict a group still referenced by pending work. Protect active local waiters where possible. If protected records prevent admission, use the storage-failure recovery path. An expired suspended producer follows explicit reconciliation, never an automatic replay.
- [x] Cover both acknowledgement orderings, two workers posting the same request, original/replay printing results in either order, late print failure, missing original response, terminal errors, dismissal, and malformed/mismatched records. Also cover producer/worker crashes before and after completion persistence, storage quota errors, missing storage events, logout during POST, generation restoration, and old-worker removal without a completion. Assert exactly one producer continuation and no additional settlement/print requests from late notifications. Existing server idempotency tests remain mandatory because simultaneous sends are still possible.
- [x] Run `npm test -- apps/ui/src/retry-queue.test.ts apps/ui/src/retry-queue.cross-window.test.ts apps/ui/src/queue-completion.test.ts` and `npm run typecheck`. Run a real two-window browser gate on the disposable Captain fixture for punch, KOT, bill, and settlement. Verify both the resulting database record counts and unlocked UI. Document that all old desktop/LAN windows must reload to receive this fix.

## C2. Include Historical Zomato Sales — Finding #6

**Files:** Modify `apps/ui/src/useDashboard.ts` and its call in `apps/ui/src/SalesDashboard.tsx`; add `apps/ui/src/useDashboard.test.ts`; extend `apps/ui/src/dashboard-data.test.ts`, `tools/e2e/sales-dashboard-server.mts`, and `tools/e2e/sales-dashboard.js`.

- [x] Port the audit's disabled-Zomato hook scenario into a request/data regression: the selected day contains only a 20,000-paise Zomato sale while the integration is off. Require both channel cards and hourly bars to total 20,000. Run `npm test -- apps/ui/src/useDashboard.test.ts apps/ui/src/dashboard-data.test.ts`; demonstrate the current mismatch.
- [x] Change the hook to `useDashboard(date)`: always request the selected day's `type=zomato` analytics alongside dine-in and parcel. Remove integration-dependent fallback/dependencies and update the sole caller. Keep operational aggregator polling, alerts, Marketplace controls, and navigation gated by the integration setting. Retain existing cancellation, request revision, same-date stale-data fallback, and visible error behavior.
- [x] Test disabled with history, disabled without history, enabled, date changes, partial fetch failures, zero-net recorded activity, and later successful retry. A failed historical request must show incomplete data, not silently substitute an empty series. Keep the existing chart's zero-series display behavior.
- [x] Update the dashboard gate's old assertion forbidding every `type=zomato` request. It should permit historical report reads while still asserting that disabled operational polling/navigation remain disabled. Add a seeded historical-sales date; do not weaken the existing enabled/disabled Marketplace checks.
- [x] Run the targeted tests, then the dashboard and Marketplace browser gates. Require consistent chart/card coverage and no new operational Zomato polling when off.

## C3. Preserve Loaded Bill History — Finding #7

**Files:** Modify `apps/ui/src/screens/Bills.tsx`; add `apps/ui/src/bill-history.ts`, `apps/ui/src/bill-history.test.ts`, `apps/ui/src/bills-history.test.ts`, and `tools/e2e/bills-history.js`. Extend the disposable fixture and E2E README through their shared owner.

- [x] Port the audit's actual-component harness into `bills-history.test.ts`: show 100 rows, Load older to 200, then emit an unrelated `order.updated`. Require the same oldest loaded boundary and all qualifying rows through it. Run `npm test -- apps/ui/src/bills-history.test.ts` against the existing component and confirm the behavioral assertion fails, rather than failing on a not-yet-created controller import. Retain this screen-wiring test during the extraction.
- [x] Extract a small stateful loader/controller into `bill-history.ts` with injectable `fetchPage(status, before?, signal?)`. It owns status, oldest loaded bill number, request revision, in-flight refresh/load-more, one queued follow-up refresh, and subscriptions. `Bills.tsx` renders its snapshot and delegates the existing buttons/events. Keep the existing `/api/bills?status=...&before=...` 100-row API unchanged.
- [x] On first load, retain the oldest returned bill number. On live refresh, fetch newest-first pages until crossing that saved boundary or reaching the end, deduplicate by bill ID, sort by bill number, and publish the whole replacement atomically. Retain rows at/above the saved boundary and use below-boundary rows as lookahead for `more`. If a full page ends exactly at the boundary, use an additional cursor read to determine whether older rows exist; cache that lookahead for Load older.
- [x] Load older extends the boundary only after a successful request. Serialize it with refresh, debounce event bursts, and schedule one follow-up when updates arrive during a fetch. Reset the boundary and invalidate old responses on filter change/unmount. A failed middle page must preserve the existing visible list and show an error. Preserve the visible row/scroll anchor where it still exists.
- [x] Test 200 loaded rows with no change, newly inserted head rows, settlement removing unpaid rows, deletion/filtering of the boundary row, exact 100-row endings, overlap with Load older, filter changes, empty results, and partial failure. Controller tests must exercise the same logic wired to the screen; the real browser test verifies event wiring and scroll retention.
- [x] Run `npm test -- apps/ui/src/bill-history.test.ts apps/ui/src/bills-history.test.ts`, `npm run typecheck`, and the browser history gate with more than 200 disposable bills. The view must retain the loaded range while reflecting changed bill state. This is eventually consistent across sequential API reads, not a database snapshot; coalesced follow-up refresh handles concurrent changes.

Implementation evidence: [Remediation results](<E:/Softwares/Restaurant Billing Software/Research & Docs/code-audit-2026-10-11/remediation-verification/REMEDIATION-RESULTS.md>). Automated checks passed on 2026-10-11; physical printer acceptance remains pending.
