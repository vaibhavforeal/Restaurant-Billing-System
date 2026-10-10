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
  const stageName = env.FORKFLOW_BUILD_STAGE ?? defaultStage;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(stageName)) throw new Error("Invalid build stage name");
  if (edition !== "development" && stageName !== defaultStage) {
    throw new Error(`The ${edition} build must use build/desktop/${defaultStage}; clear FORKFLOW_BUILD_STAGE`);
  }
  if (edition === "development" && ["demo", "commercial", "kitchen"].includes(stageName)) {
    throw new Error("Development builds cannot overwrite a customer or Kitchen stage");
  }
  // Only the customer edition consumes the release key. Ambient environment
  // settings must not turn a demo/development build into a customer build.
  const suppliedKey = commercial ? env.FORKFLOW_LICENSE_PUBLIC_KEY ?? "" : "";
  if (commercial && !suppliedKey.trim()) throw new Error("Commercial builds require FORKFLOW_LICENSE_PUBLIC_KEY (Ed25519 public PEM)");
  if (suppliedKey.includes("PRIVATE KEY")) throw new Error("Only the public verification key belongs in a POS build");
  const parsedKey = suppliedKey ? createPublicKey(suppliedKey) : null;
  if (parsedKey && parsedKey.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 public key");
  const publicKey = parsedKey ? parsedKey.export({ type: "spki", format: "pem" }).toString() : "";
  const verificationKeyFingerprint = parsedKey ? createHash("sha256").update(parsedKey.export({ type: "spki", format: "der" })).digest("hex") : null;
  // The licensing service is optional and, like the key, only a customer build embeds it.
  const serviceUrl = commercial ? (env.FORKFLOW_LICENSE_SERVICE_URL ?? "").trim() : "";
  if (serviceUrl && !isHttpsUrl(serviceUrl)) throw new Error("Licensing service URL must use HTTPS");
  return { demo, commercial, edition, stageName, publicKey, verificationKeyFingerprint, serviceUrl };
}
