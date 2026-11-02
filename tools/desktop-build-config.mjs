import { createHash, createPublicKey } from "node:crypto";

function isHttpsUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname !== ""; } catch { return false; }
}

export function desktopBuildConfig(args, env) {
  const demo = args.includes("--demo");
  const commercial = args.includes("--commercial");
  if (demo && commercial) throw new Error("Demo and commercial builds are separate products");
  const edition = demo ? "demo" : commercial ? "commercial" : "development";
  const defaultStage = edition === "development" ? "app" : edition;
  const stageName = env.MASALAPOS_BUILD_STAGE ?? defaultStage;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(stageName)) throw new Error("Invalid build stage name");
  if (edition !== "development" && stageName !== defaultStage) {
    throw new Error(`The ${edition} build must use build/desktop/${defaultStage}; clear MASALAPOS_BUILD_STAGE`);
  }
  if (edition === "development" && ["demo", "commercial", "kitchen"].includes(stageName)) {
    throw new Error("Development builds cannot overwrite a customer or Kitchen stage");
  }
  // Only the customer edition consumes the release key. Ambient environment
  // settings must not turn a demo/development build into a customer build.
  const suppliedKey = commercial ? env.MASALAPOS_LICENSE_PUBLIC_KEY ?? "" : "";
  if (commercial && !suppliedKey.trim()) throw new Error("Commercial builds require MASALAPOS_LICENSE_PUBLIC_KEY (Ed25519 public PEM)");
  if (suppliedKey.includes("PRIVATE KEY")) throw new Error("Only the public verification key belongs in a POS build");
  const parsedKey = suppliedKey ? createPublicKey(suppliedKey) : null;
  if (parsedKey && parsedKey.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 public key");
  const publicKey = parsedKey ? parsedKey.export({ type: "spki", format: "pem" }).toString() : "";
  const verificationKeyFingerprint = parsedKey ? createHash("sha256").update(parsedKey.export({ type: "spki", format: "der" })).digest("hex") : null;
  // The licensing service is optional and, like the key, only a customer build embeds it.
  const serviceUrl = commercial ? (env.MASALAPOS_LICENSE_SERVICE_URL ?? "").trim() : "";
  if (serviceUrl && !isHttpsUrl(serviceUrl)) throw new Error("Licensing service URL must use HTTPS");
  return { demo, commercial, edition, stageName, publicKey, verificationKeyFingerprint, serviceUrl };
}

const psQuoted = (value) => String(value).replaceAll("'", "''");
/** tools/installer-activate.ps1 with this build's service, key and version filled in. Windows PowerShell 5.1 reads it as ANSI, so it stays ASCII. */
export function installerActivationScript(template, { serviceUrl, verificationKeyFingerprint, appVersion }) {
  const values = {
    __MASALAPOS_LICENSE_SERVICE_URL__: serviceUrl ? serviceUrl.replace(/\/+$/, "") : "",
    __MASALAPOS_KEY_FINGERPRINT__: verificationKeyFingerprint ?? "",
    __MASALAPOS_APP_VERSION__: String(appVersion).slice(0, 40),
  };
  let script = template;
  for (const [name, value] of Object.entries(values)) {
    if (!script.includes(`'${name}'`)) throw new Error(`The installer activation script lost its ${name} placeholder`);
    script = script.replaceAll(`'${name}'`, `'${psQuoted(value)}'`);
  }
  if (/[^\x00-\x7f]/.test(script)) throw new Error("The installer activation script must be plain ASCII for Windows PowerShell");
  return script;
}

/** The NSIS settings tools/installer.nsh includes; `$` is doubled because NSIS reads it as a variable. */
export function installerConfig(scriptPath, online) {
  if (/["\r\n]/.test(scriptPath)) throw new Error("Unsupported installer script path");
  return `!define MASALAPOS_ACTIVATION_SCRIPT "${scriptPath.replaceAll("$", "$$$$")}"\n${online ? "!define MASALAPOS_ONLINE_ACTIVATION\n" : ""}`;
}
