# ForkFlow

An AI-native restaurant POS. Offline-first: a **SQLite** database on each terminal is the source of truth during service, **PostgreSQL** in the cloud is the system of record for the business.

Product and architecture plan: [`PROJECT_PLAN.md`](./PROJECT_PLAN.md).

## Status — Phase 0 (foundations) built

A terminal boots, logs in, and syncs offline → online, proven by tests and a runnable demo.

```bash
npm install
npm test      # 37 tests
npm run demo  # the Phase 0 walkthrough
```

`npm run demo` provisions an outlet, signs a cashier in with no network, writes menu categories offline, reconnects and pushes them to PostgreSQL, then pulls a head-office edit back down.

## Layout

```
packages/
  sync/   UUIDv7 ids · hybrid logical clocks · conflict rule · transport interface
  db/     dual-dialect schema · terminal & cloud handles · repository · sync agent
  core/   password hashing · RBAC
apps/
  terminal-demo/   Phase 0 proof
spikes/
  menu-ingestion/  AI menu-photo → catalog spike (needs an API key to run)
```

## How the hybrid works

**One schema, two dialects.** Tables are declared once as a neutral column spec (`packages/db/src/dialect.ts`) and compiled to both SQLite and PostgreSQL, so terminal and cloud cannot drift apart. `packages/db/src/roundtrip.test.ts` writes the same row to a real SQLite and a real PostgreSQL and asserts they read back identically.

**Writes flow up, config flows down.** Every local mutation goes through the repository, which writes the row and appends to an `outbox` in one step. The sync agent drains the outbox to the cloud and pulls cloud changes back by HLC cursor.

**Conflicts resolve by hybrid logical clock.** Two tills that edit the same row while offline converge on the later write, and reach the *same* verdict independently — the terminal id is the final tiebreaker. See `packages/db/src/conflict.test.ts`.

**The sync transport is pluggable.** Everything above sits behind `SyncTransport` (`packages/sync/src/transport.ts`). Phase 0 ships a direct in-process implementation; choosing the real engine (custom outbox+CDC vs. PowerSync vs. ElectricSQL, `PROJECT_PLAN.md` §12) does not disturb the schema or the terminal.

## Not yet built

- **Network transport** — `createDirectTransport` writes straight into a cloud handle in-process. Nothing has crossed a wire yet.
- **Tauri terminal shell** — deferred to Phase 1, when there is a UI to wrap. Needs a Rust toolchain.
- **Next.js apps** — Phase 1.
- **Typed query surface** — tables are built from a runtime spec, so Drizzle's column generics are erased at the `DbHandle` boundary (one documented cast in `client.ts`). Row-level typing lands with the Phase 1 domain queries.
