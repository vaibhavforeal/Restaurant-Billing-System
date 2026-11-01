import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { fromIni } from "@aws-sdk/credential-providers";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { sha256, verifyManifest, signManifest } from "./connector-release.mjs";

const staging = process.argv.includes("--staging");
const root = resolve(import.meta.dirname,".."), dir = join(root,"dist/connector");
let manifest = JSON.parse(readFileSync(join(dir,"latest.json"),"utf8"));
const build = JSON.parse(readFileSync(join(dir,"build-info.json"),"utf8"));
const keyFile = process.env.CONNECTOR_MANIFEST_KEY_FILE ?? (staging ? join(root,"build/connector/development-manifest-key.pem") : "");
if (!keyFile || !verifyManifest(manifest,createPublicKey(readFileSync(keyFile)))) throw new Error("Manifest signature verification failed");
const runtime = join(dir,`connector-${manifest.version}.zip`), stub = join(dir,`stub-${manifest.version}.exe`);
if (statSync(runtime).size !== manifest.size || sha256(readFileSync(runtime)) !== manifest.sha256 || sha256(readFileSync(stub)) !== build.stubSha256) throw new Error("Artifact hashes do not match the build");
if (!staging) {
  if (!manifest.production || !build.production) throw new Error("Development artifacts cannot be published to production");
  const acceptance = JSON.parse(readFileSync(process.env.CONNECTOR_ACCEPTANCE_FILE ?? "","utf8"));
  const required = ["filenameToken", "fallbackCode", "elevationCancellation", "expiredInvitation", "interruptedDownload", "tamperedArchive", "protectedCache", "duplicateLaunch", "localConsent", "elevatedWindows", "uacOptIn", "viewOnly", "stop", "disconnect", "serverRestart", "crashRecovery", "rebootRecovery", "recoverySetupFailure", "policyRestoration", "priorPolicyAbsent", "priorPolicyNonDefault", "multiMonitor", "multiDpi", "turnHotspot", "cacheReuse"];
  if (acceptance.version !== manifest.version || acceptance.sha256 !== manifest.sha256 || !acceptance.verifiedBy || !acceptance.verifiedAt || required.some((name)=>acceptance.checks?.[name] !== true)) throw new Error("Real-PC acceptance is incomplete or belongs to another artifact");
  if (!process.env.CONNECTOR_SIGNTOOL) throw new Error("CONNECTOR_SIGNTOOL is required to verify production signatures");
  execFileSync(process.env.CONNECTOR_SIGNTOOL,["verify","/pa","/all","/tw",stub],{stdio:"inherit"});
}
const bucket = process.env.CONNECTOR_S3_BUCKET;
if (!bucket) throw new Error("CONNECTOR_S3_BUCKET is required");
const credentials = fromIni({profile:process.env.AWS_PROFILE ?? "aws-project"});
const s3 = new S3Client({region:"us-east-2",credentials,maxAttempts:3});
const prefix = staging ? `staging/${manifest.version}/${manifest.sha256.slice(0,16)}/` : "";
if (staging) {
  const cdn = process.env.CONNECTOR_CDN_URL;
  if (!cdn || !/^https:\/\/[a-z0-9-]+\.cloudfront\.net$/.test(cdn)) throw new Error("CONNECTOR_CDN_URL is required for staging");
  manifest = signManifest({...manifest,url:`${cdn}/${prefix}runtime/connector-${manifest.version}.zip`},readFileSync(keyFile));
}
async function upload(path,key,type) {
  const hash = sha256(readFileSync(path));
  try {
    const old = await s3.send(new HeadObjectCommand({Bucket:bucket,Key:key}));
    if (old.Metadata?.sha256 !== hash) throw new Error(`Immutable artifact already exists with different content: ${key}`);
    return;
  } catch(error) { if (error.name !== "NotFound" && error.$metadata?.httpStatusCode !== 404) throw error; }
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:createReadStream(path),ContentType:type,ContentDisposition:"attachment",CacheControl:"public, max-age=31536000, immutable",Metadata:{sha256:hash},IfNoneMatch:"*"}));
}
await upload(runtime,`${prefix}runtime/connector-${manifest.version}.zip`,"application/zip");
await upload(stub,`${prefix}stub/stub-${manifest.version}.exe`,"application/octet-stream");
await s3.send(new PutObjectCommand({Bucket:bucket,Key:`${prefix}latest.json`,Body:JSON.stringify(manifest),ContentType:"application/json",CacheControl:"no-cache"}));
if (!staging && process.env.CONNECTOR_DISTRIBUTION_ID) {
  const cloudfront = new CloudFrontClient({region:"us-east-1",credentials});
  await cloudfront.send(new CreateInvalidationCommand({DistributionId:process.env.CONNECTOR_DISTRIBUTION_ID,InvalidationBatch:{CallerReference:`connector-${manifest.version}-${Date.now()}`,Paths:{Quantity:1,Items:["/latest.json"]}}}));
}
console.log(`${staging?"Staged":"Published"} ${manifest.version} under s3://${bucket}/${prefix}. Portal promotion is separate; keep CONNECTOR_ENABLED=0 until acceptance is complete.`);
