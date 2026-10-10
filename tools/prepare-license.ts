// Operator-only: turn a restaurant's activation request into license claims, and optionally sign them.
// node --import tsx tools/prepare-license.ts activation-request.json --plan pro --months 12 [--grace-days 7] [--sign C:\secure\license-private.pem]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { buildClaims, keyFingerprint, parseActivationRequest, signClaims } from "./license-claims.js";
import type { Plan } from "../packages/domain/src/licensing.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    plan: { type: "string" },
    months: { type: "string" },
    "grace-days": { type: "string", default: "7" },
    sign: { type: "string" },
  },
});
const requestPath = positionals[0];
if (!requestPath || !values.plan || !values.months) {
  throw new Error("Usage: prepare-license.ts activation-request.json --plan basic|pro --months 12 [--grace-days 7] [--sign private.pem]");
}

const request = parseActivationRequest(readFileSync(requestPath, "utf8"));
const claims = buildClaims(request, { plan: values.plan as Plan, months: Number(values.months), graceDays: Number(values["grace-days"]) }, Date.now());
const name = `${claims.installationId.slice(0, 8)}-r${claims.revision}`;
const folder = dirname(requestPath);

let written: string;
if (values.sign) {
  const privatePem = readFileSync(values.sign, "utf8");
  if (keyFingerprint(privatePem) !== request.verificationKeyFingerprint) {
    throw new Error("This private key does not match the public key built into this restaurant's ForkFlow. The license would be refused. Use the key pair that the installer was built with.");
  }
  written = join(folder, `license-${name}.txt`);
  writeFileSync(written, await signClaims(claims, privatePem),{ flag: "wx" });
} else {
  written = join(folder, `claims-${name}.json`);
  writeFileSync(written, `${JSON.stringify(claims, null, 2)}\n`, { flag: "wx" });
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
console.log([
  request.licenseId ? `Renewal / plan change for installation ${claims.installationId}` : `First activation for installation ${claims.installationId}`,
  `Plan ${claims.plan} · ${claims.maxDevices} devices · revision ${claims.revision}`,
  `Valid ${day(claims.issuedAt)} to ${day(claims.expiresAt)}, billing allowed until ${day(claims.graceUntil)}`,
  `License ID ${claims.licenseId} · organization ${claims.organizationId} · outlet ${claims.outletId}`,
  values.sign ? `Signed license written: ${written}. Import it in Settings > Plan and devices.` : `Claims written: ${written}. Sign with tools/issue-license.ts.`,
].join("\n"));
