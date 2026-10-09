# Zomato setup and reconciliation

> The **Zomato** sidebar page described below has moved: reconciliation and imports are
> now **Reports → Zomato reconciliation**, and the connection form is **Settings** on the
> Zomato card in the [Marketplace](marketplace.md). Day-to-day Zomato orders are handled
> on the counter; see [Zomato desk](zomato-desk.md).

Open **Zomato** in the sidebar. It appears once an administrator turns Zomato on in the
[Marketplace](marketplace.md); until then the sidebar item is hidden and the screen shows a "Zomato is turned off"
notice (administrators get a link to the Marketplace). Live webhook events are also
refused while Zomato is off in the Marketplace; see [Marketplace](marketplace.md).
Administrators configure the connection; administrators
and cashiers can import records, review reconciliation and export the displayed rows.
Waiters and kitchen users cannot access this ledger, including through the API.

This release implements **setup and reconciliation first**, as requested. Live receiving
and accept/reject/ready actions are **not activated**. Continue managing live orders in
the Zomato partner app. Saving a URL does not create a cloud service, register a webhook
with Zomato, or establish a connection.

## Set up the restaurant

1. Open **Zomato → Connection** and save the Zomato restaurant ID and restaurant name.
2. Add the POS vendor ID and public HTTPS service origin when Zomato assigns/approves them.
3. Import orders and settlements under **Reconciliation**.

The ledger supports one restaurant. Once it contains orders, settlements or events, its
restaurant ID cannot be reassigned. No API keys are requested or saved in this settings
form. A future verified adapter must load secrets server-side.

## Import records

Download the appropriate template and map your Zomato export to its columns. These are
**ForkFlow interchange templates, not official Zomato export formats**. The public POS
guide does not document a settlement API; this release makes no automated settlement calls.

Keep IDs as text, including leading zeros. CSV supports UTF-8 BOM, quoted commas and
escaped quotes. Every column is required, even when its numeric value is zero. Use up to
1,000 rows and 2 MB per file. Monetary amounts are INR decimal rupees, with at most two
decimal places, no currency symbols or thousands separators. Values are stored as integer
paise; the per-entry monetary limit is ₹10,000,000.

Order history columns:

```csv
restaurant_id,order_id,ordered_at,status,order_total,payment_mode
123456,000012345,2026-10-02T12:30:00+05:30,delivered,500.00,prepaid
```

`ordered_at` requires a full ISO timestamp with `Z` or an explicit timezone offset.
Statuses: `received`, `confirmed`, `preparing`, `ready`, `picked_up`, `delivered`,
`rejected`, `cancelled`. Payment modes: `prepaid`, `cod`, `unknown`. Historical imports
contain order totals, not item details. Imported open orders are labelled **Imported
record** in Live orders; they are not represented as verified incoming orders.

Settlement columns:

```csv
restaurant_id,order_id,entry_id,settlement_reference,settlement_date,gross_amount,deductions,additions,net_paid
123456,000012345,ENTRY-1,BATCH-1,2026-10-03,500.00,100.00,0.00,400.00
123456,000012345,ENTRY-2,BATCH-2,2026-10-10,0.00,10.05,0.00,-10.05
```

`entry_id` must uniquely identify the statement line. `settlement_reference` may repeat
across a payout batch. Dates use `YYYY-MM-DD`. Gross, deductions and additions must be
nonnegative; `net_paid` may be negative for recoveries. Later adjustments must contain
only incremental amounts with a new entry ID. Repeating an order's gross in an adjustment
will correctly flag an order-value mismatch.

**Preview import** validates every row and shows additions and duplicates before writing.
The import is atomic: a bad row prevents the whole import. An identical order or entry
is skipped; the same ID with different data is rejected rather than overwriting history.
A changed ledger invalidates an older preview. Retrying a lost commit response cannot
duplicate records. Recent imports record the staff member, time and counts.

## What reconciliation means

The date range includes orders **placed or settled** in the selected period, in the
restaurant server's timezone. For each included order, the report aggregates **all** its
imported settlement entries, including entries outside the date range. This supports split
payouts and later adjustments without presenting a partial settlement as a final balance.
These are per-order reconciliation totals, not cash receipts for the selected period.
The report accepts at most 366 days and 2,000 orders; narrow the dates for larger ledgers.

