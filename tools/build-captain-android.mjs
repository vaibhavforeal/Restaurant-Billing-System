// Builds the signed MasalaPOS Captain Android app (apps/captain-android).
// tools/build-desktop.mjs then ships it inside the POS, which serves it to tablets.
//
//   node tools/build-captain-android.mjs                     test and build a signed release APK
//   node tools/build-captain-android.mjs --create-signing-key  first time only: create the release key
//
// The signing key lives outside the repository (MASALAPOS_ANDROID_SIGNING or
// ~/.masalapos/captain-android/signing.properties). Back it up: installed tablets only
// accept updates signed with the same key.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = join(root, "apps/captain-android");
const windows = process.platform === "win32";

function javaHome() {
  const major = (home) => {
    try { return Number(/JAVA_VERSION="(\d+)/.exec(readFileSync(join(home, "release"), "utf8"))?.[1]); } catch { return 0; }
  };
  const candidates = [process.env.JAVA_HOME, windows ? "C:\\Program Files\\Android\\Android Studio\\jbr" : "/Applications/Android Studio.app/Contents/jbr/Contents/Home"].filter(Boolean);
  const found = candidates.find((home) => major(home) >= 17);
  if (!found) throw new Error("Android builds need JDK 17 or newer. Install Android Studio or set JAVA_HOME.");
  return found;
}

function sdkDir() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? (windows ? join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk") : join(homedir(), "Library/Android/sdk"));
  if (!existsSync(join(sdk, "platforms"))) throw new Error(`Android SDK not found at ${sdk}. Install it with Android Studio or set ANDROID_HOME.`);
  return sdk;
}

function signingFile(java) {
  const file = process.env.MASALAPOS_ANDROID_SIGNING ?? join(homedir(), ".masalapos", "captain-android", "signing.properties");
  if (existsSync(file)) return file;
  if (!process.argv.includes("--create-signing-key")) {
    throw new Error(`No release signing key at ${file}. Run once with --create-signing-key, or set MASALAPOS_ANDROID_SIGNING to an existing key's properties file.`);
  }
  mkdirSync(dirname(file), { recursive: true });
  const store = join(dirname(file), "captain-release.jks");
  if (existsSync(store)) throw new Error(`${store} exists without ${file}; restore its properties file instead of replacing the key.`);
  const password = randomBytes(24).toString("base64url");
  run(join(java, "bin", windows ? "keytool.exe" : "keytool"), ["-genkeypair", "-keystore", store, "-storetype", "PKCS12", "-alias", "captain",
    "-keyalg", "RSA", "-keysize", "3072", "-validity", "10000", "-storepass", password, "-keypass", password, "-dname", "CN=MasalaPOS Captain, O=MasalaPOS"]);
  const escape = (value) => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
  writeFileSync(file, `storeFile=${escape(store)}\nstorePassword=${password}\nkeyAlias=captain\nkeyPassword=${password}\n`, { mode: 0o600 });
  console.log(`Created the Captain release key at ${store}. Back up this folder: ${dirname(file)}`);
  return file;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: windows && command.endsWith(".bat"), ...options });
  if (result.status !== 0) throw new Error(`${command} failed`);
}

const java = javaHome();
const localProperties = join(project, "local.properties");
if (!existsSync(localProperties)) writeFileSync(localProperties, `sdk.dir=${sdkDir().replaceAll("\\", "/")}\n`);
const signing = signingFile(java);
// cmd.exe runs the wrapper, so it is called by name from its folder and paths are quoted.
run(windows ? ".\\gradlew.bat" : "./gradlew", ["--console=plain", "testDebugUnitTest", "assembleRelease", windows ? `"-Pmasalapos.signing=${signing}"` : `-Pmasalapos.signing=${signing}`],
  { cwd: project, env: { ...process.env, JAVA_HOME: java } });
console.log(`Captain APK: ${join(project, "app/build/outputs/apk/release/app-release.apk")}`);
