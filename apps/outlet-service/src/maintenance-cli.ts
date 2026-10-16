import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { maintainOutlet } from "./maintenance.js";

const [command, folder, ...args] = process.argv.slice(2);
if (!folder || !["status", "backup", "restore", "prepare-update", "migrate-data", "reconcile-cloud"].includes(command ?? "")) {
  throw new Error("Usage: maintenance.mjs <status|backup|restore|prepare-update|migrate-data|reconcile-cloud> <absolute-data-dir> [backup-file|verified-release.json|destination|--snapshot FILE|--encrypted FILE --manifest FILE --key KEYFILE] [--acknowledge-unsynced-loss]");
}
const keyFile = (path:string):Buffer => {
  const bytes=readFileSync(resolve(path));
  if(bytes.length===32) return bytes;
  const value=bytes.toString('utf8').trim();
  if(/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value,'hex');
  if(/^[A-Za-z0-9_-]{43}$/.test(value)) return Buffer.from(value,'base64url');
  if(/^[A-Za-z0-9+/]{43}=$/.test(value)) return Buffer.from(value,'base64');
  try {
    const saved=JSON.parse(value) as {key?:unknown};
    if(typeof saved.key==='string' && /^[A-Za-z0-9+/]{43}=$/.test(saved.key)) return Buffer.from(saved.key,'base64');
  } catch { /* report one consistent invalid key error */ }
  throw new Error('Backup key file must contain 32 raw bytes, 64 hex characters, base64, or a cloud-backup-key.json object');
};
const options = command === "restore" && args[0] ? { source: resolve(args[0]) } : command === "prepare-update" && args[0]
  ? JSON.parse(readFileSync(resolve(args[0]), "utf8")) as { schema: number; minSchema: number } : command === "migrate-data" && args[0] ? { destination: resolve(args[0]) } : command === 'reconcile-cloud' ? (() => {
    const result:{snapshot?:string;encrypted?:string;manifest?:string;key?:Buffer;acknowledgeUnsyncedLoss?:boolean}={};
    for(let i=0;i<args.length;i++) {
      const flag=args[i];
      if(flag==='--acknowledge-unsynced-loss') {result.acknowledgeUnsyncedLoss=true;continue;}
      if(!['--snapshot','--encrypted','--manifest','--key'].includes(flag??'')||!args[i+1]||args[i+1]!.startsWith('--')) throw new Error(`Unknown or incomplete recovery flag: ${flag}`);
      const value=args[++i]!;
      if(flag==='--key') result.key=keyFile(value);
      else result[flag!.slice(2) as 'snapshot'|'encrypted'|'manifest']=resolve(value);
    }
    return result;
  })() : {};
console.log(JSON.stringify(await maintainOutlet(resolve(folder), command as "status" | "backup" | "restore" | "prepare-update" | "migrate-data" | "reconcile-cloud", options), null, 2));