- **Statement net** = statement gross − deductions + additions.
- **Gross difference** = summed statement gross − recorded order value.
- **Payout difference** = reported paid − statement net. A negative value means less
  was reported paid than the statement components imply.
- **Matched** means both differences are exactly zero.
- **Awaiting statement** means the order exists without settlement entries.
- **Missing order** means settlement entries exist without an imported or received order.
- **Review cancellation** always flags cancelled/rejected orders with statements, because
  their actual contractual entitlement cannot be inferred from the order total.

`net_paid` is an imported statement value; it is not independently verified against a
bank feed. Deductions/additions are supplied explicitly, not estimated from a commission
percentage. Match status verifies the provided amounts, not the correctness of Zomato's
commercial charges. Search/status filters affect the table and CSV export; summary cards
cover the whole selected cohort. CSV exports neutralize spreadsheet formulas in text IDs
and references. Export is disabled during a refresh or after a failed refresh.

Zomato records do not create local bills, cash/UPI/card payments, KOTs or inventory
movements. They do not inflate existing sales reports. Migration 21 adds dedicated
SQLite tables without changing existing restaurant records. Ordinary full-database
backups include this ledger.

## Official documentation checked

Checked 2 October 2026; the public guide pages show “Last updated May 26, 2026”.

- [Overview](https://www.zomato.com/developer/integration/docs/overview): POS-to-Zomato
  REST calls and Zomato-to-POS registered webhooks.
- [Order management](https://www.zomato.com/developer/integration/docs/api-documentation/order-management):
  confirm, reject, ready, picked-up, assigned and delivered operations; order relay,
  order-status, fetch-status and delivery-partner webhooks.
- [Pre-integration](https://www.zomato.com/developer/integration/docs/getting-started/development-for-integration/pre-integration):
  POS creation, webhook URLs/headers/authentication, API keys from the Zomato contact,
  NDA, and domain/IP whitelisting.
- [Prerequisites](https://www.zomato.com/developer/integration/docs/getting-started/prerequisites):
  at least 50 restaurants or 10,000 monthly orders, final eligibility decided by Zomato,
  critical-feature parity and operational support requirements.
- [Endpoint reference](https://www.zomato.com/developer/integration/api-reference/v1/endpoints)
  and [webhook reference](https://www.zomato.com/developer/integration/api-reference/v1/webhooks)
  require organization login. Private payloads and authentication algorithms were not
  available and are not guessed in this implementation.

## Provider implementation boundary

`ServerOptions.zomatoProvider` accepts a server-only adapter. No production adapter is
installed in this release. `/api/integrations/zomato/webhook` returns 503 until an adapter
is present and an administrator enables it. This path is a local adapter boundary, not
an assertion about Zomato's required webhook paths.

The provider verifies the **original raw request bytes** and configured authentication,
then translates the approved payload into the internal `ZomatoEvent` contract. That
contract is explicitly not Zomato's wire schema. It supplies the official acknowledgement
format. Events and order snapshots commit atomically before success is returned. Duplicate
event IDs are checked for conflicting contents; updates arriving before an order snapshot
are retained; older/regressive statuses do not move an order backward. Only the configured
restaurant is accepted. Stored financial snapshots are not silently repriced.

Remaining work after approved access: implement verified authentication and all required
webhook types/acknowledgements, outgoing order actions with durable retries and remote
status reconciliation, menu/outlet mapping and required feature parity, a durable public
relay for an offline Windows PC, credentials provisioning/rotation, monitoring, sandbox
certification and production onboarding. Do not expose the entire local POS API publicly.
Delivery partner details, post-delivery refunds, settlement APIs and bank verification are
not implemented. The UI refreshes saved orders on WebSocket events and every 15 seconds.

Tests use a clearly labelled fake adapter and disposable SQLite databases. They are
evidence for the internal boundary, not Zomato sandbox or production certification.

## Verification for this release

- Full suite: 538 tests passed across 80 files.
- TypeScript checks and production UI build passed.
- 18 browser checks passed for imports, reconciliation, CSV, setup and error recovery.
- Desktop and 390-pixel phone layouts were inspected in light and dark themes.
- Cashier connection fields are read-only; waiters retain the Captain interface.
- Desktop bundle built successfully in a separate staging directory and was copied
  back to `build/desktop/app` after Windows prevented replacing the active directory.
  Fully quit ForkFlow from the tray, then use `Start ForkFlow.cmd` to load this build.
  The distributable installer was not regenerated.
