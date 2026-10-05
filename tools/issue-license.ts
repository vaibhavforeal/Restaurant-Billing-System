// Operator-only helper. This file and the private key are never bundled into POS builds.
// node --import tsx tools/issue-license.ts private.pem claims.json license.txt
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { LicenseClaims, PLANS } from "../packages/domain/src/licensing.js";

const [keyPath, claimsPath, outputPath] = process.argv.slice(2);
if (!keyPath || !claimsPath || !outputPath) throw new Error("Usage: issue-license.ts private.pem claims.json license.txt");
const input = JSON.parse(readFileSync(claimsPath, "utf8").replace(/^\uFEFF/, ""));
const plan = PLANS[input.plan as keyof typeof PLANS];
if (!plan) throw new Error("Choose basic or pro");
const claims = LicenseClaims.parse({ maxDevices: plan.maxDevices, features: plan.features, ...input });
const key = createPrivateKey(readFileSync(keyPath));
if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 private key");
const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
const message = `ff1.${payload}`;
writeFileSync(outputPath, `${message}.${sign(null, Buffer.from(message), key).toString("base64url")}\n`, { flag: "wx" });
console.log("Signed license written. Import it in Settings > Plan and devices.");
