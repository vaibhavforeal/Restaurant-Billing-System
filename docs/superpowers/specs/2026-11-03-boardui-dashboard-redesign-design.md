# Dynamic Reports dashboard redesign with BoardUI

Date: 2026-11-03 · Branch: `feat/dynamic-reports` · Status: draft for review

## Goal

Redesign the Dynamic Reports Home dashboard (`apps/ui/src/dynamic-dashboard/`) with the BoardUI
design system: a more polished look, a better edit-mode experience, tablet/touch use, and
light/dark support. Free BoardUI components only (no Pro licence on this machine).

## Non-goals

- No change to any other POS screen. Billing, kitchen, captain, settings and the fixed
  `SalesDashboard` must look and behave exactly as today.
- No change to the server, domain package, API, layout schema or licensing.
- No replacement of the in-house grid logic (`packages/domain/src/dashboard/grid.ts`,
  `editing.ts`, `grid-pointer.ts`). BoardUI has no drag/resize grid; those stay and are restyled.
- No global Tailwind or whole-app theme migration.

## Findings that shape the design

- `apps/ui` is React 19 + Vite 8 with hand-written CSS; it has no Tailwind today.
- BoardUI is Tailwind v4 based; its `globals` entry includes base resets that would restyle
  every screen if loaded globally.
- The app already has a global theme: `theme.ts` sets `html[data-theme="light|dark"]`,
  persisted under `masalapos.theme.v1`, switched by `ThemeToggle.tsx`. BoardUI dark mode
  uses a `.dark` class.

## Design

### 1. Isolation
- Add `tailwindcss` and `@tailwindcss/vite` to `apps/ui`.
- One dashboard-only stylesheet (`dynamic-dashboard/boardui.css`) imports BoardUI `theme` and
  `typography` tokens and Tailwind **theme + utilities only, without preflight**. It is
  imported only by the dynamic-dashboard module.
- The dashboard renders inside a `.boardui-root` wrapper. BoardUI components are installed
  under `apps/ui/src/dynamic-dashboard/boardui/` (own `boardui.json` paths) so they are
  clearly separated from app code.
- Guard against class-name clashes: before install, check that no existing app CSS defines
  bare selectors equal to Tailwind utility names (`.flex`, `.hidden`, `.table`, `.border`,
  `.block`, `.grid`, ...). If any clash, resolve in the existing CSS or scope them.
- Test: a build-output check that BoardUI styles do not appear in a stylesheet loaded by
  non-dashboard screens, and a before/after screenshot of one non-dashboard screen.

### 2. Theme
- No second toggle. `.boardui-root` mirrors the app theme: it gets the `.dark` class when
  `html[data-theme="dark"]`, kept in sync by a small hook that observes the attribute.
- Existing `ThemeToggle` stays the single control.

### 3. Widgets (look)
- Each widget is a BoardUI card. KPI widgets use stat-card styling with delta chips.
- Charts keep `charts.tsx` / `DashboardCharts.tsx` as the data and rendering layer, restyled
  to BoardUI chart tokens; loading states use `skeleton`; errors use BoardUI notification
  styling.
- Live status widgets use `status-dot` / `chip`.

### 4. Edit mode (UX)
- Widget catalogue becomes a `drawer` (side drawer on desktop, bottom sheet on tablet).
- Widget settings become a `popover` on desktop and a drawer on tablet; period uses
  `segmented-control`, compare uses `switch`, options use `select`.
- Edit mode has a clear toolbar (Done / Add widget / Reset) using BoardUI `button`s, and
  widgets show visible drag and resize handles in edit mode only.

### 5. Tablet and touch
- Minimum 44px touch targets for toolbar buttons, handles and menu items.
- Larger drag/resize handles in edit mode; keep the existing tablet drag-safety behaviour
  (grid-pointer logic and its tests unchanged).
- Layout verified at tablet width (about 800-1280px) and desktop.

## Testing

- Existing unit tests (domain, server dashboard, `dynamic-dashboard/*.test.ts`) stay green;
  logic files are not changed except for props/markup plumbing.
- New tests: isolation check (above), theme-sync hook, and render tests for the new edit-mode
  components where the existing test setup allows.
- Playwright screenshots at tablet and desktop widths in both themes.
- Real-tablet touch drag/resize remains a manual check (no emulator).
- `typecheck` and `vite build` must pass for `apps/ui`.

## Risks

- Tailwind class-name clashes with existing CSS (mitigated in 1).
- Bundle size growth from React Aria (a BoardUI dependency); dashboard module is already
  lazy-loadable, so confirm it is code-split from the main POS bundle.
- Free-only components: any Pro-only look is out of scope.
- Working tree started from the WIP checkpoint commit `ba4f2a1`, which was committed
  without a full test run; the first implementation step re-runs the suite to establish a
  baseline.

## Open items for the plan

- Exact free BoardUI components to install (confirmed with `get_component` at plan time).
- Whether `DynamicDashboard` is already lazy-loaded.
