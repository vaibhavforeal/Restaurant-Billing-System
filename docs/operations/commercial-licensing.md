# Commercial licensing

This is the local enforcement layer for the cloud plus offline product. It does
not yet include a hosted account service, payments, automatic license renewal,
or restaurant-data synchronization. Do not expose the existing local POS API to
the public internet: its PIN authentication and database are single-outlet.

## Plans

| Entitlement | Basic | Pro |
|---|---|---|
| Registered devices per outlet | 2 | 5 |
| Recipe editing | No | Included for administrators |
| Guest QR ordering | Menu browsing only | Included |
| Billing, basic inventory, backups | Included | Included |

The main PC's browser/Electron profile uses one slot. Other counter browsers,
waiter phones, and kitchen displays each use a slot. Multiple tabs in one profile
share a credential. Clearing browser storage, using another profile, or using a
different URL origin requires registration again. An admin can remove the old
registration. These are browser registrations, not hardware fingerprints.

## Cloud and offline boundary

- The cloud will own organizations, outlets, subscriptions, entitlement revisions,
  installation enrollment, and remote reporting. Owner login must use proper
  cloud account authentication, not a public staff PIN endpoint.
- One restaurant hub owns live orders, bills, payments, stock movements, and
  printing whether the internet is available or not. Counters use that hub over
  LAN. Internet loss is supported; loss of the hub/LAN is a separate availability
  problem. This release does not make every disconnected phone a billing server.
- Cloud-originated operational changes must be acknowledged by the hub before
  they are shown as applied. Do not allow the cloud and hub to issue independent
  bills for the same outlet. Remote reports must show their last-sync time.
- Future synchronization needs a transactional outbox, stable event IDs, tenant
  and outlet scope derived from authenticated installation credentials, deduplication,
  ordered acknowledgements, retry/backoff, protocol versions, and recovery epochs.
  Never copy a live SQLite file as the synchronization protocol. Replaying an old
  backup must not duplicate sales or delete newer cloud records.
- One offline authority is enrolled per outlet. Replacement requires fencing the
  old installation; an offline hub cannot be revoked instantly. Independent cloud
  device registrations must not allocate a second copy of the offline slot budget.

The implementation now stores signed organization/outlet/installation identity in
the grant. It does not add tenancy to business tables or make the server multi-tenant.

## Signing and building

Keep these two distribution apps separate. They share source code so fixes reach
both, but one build never replaces the other:

| | Demo | Licensed customer app |
|---|---|---|
| Windows app | ForkFlow Demo | ForkFlow |
| App ID | `in.forkflow.demo` | `in.forkflow.pos` |
| Build folder | `build/desktop/demo` | `build/desktop/commercial` |
| Installer folder | `dist/demo` | `dist/commercial` |
| Default data | `%APPDATA%\forkflow-demo\data` | `%APPDATA%\forkflow-desktop\data` |
| Default port | 4110 | 4100 |
| First launch | Sample restaurant and demo PINs | Restaurant/admin setup, then license activation |
| Workspace launcher | `Start ForkFlow Demo.cmd` | `Start ForkFlow Customer.cmd` |

Demo has a permanent banner, simulated thermal printing and a reset menu. The
customer app has ordinary printing and enforces its signed Basic/Pro grant.
Its existing app ID and data location are retained for updates. Activation does
not convert a Demo installation; install the customer app separately.
The Kitchen client connects to either app using that app's address and port.

Use an Ed25519 key pair owned by the licensing service. Keep the private key in
the service's secret store; never put it in this repo, the app bundle, a license,
or browser code. Only the public SPKI PEM goes in the desktop build.

For a commercial build in PowerShell:

```powershell
$env:FORKFLOW_LICENSE_PUBLIC_KEY = Get-Content 'C:\secure\license-public.pem' -Raw
npm.cmd run package:commercial
```

Close applications using `build/desktop/commercial` before staging another customer build.
`package:commercial` refuses a missing or non-Ed25519 key. The public key is
embedded at build time, so clearing a runtime environment variable does not
disable enforcement. Customer runtime also refuses to start if its embedded key
is missing. `package:win` is an alias for this licensed build; `package:dir` uses
the same licensing requirements. The installer checks the staged edition, version
and key fingerprint, including when invoked directly with electron-builder.
Do not use old files in `dist/installer` as customer releases; rebuild into
`dist/commercial` with the public key.

