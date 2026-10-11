# Staff and Refund Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close audit findings #1, #4, and #2 without changing stored PIN security or rewriting financial history.

**Architecture:** A per-server serial executor protects all staff creates/updates across asynchronous hashing; current authorization and database invariants are rechecked at the synchronous write. Refund allocation uses cumulative integer arithmetic against immutable bill lines.

**Tech Stack:** Fastify, TypeScript, better-sqlite3, BigInt, Vitest.

**Spec and Global Constraints:** Apply the [master plan](<E:/Softwares/Restaurant Billing Software/Restaurant Billing Software/docs/superpowers/plans/2026-10-11-audit-remediation.md>) and its linked audit. No asynchronous SQLite transactions, new PIN digest index, automatic financial repair, or schema migration.

## D1. Serialize Staff Mutations — Findings #1 and #4

**Files:** Modify `apps/server/src/users.ts`, `apps/server/src/users.test.ts`, and the permission helper/declaration in `apps/server/src/auth.ts`; extend `apps/server/src/auth.test.ts` for preserved auth contracts. Add `apps/server/src/users-concurrency.test.ts` for controlled overlapping requests.

- [x] Port `user-concurrency-repro.mts` into API regressions. Concurrently demote two admins while changing their PINs; require one successful mutation, the other rejected, and exactly one active admin. Concurrent creates with the same unused PIN must produce one 201 and one 409, with one stored user and an unambiguous login. Run `npm test -- apps/server/src/users-concurrency.test.ts`; confirm the existing implementation fails those assertions.
- [x] Add deterministic overlap coverage using deferred password verification/hashing in the test module, released in a controlled order. Cover POST/POST, PATCH/PATCH, POST/PATCH PIN collisions, deactivation, and a name-only patch queued behind a role/PIN update. Include inactive users in PIN reservation and retain self-exclusion for unchanged PINs.
- [x] Add a serial executor scoped inside `registerUsers`, not a process-global lock. Its essential behavior is:

```ts
let tail: Promise<void> = Promise.resolve();
function serializeUserMutation<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.then(() => undefined, () => undefined);
  return next;
}
```

Both create and patch handlers must enter the same executor *before* checking uniqueness or reading fields used to build an update. A failed mutation must not poison subsequent requests. Other API routes remain concurrent.

- [x] Extract the existing authentication/permission/licensing assertion into a synchronous internal `app.assertPermission(req, slug): AuthedUser`, reused by `requirePermission` and guarded staff writes. Preserve existing 401/403 response contracts, permission metadata, `req.user`, and licensing behavior; extend the Fastify declaration. Recheck after waiting for the queue and again after hashing, immediately before writing. A queued request from a demoted/deactivated/logged-out user must not retain earlier authority.
- [x] Within serialized work, perform PIN verification and hashing without an open SQLite transaction. Then enter a synchronous transaction, reload the target row, recheck authorization and the active-admin count, derive omitted fields from the fresh row, and write. Keep existing websocket invalidation/broadcast behavior after a successful write. The critical section must have no `await` between the final invariant checks and mutation.
- [x] Add tests for queue recovery after rejection, stale authorization, current target fields, successful ordinary staff edits, and independent app instances. Retain setup's existing first-user protections; confirm its tests still pass. Do not add an automatic recovery admin or change existing credentials.
- [x] Run `npm test -- apps/server/src/users.test.ts apps/server/src/users-concurrency.test.ts apps/server/src/auth.test.ts` and `npm run typecheck`. Review only this task's diff; expected outcome is no path from these concurrent mutations to zero active admins or duplicate PINs.

## D2. Allocate Refunds Cumulatively — Finding #2

**Files:** Modify `packages/domain/src/credit-notes.ts`, `packages/domain/src/credit-notes.test.ts`, `apps/server/src/credit-notes.ts`, `apps/server/src/credit-notes.test.ts`, and `apps/server/src/credit-note-reports.test.ts`. Extend `apps/ui/src/credit-note-form.test.ts` for zero-value returns. Add `tools/audit-credit-history.mts` and `tools/audit-credit-history.test.ts`; document the diagnostic in a new `docs/operations/credit-history-check.md`.

