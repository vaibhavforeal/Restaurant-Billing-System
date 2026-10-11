# Check historical credit notes

Run this diagnostic against a **consistent backup copy** of the ForkFlow database. Use the application's backup facility or stop the application before taking a copy; copying a live SQLite main file alone can omit committed data still in its WAL. Keep the original database and the backup for any separate reconciliation.

From the repository directory, with its normal dependencies installed:

```powershell
node --import tsx tools/audit-credit-history.mts 'E:\Backups\forkflow-backup.db'
```

The database path is required. The tool makes a private temporary copy, opens that copy with SQLite `readonly: true` and `fileMustExist: true`, and uses a read transaction. SQLite may create sidecars beside its private copy; the tool removes its temporary directory when finished. The supplied backup and its directory remain unchanged. No migrations or repairs run. It also examines bills that have already been fully refunded or voided.

A nonempty adjacent `-wal` or `-journal` file causes exit 2. The tool refuses these inputs because the main file alone may omit committed records or require recovery. Create a fresh standalone backup using the application's backup facility, or stop the application cleanly before copying the database. Do not delete existing sidecars to bypass this check. The tool also rejects a source file that changes while being copied and validates all required tables and columns even when there are no bills.

Output is JSON with `billsChecked` and a `findings` array. Each finding identifies a `billId`, and where applicable an `orderItemId`, `creditNoteId`, money `field`, or payment `mode`, followed by an `invariant` describing the problem. No PINs, user records, request fingerprints, or full payment references are emitted. Redirect standard output to save a report:

```powershell
node --import tsx tools/audit-credit-history.mts 'E:\Backups\forkflow-backup.db' > 'E:\Backups\credit-history-findings.json'
$LASTEXITCODE
```

| Exit code | Meaning |
| --- | --- |
| 0 | No invariant violations found. |
| 1 | Findings need review; no records were changed. |
| 2 | Invalid arguments, inaccessible/nonexistent database, or unsupported/damaged schema. No successful audit result is implied. |

The checks include cumulative quantities and amounts outside the original stored line, nonintegral money or quantities, inconsistent component sums, full returned quantities with money left over, negative amounts on individual saved credits, discrepancies between note/line/tax aggregates, and refunds exceeding payments overall or by method. Legacy bills without stored report lines retain their supported whole-bill void behavior; the tool cannot reconstruct their missing line-level allocation.

A valid older allocation may run ahead of the new cumulative schedule. Such history remains usable: later credits can be zero until the schedule catches up, and the final credit takes the exact remaining amount. Signed rounding is a balancing residual; it may legitimately be positive or negative and is not independently capped.

For an inconsistent history, the API refuses new previews and writes with HTTP 409 and `code: "credit_history_inconsistent"`. Preserve the affected original bills, credit notes, payments, and diagnostic report for separate reconciliation. If an original tax component was 5 paise and historical credits already refunded 8 paise, another nonnegative credit cannot correct that excess. Do not conceal the problem by clamping totals, editing old notes, or rewriting original bills. An already-successful request remains replayable with the same idempotency reference.

A clean report confirms these checked invariants for the supplied backup; it is not a reconciliation against bank or payment-provider records.
