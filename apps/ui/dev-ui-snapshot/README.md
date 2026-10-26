# Exact ForkFlow Dev UI

This snapshot contains the 11 compiled UI files from ForkFlow Dev 0.7.0,
copied unchanged from its `resources/app.asar`. `manifest.json` records
SHA-256 checksums. It does not contain restaurant data or the backend.

The editable UI source differs from this snapshot. A normal build compiles
that source and replaces the generated UI. To reproduce the requested Dev
appearance in the demo, run from the repository root:

```powershell
npm run build:demo
node tools/restore-dev-ui.mjs
```

Reopen or reload the demo after restoring. The restore command validates all
snapshot checksums before copying files into `apps/ui/dist` and
`build/desktop/demo/ui`. The snapshot is compiled output, not recovered React
source; future source changes require rebuilding and consciously choosing
whether to restore this exact version afterward.
