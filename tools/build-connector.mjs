import { build as bundle } from "esbuild";
import { build as packageElectron, Platform, Arch } from "electron-builder";
import { getMakeNsisPath } from "app-builder-lib/out/toolsets/windows.js";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { signManifest, rsaXml, sha256 } from "./connector-release.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)),".."), development = process.argv.includes("--dev");
const stage = join(root,"build/connector/app"), out = join(root,"dist/connector");
const pkg = JSON.parse(readFileSync(join(root,"package.json"),"utf8"));
const origin = process.env.CONNECTOR_ORIGIN ?? "https://portal.billnroll.in";
const cdn = process.env.CONNECTOR_CDN_URL ?? (development ? "https://development.cloudfront.net" : "");
if (!/^https:\/\/[a-z0-9.-]+$/.test(origin) || !/^https:\/\/[a-z0-9-]+\.cloudfront\.net$/.test(cdn)) throw new Error("Configure HTTPS CONNECTOR_ORIGIN and CONNECTOR_CDN_URL");
if (!development && (!process.env.CONNECTOR_MANIFEST_KEY_FILE || !process.env.CONNECTOR_CERT_SHA1 || !process.env.CONNECTOR_SIGNTOOL)) throw new Error("Production build requires CONNECTOR_MANIFEST_KEY_FILE, CONNECTOR_CERT_SHA1 and CONNECTOR_SIGNTOOL. Use --dev for local testing only.");
if (relative(root,stage).replaceAll("\\","/") !== "build/connector/app") throw new Error("Unsafe staging path");
rmSync(stage,{recursive:true,force:true}); mkdirSync(stage,{recursive:true}); mkdirSync(out,{recursive:true});
const keyPath = process.env.CONNECTOR_MANIFEST_KEY_FILE ?? join(root,"build/connector/development-manifest-key.pem");
if (!existsSync(keyPath)) {
  if (!development) throw new Error("Manifest signing key is missing");
  const pair = generateKeyPairSync("rsa",{modulusLength:3072});
  writeFileSync(keyPath,pair.privateKey.export({format:"pem",type:"pkcs8"}),{mode:0o600});
}
const key = readFileSync(keyPath,"utf8");
writeFileSync(join(root,"build/connector/manifest-key.xml"),rsaXml(key));
await bundle({entryPoints:[join(root,"apps/connector/src/main.ts")],outfile:join(stage,"main.js"),bundle:true,platform:"node",format:"esm",target:"node24",external:["electron","koffi"],define:{__CONNECTOR_ORIGIN__:JSON.stringify(origin)}});
for (const [entry,name] of [["apps/connector/src/preload.ts","preload"],["packages/remote-agent/src/agent-preload.ts","remote-agent-preload"],["packages/remote-agent/src/banner-preload.ts","remote-banner-preload"]]) {
  await bundle({entryPoints:[join(root,entry)],outfile:join(stage,`${name}.cjs`),bundle:true,platform:"node",format:"cjs",target:"node24",external:["electron"]});
}
await bundle({entryPoints:[join(root,"packages/remote-agent/src/agent-page.ts")],outfile:join(stage,"remote-agent.js"),bundle:true,platform:"browser",format:"iife",target:"chrome140"});
writeFileSync(join(stage,"remote-agent.html"),'<!doctype html><html><head><meta charset="utf-8"><title>MasalaPOS screen sharing</title></head><body><script src="remote-agent.js"></script></body></html>');
execFileSync(process.execPath,[join(root,"node_modules/vite/bin/vite.js"),"build"],{cwd:join(root,"apps/connector"),stdio:"inherit"});
cpSync(join(root,"apps/connector/dist/renderer"),join(stage,"renderer"),{recursive:true});
const koffi = join(root,"node_modules/koffi");
cpSync(koffi,join(stage,"node_modules/koffi"),{recursive:true,filter:(path)=>!relative(koffi,path).replaceAll("\\","/").startsWith("build/koffi/") || relative(koffi,path).replaceAll("\\","/").startsWith("build/koffi/win32_x64")});
writeFileSync(join(stage,"package.json"),JSON.stringify({name:"masalapos-support",version:pkg.version,type:"module",main:"main.js",author:"MasalaPOS",description:"Consent-based restaurant support",dependencies:{koffi:"2.16.3"}}));
await packageElectron({targets:Platform.WINDOWS.createTarget(["zip"],Arch.x64),config:{extends:join(root,"electron-builder.connector.yml"),forceCodeSigning:!development,...(development?{win:{signAndEditExecutable:false}}:{win:{signtoolOptions:{certificateSha1:process.env.CONNECTOR_CERT_SHA1}}})}});
if (!development) execFileSync(process.env.CONNECTOR_SIGNTOOL,["verify","/pa","/all","/tw",join(out,"win-unpacked/MasalaPOS Support.exe")],{stdio:"inherit"});
const runtime = join(out,`connector-${pkg.version}.zip`);
const manifest = signManifest({version:pkg.version,size:statSync(runtime).size,sha256:sha256(readFileSync(runtime)),url:`${cdn}/runtime/connector-${pkg.version}.zip`,production:!development},key);
writeFileSync(join(out,"latest.json"),JSON.stringify(manifest,null,2)+"\n");
// electron-builder verifies this pinned NSIS 3.0.4.1 archive:
// SHA-256 9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa.
if (process.env.ELECTRON_BUILDER_NSIS_DIR) throw new Error("Custom NSIS overrides are not allowed for connector builds");
const nsis = await getMakeNsisPath("0.0.0");
const stub = join(out,`stub-${pkg.version}.exe`);
execFileSync(nsis.path,[`/DOUTPUT=${stub}`,`/DBOOTSTRAP=${join(root,"tools/connector-bootstrap.ps1")}`,`/DMANIFEST_KEY=${join(root,"build/connector/manifest-key.xml")}`,`/DORIGIN=${origin}`,`/DDEVELOPMENT=${development?1:0}`,join(root,"tools/connector-stub.nsi")],{stdio:"inherit",env:{...process.env,...nsis.env}});
if (!development) execFileSync(process.env.CONNECTOR_SIGNTOOL,["sign","/sha1",process.env.CONNECTOR_CERT_SHA1,"/fd","SHA256","/tr","http://timestamp.digicert.com","/td","SHA256",stub],{stdio:"inherit"});
if (!development) execFileSync(process.env.CONNECTOR_SIGNTOOL,["verify","/pa","/all","/tw",stub],{stdio:"inherit"});
if (statSync(stub).size >= 2*1024*1024) throw new Error("Connector stub exceeds the 2 MB target");
writeFileSync(join(out,"build-info.json"),JSON.stringify({version:pkg.version,production:!development,stubSha256:sha256(readFileSync(stub)),stubBytes:statSync(stub).size,runtimeBytes:manifest.size},null,2));
console.log(`Support Connector built: stub ${statSync(stub).size} bytes, runtime ${manifest.size} bytes. ${development?"Development artifacts: production publishing is disabled.":"Signed artifacts require real-PC acceptance before publishing."}`);
