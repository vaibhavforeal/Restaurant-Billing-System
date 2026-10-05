# Demo and separate Kitchen app

User requested a customer demo plus a separate connected kitchen application.
They explicitly chose isolated resettable sample data and Windows plus
tablet/browser support.

Implemented:

- Separate `build/desktop/demo`, application ID `in.forkflow.demo`, data directory
  `%APPDATA%/forkflow-demo/data`, fixed port 4110. Compile-time demo flag; ordinary
  restaurant builds keep their original data selection and licensing behavior.
- Sample seed through business APIs: 4 roles, 14 dishes, 8 tables, 5 ingredients,
  6 recipes, 8 paid bills and 3 open kitchen orders. Printing uses a fake sink.
- Demo menu/tray reset stops its server, archives only a marked demo database,
  changes the queue generation and recreates samples on restart. Existing
  restaurant data is refused by both directory initialization and seeding.
- `/kitchen/` dedicated UI, separate auth token key, PIN sign-in, ticket-only
  navigation, responsive layout, explicit stale/offline/error states and retries.
  Existing KOT permissions, acceptance/billing rules and WS events are reused.
- Scoped Kitchen PWA, manifest and icons. Shared tested shell-worker generator
  keeps Captain/Kitchen caches separate and never caches API data.
- Separate sandboxed Windows Kitchen client, address onboarding, persisted
  connection, origin/navigation restrictions, restricted local-only IPC, F11 and
  Change POS menu. It starts no local restaurant server/database.
- Distinct NSIS configs, build/package scripts and workspace launchers.
- Setup docs: `docs/operations/demo-and-kitchen.md`.

Validation:

- Full suite: **524 tests passed, 78 files**; workspace typecheck passed.
- Native Electron demo and kitchen stages ran concurrently with the existing
  restaurant POS. Nine browser checks sent a new order through POS UI, confirmed
  billing was blocked until Kitchen accepted, then verified live billing unlock
  and correct bill issuance. Eight Kitchen checks covered role denial, session
  isolation, stale-read behavior, write retry, persisted completion and cache
  boundaries. Tablet 768px layout and desktop screenshots inspected.
- Stopped only the identified demo test processes, called the same reset helper,
  restarted demo, and read-only verified 4 users, 8 paid bills, 3 open orders,
  3 active KOTs and SQLite integrity `ok`. Connected Kitchen returned to login.
- Both installers built successfully. Their critical ASAR files byte-match the
  tested staging files; no forkflow.db is included. A later combined command to
  stop staged apps and launch packaged executables was rejected by automatic
  approval review with `blocked by policy`. No retry of that shutdown. Packaged
  binaries were verified by content comparison instead of a second launch.

Deliverables:

- `dist/demo/ForkFlow-Demo-Setup-0.6.4.exe` (110043879 bytes)
- `dist/kitchen/ForkFlow-Kitchen-Setup-0.6.4.exe` (99585099 bytes)
- `Start ForkFlow Demo.cmd`, `Start ForkFlow Kitchen.cmd`

Current running demo stage was launched with PID 15964 / renderer CDP 9239;
Kitchen stage PID 15768 / CDP 9240. These were left running after the rejected
shutdown. Use each app's Quit menu when finished. A fresh sample demo is present;
user can sign in with admin 1234 / kitchen 4567. Main restaurant PID 4812 and
server 4100 were never stopped or used for test writes.

Updated only `build/desktop/app/ui` for the ordinary launcher, copying assets,
captain and kitchen folders then index last. Verified the server on 4100 serves
`index-lckz2_iA.js` at `/kitchen/`. The normal backend/installer were not rebuilt.
Source backend edits add optional demo metadata; ordinary runtime needs no new
API for the kitchen screen. Existing open windows need Ctrl+R for the new UI.
