// Bundles the server into dist/ with everything it needs beside it: migrations and the built portal. Only better-sqlite3 stays external (native).
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
await build({ entryPoints: ["src/main.ts"], outfile: "dist/main.mjs", bundle: true, platform: "node", format: "esm", target: "node22", external: ["better-sqlite3"], sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
cpSync("../licensing-worker/migrations", "dist/migrations", { recursive: true });
if (existsSync("../portal/dist")) cpSync("../portal/dist", "dist/web", { recursive: true });
else console.warn("The portal is not built (npm run build -w @forkflow/portal), so dist/web is missing and /portal will answer 503.");
console.log("Built apps/licensing-node/dist");
