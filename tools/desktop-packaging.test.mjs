import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopBuildConfig, installerActivationScript } from "./desktop-build-config.mjs";
import verifyDesktopPackage from "./verify-desktop-package.mjs";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const env = { MASALAPOS_LICENSE_PUBLIC_KEY: publicKey };

test("demo and licensed customer builds have different stages and licensing", () => {
  const demo = desktopBuildConfig(["--demo"], env);
  const customer = desktopBuildConfig(["--commercial"], env);
  assert.equal(demo.stageName, "demo");
  assert.equal(demo.publicKey, "");
  assert.equal(demo.verificationKeyFingerprint, null);
  assert.equal(customer.stageName, "commercial");
  assert.equal(customer.publicKey, publicKey);
  assert.match(customer.verificationKeyFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(desktopBuildConfig([], env).edition, "development");
  assert.equal(desktopBuildConfig([], env).publicKey, "");
});

test("customer builds reject missing, private and non-Ed25519 keys", () => {
  for (const value of [undefined, "", "  "]) {
    assert.throws(() => desktopBuildConfig(["--commercial"], { MASALAPOS_LICENSE_PUBLIC_KEY: value }), /require MASALAPOS_LICENSE_PUBLIC_KEY/);
  }
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => desktopBuildConfig(["--commercial"], { MASALAPOS_LICENSE_PUBLIC_KEY: privateKey }), /Only the public/);
  const ecKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.throws(() => desktopBuildConfig(["--commercial"], { MASALAPOS_LICENSE_PUBLIC_KEY: ecKey }), /Ed25519/);
  assert.throws(() => desktopBuildConfig(["--commercial"], { MASALAPOS_LICENSE_PUBLIC_KEY: "not a key" }));
});

test("only customer builds carry the licensing service URL, and it must be HTTPS", () => {
  const withUrl = { ...env, MASALAPOS_LICENSE_SERVICE_URL: "https://license.example.com" };
  assert.equal(desktopBuildConfig(["--commercial"], withUrl).serviceUrl, "https://license.example.com");
  assert.equal(desktopBuildConfig(["--commercial"], env).serviceUrl, "");
  assert.equal(desktopBuildConfig(["--demo"], withUrl).serviceUrl, "");
  assert.equal(desktopBuildConfig([], withUrl).serviceUrl, "");
  for (const url of ["http://license.example.com", "http://127.0.0.1:8787", "license.example.com", "https://"]) {
    assert.throws(() => desktopBuildConfig(["--commercial"], { ...env, MASALAPOS_LICENSE_SERVICE_URL: url }), /Licensing service URL must use HTTPS/);
  }
  // Ambient settings never break a build that does not use them.
  assert.equal(desktopBuildConfig(["--demo"], { ...env, MASALAPOS_LICENSE_SERVICE_URL: "http://example.com" }).serviceUrl, "");
});

test("release stages cannot be redirected or overwritten by development builds", () => {
  assert.throws(() => desktopBuildConfig(["--demo", "--commercial"], env), /separate products/);
  for (const stage of ["demo", "commercial", "kitchen"]) {
    assert.throws(() => desktopBuildConfig([], { MASALAPOS_BUILD_STAGE: stage }), /cannot overwrite/);
  }
  for (const edition of ["demo", "commercial"]) {
    assert.throws(() => desktopBuildConfig([`--${edition}`], { ...env, MASALAPOS_BUILD_STAGE: "app" }), /must use/);
  }
  assert.throws(() => desktopBuildConfig([], { MASALAPOS_BUILD_STAGE: "../data" }), /Invalid build stage/);
  assert.equal(desktopBuildConfig([], { MASALAPOS_BUILD_STAGE: "printer-preview" }).stageName, "printer-preview");
});

