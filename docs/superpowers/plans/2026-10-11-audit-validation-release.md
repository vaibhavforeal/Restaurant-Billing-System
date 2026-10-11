# Audit Validation and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair findings #9 and #10, triage/update affected dependencies, and verify the final combined fixes with reproducible evidence.

**Architecture:** Keep the existing browser gates and disposable fixtures, strengthen their assertions against the validated bugs, and isolate dependency changes from behavior fixes. Release evidence distinguishes automated checks, browser behavior, historical-data review, and physical printing.

**Tech Stack:** Vitest, TypeScript compiler API, existing browser E2E scripts, npm audit/lockfile, Electron packaging.

**Spec and Global Constraints:** Apply the [master plan](<E:/Softwares/Restaurant Billing Software/Restaurant Billing Software/docs/superpowers/plans/2026-10-11-audit-remediation.md>). Preserve current uncommitted scripts. Audit evidence is a baseline, not proof that a later revision passes. No forced bulk dependency upgrades or testing against restaurant data.

## V1. Repair the Test Gates — Findings #9 and #10

**Files:** Modify `tools/e2e/m10-takeaway.js`, `tools/e2e/kot-send.js`, and `tools/e2e/README.md`; add `tools/e2e-scope.test.ts` and a dedicated `tools/e2e/m10-server.mts` fixture for the documented signed-Pro/Basic disposable setup.

- [x] Turn `m10-scope-check.cjs` into a repository test using the installed TypeScript compiler API with `allowJs`, `checkJs`, `noEmit`, and DOM/ES libraries. For the two scripts, require no TS2304 unresolved-name diagnostics. Do not demand a full strict JS type cleanup or suppress unresolved names with a broad ignore. Run `npm test -- tools/e2e-scope.test.ts`; require it to identify the current out-of-scope `pickReport`.
- [x] Move `pickReport` from inside `click` to the enclosing script scope beside the other helpers. Keep the current report-tab/More reports behavior and all newer user edits. Run the scope test and `node --check tools/e2e/m10-takeaway.js`; syntax checking alone does not close this finding.
- [x] Run the original KOT gate on the disposable Captain fixture and retain its failing workspace/selector result. Change its KOT lookup to `[data-shortcut="send_kitchen"]`. For button lookup, normalize only the displayed keyboard suffix, such as `label.replace(/\s*·\s*F\d+\s*$/, "")`, and prefer stable action identifiers where available. Do not make assertions pass by skipping interaction or broad substring matching.
- [x] Run the repaired repository `kot-send.js`, not the audit's adapted copy, and require all existing 12 assertions. Run `node --check tools/e2e/kot-send.js` and the scope regression as well.
- [x] Before running the complete M10 gate, implement `m10-server.mts` using the existing test-server patterns: unique scratch data directory, loopback port 4121, ephemeral in-memory Ed25519 key, signed Pro revision 1 and Basic revision 2 for one installation, latest built UI, fake printer, no external licensing/provider calls. Emit only disposable browser setup/grant data for the gate; do not borrow production keys. Add the launch and shutdown instructions to the README. The gate already seeds its menu/settings and enables Kitchen Display itself.
- [x] Run M10 to final `status: passed`, following all four real reload boundaries and supplying the same-installation, higher-revision Basic grant. Its documented baseline is 56 assertions; retain all behavioral assertions as implementation evolves. Follow with `m10-takeaway-get-failure.js` and its eight assertions. A syntax check or one successful phase is insufficient.

## V2. Address Dependency Advisories Separately

**Files:** Relevant existing workspace `package.json` files and root `package-lock.json`; a dependency outcome section in the completion report. Change packaging configuration only if a tested compatibility issue requires it.

The audit reported 19 affected package entries: 2 critical, 7 high, and 10 moderate, including transitive/development entries. Production-only audit listed high findings for Fastify, fast-uri, and brace-expansion. Electron also ships to customers despite its development-dependency classification. The critical shell-quote/concurrently chain is build/development tooling; package severity alone does not establish application exploitability.

- [x] Capture fresh `npm audit --json` and `npm audit --omit=dev --json` output, preserving their nonzero exit codes as advisory results. Use `npm explain fastify`, `npm explain fast-uri`, `npm explain brace-expansion`, `npm explain electron`, `npm explain shell-quote`, and `npm explain concurrently` to identify each installed path.
- [x] For each critical/high entry, record advisory ID, installed version/path, patched range, whether it ships or runs in tooling, and affected application usage. Check the advisory and registry at implementation time; choose an explicitly recorded compatible patched version instead of assuming that today's latest release is appropriate.
- [x] Update direct dependencies deliberately and regenerate the lockfile using normal npm resolution. Update transitive packages through their owning dependency or a justified compatible override. Do not use `npm audit fix --force`, hand-edit lockfile integrity values, or downgrade unrelated packaging tools to satisfy an automatic suggestion.
- [x] Prioritize shipped Fastify/transitives and Electron; handle the critical tooling chain in the same dependency change set or a separately tracked tooling patch. Test HTTP error/route behavior, static serving, websocket authentication, desktop startup, and packaged SQLite loading after relevant changes. An Electron update must verify the better-sqlite3 native binary against the new Electron ABI.
- [x] Run `npm ci` in the prepared isolated checkout to prove lockfile reproducibility, then the final checks in V3. Do not remove the user's current dependency tree while another worker relies on it. Re-run both audit modes and list every unresolved critical/high advisory with a concrete disposition. Do not claim a clean dependency audit merely because the full test suite passes.

