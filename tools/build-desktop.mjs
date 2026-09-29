import { build } from "esbuild";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "build", "desktop", "app");
// Only ever clear the build staging directory, not source or restaurant data.
if (relative(root, stage).replaceAll("\\", "/") !== "build/desktop/app") throw new Error("Unsafe staging directory");
rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
const pkg = JSON.parse(readFileSync(join(root, "package.json")));
const deps = { ...JSON.parse(readFileSync(join(root, "apps/server/package.json"))).dependencies, "better-sqlite3": "*" };
delete deps["@forkflow/core"]; delete deps["@forkflow/domain"];
const installed = new Map();
function locate(name, from) {
  const lookup = createRequire(join(from, "package.json"));
  for (const path of lookup.resolve.paths(`${name}/package.json`) ?? []) {
    const candidate = join(path, name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
  }
  throw new Error(`Missing locked dependency ${name} from ${from}; run npm ci first`);
}
function copyDependency(name, from, parent = stage) {
  const source = locate(name, from);
  const manifest = JSON.parse(readFileSync(join(source, "package.json")));
  const top = join(stage, "node_modules", name);
  const target = !installed.has(top) || installed.get(top) === source ? top : join(parent, "node_modules", name);
  if (installed.get(target) === source) return manifest.version;
  installed.set(target, source);
  cpSync(source, target, { recursive: true, filter: (path) => !relative(source, path).split(/[\\/]/).includes("node_modules") });
  for (const dep of Object.keys(manifest.dependencies ?? {})) copyDependency(dep, source, target);
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
    try { locate(dep, source); } catch { continue; }
    copyDependency(dep, source, target);
  }
  return manifest.version;
}
for (const name of Object.keys(deps)) deps[name] = copyDependency(name, root);
await build({ entryPoints: [join(root, "apps/server/src/main.ts")], outfile: join(stage, "server/main.mjs"), bundle: true, packages: "external", platform: "node", format: "esm", target: "node24", sourcemap: true,
  plugins: [{ name: "workspace-source", setup(b) { b.onResolve({ filter: /^@forkflow\/(domain|core)$/ }, (args) => ({ path: join(root, "packages", args.path.split("/")[1], "src/index.ts") })); } }],
});
await build({ entryPoints: [join(root, "apps/desktop/src/main.ts")], outfile: join(stage, "main.js"), bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron"], sourcemap: true });
cpSync(join(root, "apps/ui/dist"), join(stage, "ui"), { recursive: true });
writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "forkflow-desktop", version: pkg.version, type: "module", main: "main.js", description: "Local restaurant billing, kitchen and stock management", author: "ForkFlow", private: true, dependencies: deps }, null, 2));

// Small original F icon, rendered without extra image or native build tools.
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const payload = Buffer.concat([Buffer.from(type), data]); const size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(payload)); return Buffer.concat([size, payload, crc]); }
const size = 256, pixels = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const i = y * (size * 4 + 1) + 1 + x * 4;
  const ink = x >= 64 && x < 96 && y >= 48 && y < 208 || x >= 96 && x < 192 && y >= 48 && y < 80 || x >= 96 && x < 168 && y >= 112 && y < 144;
  pixels.set(ink ? [255, 255, 255, 255] : [209, 45, 59, 255], i);
}
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
writeFileSync(join(stage, "icon.png"), png);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
writeFileSync(join(root, "build/desktop/icon.ico"), Buffer.concat([ico, png]));
console.log(`Desktop staged at ${stage}; ${installed.size} dependency packages copied from the lockfile installation.`);
