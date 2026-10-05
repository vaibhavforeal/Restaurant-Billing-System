# Captain picker repair

The user reported that the native captain dropdown would not open in the desktop
app. Read-only inspection confirmed an active waiter, Suraj, and successful
captain-directory reads. No captain PATCH requests were recorded during the
reported attempts. The native select worked in the browser fixture; the exact
desktop popup failure could not be reproduced in the live window because native
automation was unavailable.

Replaced that select in OrderScreen with the existing WorkspaceDialog and named
captain buttons. It supports current selection, removal, inactive/empty staff
explanations, saving locks, and retry errors inside the dialog. The existing
server validation and optimistic concurrency check remain in use. Successful
PATCH responses immediately update the displayed assignment.

Validation: workspace typecheck and UI build passed; all 3 table-captains API
tests passed. tools/e2e/captain-picker.js passed 10 checks in Chromium and the
same 10 checks in an isolated Electron window against the in-memory fixture on
4139. Mouse opening, keyboard Escape/Enter/Tab, 390px light/dark layouts, and
44px choice targets were checked. Neither browser reported JS errors.

Updated build/desktop/app/ui (assets, captain PWA, index last), and verified the
live server on 4100 serves index-v_-35dwr.js. No backend rebuild, installer
repackage, or restaurant-data mutation. The open desktop window needs Ctrl+R.
Screenshots: output/captain/selector-dialog-{desktop,mobile,dark}.png.