`FORKFLOW_BUILD_STAGE` is reserved for internal development previews. Release
builds reject overrides that would change their dedicated folder. The ordinary
development build in `build/desktop/app` ignores the release key and explicitly
reports development mode and preserves existing local development behavior.
Never distribute a development build to paying customers.

When running source directly, set the same environment variable before starting
the server to exercise commercial enforcement. The server creates
`installation.json` in its data directory. Preserve it during updates and recovery
on the same PC. It is not included in database-only backups, so restoring a database
to a new installation requires a provider-managed re-enrollment workflow (not yet
implemented). Normal startup backs up existing databases before migration 008.

## Issuing a grant before the hosted service exists

### Quick way: from the activation request

Ask the restaurant for the file from **Settings > Plan and devices > Activation
details > Download activation request**, then run:

```powershell
node --import tsx tools/prepare-license.ts C:\licenses\activation-request.json --plan pro --months 12 --sign C:\secure\license-private.pem
```

- **First activation** (the request has no license yet): new license,
  organization and outlet IDs are created at revision 1.
- **Renewal or plan change** (the request already has a license): the same IDs
  are reused and the revision goes up by one, as renewals require.
- `--months` sets the length from today; `--grace-days` (default 7) sets how long
  billing keeps working after expiry.
- `--sign` checks that your private key matches the public key built into that
  restaurant's installer (using the fingerprint in the request) and refuses if
  not, then writes `license-<installation>-r<revision>.txt` next to the request.
  Without `--sign` it writes `claims-<installation>-r<revision>.json` for
  `tools/issue-license.ts` below.
- It never overwrites an existing file and prints the plan, devices, dates and
  IDs — keep that summary with your customer records.

### Manual way: from a claims file

`tools/issue-license.ts` is an operator-only signing helper, excluded from the
desktop bundle. Supply a claims JSON file with this shape; identifiers below are
illustrative, and dates are Unix milliseconds:

```json
{
  "version": 1,
  "licenseId": "11111111-1111-4111-8111-111111111111",
  "organizationId": "22222222-2222-4222-8222-222222222222",
  "outletId": "33333333-3333-4333-8333-333333333333",
  "installationId": "44444444-4444-4444-8444-444444444444",
  "revision": 1,
  "plan": "basic",
  "issuedAt": 1790630400000,
  "expiresAt": 1793222400000,
  "graceUntil": 1793827200000
}
```

Use the installation ID shown in Plan and devices. The helper resolves Basic to
2 devices with menu browsing, and Pro to 5 devices with recipes and QR ordering.
Signed `maxDevices` and `features`
overrides support negotiated entitlements. Do not accept overrides from a customer
request in the future hosted issuer: derive them from the paid subscription.

`qrOrdering` controls guest request submission and staff acceptance. Guest menus
on Basic remain readable without registering customer phones as staff devices.
Older signed grants without this feature still verify but default it to false;
issue a newer revision to enable it. See [QR ordering](qr-ordering.md).

```powershell
node --import tsx tools/issue-license.ts C:\secure\license-private.pem claims.json license.txt
```

The helper refuses to overwrite an existing output. Import its contents into
**Settings > Plan and devices** (also shown immediately after initial setup in a
commercial build). Sign in as an administrator on each device and register it by
name. Staff access and plan entitlement are both required; a Pro license never
grants administrator permissions.

Renewals, upgrades, and downgrades keep all identity fields and increase `revision`.
The API permits retrying the same signed grant and rejects older grants. Store the
latest revision durably in the future cloud service. Wrong-installation grants,
signature edits, invalid dates, and subscription/outlet transfers are refused.

## Activation and renewal workflow

1. Open **Settings > Plan and devices**. Commercial builds show this screen
   automatically until the installation is activated and the current browser is
   registered. **Activation details > Download activation request** creates a
   JSON file containing installation identity, current subscription scope and
   revision, and the public verification key's fingerprint. Give this file to
   your provider. It contains no staff PINs, device credentials, or signed grant.
2. Choose the provider's `.txt` or `.lic` file, or paste its signed text. Files
   are limited to 16 KB; UTF-8 files with a BOM and trailing newlines are supported.
