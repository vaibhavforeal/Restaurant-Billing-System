# Cloud plus offline: local licensing foundation

User selected cloud plus offline hosting, Basic with 2 devices, and Pro with 5.
Basic excludes recipe editing. One complete application is licensed by entitlements.
This supersedes the earlier local-only product direction; cloud services are not
yet implemented. Read [commercial licensing](../../operations/commercial-licensing.md)
for architecture boundaries, issuance, builds, limitations, and continuation steps.

## Implemented

- Shared plan definitions and strict versioned claims containing organization,
  outlet, installation, subscription identity, revision, resolved entitlements,
  expiry and grace dates. Ed25519 signature verification before claims are trusted.
- Migration 008 persists licenses and registered devices. Existing sessions.device
  stores the device credential hash. Only hashes are persisted; device listings
  never expose credentials. Schema updates use the existing pre-migration backup.
- API and WebSocket checks for license validity, device allowance, and binding
  between staff session and device. Permission checks remain required alongside
  the new requireFeature guard. Recipe editing itself has not been built.
- Admin license import and registration/revocation UI. Activation appears after
  setup in a commercial build. Admin renewal and backups remain accessible after
  expiry; the grace deadline permits continued operation until it ends.
- Signed upgrades/downgrades; higher revisions prevent ordinary replay. A reduced
  allowance retains the oldest permitted registrations without deleting extra
  devices or restaurant data. Corrupt grants can be replaced by a newer grant for
  the same stored subscription/outlet identity.
- Commercial build command requires a public Ed25519 key and embeds it; runtime
  environment changes cannot turn checks off. Private-key input is rejected by the
  build script. Development builds retain prior behavior and label it explicitly.
- Operator-only issue-license.ts helper. No production signing keys generated,
  no payment provider configured, and no service deployed.

## Verification

- Full suite: 262 tests across 41 files passed.
- Final recovery adjustment: all 12 licensing/schema tests passed again.
- Typecheck and production UI build passed.
- Real browser: first-time setup, signed Basic import, register current browser,
  dashboard access, Pro upgrade to 5 slots, and Settings entitlement display.
- Commercial billing: all 12 M4 browser checks passed using a device credential,
  including both GST modes, split settlement, receipt display and reports.
- Browser errors empty; Plan and devices screenshot visually checked.
- git diff --check passed with the repository's normal line-ending configuration.

QA used the ignored `.e2e-scratch/license-preview.ts` and a generated disposable
database on port 4115. The QA server/browser were stopped. The existing Electron
application on port 4100 was not stopped, rebuilt, migrated or activated. No new
desktop installer was produced. All edits remain uncommitted.

## Next

Build the hosted identity/subscription/enrollment service, then authenticated
renewal and sync. One hub must remain the authority for live outlet operations;
remote changes require its acknowledgement. Offline phone billing without a hub
is not part of this design. The current PIN-based API must not be exposed publicly.

Outstanding production work includes key rotation, installation replacement and
fencing, audit history, chosen renewal/grace policy, secure LAN transport, tenant
isolation, outbox/cloud ingestion, restore reconciliation, and subscription payments.
The older recipe, print durability, refund, and Windows/hardware rollout backlog
also remains. Do not market this as a completed cloud SaaS or unbreakable DRM.