function fixture(t, edition) {
  // The stage sits in its own folder, with the installer's generated files beside it as in build/desktop.
  const root = mkdtempSync(join(tmpdir(), "masalapos-package-test-")), appDir = join(root, edition);
  mkdirSync(appDir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = desktopBuildConfig([`--${edition}`], { ...env, MASALAPOS_LICENSE_SERVICE_URL: "https://license.example.com" });
  const info = { edition: config.edition, version: "1.0.0", verificationKeyFingerprint: config.verificationKeyFingerprint,
    ...(edition === "commercial" ? { serviceUrl: config.serviceUrl } : {}) };
  const writeScript = (changes = {}) => {
    mkdirSync(join(root, "installer"), { recursive: true });
    writeFileSync(join(root, "installer", "installer-activate.ps1"), installerActivationScript(readFileSync(new URL("./installer-activate.ps1", import.meta.url), "utf8"),
      { serviceUrl: info.serviceUrl, verificationKeyFingerprint: info.verificationKeyFingerprint, appVersion: info.version, ...changes }));
  };
  if (edition === "commercial") writeScript();
  const writeInfo = (changes = {}) => writeFileSync(join(appDir, "build-info.json"), JSON.stringify({ ...info, ...changes }));
  writeInfo();
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: edition === "demo" ? "masalapos-demo" : "masalapos-desktop", version: "1.0.0" }));
  const context = { packager: { info: { appDir }, config: { appId: edition === "demo" ? "in.masalapos.demo" : "in.masalapos.pos" } } };
  return { context, writeInfo, writeScript, appDir, root };
}

test("installer guard accepts only the matching demo/customer edition", (t) => {
  for (const edition of ["demo", "commercial"]) {
    const f = fixture(t, edition);
    assert.doesNotThrow(() => verifyDesktopPackage(f.context));
    f.writeInfo({ edition: "development" });
    assert.throws(() => verifyDesktopPackage(f.context), /mismatched build/);
    f.writeInfo({ edition: edition === "demo" ? "commercial" : "demo" });
    assert.throws(() => verifyDesktopPackage(f.context), /mismatched build/);
    f.writeInfo({ version: "0.9.0" });
    assert.throws(() => verifyDesktopPackage(f.context), /mismatched build/);
  }
});

test("installer guard rejects legacy stages and customer builds without a key", (t) => {
  const f = fixture(t, "commercial");
  f.writeInfo({ verificationKeyFingerprint: null });
  assert.throws(() => verifyDesktopPackage(f.context), /require an embedded/);
  rmSync(join(f.appDir, "build-info.json"));
  assert.throws(() => verifyDesktopPackage(f.context), /Missing build identity/);
  const demo = fixture(t, "demo");
  demo.writeInfo({ verificationKeyFingerprint: "a".repeat(64) });
  assert.throws(() => verifyDesktopPackage(demo.context), /must not use customer licensing/);
});

test("installer guard requires the activation script from the same build", (t) => {
  const f = fixture(t, "commercial");
  assert.doesNotThrow(() => verifyDesktopPackage(f.context));
  for (const stale of [{ serviceUrl: "https://old.example.com" }, { verificationKeyFingerprint: "c".repeat(64) }, { appVersion: "0.9.0" }]) {
    f.writeScript(stale);
    assert.throws(() => verifyDesktopPackage(f.context), /from another build/, JSON.stringify(stale));
  }
  rmSync(join(f.root, "installer"), { recursive: true });
  assert.throws(() => verifyDesktopPackage(f.context), /Missing the installer activation script/);
});

