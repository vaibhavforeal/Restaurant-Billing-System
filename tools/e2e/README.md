# ForkFlow E2E Gate

Browser-based acceptance test for M3a (orders/KOT) and M3s (table splits).

## Prerequisites

- Python 3.10 or later
- Playwright with Chromium installed:
  ```bash
  pip install playwright
  playwright install chromium
  ```

## Running the gate

1. **Build the UI production bundle** (the server serves the production build):
   ```bash
   npm run build -w @forkflow/ui
   ```

2. **Start the ForkFlow server with a fresh scratch database**:
   ```bash
   FORKFLOW_DATA_DIR=<path-to-scratch-dir> npx tsx apps/server/src/main.ts
   ```

   Example (Git Bash on Windows):
   ```bash
   FORKFLOW_DATA_DIR="D:/scratch/forkflow-gate" npx tsx apps/server/src/main.ts
   ```

   The server will initialize a fresh DB on first run. To re-run the gate from scratch, delete the scratch directory and restart the server.

3. **Run the gate script** (from the repo root):
   ```bash
   python tools/e2e/gate.py
   ```

   The script connects to `http://localhost:4100` by default. Override with `GATE_BASE`:
   ```bash
   GATE_BASE=http://localhost:3000 python tools/e2e/gate.py
   ```

4. **Optional: LAN origin test** (verifies uuid fallback on insecure origins):
   ```bash
   GATE_LAN=http://192.168.x.x:4100 python tools/e2e/gate.py
   ```

   If `GATE_LAN` is not set, the LAN test is skipped (printed as `[SKIP]`).

## Notes

- **KOT numbers in assertions** are per-day sequences starting at 1. The gate assumes a **fresh scratch DB** (all KOTs start from 1). If you run the gate against a DB that has already issued KOTs today, the assertions will fail.

- **Screenshots**: On success, the gate saves `gate-final-split-a.png` and `gate-final-kitchen.png` to the current directory. On failure, it saves `gate-fail-<page-name>.png` for each open page.

- **Server logs**: The gate runs in headless mode. To debug a failing step, check the server logs (stdout from the `tsx` command) for API errors or WS events.

## Killing the server

The server does not daemonize. To stop it:
- Ctrl+C in the terminal where it's running, OR
- On Windows: identify the PID for this test server, verify its command line,
  then `Stop-Process -Id <test-server-pid>`.
- On Unix: identify this test server's PID and `kill <test-server-pid>`.

## M4 billing gate

`m4-billing.js` verifies both GST settings, cart guards, preview/issue, cash+UPI
split settlement, card payment, receipt iframe, history, immutable tax mode and
the day-end report. It creates test menu items and bills: use a **scratch DB**.
Build the current UI first, start the server with that DB, open it in
agent-browser and complete setup/sign in as an admin.

```powershell
# Substitute your installed agent-browser executable if different.
Get-Content -Raw -Encoding utf8 tools/e2e/m4-billing.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session forkflow-m4 eval --stdin
```

The gate uses DOM events in the real browser (works around native-click issues
seen with agent-browser 0.38 on Windows), with API fixture setup and persisted
result assertions. It prints 12 passing checks, or throws at the failed step.
The gate must run on localhost/127.0.0.1 and is repeatable on the scratch DB.

## M5 inventory gate

With the current production UI built, a restarted test server, and an admin
signed into agent-browser against a scratch database:

```powershell
Get-Content -Raw -Encoding utf8 tools/e2e/m5-inventory.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session forkflow-m5 eval --stdin
```

The gate creates menu fixtures through the API, then exercises stock creation,
fractional product links, kitchen deductions, low-stock warnings, cancellation
reversal, stationless billing, settlement, purchases, wastage, physical counts,
concurrent-count rejection and history through browser DOM events. It verifies
saved balances and ledger totals and reports **18 checks**. It creates test
orders and stock movements; run only on a disposable scratch database.

The M4 gate is also run after inventory changes to check both GST modes, receipts
and payment/report behavior. Its receipt check waits for iframe print readiness.

## M6 resilience gate

Build the UI and start a server against a disposable data folder. Sign in as an
admin, starting on Home (not Settings), then run:

```powershell
Get-Content -Raw -Encoding utf8 tools/e2e/m6-resilience.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session forkflow-m6 eval --stdin
```

The gate checks manual backup/download, LAN QR and shortcut generation, draft
navigation, queued offline punch while adding new rows, and lost acknowledgements
for kitchen send, bill issue and settlement. It restores the original browser
fetch function after fault injection. With a LAN interface it reports 12 checks.
Run the M4 and M5 gates as checkout/stock regression checks.

For packaged-runtime QA, set `FORKFLOW_DATA_DIR` to an absolute scratch folder,
`FORKFLOW_PORT` to an unused port, and `FORKFLOW_DISABLE_AUTOSTART=1` before
launching `dist/installer/win-unpacked/ForkFlow.exe --remote-debugging-port=4122`.
Connect agent-browser to 4122. Check the rendered setup flow, complete setup,
verify SQLite-backed API calls and backup creation, terminate only its identified
utility server child and check that a new health instance ID appears. Quit the
test app after verification. This does not install the app or change firewall
rules. Close any app/server using staged dependencies before rebuilding.

For the automated six-check desktop gate, additionally launch with
`--inspect=9233`, then run `node tools/e2e/m6-desktop.mjs`. It checks that the
process is the unpacked package with a scratch data path and autostart disabled
before terminating its identified server child. The app stays open afterward
for visual inspection. Quit it from the tray after verification; debug ports
are only for QA and should not be enabled in a restaurant launch shortcut.
