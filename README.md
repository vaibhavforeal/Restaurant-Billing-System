# ForkFlow

A local-only desktop POS for restaurants. One Windows PC runs everything —
an Electron shell, a Fastify server, and a SQLite database. Extra billing
counters, waiter phones, and the kitchen display are just browsers pointed
at the server's LAN address. No cloud.

Spec: [`docs/superpowers/specs/2026-08-13-desktop-pos-design.md`](./docs/superpowers/specs/2026-08-13-desktop-pos-design.md)

## Status — Milestone 1 (Foundation)

Schema, migrations, PIN auth with roles, a login/setup UI, and the Electron
shell. Modules (catalog, tables/KOT, billing, inventory) land in Milestones 2-5.

## Develop

```bash
npm install
npm test              # vitest across all workspaces
npm run typecheck
npm run dev           # server (:4100) + Vite UI (:5173) with hot reload
npm run dev:desktop   # the real thing: Electron window + server + built UI
```

The database lives in `./data/forkflow.db` (override with FORKFLOW_DATA_DIR).
Delete it to re-run first-time setup.

## Layout

```
packages/
  core/     PIN hashing (scrypt) · RBAC permission checks
  domain/   SQLite schema + migrations · roles · request schemas · uuidv7
apps/
  server/   Fastify: REST API · static UI hosting · the only SQLite writer
  ui/       React SPA served to the Electron window and LAN browsers
  desktop/  Thin Electron shell: supervises the server, opens the window
```
