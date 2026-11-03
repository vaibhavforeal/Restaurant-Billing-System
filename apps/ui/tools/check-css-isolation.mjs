// Proves BoardUI/Tailwind styles ship only in the lazy dashboard chunk and cannot restyle the rest of the POS.
// Builds into a scratch folder (never apps/ui/dist), then inspects the output.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "..", "..", ".superpowers", "css-isolation-dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({ root, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
if (!existsSync(join(out, "index.html"))) throw new Error("build produced no index.html");

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const files = (dir, ext) => readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(ext)).map((f) => join(dir, String(f)));
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
check(!dashboardCss.some((f) => entryCss.includes(f)), "dashboard CSS is part of the entry stylesheet");
for (const f of entryJs) check(!readFileSync(f, "utf8").includes("boardui-root"), `entry JS ${relative(out, f)} contains the dashboard`);

// BoardUI is sized in rem and the POS root is 13px, so the build rewrites rem to px (vite.config.ts boardRemToPx).
for (const f of dashboardCss) check(!/--spacing:\s*[\d.]+rem/.test(readFileSync(f, "utf8")), `dashboard CSS ${relative(out, f)} still sizes BoardUI in rem`);

// No Tailwind preflight anywhere (it restyles every element it reaches).
const preflight = [/\*,\s*:?:?before,\s*:?:?after[^{]*\{[^}]*box-sizing/, /button,\s*input,\s*select,\s*optgroup,\s*textarea/];
for (const f of allCss) for (const p of preflight) check(!p.test(readFileSync(f, "utf8")), `${relative(out, f)} contains Tailwind preflight`);

// The dashboard stylesheet must not redeclare a custom property the POS already uses.
// --control-touch is the one deliberate override; it is set only inside .boardui-root.
const SCOPED_OVERRIDES = new Set(["--control-touch"]);
const declared = (css) => new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
const appFiles = files(join(root, "src"), ".css").filter((f) => !f.includes(join("dynamic-dashboard", "boardui")) && !f.endsWith("boardui.css"));
const appVars = new Set(appFiles.flatMap((f) => [...declared(readFileSync(f, "utf8"))]));
for (const f of dashboardCss) for (const name of declared(readFileSync(f, "utf8"))) check(SCOPED_OVERRIDES.has(name) || !appVars.has(name), `dashboard CSS redeclares the POS custom property ${name}`);

rmSync(out, { recursive: true, force: true });
if (failures.length) { console.error(failures.map((m) => `FAIL ${m}`).join("\n")); process.exit(1); }
console.log(`css isolation OK (${entryCss.length} entry stylesheet(s), ${dashboardCss.length} dashboard stylesheet(s), ${appVars.size} POS custom properties checked)`);
