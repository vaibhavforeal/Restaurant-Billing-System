import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopBuildConfig } from "./desktop-build-config.mjs";
import verifyDesktopPackage from "./verify-desktop-package.mjs";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const env = { FORKFLOW_LICENSE_PUBLIC_KEY: publicKey };

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
    assert.throws(() => desktopBuildConfig(["--commercial"], { FORKFLOW_LICENSE_PUBLIC_KEY: value }), /require FORKFLOW_LICENSE_PUBLIC_KEY/);
  }
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => desktopBuildConfig(["--commercial"], { FORKFLOW_LICENSE_PUBLIC_KEY: privateKey }), /Only the public/);
  const ecKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.throws(() => desktopBuildConfig(["--commercial"], { FORKFLOW_LICENSE_PUBLIC_KEY: ecKey }), /Ed25519/);
  assert.throws(() => desktopBuildConfig(["--commercial"], { FORKFLOW_LICENSE_PUBLIC_KEY: "not a key" }));
});

test("release stages cannot be redirected or overwritten by development builds", () => {
  assert.throws(() => desktopBuildConfig(["--demo", "--commercial"], env), /separate products/);
  for (const stage of ["demo", "commercial", "kitchen"]) {
    assert.throws(() => desktopBuildConfig([], { FORKFLOW_BUILD_STAGE: stage }), /cannot overwrite/);
  }
  for (const edition of ["demo", "commercial"]) {
    assert.throws(() => desktopBuildConfig([`--${edition}`], { ...env, FORKFLOW_BUILD_STAGE: "app" }), /must use/);
  }
  assert.throws(() => desktopBuildConfig([], { FORKFLOW_BUILD_STAGE: "../data" }), /Invalid build stage/);
  assert.equal(desktopBuildConfig([], { FORKFLOW_BUILD_STAGE: "printer-preview" }).stageName, "printer-preview");
});

function fixture(t, edition) {
  const appDir = mkdtempSync(join(tmpdir(), "forkflow-package-test-"));
  t.after(() => rmSync(appDir, { recursive: true, force: true }));
  const config = desktopBuildConfig([`--${edition}`], env);
  const info = { edition: config.edition, version: "1.0.0", verificationKeyFingerprint: config.verificationKeyFingerprint };
  const writeInfo = (changes = {}) => writeFileSync(join(appDir, "build-info.json"), JSON.stringify({ ...info, ...changes }));
  writeInfo();
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: edition === "demo" ? "forkflow-demo" : "forkflow-desktop", version: "1.0.0" }));
  const context = { packager: { info: { appDir }, config: { appId: edition === "demo" ? "in.forkflow.demo" : "in.forkflow.pos" } } };
  return { context, writeInfo, appDir };
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
