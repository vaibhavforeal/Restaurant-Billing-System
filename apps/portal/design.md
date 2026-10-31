# ForkFlow portal design

Scope: the staff portal only. React, routes, permissions, payloads and existing states stay intact.

## System

Hallmark 2.0, full redesign, app scope. Coral was dealt first of three themes. Its warm neutral paper and ink suit the portal's records; retain the ForkFlow red mark. System sans fonts satisfy the same-origin CSP without downloads. No textures, stationery illustrations, marketing hero, new metrics or decorative animation.

The source of truth is `src/portal.css`, including its root tokens. Keep one stylesheet as the project brief requests; fold the scaffold's useful tokens and base rules into it.

- Paper: warm pale grey canvas, near-white work surfaces, charcoal text.
- Accent: ForkFlow red for selection and focus; ink primary controls.
- Typography: system sans, tabular numbers, mono only for identifiers. Sentence case labels, no tracked capitals.
- Shape: compact staff navigation, full-width record ledgers, ruled totals, lightly tinted supporting rails. Today leads with actionable work rather than a greeting and four cards.
- Controls: 40px default, 44px phone targets, 6px corners. Visible focus, native disabled state, no layout animation.
- Records: horizontal rules, no nested card frames. Existing phone stacking retained.
- Layout: capped centred content, 24px grid gap, responsive drawer below 960px.
- States: preserve existing loading, empty, failure/retry and populated states. Do not add new application behavior for styling.

## Page composition

Today: compact totals beside the page identity; follow-up/payment work ledger and a supporting pipeline/renewals rail. Reports: chart and table with clear numerical hierarchy. Details: record summary beside supporting facts, existing forms and actions unchanged. Lists: aligned tabs/filter bar and ruled rows. Sign-in: brand and task context alongside the real credential form.

## Motion and assets

Still at rest. Only short control feedback, reduced-motion honored. No external assets, libraries, calls or invented proof. The source contains the existing brand mark.
