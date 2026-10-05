import { build } from "esbuild";
import { mkdirSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "build/desktop/kitchen");
mkdirSync(stage, { recursive: true });
await build({ entryPoints: [join(root, "apps/kitchen-desktop/src/main.ts")], outfile: join(stage, "main.js"), bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron"] });
await build({ entryPoints: [join(root, "apps/kitchen-desktop/src/preload.ts")], outfile: join(stage, "preload.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron"] });
for (const file of ["connect.html", "connect.css", "connect.js"]) copyFileSync(join(root, "apps/kitchen-desktop/src", file), join(stage, file));
writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "forkflow-kitchen", version: JSON.parse(readFileSync(join(root, "package.json"))).version, type: "module", main: "main.js", author: "ForkFlow", description: "Kitchen display connected to the restaurant POS", private: true }));
console.log(`Kitchen client staged at ${stage}`);
