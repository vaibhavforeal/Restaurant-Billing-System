import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
export function manifestBytes(manifest) {
  return Buffer.from(`${manifest.version}\n${manifest.sha256}\n${manifest.size}\n${manifest.url}\n${!!manifest.production}`);
}
export function signManifest(manifest, privateKey) {
  return { ...manifest, signature: sign("sha256", manifestBytes(manifest), privateKey).toString("base64") };
}
export function verifyManifest(manifest, publicKey) {
  const cdn = typeof manifest.url === "string" ? manifest.url.match(/^https:\/\/[a-z0-9-]+\.cloudfront\.net(?=\/)/)?.[0] : null;
  const releasePath = `/runtime/connector-${manifest.version}.zip`;
  const validUrl = cdn && (manifest.url === cdn+releasePath || (manifest.production === false && manifest.url === `${cdn}/staging/${manifest.version}/${String(manifest.sha256).slice(0,16)}${releasePath}`));
  return /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version) && /^[a-f0-9]{64}$/.test(manifest.sha256)
    && Number.isSafeInteger(manifest.size) && manifest.size > 0 && manifest.size <= 536870912
    && !!validUrl
    && typeof manifest.production === "boolean" && verify("sha256",manifestBytes(manifest),publicKey,Buffer.from(manifest.signature,"base64"));
}
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function rsaXml(privateKey) {
  const jwk = createPublicKey(createPrivateKey(privateKey)).export({format:"jwk"});
  return `<RSAKeyValue><Modulus>${Buffer.from(jwk.n,"base64url").toString("base64")}</Modulus><Exponent>${Buffer.from(jwk.e,"base64url").toString("base64")}</Exponent></RSAKeyValue>`;
}
