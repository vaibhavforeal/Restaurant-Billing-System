# BoardUI Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Dynamic Reports Home dashboard with free BoardUI components, with a better edit mode, touch-friendly controls and light/dark support, without changing any other POS screen.

**Architecture:** Tailwind v4 and BoardUI load only inside the lazily-loaded dashboard module, behind a `.boardui-root` wrapper, with no global reset. The wrapper mirrors the app's existing `html[data-theme]` as BoardUI's `.dark` class. The grid/drag logic and all data hooks are untouched; only markup, classes and the edit-mode dialogs change.

**Tech Stack:** React 19, Vite 8, Tailwind CSS v4 (`tailwindcss`, `@tailwindcss/vite`), BoardUI free components (React Aria based), vitest (node env, `renderToStaticMarkup`), Playwright MCP for visual checks.

**Spec:** `docs/superpowers/specs/2026-11-03-boardui-dashboard-redesign-design.md`

## Global Constraints

- Free BoardUI components only; no Pro licence is active.
- Nothing outside `apps/ui/src/dynamic-dashboard/` (plus `Home.tsx` lazy import, `vite.config.ts`, `apps/ui/package.json`, docs) changes. No server, domain, API, schema or licensing change.
- `charts.tsx` is also used by `OrderAnalyticsCharts.tsx`: do not restyle it; restyle `DashboardCharts.tsx` and the `dd-*` CSS only.
- Do not edit `grid.ts`, `editing.ts`, `grid-pointer.ts` or their tests except to keep them compiling.
- BoardUI source is installed only under `apps/ui/src/dynamic-dashboard/boardui/`. Do not let `init_boardui` overwrite the repo-root `AGENTS.md`, `CLAUDE.md` or `.cursor`; use `projectDir` `apps/ui` and review every file it writes.
- Tailwind runs without preflight. Use BoardUI semantic tokens (`text-text-primary`, `bg-background-*`, `border-border-*`), never raw palette classes or hex, and `cx()` to merge classes.
- Touch targets in dashboard edit mode are at least 44px; set it with `--control-touch: 44px` scoped to `.boardui-root`, not in `pos-tokens.css`.
- Existing keyboard drag/resize behaviour and its `aria-label` text stay.

## Review Focus

- App-wide element rules (`html[data-theme] button`, `input`, `select` in `theme.css`) are unlayered and can override BoardUI's layered utilities, making BoardUI controls look like POS buttons. Expected: BoardUI controls keep BoardUI styling inside the dashboard. (Task 1)
- Theme switched while the dashboard is open, or `data-theme` missing/unknown. Expected: wrapper follows immediately; missing means light. (Task 1)
- Popovers, drawers and menus render in portals outside `.boardui-root` and lose tokens and dark mode. Expected: overlays are styled correctly in both themes. (Task 4)
- Settings or catalogue open for a widget that is then removed, or edit mode left (Cancel/Save/Reset) while an overlay is open. Expected: overlay closes, no crash, no stale draft. (Task 4)
- Pressing a BoardUI button inside the drag handle (Settings/Remove) must not start a drag, and a touch drag must still work with larger handles. Expected: tools click normally; handle and grip still drag. (Tasks 4, 5)

---

### Task 1: Tailwind + BoardUI foundation, isolation and theme sync

**Files:**
- Modify: `apps/ui/package.json` (add `tailwindcss`, `@tailwindcss/vite`, BoardUI runtime deps as installed), `apps/ui/vite.config.ts` (add the Tailwind plugin), `apps/ui/src/screens/Home.tsx` (lazy `DynamicDashboard`)
- Create: `apps/ui/boardui.json`, `apps/ui/src/dynamic-dashboard/boardui.css`, `apps/ui/src/dynamic-dashboard/boardui/` (installed source), `apps/ui/src/dynamic-dashboard/BoardRoot.tsx`, `apps/ui/src/dynamic-dashboard/board-theme.ts`, `apps/ui/src/dynamic-dashboard/board-theme.test.ts`, `apps/ui/tools/check-css-isolation.mjs`
- Modify: `apps/ui/src/dynamic-dashboard/DynamicDashboard.tsx` (wrap output in `BoardRoot`)

**Interfaces:**
- Produces:
  - `boardThemeClass(attr: string | null | undefined): "dark" | ""` in `board-theme.ts`; `"dark"` only for exactly `"dark"`.
  - `useAppTheme(): "light" | "dark"` in `board-theme.ts`; reads `document.documentElement.dataset.theme` and re-renders on change via `MutationObserver`.
  - `<BoardRoot className?: string>{children}</BoardRoot>` in `BoardRoot.tsx`; renders `<div className="boardui-root [dark]">`, and exposes its element through `useBoardRootElement(): HTMLElement | null` (context) for overlay portal containers.
  - `npm run check:css-isolation -w @masalapos/ui` runs `tools/check-css-isolation.mjs`.

