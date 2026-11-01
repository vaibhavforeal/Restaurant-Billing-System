import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { manifestBytes, signManifest, verifyManifest } from "./connector-release.mjs";
test("release manifest authenticates version, hash, location, size and production status",()=>{
  const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
  const m=signManifest({version:"0.7.0",sha256:"a".repeat(64),size:123,url:"https://test.cloudfront.net/runtime/connector-0.7.0.zip",production:false},privateKey);
  assert.equal(verifyManifest(m,publicKey),true);
  for(const [field,value] of Object.entries({version:"0.7.1",sha256:"b".repeat(64),size:124,url:"https://evil.cloudfront.net/runtime/connector-0.7.0.zip",production:true})) assert.equal(verifyManifest({...m,[field]:value},publicKey),false);
  assert.equal(manifestBytes(m).toString().endsWith("\nfalse"),true);
  const staging = signManifest({...m,url:"https://test.cloudfront.net/staging/0.7.0/aaaaaaaaaaaaaaaa/runtime/connector-0.7.0.zip"},privateKey);
  assert.equal(verifyManifest(staging,publicKey),true);
  assert.equal(verifyManifest(signManifest({...staging,production:true},privateKey),publicKey),false);
  assert.equal(verifyManifest(signManifest({...staging,url:staging.url.replace("aaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbb")},privateKey),publicKey),false);
});
