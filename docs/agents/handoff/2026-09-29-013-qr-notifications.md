# QR order notifications

Added global staff QR request alerts for admins, cashiers, and waiters. The
pending banner appears across staff screens; its Review button opens the pending
QR dialog through the existing navigation/save guard. Kitchen-only sessions and
guest menus do not start a notification monitor.

New arrivals trigger a two-note Web Audio chime (enabled by default, activated by
user interaction). The QR inbox contains a persisted sound toggle, Test sound,
and a desktop permission button. Granted desktop notifications show while the
window is unfocused/backgrounded; clicking them opens the request inbox.

The global monitor uses authenticated reads and WebSocket invalidation with a
15-second fallback/focus refresh. Concurrent events coalesce into a follow-up
read. IDs are retained until expiry to suppress repeated alerts. Initial pending
requests appear silently. Unmount/logout aborts reads, disconnects listeners,
closes audio and desktop notifications. No server or database changes.

Verification: five focused tests passed (arrival deduplication, expired/batch
requests, in-flight events, polling/error recovery, and late results after
cleanup). Full TypeScript check and UI production build passed. Isolated browser
QA on 4121 submitted real guest requests, verified Home alerts, chime oscillator
creation, simulated background Notification calls, direct inbox navigation,
saved mute, and clearing after rejection. Desktop and phone screenshots were
reviewed. No browser errors. Actual OS toast delivery/audio output depend on the
device and were not physically verified.

Browser gate: `tools/e2e/qr-notifications.js`, run with agent-browser eval on the
disposable `.e2e-scratch/takeaway-preview.ts` server after staff login/device
registration and a click on Tables. Evidence is `.e2e-scratch/qr-notifications-*`.

Built UI assets copied into `build/desktop/app/ui`; the live desktop on 4100 can
load the update with Ctrl+R. The existing restaurant database is untouched by QA.
