# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fix the eight application bugs and two test-gate defects validated on 2026-10-11, add regression coverage, and assess the reported dependency advisories before release.

**Architecture:** Preserve the single SQLite writer, existing REST contracts, append-only credit notes, and idempotent order/payment operations. Serialize staff mutations, allocate refunds cumulatively, persist browser request completions, retain bill-history boundaries, and send COM data through a bounded Win32 helper. No database schema migration is planned.

**Tech Stack:** TypeScript, Fastify 5, SQLite/better-sqlite3, React 19, Vite, Electron, Vitest, Node 24, Windows PowerShell with embedded C#.

**Spec:** [Validated audit and reproduction evidence](<E:/Softwares/Restaurant Billing Software/Research & Docs/code-audit-2026-10-11/CODE-AND-BUG-REVIEW.md>). Implementation and automated acceptance are complete. Physical printer acceptance remains pending; see the linked completion report.

## Global Constraints

- Repository: `E:\Softwares\Restaurant Billing Software\Restaurant Billing Software`; audited HEAD: `2e72e5f`. Paths in the child plans are relative to this repository unless stated otherwise.
- The audited state includes existing uncommitted UI, snapshot, and E2E changes. Preserve them. In particular, the M10 defect exists in the current working copy. An isolated checkout made from HEAD alone is not the audited baseline: carry the current changes into isolation without resetting, stashing, or removing the originals, or work with narrowly scoped edits in the current checkout.
- Use disposable databases and browser profiles for all tests. Do not send real payments, provider orders, messages, or print jobs except during the deliberate physical printer acceptance test.
- Preserve original bill totals, historical credit notes, payment records, salted PIN hashes, request idempotency references, and existing permission rules. Diagnose inconsistent historical refunds; do not silently rewrite them.
- Introduce a failing regression before each application fix. The audit harnesses currently assert the *buggy* result: port their scenarios into tests that assert the corrected behavior, and retain the original evidence unchanged.
- This is a bounded remediation of validated findings, not a promise that every undiscovered bug or vulnerability is eliminated. Do not mix redesigns or unrelated formatting into the fixes.

## Work Packages and Order

| Order | Audit findings | Deliverable | Plan |
|---|---|---|---|
| 0 | #9, #10 | Repair the M10 helper scope and KOT selectors so browser verification is usable | [Validation and release](<E:/Softwares/Restaurant Billing Software/Restaurant Billing Software/docs/superpowers/plans/2026-10-11-audit-validation-release.md>) |
| 1 | #1 P1, #4 P2 | Preserve at least one active admin and unique staff PINs under concurrency | [Data integrity, task D1](<E:/Softwares/Restaurant Billing Software/Restaurant Billing Software/docs/superpowers/plans/2026-10-11-audit-data-integrity.md>) |
| 2 | #2 P2 | Exact partial refunds, nonnegative taxes, and detection of affected old credits | [Data integrity, task D2](<E:/Softwares/Restaurant Billing Software/Restaurant Billing Software/docs/superpowers/plans/2026-10-11-audit-data-integrity.md>) |
| 2 | #3 P2 | Complete or explicitly reconcile actions processed by another window | [Client recovery, task C1](<E:/Softwares/Restaurant Billing Software/Restaurant Billing Software/docs/superpowers/plans/2026-10-11-audit-client-recovery.md>) |
| 3 | #6, #7 P2 | Historical Zomato sales and stable paginated bill history | [Client recovery, tasks C2-C3](<E:/Softwares/Restaurant Billing Software/Restaurant Billing Software/docs/superpowers/plans/2026-10-11-audit-client-recovery.md>) |
| 3 | #8, #5 P2 | Correct retry classification and functioning Windows COM transport | [Printing](<E:/Softwares/Restaurant Billing Software/Restaurant Billing Software/docs/superpowers/plans/2026-10-11-audit-printing.md>) |
| 4 | Dependency advisories; all ten findings | Targeted dependency updates and combined acceptance evidence | [Validation and release](<E:/Softwares/Restaurant Billing Software/Restaurant Billing Software/docs/superpowers/plans/2026-10-11-audit-validation-release.md>) |

Staff, refund, and queue work can run independently with separate file ownership. Printing can run in parallel. Coordinate edits to `tools/e2e/sales-dashboard.js`, `tools/e2e/README.md`, shared test helpers, and package manifests through one owner. Do not combine dependency churn with the initial correctness patches.

## Design Decisions

1. **Staff:** a server-instance async mutation queue plus a synchronous guarded database write. A plain transaction around only the final write does not protect the asynchronous PIN uniqueness check; keeping a transaction open while hashing is also unsuitable.
2. **Refunds:** allocate cumulative taxable, CGST, SGST, and total amounts, then derive rounding as the residual. Allocating the signed rounding component independently can still create a negative final refund on tiny bills. Read-only diagnostics handle old inconsistent credits.
3. **Browser queue:** durable results preserve the original bill/KOT/printing response. Blind replay can encounter a changed order state or lose the original printing outcome. Web Locks are not a correctness dependency because clients may use plain LAN HTTP.
4. **Bill history:** refetch through the oldest loaded bill-number boundary using the existing keyset API. Replacing only the first page loses history; remembering just the number of pages also loses older rows when new bills arrive.
5. **Printing:** use embedded PowerShell/C# with exclusive `OPEN_EXISTING` COM access, preserving Windows port configuration. This avoids a new Electron native-module dependency or printer-settings migration. Hardware acceptance remains necessary.

## Execution Checklist

- [x] Capture the current Git diff, untracked-file inventory, runtime versions, and test baseline; identify any change since the audit before editing.
- [x] Complete gate repairs V1 while D1 starts; keep each package's regressions and implementation in a distinct reviewable change set.
- [x] Complete D1, then D2 and C1; validate them before relying on subsequent browser gates.
- [x] Complete C2-C3 and P1-P2; run their targeted checks.
- [x] Complete dependency triage V2 separately, then run V3 against the final combined revision.
- [x] Review the final diff against all ten audit findings, preserving the user's earlier changes; record changed files, commands, outcomes, and remaining release prerequisites.

## Completion and Rollout

All ten findings need corrected-behavior regressions and passing targeted checks. The combined suite must include the existing 1,213 tests plus added coverage, typechecking, UI/desktop builds, packaging tests, and the repaired browser gates. A test count is a baseline, not a substitute for checking the actual assertions.

Before deploying to restaurant data, create and verify the normal backup, run the read-only credit-history diagnostic against a backup copy, and retain a rollback build. Findings in old records require an explicit reconciliation procedure; the software patch must not fabricate compensating financial entries. Existing installations with zero active admins also need a separately documented recovery of the intended administrator, not an automatic role promotion.

Reload every desktop/LAN window after the queue update; an already-open old producer still contains the original deadlock. Retain completion records through rollout as described in C1. Verify backup/restore against a disposable database. Do not restore a pre-upgrade database over newly recorded transactions as a casual rollback.

Mark code validation and physical printer acceptance separately. If hardware is unavailable, the report must say that COM transport compatibility is still awaiting the listed device tests; passing mocked tests cannot close that release prerequisite.

Implementation evidence: [Remediation results](<E:/Softwares/Restaurant Billing Software/Research & Docs/code-audit-2026-10-11/remediation-verification/REMEDIATION-RESULTS.md>). The physical acceptance checklist remains open in the printing and validation plans. No deployment or Git commit was performed.