test("ships the Captain Android app only when it was built for this release", async () => {
  const { stageCaptainAndroid } = await import("./captain-android-release.mjs");
  const folder = mkdtempSync(join(tmpdir(), "masalapos-captain-apk-"));
  try {
    const apks = join(folder, "apk"), ui = join(folder, "ui");
    assert.match(stageCaptainAndroid(apks, ui, "1.2.3"), /not built/);
    mkdirSync(apks, { recursive: true });
    writeFileSync(join(apks, "app-release.apk"), "apk bytes");
    writeFileSync(join(apks, "output-metadata.json"), JSON.stringify({ elements: [{ versionCode: 1002003, versionName: "1.2.3", outputFile: "app-release.apk" }] }));
    assert.match(stageCaptainAndroid(apks, ui, "1.2.4"), /Skipping/);
    assert.equal(existsSync(join(ui, "captain/android")), false);
    stageCaptainAndroid(apks, ui, "1.2.3");
    assert.equal(readFileSync(join(ui, "captain/android/MasalaPOS-Captain.apk"), "utf8"), "apk bytes");
    assert.deepEqual(JSON.parse(readFileSync(join(ui, "captain/android/version.json"), "utf8")), {
      versionCode: 1002003, versionName: "1.2.3", sha256: createHash("sha256").update("apk bytes").digest("hex").toUpperCase(),
    });
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("the installer activation script gets this build's service, key and version", async () => {
  const { installerActivationScript } = await import("./desktop-build-config.mjs");
  const template = readFileSync(new URL("./installer-activate.ps1", import.meta.url), "utf8");
  const script = installerActivationScript(template, { serviceUrl: "https://license.example.com/", verificationKeyFingerprint: "ab".repeat(32), appVersion: "1.2.3" });
  assert.match(script, /\$ServiceUrl = 'https:\/\/license\.example\.com'/);
  assert.ok(script.includes(`$Fingerprint = '${"ab".repeat(32)}'`));
  assert.match(script, /\$AppVersion = '1\.2\.3'/);
  assert.doesNotMatch(script, /__MASALAPOS_/);
  assert.doesNotMatch(script, /[^\x00-\x7f]/);
  // A quote in a value cannot end the PowerShell string early.
  assert.match(installerActivationScript(template, { serviceUrl: "https://x.example/a'b", verificationKeyFingerprint: null, appVersion: "1" }), /'https:\/\/x\.example\/a''b'/);
  assert.throws(() => installerActivationScript("no placeholders", { serviceUrl: "", verificationKeyFingerprint: null, appVersion: "1" }), /placeholder/);
});

test("the installer activation script protects the staged secret and trusts only its own and the session user's identity", () => {
  const script = readFileSync(new URL("./installer-activate.ps1", import.meta.url), "utf8");
  // The secret file is created new with its permissions set at creation (SYSTEM and Administrators full, the session user read and
  // delete, nothing inherited), a leftover file that can't be removed stops setup, and the result is checked.
  assert.match(script, /\[IO\.FileMode\]::CreateNew/);
  assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(script, /sid = \$userSid; rights = 'Read, Delete'/);
  assert.match(script, /throw 'The old activation file could not be removed\.'/);
  assert.match(script, /\$rules\.Count -ne 3/);
  assert.doesNotMatch(script, /S-1-5-32-545:(M|\(R,D\))/);
  assert.doesNotMatch(script, /Remove-Item -LiteralPath \$stagePath -Force -ErrorAction SilentlyContinue/);
  // Identities are read through the open handle: its real path and owner, and the session user's file only if that user owns it.
  assert.match(script, /GetFinalPathNameByHandleW/);
  assert.match(script, /owners = @\(\$userSid\) \}/);
  // The shared folder is administrator-owned and only administrators may write to it.
  assert.match(script, /\$stageDir \/setowner "\*\$\{Admins\}"/);
  assert.match(script, /\$stageDir \/inheritance:r \/grant:r "\*\$\{System\}:\(OI\)\(CI\)F" "\*\$\{Admins\}:\(OI\)\(CI\)F" '\*S-1-5-32-545:\(RX\)'/);
  // The session user comes from this session's Explorer; no unresolved user falls back to a broad grant.
  assert.match(script, /GetOwnerSid/);
  assert.match(script, /if \(!\$userSid\) \{ Fail \$NoUser \}/);
  // Identities come only from the two known profiles and the staged file, each checked against its allowed owners; no profile scan.
  assert.doesNotMatch(script, /Get-ChildItem/);
  assert.match(script, /ProfileList\\\$userSid/);
  assert.match(script, /Read-Identity \$file\.path \$file\.owners/);
});

test("the installer asks for activation codes only when the build activates online", async () => {
  const { installerConfig } = await import("./desktop-build-config.mjs");
  assert.equal(installerConfig("C:\b$x\a.ps1", true), '!define MASALAPOS_ACTIVATION_SCRIPT "C:\b$$x\a.ps1"\n!define MASALAPOS_ONLINE_ACTIVATION\n');
  assert.doesNotMatch(installerConfig("C:\a.ps1", false), /ONLINE_ACTIVATION/);
  assert.throws(() => installerConfig('C:\\"a.ps1', true), /Unsupported/);
});