## V3. Verify the Combined Revision

**Files:** Save new results under `Research & Docs/code-audit-2026-10-11/remediation-verification/`, leaving the original evidence intact. Write `REMEDIATION-RESULTS.md` there with the tested commit/working-diff identity and one status per finding. This directory is a future implementation deliverable, not evidence created by this planning task.

- [x] Confirm all targeted regressions pass after integration, including tests of actual PowerShell execution. Check the diff for accidental changes to the user's existing work and missing files in the plan's file maps.
- [x] Run the full suite with the environment that resolved the audit's Windows-only module collision. Scope changes to this shell and restore them:

```powershell
$savedAuditPolicy = $env:PSExecutionPolicyPreference
$savedAuditModules = $env:PSModulePath
try {
  $env:PSExecutionPolicyPreference = 'Bypass'
  $env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
  npm test -- --reporter=dot
  if ($LASTEXITCODE -ne 0) { throw 'Vitest failed' }
} finally {
  $env:PSExecutionPolicyPreference = $savedAuditPolicy
  $env:PSModulePath = $savedAuditModules
}
```

Baseline: 1,213 tests in 132 files passed during the audit. Require all retained tests and new regressions to pass, with no new unexplained skips. Do not change machine execution policy.

- [x] Run `npm run typecheck`, `npm run build:desktop` (includes the UI production build), and `npm run test:packaging`. Baseline packaging coverage was six tests. Check JavaScript syntax for changed E2E files; retain the scope regression for errors syntax checking misses.
- [x] Run the following browser acceptance matrix using the current built UI and separate disposable data where gates mutate fixtures. Capture final results and browser errors, not only screenshots:

| Gate | Required evidence |
|---|---|
| Sales dashboard | Existing 42 baseline assertions retained/adapted to the corrected contract; disabled integration with historical sales has matching totals and bars |
| Marketplace admin | Existing 36 assertions; disabled operational integrations stay inactive |
| M4 billing | Existing 13 assertions; bill/payment idempotency remains intact |
| KOT send | All 12 original assertions through the repaired repository script |
| M10 takeaway | Final passed result through all four reloads; existing 56 assertions and eight GET-failure checks |
| New two-window queue | Punch/KOT/bill/settle resolve or enter explicit review, no indefinite lock, no duplicate financial/stock effects |
| New bill-history gate | More than 200 records, stable loaded boundary and scroll position through updates/filter changes |
| Refund UI/API | Repeated partial returns, zero-value credit, final void, correct taxes/payment limits, visible legacy-inconsistency error |

Use `tools/e2e/captain-server.mts` on 4139 for desktop/KOT/queue checks and `tools/e2e/sales-dashboard-server.mts` on 4145 for dashboard/Marketplace, following their documented setup. M10 uses its separate 4121 fixture. Stop only fixture processes created by this run and confirm their listeners close.

- [x] Test packaged demo and commercial server startup against fresh scratch databases. Generate a throwaway Ed25519 pair, build with only its public PEM in the process-scoped `FORKFLOW_LICENSE_PUBLIC_KEY`, and use the matching private-key file solely as the input to `tools/e2e/distribution-smoke.mjs`. Clear/restore build environment variables and use an isolated build directory/checkout; do not overwrite a prepared customer release or access a production signing key. Verify installed Electron startup and SQLite read/write in a disposable profile after any Electron/native dependency change.
- [ ] Complete P2's physical printer acceptance separately. Run the credit-history diagnostic against a representative backup copy and verify normal backup/restore with new queue generation handling. Existing inconsistent finances or zero-admin installations need their documented recovery procedures; these are not silently repaired by deploying code.
- [x] Produce the completion report with each finding marked fixed/verified, implemented with verification pending, or unresolved. Include dependency before/after results, all command/gate outcomes, hardware model/results or its pending status, and deployment/rollback prerequisites. Report only evidence obtained on the final combined revision.

## Exit Criteria

The code remediation is complete when all ten findings have the specified behavioral correction and automated/browser regression evidence. Release additionally requires physical COM acceptance, packaged runtime checks, and disposition of historical-data and critical/high dependency findings. Keep those statuses separate so a missing device or unresolved advisory is visible without misrepresenting the completed code work.

Implementation evidence: [Remediation results](<E:/Softwares/Restaurant Billing Software/Research & Docs/code-audit-2026-10-11/remediation-verification/REMEDIATION-RESULTS.md>). Automated checks passed on 2026-10-11; physical printer acceptance remains pending.