3. Select **Preview license**. The server checks the signature, installation,
   subscription scope, dates and revision without changing activation. Review the
   plan, features, dates and device allowance. Downgrades list registrations that
   would lose access. Existing restaurant data and registrations are retained.
4. Select **Apply license**. If another administrator changed the license or
   device list since preview, preview again. An unchanged retry after a lost
   response applies the license once. An already-installed file is identified in
   preview without creating another history entry.
5. For initial activation, enter a **Device name** and **Register this device**.
   Existing registrations survive renewals, so no new registration is required.

The activation request is an information handoff, not proof of purchase. The
provider must authorize the subscription and choose entitlements before signing.
The current issuer remains `tools/issue-license.ts`; hosted issuance and automatic
renewal are separate work. Its claims JSON reader also accepts UTF-8 BOM files.

Plan dates use the restaurant server's timezone. Device counts come from the
server, including blocked registrations after a downgrade. License status is
shared across screens and refreshes on changes, focus and every 30 seconds;
late responses cannot replace a newer status. The server remains authoritative
when a status refresh fails.

## Device management and local history

Administrators can rename any registered device from **Plan and devices**.
Renaming preserves its place in the allowance. **Last active** records use of a
valid registration at most once a minute; it is not a live online/offline signal.
Older registrations show **Not recorded** until used after upgrading.

Removing a device signs out its staff sessions and closes its WebSockets. Removing
the current browser signs out the administrator too. Repeated removal is safe;
if the device was renamed or registered again after the list loaded, the stale
action is rejected. Refresh and review the list before retrying. A removed device
must sign in and register again to use an available slot.

**License and device history** shows successful activations, registrations,
renames and removals, with the acting administrator and server time. It supports
loading older entries. Exact retries and no-op renames do not create duplicate
entries. History is local SQLite data included in database backups; it is not
cloud audit storage or a tamper-proof log. Migration 013 preserves existing
licenses and device priority. Changes before this upgrade are not backfilled.

## Expiry, downgrades, and recovery

Expiry and grace deadlines are chosen by the issuer; pricing and the commercial
grace duration have not been decided. All licensed operations continue through
grace. Once it ends, operational APIs pause. Admin authentication, license import,
device management, and backup creation/download remain available. No business data
is deleted. Correct a backward system clock before activation or operation resumes.

After a device-limit reduction, the oldest registrations (ID tie-breaker) retain
access up to the new allowance. Extra registrations stay visible but are blocked;
an admin can remove unwanted devices. APIs and WebSockets enforce the allowance.
Revocation deletes device-bound staff sessions and closes its sockets immediately.

The `recipes` entitlement governs [recipe editing](recipes.md). Administrators
need this entitlement to save multiple-ingredient recipes; development mode also
allows editing. Basic retains the simple single-stock link editor. Cashiers and
Basic customers can view existing recipes, but Basic cannot change a
multiple-ingredient recipe through either editor.

A downgrade preserves recipe stock links and deduction history. Existing recipes
continue deducting stock when kitchen items are sent or stationless items are
billed, and cancellation reverses the original recorded quantities. Editing a
recipe affects pending items at their next deduction; it does not recalculate
earlier stock movements. Editing requires a live connection to the restaurant
hub, not an internet connection while the license permits offline operation.

Offline enforcement is a commercial deterrent, not tamper-proof DRM. A customer
with machine control can patch code, copy browser credentials, or restore the whole
data directory (including license revision/clock state). Trusted cloud renewal,
installation fencing, key rotation, and cloud audit history are remaining production
work. Revocations and subscription changes cannot be immediate on a disconnected
installation. The current LAN uses HTTP; secure LAN transport and credential
storage hardening also remain before broad commercial rollout.

## Next delivery steps

1. Hosted tenant accounts, outlet enrollment, subscription records, and authenticated
   entitlement issuance/renewal with server-side device allocation and an audit log.
2. Transactional hub outbox and cloud ingestion with duplicate/reordered delivery,
   tenant-isolation, backup-restore, and prolonged-disconnection tests.
3. Cloud dashboard/read models, remote configuration commands acknowledged by the
   hub, and clear sync status in both applications.
4. Payment-provider integration, provisioning/support tools, key rotation,
   installation replacement, signed releases, and clean-PC/hardware rollout tests.
