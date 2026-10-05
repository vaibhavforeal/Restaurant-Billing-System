import { readFileSync } from "node:fs";
import { join } from "node:path";

// Runs even when electron-builder is called directly, so an old development
// stage cannot accidentally be shipped through the customer installer config.
/** @param {import("app-builder-lib").PackContext} context */
export default function verifyDesktopPackage({ packager }) {
  const appDir = packager.info.appDir;
  const edition = { "in.forkflow.pos": "commercial", "in.forkflow.demo": "demo" }[packager.config.appId];
  if (!edition) throw new Error("Unknown POS installer identity");
  let info;
  try { info = JSON.parse(readFileSync(join(appDir, "build-info.json"), "utf8")); }
  catch { throw new Error(`Missing build identity. Run npm run build:${edition} before packaging`); }
  const manifest = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
  if (info.edition !== edition || info.version !== manifest.version ||
      manifest.name !== (edition === "demo" ? "forkflow-demo" : "forkflow-desktop")) {
    throw new Error(`Refusing to package a mismatched build as ${edition}`);
  }
  if (edition === "commercial" && !/^[a-f0-9]{64}$/.test(info.verificationKeyFingerprint ?? "")) {
    throw new Error("Customer installers require an embedded license verification key");
  }
  if (edition === "demo" && info.verificationKeyFingerprint !== null) {
    throw new Error("Demo installers must not use customer licensing");
  }
}
