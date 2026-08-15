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
- On Windows: `taskkill /F /IM node.exe` (kills all Node processes — use with care)
- On Unix: `pkill -f "tsx apps/server/src/main.ts"` or `lsof -ti:4100 | xargs kill`
