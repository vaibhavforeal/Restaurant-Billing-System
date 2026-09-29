# M5 inventory

Continue the local M4 working tree. User chose to allow ordering below zero and
show a low-stock warning. Existing GST configuration and billing stay intact.

- Admin stock setup: name, immutable unit, opening balance, optional threshold,
  edit/archive/reactivate, purchase/wastage and physical count adjustments.
- Cashiers can view quantities/history; waiters see warnings on relevant orders.
- M5 product mapping: one tracked stock item and quantity per menu item, shared
  by variants. Domain deduction supports the existing multi-link schema for M7;
  the simple editor must not silently overwrite a multi-link configuration.
- Quantities support three decimal places in the selected unit. Arithmetic uses
  integer thousandths, then stores canonical decimals in the existing REAL fields.
- Deduct kitchen items in the KOT transaction; deduct stationless pending items
  in the bill-issue transaction. No deductions at punch, settlement or reprint.
- Persist per-order-item sale movements. Cancellation reverses those exact
  movements even after link edits/archiving. Sale/reversal uniqueness and retry
  references prevent duplicate movements. Ledger entries are append-only.
- Manual counts require the version read by the operator; concurrent changes
  reject stale writes. Retry references are checked before version validation.
- Low stock means quantity <= threshold (or zero if no threshold). Negative
  balances are allowed. Broadcast changes only after successful transactions.
- Verify quantity math, migration preservation, API roles and retries, atomic
  rollback, both consumption points, cancellation after remapping, live warnings
  and a browser inventory→order→bill→history flow. Re-run M4 billing gate.
