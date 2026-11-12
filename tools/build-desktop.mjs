import { build } from "esbuild";
import { resolveWorkspace } from "./workspace-exports.mjs";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { desktopBuildConfig, installerActivationScript, installerConfig } from "./desktop-build-config.mjs";
import { stageCaptainAndroid } from "./captain-android-release.mjs";
import { googleOAuthClient } from "./google-oauth-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { demo, commercial, edition, stageName, publicKey, verificationKeyFingerprint, serviceUrl } = desktopBuildConfig(process.argv.slice(2), process.env);
if (process.argv.includes("--check")) { console.log(`${edition} build configuration OK`); process.exit(0); }
const stage = join(root, "build", "desktop", stageName);
// Only ever clear the build staging directory, not source or restaurant data.
if (relative(root, stage).replaceAll("\\", "/") !== `build/desktop/${stageName}`) throw new Error("Unsafe staging directory");
rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
const pkg = JSON.parse(readFileSync(join(root, "package.json")));
// electron-updater runs in the Electron main process; it is copied like the server's runtime dependencies.
const deps = { ...JSON.parse(readFileSync(join(root, "apps/server/package.json"))).dependencies, "better-sqlite3": "*", "electron-updater": "*" };
delete deps["@masalapos/core"]; delete deps["@masalapos/domain"]; delete deps["@masalapos/print"];
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
const google = googleOAuthClient(root);
console.log(google.clientId ? `Google Drive backup: enabled (${google.clientId.split("-")[0]}…, from ${google.source === "environment" ? "environment" : relative(root, google.source)})` : "Google Drive backup: not configured (no Google OAuth client)");
await build({ entryPoints: [join(root, "apps/server/src/main.ts")], outfile: join(stage, "server/main.mjs"), bundle: true, packages: "external", platform: "node", format: "esm", target: "node24", sourcemap: true,
  define: { __MASALAPOS_LICENSE_PUBLIC_KEY__: JSON.stringify(publicKey), __MASALAPOS_LICENSE_SERVICE_URL__: JSON.stringify(serviceUrl), __MASALAPOS_DEMO__: JSON.stringify(demo), __MASALAPOS_COMMERCIAL__: JSON.stringify(commercial),
    // Google "Desktop app" OAuth client for Drive backups. Google treats a desktop client secret as public; PKCE protects sign-in.
    __MASALAPOS_GOOGLE_CLIENT_ID__: JSON.stringify(google.clientId), __MASALAPOS_GOOGLE_CLIENT_SECRET__: JSON.stringify(google.clientSecret) },
  // Workspace packages are bundled from source, including subpath imports (@masalapos/domain/vendor-codes): the installer ships no copy of them.
  plugins: [{ name: "workspace-source", setup(b) { b.onResolve({ filter: /^@masalapos\/(domain|core|print)(\/[a-z0-9-]+)?$/ }, (args) => ({ path: resolveWorkspace(root, args.path) })); } }],
});
// The installer has no workspace packages: an import of one left in the bundle means a server that cannot start.
const leftover = readFileSync(join(stage, "server/main.mjs"), "utf8").match(/from\s*["']@masalapos\/[^"']*["']/g);
if (leftover) throw new Error(`The server bundle still imports workspace packages: ${[...new Set(leftover)].join(", ")}`);
await build({ entryPoints: [join(root, "apps/desktop/src/main.ts")], outfile: join(stage, "main.js"), bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron", "electron-updater"], sourcemap: true, define: { __MASALAPOS_DEMO__: JSON.stringify(demo), __MASALAPOS_COMMERCIAL__: JSON.stringify(commercial) } });
// The preload runs sandboxed, so it is CommonJS. Remote support is the separate Support Connector (tools/build-connector.mjs).
await build({ entryPoints: [join(root, "apps/desktop/src/preload.ts")], outfile: join(stage, "preload.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron"] });
cpSync(join(root, "apps/ui/dist"), join(stage, "ui"), { recursive: true });
// The Captain Android app, when built for this release by tools/build-captain-android.mjs.
console.log(stageCaptainAndroid(join(root, "apps/captain-android/app/build/outputs/apk/release"), join(stage, "ui"), pkg.version));
writeFileSync(join(stage, "package.json"), JSON.stringify({ name: demo ? "masalapos-demo" : "masalapos-desktop", version: pkg.version, type: "module", main: "main.js", description: demo ? "MasalaPOS customer demo with isolated sample data" : "Local restaurant billing, kitchen and stock management", author: "MasalaPOS", private: true, dependencies: deps }, null, 2));
writeFileSync(join(stage, "build-info.json"), JSON.stringify({ edition, version: pkg.version, verificationKeyFingerprint, ...(commercial ? { serviceUrl: serviceUrl.replace(/\/+$/, "") } : {}) }, null, 2));
// The customer installer asks for the Customer ID and Order ID and activates before installing (tools/installer.nsh). Its script
// and settings sit outside the app stage, so they are compiled into the setup file but never shipped inside the app.
if (commercial) {
  const installerDir = join(root, "build", "desktop", "installer");
  rmSync(installerDir, { recursive: true, force: true }); mkdirSync(installerDir, { recursive: true });
  const script = installerActivationScript(readFileSync(join(root, "tools/installer-activate.ps1"), "utf8"), { serviceUrl, verificationKeyFingerprint, appVersion: pkg.version });
  writeFileSync(join(installerDir, "installer-activate.ps1"), script);
  writeFileSync(join(installerDir, "installer-config.nsh"), installerConfig(join(installerDir, "installer-activate.ps1"), !!serviceUrl));
  console.log(serviceUrl ? "Installer: asks for the Customer ID and Order ID and activates before installing" : "Installer: no licensing service URL, so setup does not ask for activation codes");
}

// Small MasalaPOS M icon, rendered without extra image or native build tools.
const M_MARK = [[36,32],[46,32],[54,48],[62,32],[72,32],[72,76],[62,76],[62,50],[54,64],[46,50],[46,76],[36,76]];
function markInk(xx, yy) { const px = xx * 108, py = yy * 108; let inside = false; for (let i = 0, j = M_MARK.length - 1; i < M_MARK.length; j = i++) { const [xi, yi] = M_MARK[i], [xj, yj] = M_MARK[j]; if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside; } return inside; }
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const payload = Buffer.concat([Buffer.from(type), data]); const size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(payload)); return Buffer.concat([size, payload, crc]); }
const size = 256, pixels = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const i = y * (size * 4 + 1) + 1 + x * 4;
  const ink = markInk((x + .5) / size, (y + .5) / size);
  pixels.set(ink ? [255, 255, 255, 255] : [209, 45, 59, 255], i);
}
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
writeFileSync(join(stage, "icon.png"), png);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
writeFileSync(join(root, "build/desktop/icon.ico"), Buffer.concat([ico, png]));
console.log(`Desktop staged at ${stage}; ${installed.size} dependency packages copied from the lockfile installation.`);
