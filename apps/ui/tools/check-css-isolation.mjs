// Proves BoardUI/Tailwind styles ship only in the lazy dashboard chunk and cannot restyle the rest of the POS.
// Builds into a scratch folder (never apps/ui/dist), then inspects the output.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "masalapos-css-isolation-"));
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const files = (dir, ext) => readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(ext)).map((f) => join(dir, String(f)));

try {
  mkdirSync(out, { recursive: true });
  await build({ root, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  if (!existsSync(join(out, "index.html"))) throw new Error("build produced no index.html");

  const html = readFileSync(join(out, "index.html"), "utf8");
  const entryCss = [...html.matchAll(/href="([^"]+\.css)"/g)].map((m) => join(out, m[1]));
  const entryJs = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => join(out, m[1]));
  const allCss = files(out, ".css");
  const dashboardCss = allCss.filter((f) => readFileSync(f, "utf8").includes(".boardui-root"));

  check(entryCss.length > 0, "the entry HTML links no stylesheet");
  check(dashboardCss.length > 0, "no stylesheet contains .boardui-root (dashboard CSS missing)");
  for (const f of entryCss) {
    const css = readFileSync(f, "utf8");
    check(!css.includes(".boardui-root"), `entry CSS ${relative(out, f)} contains BoardUI styles`);
    check(!css.includes("--tw-"), `entry CSS ${relative(out, f)} contains Tailwind output`);
  }
  // charts.tsx is shared with the Reports page, which loads without the dashboard chunk: its own classes must ship eagerly.
  for (const cls of [".dd-empty", ".dd-legend"]) check(entryCss.some((f) => readFileSync(f, "utf8").includes(cls)), `entry CSS lacks ${cls} (shared charts.tsx needs it outside the dashboard chunk)`);
  check(!dashboardCss.some((f) => entryCss.includes(f)), "dashboard CSS is part of the entry stylesheet");
  for (const f of entryJs) check(!readFileSync(f, "utf8").includes("boardui-root"), `entry JS ${relative(out, f)} contains the dashboard`);

  // BoardUI is sized in rem and the POS root is 13px, so the build rewrites rem to px (vite.config.ts boardRemToPx).
  for (const f of dashboardCss) check(!/--spacing:\s*[\d.]+rem/.test(readFileSync(f, "utf8")), `dashboard CSS ${relative(out, f)} still sizes BoardUI in rem`);

  // No Tailwind preflight anywhere (it restyles every element it reaches). Preflight starts `*, ::after, ::before, ...{box-sizing:border-box`.
  const preflight = [/\*\s*,\s*:{1,2}(?:after|before)\s*,[^{]*\{[^}]*box-sizing/, /button\s*,\s*input\s*,\s*select\s*,\s*optgroup\s*,\s*textarea/];
  for (const f of allCss) for (const p of preflight) check(!p.test(readFileSync(f, "utf8")), `${relative(out, f)} contains Tailwind preflight`);

  // The dashboard stylesheet must not redeclare a custom property the POS already uses.
  // --control-touch is the one deliberate override; it is set only inside .boardui-root.
  const SCOPED_OVERRIDES = new Set(["--control-touch"]);
  const declared = (css) => new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
  const appFiles = files(join(root, "src"), ".css").filter((f) => !f.includes(join("dynamic-dashboard", "boardui")) && !f.endsWith("boardui.css"));
  const appVars = new Set(appFiles.flatMap((f) => [...declared(readFileSync(f, "utf8"))]));
  for (const f of dashboardCss) for (const name of declared(readFileSync(f, "utf8"))) check(SCOPED_OVERRIDES.has(name) || !appVars.has(name), `dashboard CSS redeclares the POS custom property ${name}`);

  // Vite never removes chunk CSS once injected, so after anyone opens Home every class below stays in the document.
  // The dashboard's Tailwind utilities are !important: a POS className equal to one of them (hidden, grid, flex, ...) would be overridden.
  const classSelector = /(?:^|[}{;,])\s*\.((?:\\.|[\w-])+)\s*(?=[{,])/g;
  const dashboardClasses = new Set(dashboardCss.flatMap((f) => [...readFileSync(f, "utf8").matchAll(classSelector)].map((m) => m[1].replace(/\\(.)/g, "$1"))));
  const posSources = files(join(root, "src"), ".tsx").filter((f) => !f.includes("dynamic-dashboard") && !f.endsWith(".test.tsx"));
  const classAttribute = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\}|\{'([^']*)'\})/g;
  const classExpression = /className=\{[^}]*?["'`]([^"'`]*)["'`]/g;
  for (const f of posSources) {
    const source = readFileSync(f, "utf8");
    const tokens = new Set([...source.matchAll(classAttribute), ...source.matchAll(classExpression)].flatMap((m) => m.slice(1).filter(Boolean).flatMap((v) => v.split(/\s+/))));
    for (const token of tokens) check(!dashboardClasses.has(token), `POS markup ${relative(root, f)} uses class "${token}", which the dashboard stylesheet also defines (!important, and it stays loaded after Home opens)`);
  }

  if (failures.length) { console.error(failures.map((m) => `FAIL ${m}`).join("\n")); process.exitCode = 1; }
  else console.log(`css isolation OK (${entryCss.length} entry stylesheet(s), ${dashboardCss.length} dashboard stylesheet(s), ${appVars.size} POS custom properties, ${dashboardClasses.size} dashboard classes vs ${posSources.length} POS files)`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
