# Menu-Ingestion Spike

De-risks the product's #1 differentiator: **turn a real menu photo/PDF into a structured, review-ready catalog** — self-serve, in seconds. If the extraction quality is good, the whole "easier than PetPooja" onboarding story is real.

This is a throwaway spike (standalone CLI), not production code — it proves the approach before we wire it into the app.

## What it does

1. Sends a menu **image or PDF** straight to `claude-opus-4-8` (vision), with a **forced JSON schema** — no separate OCR step, so the model keeps the menu's spatial layout (which price belongs to which item, which items sit under which heading).
2. Extracts categories → items → variations/add-ons → prices, plus `veg_status`, `spice_level`, and a per-item **confidence**.
3. Runs a **review layer in code** (not the model): flags low-confidence reads, missing prices, and price outliers — the "trust" half that keeps a misread price from becoming a billing bug.
4. Writes `<menu>.catalog.json`.

See `../../PROJECT_PLAN.md` §3.0.1 for the design rationale.

## Setup

```bash
cd "spikes/menu-ingestion"
npm install
```

Auth — the Anthropic SDK reads credentials from the environment. Either:

- `export ANTHROPIC_API_KEY=sk-ant-...`, **or**
- run `ant auth login` once (the zero-arg client then picks up the profile automatically).

> In this Claude Code session you can run a login yourself by typing `! ant auth login` in the prompt.

## Run

```bash
npm run ingest -- ./my-menu.jpg
# or
npm run ingest -- ./my-menu.pdf
```

Supported inputs: `.png .jpg .jpeg .webp .gif .pdf`.

## Example output

```
📷  Ingesting: ./cafe-menu.jpg
✅  Extracted in 11.4s
    categories:  6
    items:       48
    median price:180

🍽   Catalog preview:
  Beverages
    • Masala Chai  —  40
    • Cold Coffee  —  Regular 120 / Large 160
  ...

⚠️   2 item(s) need a human glance before going live:
    - [Beverages] Filter Kaapi: low-confidence read — verify name & price
    - [Mains] Thali (Unlimited): no price found — enter manually

💾  Wrote structured catalog → ./cafe-menu.catalog.json
```

## What "good" looks like

Run it on 3–4 messy real menus (glare, handwriting, multi-column, regional script). We're checking:

- **Structure** correct — right items under right categories, variations captured.
- **Prices** accurate — this is the risk; the review flags should catch the misses.
- **Confidence** honest — hard-to-read items actually get flagged `low`.

If it holds up, the onboarding wedge is validated and we build the review-UI around this exact schema.