- [x] Add the exact API reproduction: ten units at 1,000 paise, 18% GST, 9,935-paise discount; original stored line is taxable 55, CGST 5, SGST 5, rounding 35, total 100 paise. Sequential one-unit refunds must all succeed and sum to the bill, without negative tax or exceeding remaining payments. Add a partial-refund-then-void variant. Run `npm test -- packages/domain/src/credit-notes.test.ts apps/server/src/credit-notes.test.ts`; demonstrate the new cases fail first.
- [x] Make total, taxable, and tax allocation cumulative. Keep the existing exact BigInt proportion helper. For each requested line and each nonnegative field `taxablePaise`, `cgstPaise`, `sgstPaise`, and `totalPaise`:

```ts
const beforeQty = already?.qty ?? 0;
const afterQty = beforeQty + q;
const previous = already?.[field] ?? 0;
const proportionalTarget = proportion(line[field], afterQty, line.qty);
// A valid older allocation may be ahead of the new cumulative schedule.
const target = afterQty === line.qty
  ? line[field]
  : Math.max(previous, proportionalTarget);
credit[field] = target - previous;
```

Validate historical bounds *before* this calculation. Set `credit.roundingPaise = credit.totalPaise - credit.taxablePaise - credit.cgstPaise - credit.sgstPaise`. Never independently allocate signed rounding and then use its sum as the payment total. Preserve line metadata, grouped taxes, preview/write parity, and final exact remainders.

- [x] Add a second regression for a valid two-unit line with taxable 12, CGST 1, SGST 1, rounding -14, total 0. Both one-unit credits must total zero; a naive cumulative allocation of all four components would give +1 then -1. Verify `refunds: []` is accepted for a zero-total credit and the form does not require a positive payment amount.
- [x] Update old per-step expectations to the new allocation contract while keeping exact aggregate assertions. Replace the existing negative-CGST synthetic rounding fixture with valid nonnegative taxes and a negative rounding residual. Cover quantities 1-99 with deterministic partitions, tiny amounts, multiple GST rates, discounts, both rounding signs, tax-included/no-tax/legacy-exclusive bills, grouped requests, final voids, payment-mode caps, and idempotent retries. Avoid a new property-testing dependency.
- [x] Add a typed `CreditHistoryError` for invalid history: nonintegral amounts/quantities, quantity outside the billed range, negative cumulative taxable/tax/total, amounts above the original line, inconsistent component sums, or fully credited quantities with unexplained money remaining. Map it to HTTP 409 with code `credit_history_inconsistent` and a clear message that earlier refunds require review. Valid older allocations within bounds continue using the monotone rule above. Keep the existing restriction for legacy bills without stored lines.
- [x] Test an already over-credited original GST of 5 with previous GST of 8. Preview and write must reject without inserting notes, refund payments, stock entries, or audit records for a failed operation. Existing idempotent successful responses must still be returned before attempting a new draft. Concurrent valid credits must remain protected by the current write transaction and held-payment checks.
- [x] Implement the read-only diagnostic with an explicit database-path argument and SQLite read-only/file-must-exist mode. Reuse domain history validation; additionally report negative tax/total on individual saved credit lines, line/note aggregate discrepancies, and refunds exceeding payments. Emit JSON containing bill/line IDs and invariant violations, never PINs or full payment references. Exit 0 for no findings, 1 for findings, 2 for an execution error. Do not run migrations or writes. Test clean, recoverable older, over-credited, and already-finalized inconsistent fixtures; confirm the file remains unchanged.
- [x] Document running the diagnostic against a backup copy and preserving affected records for separate reconciliation. An over-credited historic tax component cannot be corrected simply by producing another nonnegative credit; do not conceal it by clamping or rewriting old notes.
- [x] Run `npm test -- packages/domain/src/credit-notes.test.ts apps/server/src/credit-notes.test.ts apps/server/src/credit-note-reports.test.ts apps/ui/src/credit-note-form.test.ts tools/audit-credit-history.test.ts` and `npm run typecheck`. Require exact sums for every money field at full return, no new negative taxable/tax/total values, identical preview/write allocation, and unchanged original bills.

Implementation evidence: [Remediation results](<E:/Softwares/Restaurant Billing Software/Research & Docs/code-audit-2026-10-11/remediation-verification/REMEDIATION-RESULTS.md>). Automated checks passed on 2026-10-11; physical printer acceptance remains pending.