- [ ] **Step 1: Write the failing test** in `board-theme.test.ts`: `boardThemeClass("dark") === "dark"`; `boardThemeClass("light") === ""`; `boardThemeClass(undefined) === ""`; `boardThemeClass("DARK") === ""`; and `renderToStaticMarkup` of `BoardRoot` contains `class="boardui-root"` (no `dark`) in the node env.
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/dynamic-dashboard/board-theme.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 2b: Baseline screenshots.** Before any install, run the app and save Playwright screenshots of the Tables and Settings screens at 1280x800 in light and dark to `.claude/screenshots-baseline/` (already untracked; do not commit); Task 6 compares against them.
- [ ] **Step 3: Collision check before installing.** Run a grep of `apps/ui/src/**/*.css` for bare selectors equal to Tailwind utility names used by BoardUI (`.flex`, `.hidden`, `.block`, `.grid`, `.table`, `.border`, `.relative`, `.absolute`, `.fixed`, `.inline`, `.truncate`, `.container`, `.sr-only`). Expected: none; if any exist, scope or rename them in the existing CSS and note it in the commit message.
- [ ] **Step 4: Install.** `npm i -w @masalapos/ui tailwindcss @tailwindcss/vite`; create `apps/ui/boardui.json` mapping components to `src/dynamic-dashboard/boardui/` with the `@/` alias resolved in `tsconfig.json` and `vite.config.ts` for that folder only; call `init_boardui` and `install_components` (MCP, `projectDir` `apps/ui`) for: `theme`, `typography`, `cx`, `button`, `icon-button`, `chip`, `segmented-control`, `select`, `switch`, `popover`, `drawer`, `tooltip`, `skeleton`, `status-dot`, `notification`, `direction`. Review the written files; revert anything outside `apps/ui`.
- [ ] **Step 5: Write `boardui.css`**: import BoardUI `theme` and `typography`, `@import "tailwindcss/theme"` and `@import "tailwindcss/utilities"` (no `preflight`), the `.dark` custom variant scoped to `.boardui-root`, and `.boardui-root { --control-touch: 44px; }`. Import it only from `DynamicDashboard.tsx`.
- [ ] **Step 6: Implement `board-theme.ts` and `BoardRoot.tsx`** per the Interfaces; wrap the return of `DynamicDashboard` (all three branches) in `BoardRoot`. In `Home.tsx` replace the static import with `React.lazy(() => import("../dynamic-dashboard/DynamicDashboard").then(m => ({ default: m.DynamicDashboard })))` inside `<Suspense fallback={<p role="status">Loading dashboard…</p>}>`.
- [ ] **Step 7: Cascade check.** Write `tools/check-css-isolation.mjs` to run `vite build` and assert: (a) the entry CSS chunk contains no Tailwind preflight marker (`*,:before,:after{box-sizing` or `--tw-` property defaults); (b) the dashboard chunk CSS exists; (c) `DynamicDashboard` is not in the entry JS chunk. Then in the running dev app, via Playwright `browser_evaluate`, assert a BoardUI `Button` inside `.boardui-root` has the BoardUI background (computed `background-image`/`background-color` differs from a plain POS `<button>`). If the POS element rules win, add the Tailwind `important` flag to the utilities import (`@import "tailwindcss/utilities" layer(utilities) important;`) and re-check; record which fix was needed in the commit message.
- [ ] **Step 8: Run** `npx vitest run apps/ui` , `npm run typecheck -w @masalapos/ui`, `npm run check:css-isolation -w @masalapos/ui`. Expected: all PASS.
- [ ] **Step 9: Commit** `feat(ui): isolated Tailwind and BoardUI foundation for the dashboard`.

### Task 2: Widget cards, KPI, status, ranking, loading and error states

**Files:**
- Modify: `apps/ui/src/dynamic-dashboard/widgets.tsx`, `apps/ui/src/dynamic-dashboard/DynamicDashboard.tsx` (`header`), `apps/ui/src/dynamic-dashboard/DashboardGrid.tsx` (card surface classes), `apps/ui/src/dynamic-dashboard/dynamic-dashboard.css`
- Test: `apps/ui/src/dynamic-dashboard/widgets.test.ts`

