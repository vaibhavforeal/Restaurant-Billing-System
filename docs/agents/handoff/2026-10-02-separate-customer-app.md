# Separate demo and licensed customer distributions

User requested two separate apps: a demo and an app licensed to customers.
They subsequently authorized creating new licensing keys for the first release.

## Result

- Demo remains `in.forkflow.demo`, `%APPDATA%/forkflow-demo/data`, port 4110,
  resettable samples, demo PINs and simulated thermal printing.
- Customer retains `in.forkflow.pos` and its existing data location/port 4100.
  It now stages independently in `build/desktop/commercial` and packages into
  `dist/commercial`. It starts with restaurant setup and signed license activation.
- Internal development continues in `build/desktop/app`; its launcher is not a
  customer distribution. New `Start ForkFlow Customer.cmd` opens the licensed stage.
- `package:win` aliases `package:commercial`; `package:dir` also requires licensing.
- Release preflight requires an Ed25519 public key, rejects private keys and stage
  overrides, and prevents development from overwriting Demo/Customer/Kitchen stages.
- Stages carry edition/version/public-key fingerprint metadata. The shared
  electron-builder hook checks it even for direct builder invocations.
- Customer runtime fails closed if its embedded key is absent. Runtime environment
  changes cannot disable or replace its compiled verification key.

## Keys

Keys were generated outside the repository in:
`C:\Users\AR\.forkflow-licensing\keys\2026-10-02-e4ae2caa`

`license-public.pem` is embedded in the customer build. `license-private.pem`
remains operator-only, with protected Windows folder permissions granting access
only to the current user. The folder's README documents rebuilds and issuing
licenses. Secure backup of the private key remains the owner's responsibility.
Reuse this key pair for future builds and renewals.

Public fingerprint (SHA-256 SPKI DER):
`87294447fe300e581386bbc58ff683a13b1182af2bf4d74bafe7ced053c5dac1`

No customer-specific production license was issued. A one-hour grant for a
disposable scratch installation was used only for verification.

## Validation

- 27 focused Vitest tests passed: licensing, license configuration, demo seeding
  and demo data isolation. An initial run had two timeout failures during an
  unusually long execution pause; the subsequent complete targeted run passed.
- Five Node packaging tests passed. Workspace typecheck passed.
- `tools/e2e/distribution-smoke.mjs` ran both compiled servers on free ports with
  fresh scratch databases. Demo signed in and had eight sample tables. Customer
  required setup, denied operations before activation, verified the new key's
  fingerprint, accepted a valid signed Basic grant/device registration, and had
  no sample tables. Runtime public-key environment was empty throughout.
- Test servers were stopped; scratch data remains under `.e2e-scratch`.
- Both NSIS packaging processes completed successfully. Critical ASAR files
  byte-match the smoke-tested stages. Archive checks found no restaurant database,
  issuer script or generated private signing key. The public/private pair matches.
- Installers retain the existing unsigned distribution status. No clean-machine
  installation, firewall/autostart or physical printer test was performed here.

## Deliverables

- `dist/demo/ForkFlow-Demo-Setup-0.6.4.exe` — 110054171 bytes
- `dist/commercial/ForkFlow-Setup-0.6.4.exe` — 110054360 bytes
- `Start ForkFlow Demo.cmd` and `Start ForkFlow Customer.cmd`

Older `dist/installer` artifacts were preserved but are not customer releases.
The existing working tree has extensive changes from earlier work; none were
reverted. No Git commit was created.
