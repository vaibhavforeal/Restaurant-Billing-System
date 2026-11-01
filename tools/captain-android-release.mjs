import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Copies the Captain Android app built by tools/build-captain-android.mjs into the staged UI.
 * Tablets download it from the POS and read version.json to offer updates.
 * Returns a line for the build log.
 */
export function stageCaptainAndroid(apkFolder, uiFolder, version) {
  const metadata = join(apkFolder, "output-metadata.json");
  if (!existsSync(metadata)) return "Captain Android app not built; Settings will offer the browser Captain only.";
  const { elements: [apk] } = JSON.parse(readFileSync(metadata, "utf8"));
  if (apk.versionName !== version) return `Skipping Captain Android ${apk.versionName}; rebuild it for ${version} with node tools/build-captain-android.mjs.`;
  const bytes = readFileSync(join(apkFolder, apk.outputFile));
  const target = join(uiFolder, "captain", "android");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "MasalaPOS-Captain.apk"), bytes);
  writeFileSync(join(target, "version.json"), JSON.stringify({
    versionCode: apk.versionCode, versionName: apk.versionName, sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
  }));
  return `Included Captain Android ${apk.versionName}.`;
}