**Interfaces:**
- Consumes: BoardUI `Chip`, `Skeleton`, `StatusDot`, `Notification`/`Button` from `./boardui/...`; `WidgetBodyProps` unchanged.
- Produces: `WidgetBody` with the same props and the same text output (values, "vs label", "Nothing sold in this period.", `role="alert"` error with a Retry button, `aria-busy` skeleton labelled `Loading <title>`).

- [ ] **Step 1: Update `widgets.test.ts`** first: keep every existing assertion on text, `role="alert"`, `aria-busy`, Retry, and the screen-reader "up"/"down" text; add assertions that the change indicator renders as a BoardUI chip (class from `Chip`) with `▲`/`▼` `aria-hidden`, and that a loading result renders the BoardUI skeleton (still `aria-busy`).
- [ ] **Step 2: Run** the file. Expected: new assertions FAIL.
- [ ] **Step 3: Restyle `widgets.tsx`**: `Change` becomes a soft `Chip` (success for up, danger for down, neutral for flat/none); KPI and status values use the BoardUI headline type utility; ranking rows and status detail keep their markup but use token classes; the error block uses BoardUI `Button` (secondary, small) for Retry; loading uses `Skeleton`.
- [ ] **Step 4: Restyle the card** in `DashboardGrid.tsx`/`dynamic-dashboard.css`: `.dd-item` surface, border and radius come from BoardUI tokens; remove the now-unused `dd-*` colour rules (leave grid geometry rules untouched).
- [ ] **Step 5: Run** `npx vitest run apps/ui/src/dynamic-dashboard` and typecheck. Expected: PASS.
- [ ] **Step 6: Commit** `feat(ui): BoardUI cards and KPI/status widgets`.

### Task 3: Chart styling

**Files:**
- Modify: `apps/ui/src/dynamic-dashboard/DashboardCharts.tsx`, `apps/ui/src/dynamic-dashboard/dynamic-dashboard.css` (chart rules only)
- Test: `apps/ui/src/dynamic-dashboard/DashboardCharts.test.ts`

**Interfaces:**
- Consumes: BoardUI chart tokens (`chart` colour group in `theme`), `IconButton` for the previous/next value buttons.
- Produces: `TimeChart`, `BreakdownChart`, `plotRange` with unchanged signatures and unchanged text (`₹150.00`, `Yesterday: `, `-₹150.00`, `Next Daily trend value`).

