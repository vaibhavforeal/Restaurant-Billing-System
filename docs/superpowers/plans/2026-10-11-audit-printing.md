# Windows Printing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close findings #8 and #5: retryable pre-submission spooler failures and a valid, bounded Windows COM transport.

**Architecture:** Preserve `PrinterTarget`, `SinkSend`, and the queue's failed/unknown distinction. Correct the existing PowerShell exception handling first; then share process/file plumbing with an embedded C# Win32 serial helper.

**Tech Stack:** TypeScript, Node child_process, Windows PowerShell, .NET Framework-compatible C#, Win32, Vitest.

**Spec and Global Constraints:** Apply the [master plan](<E:/Softwares/Restaurant Billing Software/Restaurant Billing Software/docs/superpowers/plans/2026-10-11-audit-remediation.md>). No serial-port filesystem writes, new native Node dependency, arbitrary device paths, printer schema migration, or unbounded writes. Keep network transport behavior unchanged.

## P1. Correct Windows Spooler Error Classification — Finding #8

**Files:** Modify `apps/server/src/print/sinks.ts` and `apps/server/src/print/windows-sink.test.ts`; add `apps/server/src/print/windows-helper.integration.test.ts`; extend `apps/server/src/print/queue.test.ts`.

- [x] Convert `repro-windows-notsent.mjs` into a Windows-only integration regression using a randomly named nonexistent printer and the actual PowerShell helper. Require an ordinary Error, not `PrintOutcomeUnknown`; no installed printer receives bytes. Run `npm test -- apps/server/src/print/windows-helper.integration.test.ts` on Windows and confirm the current failure.
- [x] Unwrap the PowerShell invocation exception before logging/classification:

```powershell
$message = $_.Exception.GetBaseException().Message
[Console]::Error.WriteLine($message)
if ($message -like 'NOTSENT:*') { exit 20 } else { exit 21 }
```

Retain the C# distinction between known pre-submission failure and possible submission. Do not classify by localized outer “Exception calling…” text.

- [x] Verify an invalid-printer queue job becomes `failed` and permits normal retry. Write-stage/timeout cases remain unknown and require checking paper. Run `npm test -- apps/server/src/print/windows-sink.test.ts apps/server/src/print/windows-helper.integration.test.ts apps/server/src/print/queue.test.ts` before proceeding to the transport extraction.

## P2. Replace Bluetooth COM Filesystem Writes — Finding #5

**Files:** Modify `apps/server/src/print/sinks.ts`, `apps/server/src/print/windows-sink.test.ts`, `apps/server/src/print/sinks.test.ts`, and queue/recovery tests. Add `apps/server/src/print/serial-helper.ts` and `apps/server/src/print/serial-helper.test.ts`. Update `docs/operations/printer-settings.md`.

- [x] Add a regression for Bluetooth dispatch that requires the helper path and correct outcomes. During the failing baseline, intercept any COM filesystem access so the test cannot contact a real device; the behavioral assertion is that helper dispatch is required, not that a mocked filesystem write succeeds. Run `npm test -- apps/server/src/print/windows-sink.test.ts`; require that assertion to fail before replacing the transport.
- [x] Extract private `runWindowsHelper({ script, target, bytes, timeoutMs }): Promise<void>` for temporary payload/script files, encoded environment target values, hidden `powershell.exe`, cleanup, and outcome mapping. Preserve `SinkSend`. Embed serial source in a TypeScript string so the desktop bundle requires no extra helper asset. Keep temp-directory cleanup errors from changing a confirmed submission outcome.
- [x] In `serial-helper.ts`, separate a testable `SerialTransport.Send(ISerialApi api, string port, byte[] payload, int deadlineMs)` from its P/Invoke implementation. Normalize only validated `COM1`-style values, including COM10+, to the Win32 device namespace. Use `CreateFileW` with read/write access, `OPEN_EXISTING`, share mode 0, and a `SafeFileHandle`. Do not substitute Node's `r+`: its sharing flags still violate the serial contract.
- [x] Read the initialized DCB with `GetCommState`; preserve configured baud rate and handshaking. Verify supported binary, eight-bit settings and reject unsupported configuration before writing with a setup message. Document using the paired outgoing Windows port and configuring it for the printer. Do not invent a universal baud rate or add application-level serial settings in this repair.
- [x] Set bounded COM write timeouts and a monotonic total deadline, initially 10 seconds inside the helper and 15 seconds outside it. Mark `writeAttempted` immediately before the first `WriteFile`. Advance through partial writes without repeating accepted bytes; zero progress, API failure, or deadline expiry after that boundary is unknown. Inspect/drain the driver output queue within the same deadline; avoid unbounded `FlushFileBuffers`. Always dispose the handle.
- [x] Give the serial helper explicit outcomes: 20 for proven pre-write failure, 21 for possible/partial submission, and 0 only after all bytes are accepted and the output queue drains. Catch compile/payload/configuration errors before invocation and return 20. Shared process plumbing treats killed/unexpected exits as unknown; do not extend the old generic exit-1 shortcut to serial failures without proof. Keep the spooler integration regression passing through the refactor.
- [x] Run the actual C# transport against a fake `ISerialApi` in Windows tests. Verify open flags, preserved DCB, bytes `00/1B/FF`, partial writes, zero progress, deadline/drain failure, correct before/after-write classification, and handle disposal. Mocking the TypeScript wrapper alone is insufficient. Add queue cases proving normal retry for unsent failures, checked-paper confirmation for uncertain writes, and released queue locks after timeout.
- [x] Run `npm test -- apps/server/src/print`, `npm run typecheck`, `npm run build:desktop`, and `npm run test:packaging`. Confirm embedded helper compilation/execution on Windows and no additional packaged assets or native modules.

## Physical Acceptance Before Release

- [ ] On a supported paired printer using the packaged app, print receipt, QR, KOT, and multiple-copy jobs; include a COM10+ pairing where available. Verify complete paper output and readable control sequences.
- [ ] Test printer off, occupied port, mid-transmission disconnection, reconnect, and application restart during a send. Verify bounded completion, released handles, no silent automatic duplicate printing, and accurate retry prompts.
- [ ] Validate the chosen timeout against the largest supported receipt. Record printer model, driver/Windows version, COM configuration, build revision, and observed results. If this equipment is unavailable, leave physical compatibility explicitly pending rather than marking the transport fully verified.

Implementation evidence: [Remediation results](<E:/Softwares/Restaurant Billing Software/Research & Docs/code-audit-2026-10-11/remediation-verification/REMEDIATION-RESULTS.md>). Automated checks passed on 2026-10-11; physical printer acceptance remains pending.
