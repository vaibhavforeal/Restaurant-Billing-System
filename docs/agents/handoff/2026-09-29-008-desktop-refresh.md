# Desktop refreshed with recipes and table QR ordering

After the user's acknowledgement, rebuilt the development desktop staging app
and restarted ForkFlow on port 4100 using its existing data folder:
`C:\Users\AR\AppData\Roaming\forkflow-desktop\data`.

- Created and verified an online SQLite backup before stopping the old process:
  `backups/forkflow-pre-update-1790659363817-fc37fc7f-0b51-465d-8632-75d7a5886aa1.db`.
- `npm run build:desktop` passed. Launched the result through the standard
  Electron launcher. The running desktop is a development build, not a newly
  packaged commercial installer.
- Startup migrated the database from schema 7 to 9. SQLite integrity and foreign
  key checks passed. Counts of users, products, orders, order items, bills,
  stock items and stock movements match the pre-restart baseline.
- Health endpoint passed, and the native `ForkFlow POS` window is open.
  Browser verification confirmed the sign-in screen and guest menu route load
  without runtime errors. QR administration requires staff authentication.
- Recipe and guest-ordering flows had already passed the isolated integration
  gates documented in handoffs 006 and 007. No test orders or catalog entries
  were added to the existing desktop data during this restart.

The earlier note that the desktop had not been refreshed is now resolved.
Cloud hosting/sync, commercial packaging, and real-phone/hardware checks remain
separate work.