- [ ] **Step 1: Extend `DashboardCharts.test.ts`**: existing assertions stay; add that the previous/next controls render as BoardUI icon buttons with their `aria-label`s intact, and that chart marks use token classes/CSS variables (no hex colour literals in the markup).
- [ ] **Step 2: Run** the file. Expected: new assertions FAIL.
- [ ] **Step 3: Implement**: replace `var(--pos-accent)`/`var(--muted)` chart colours with BoardUI chart/foreground tokens (light and dark both defined by tokens), swap the nav buttons for `IconButton`s (44px hit area via the root touch variable), keep SVG geometry and keyboard behaviour.
- [ ] **Step 4: Run** dashboard tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): BoardUI chart styling and dark mode`.

### Task 4: Edit toolbar, catalogue drawer and settings

**Files:**
- Create: `apps/ui/src/dynamic-dashboard/EditToolbar.tsx`, `apps/ui/src/dynamic-dashboard/edit-ui.test.ts`
- Modify: `apps/ui/src/dynamic-dashboard/DynamicDashboard.tsx`, `apps/ui/src/dynamic-dashboard/WidgetCatalogue.tsx`, `apps/ui/src/dynamic-dashboard/WidgetSettings.tsx`, `apps/ui/src/dynamic-dashboard/DashboardGrid.tsx` (tool buttons only), `apps/ui/src/dynamic-dashboard/dynamic-dashboard.css`

**Interfaces:**
- Consumes: `useBoardRootElement()` from Task 1 (overlay portal container); BoardUI `Button`, `Drawer`, `Popover`, `SegmentedControl`, `Select`, `Switch`; existing `ORDER_TYPES`, `topNChoices`.
- Produces:
  - `<EditToolbar editing: boolean; busy: boolean; full: boolean; onCustomise(): void; onAdd(): void; onReset(): void; onCancel(): void; onSave(): void />`. Same labels as today (`Customise`, `+ Add widget`, `Reset to default`, `Cancel`, `Save`/`Saving…`, "Your dashboard is full" title), plus the existing edit hint.
  - `WidgetCatalogue` and `WidgetSettings` keep their current props (`open/onPick/onClose`, `item/onChange/onClose`) so `DynamicDashboard` wiring does not change.
  - `topNChoices` and `ORDER_TYPES` stay exported from `WidgetSettings.tsx`.

- [ ] **Step 1: Write `edit-ui.test.ts`** (`renderToStaticMarkup`): `EditToolbar` not editing shows only Customise; editing shows Add widget, Reset to default, Cancel, Save; `full` disables Add with the title; `busy` shows `Saving…` and disables all. `WidgetSettings` with `item=null` renders nothing and does not throw; with a KPI item shows Period and Compare controls and not "How many items"; Zomato option hidden when the module is inactive (reuse the existing module mocking approach in `live-and-settings.test.ts`).
- [ ] **Step 2: Run** the file. Expected: FAIL (`EditToolbar` missing).
- [ ] **Step 3: Implement `EditToolbar`** and use it in `DynamicDashboard` in place of the inline toolbar.
- [ ] **Step 4: Implement the catalogue** as a BoardUI `Drawer` (side on `min-width: 1024px`, bottom sheet below) grouped Numbers/Charts/Live service, each widget a full-width pressable row (min 44px) with title and description; picking closes it. Mount the overlay into the `BoardRoot` element so it inherits tokens and `.dark`.
- [ ] **Step 5: Implement settings** with the same drawer/bottom-sheet on tablet and a `Popover` on desktop: Period as `SegmentedControl` when 4 or fewer choices else `Select`, Compare as `Select`, Order type as `SegmentedControl`, How many items as `Select`; changes apply immediately via `onChange`; `Done` closes. When `item` becomes null while open, the overlay closes.
- [ ] **Step 6: Swap the Settings/Remove tool buttons** in `DynamicDashboard.renderTools` to BoardUI ghost `Button`s with 44px hit areas; keep `aria-label`s (`<title> settings`, `Remove <title>`) and the `onPointerDown stopPropagation` wrapper in `DashboardGrid` so presses never start a drag.
- [ ] **Step 7: Run** `npx vitest run apps/ui`, typecheck. Expected: PASS.
- [ ] **Step 8: Commit** `feat(ui): BoardUI edit toolbar, catalogue drawer and widget settings`.

### Task 5: Touch targets and handles

**Files:**
- Modify: `apps/ui/src/dynamic-dashboard/DashboardGrid.tsx` (classes only), `apps/ui/src/dynamic-dashboard/dynamic-dashboard.css`

**Interfaces:**
- Consumes: `--control-touch` (44px under `.boardui-root`). Produces: no new API.

- [ ] **Step 1: Make the handle and grip clearly visible** in edit mode: `.dd-handle` min-height `var(--control-touch)`, a BoardUI-style grab icon, `.dd-grip` `var(--control-touch)` square with a visible BoardUI foreground-icon glyph; `touch-action: none` stays on both.
- [ ] **Step 2: Verify `grid-pointer.test.ts` and `editing.test.ts` still pass unchanged.** Run `npx vitest run apps/ui/src/dynamic-dashboard`. Expected: PASS.
- [ ] **Step 3: Playwright check** at 800x1200 and 1280x800 in edit mode: every interactive element inside the dashboard has a bounding box of at least 44x44 (assert with `browser_evaluate`), and mouse drag of a widget header and of the grip changes the layout draft.
- [ ] **Step 4: Commit** `feat(ui): 44px touch targets and clearer drag handles`.

### Task 6: Visual verification, docs and full checks

**Files:**
- Modify: `docs/operations/dynamic-reports.md` (screenshots notes: theme follows the app toggle; edit mode controls; tablet behaviour)

- [ ] **Step 1: Run the app** (`npm run dev`, UI on the Vite port, server on 4100) with the demo data, sign in as a user with `reports.dashboard`, and with Playwright take screenshots of: view mode, edit mode, catalogue drawer, settings, at 1280x800 and 800x1200, in light and dark (use the existing `ThemeToggle`). Look at each; fix any clipped text, low contrast or unstyled control.
- [ ] **Step 2: Regression check of another screen**: retake the Tables and Settings screenshots and compare them with the Task 1 baseline; they must be identical apart from data.
- [ ] **Step 3: Full checks**: `npm test`, `npm run typecheck`, `npm run build -w @masalapos/ui`, `npm run check:css-isolation -w @masalapos/ui`. Expected: all pass. Report any pre-existing failures separately (known earlier: 2 UTC-vs-local date failures, 1 flaky).
- [ ] **Step 4: Update the operations doc** and note that real-tablet touch drag/resize remains a manual check.
- [ ] **Step 5: Commit** `docs: dashboard redesign notes`.
