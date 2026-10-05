// Operator-only helper. This file and the private key are never bundled into POS builds.
// node --import tsx tools/issue-license.ts private.pem claims.json license.txt
import { readFileSync, writeFileSync } from "node:fs";
import { LicenseClaims, PLANS } from "../packages/domain/src/licensing.js";
import { signClaims } from "./license-claims.js";

const [keyPath, claimsPath, outputPath] = process.argv.slice(2);
if (!keyPath || !claimsPath || !outputPath) throw new Error("Usage: issue-license.ts private.pem claims.json license.txt");
const input = JSON.parse(readFileSync(claimsPath, "utf8").replace(/^\uFEFF/, ""));
const plan = PLANS[input.plan as keyof typeof PLANS];
if (!plan) throw new Error("Choose basic or pro");
const claims = LicenseClaims.parse({ maxDevices: plan.maxDevices, features: plan.features, ...input });
writeFileSync(outputPath, signClaims(claims, readFileSync(keyPath, "utf8")), { flag: "wx" });
console.log("Signed license written. Import it in Settings > Plan and devices.");
