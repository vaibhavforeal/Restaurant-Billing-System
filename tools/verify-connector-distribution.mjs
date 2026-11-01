import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";

const manifest = JSON.parse(readFileSync(process.env.CONNECTOR_MANIFEST_FILE ?? "dist/connector/latest.json","utf8"));
const cdn = process.env.CONNECTOR_CDN_URL, bucket = process.env.CONNECTOR_S3_BUCKET;
const keyPairId = process.env.CONNECTOR_CDN_KEY_ID;
const privateKey = readFileSync(process.env.CONNECTOR_CDN_PRIVATE_KEY_FILE,"utf8");
const prefix = process.env.CONNECTOR_ARTIFACT_PREFIX ?? "";
if (!cdn || !bucket || !keyPairId || !/^[a-zA-Z0-9/.-]*$/.test(prefix)) throw new Error("Distribution configuration missing");
const sign = (url, expiry=Date.now()+300_000) => getSignedUrl({url,keyPairId,privateKey,dateLessThan:new Date(expiry).toISOString()});
async function checkStatus(url,expected) {
  const response=await fetch(url,{redirect:"manual"}); await response.body?.cancel();
  assert.equal(response.status,expected); return response;
}
const stub=`${cdn}/${prefix}stub/stub-${manifest.version}.exe`;
await checkStatus(stub,403);
for (const number of [1001,1002,1001]) {
  const filename=`MasalaPOS-Support-C-${number}-${"x".repeat(43)}.exe`;
  const url=new URL(stub);url.searchParams.set("response-content-disposition",`attachment; filename="${filename}"`);
  const signed=sign(url.href), response=await fetch(signed);
  assert.equal(response.status,200);assert.equal(response.headers.get("content-disposition"),`attachment; filename="${filename}"`);
  assert.ok((await response.arrayBuffer()).byteLength<2*1024*1024);
  const forged=new URL(signed);forged.searchParams.set("response-content-disposition","attachment; filename=wrong.exe");
  await checkStatus(forged,403);await checkStatus(sign(url.href,Date.now()-60_000),403);
}
const runtime=`${cdn}/${prefix}runtime/connector-${manifest.version}.zip`;
if (prefix.startsWith("staging/")) await checkStatus(runtime,403);
const response=await fetch(prefix.startsWith("staging/")?sign(runtime):runtime);
assert.equal(response.status,200);let size=0;const hash=createHash("sha256");
for await (const chunk of response.body) {size+=chunk.length;hash.update(chunk);}
assert.equal(size,manifest.size);assert.equal(hash.digest("hex"),manifest.sha256);
await checkStatus(`https://${bucket}.s3.us-east-2.amazonaws.com/${prefix}runtime/connector-${manifest.version}.zip`,403);
console.log(JSON.stringify({distribution:cdn,prefix,stubFilenameIsolation:true,expiredAndTamperedUrlsDenied:true,unsignedStagingDenied:prefix.startsWith("staging/"),directS3Denied:true,runtimeBytes:size,runtimeSha256:manifest.sha256}));
