import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { appendFile, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

const Context = z.object({ outletId: z.string().min(1), installationId: z.string().min(1), epoch: z.string().min(1), sequence: z.number().int().nonnegative().safe() });
export const BackupManifest = Context.extend({ id: z.string().uuid(), format: z.literal('ffbk1'), createdAt: z.number().int().nonnegative(), keyId: z.string().regex(/^[a-f0-9]{64}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive() }).strict();
export type BackupManifest = z.infer<typeof BackupManifest>;
const magic = Buffer.from('FFBK1');
const aad = (context: z.infer<typeof Context>) => Buffer.from(JSON.stringify(Context.parse(context)));
export async function sha256File(path: string): Promise<string> {
  const hash=createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer); return hash.digest('hex');
}
export async function encryptBackup(source: string, destination: string, key: Buffer, context: z.infer<typeof Context>): Promise<BackupManifest> {
  if (key.length !== 32) throw new Error('Backup encryption requires a 256-bit key');
  if (existsSync(destination)) throw new Error('Backup destination already exists');
  const iv=randomBytes(12), temporary=`${destination}.${randomUUID()}.partial`;
  const cipher=createCipheriv('aes-256-gcm',key,iv); cipher.setAAD(aad(context));
  try {
    await writeFile(temporary,Buffer.concat([magic,iv]),{flag:'wx',mode:0o600});
    await pipeline(createReadStream(source),cipher,createWriteStream(temporary,{flags:'a'}));
    await appendFile(temporary,cipher.getAuthTag());
    const fd=await open(temporary,'r+'); try { await fd.sync(); } finally { await fd.close(); }
    const manifest=BackupManifest.parse({ ...context,id:randomUUID(),format:'ffbk1',createdAt:Date.now(),keyId:createHash('sha256').update(key).digest('hex'),sha256:await sha256File(temporary),bytes:(await stat(temporary)).size });
    await rename(temporary,destination); return manifest;
  } catch(error) { await unlink(temporary).catch(()=>{}); throw error; }
}
export async function decryptBackup(source: string,destination: string,key: Buffer,input: unknown): Promise<void> {
  const manifest=BackupManifest.parse(input);
  if (existsSync(destination)) throw new Error('Restore destination already exists');
  if (key.length!==32 || createHash('sha256').update(key).digest('hex')!==manifest.keyId) throw new Error('Backup encryption key does not match');
  const size=(await stat(source)).size;
  if(size!==manifest.bytes || size<33 || await sha256File(source)!==manifest.sha256) throw new Error('Backup checksum does not match');
  const fd=await open(source,'r'),header=Buffer.alloc(17),tag=Buffer.alloc(16);
  try { await fd.read(header,0,17,0); await fd.read(tag,0,16,size-16); } finally { await fd.close(); }
  if(!header.subarray(0,5).equals(magic)) throw new Error('Unsupported backup format');
  const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(5)); decipher.setAAD(aad(manifest)); decipher.setAuthTag(tag);
  const temporary=`${destination}.${randomUUID()}.partial`;
  try { await pipeline(createReadStream(source,{start:17,end:size-17}),decipher,createWriteStream(temporary,{flags:'wx',mode:0o600})); await rename(temporary,destination); }
  catch(error) { await unlink(temporary).catch(()=>{}); throw error; }
}
export function retainedBackups(rows: Array<{id:string;createdAt:number}>,now=Date.now()): Set<string> {
  const sorted=[...rows].sort((a,b)=>b.createdAt-a.createdAt),keep=new Set(sorted.slice(0,48).map(r=>r.id)),days=new Set<string>();
  for(const row of sorted) { if(row.createdAt<now-30*86400_000) continue; const day=new Date(row.createdAt).toISOString().slice(0,10); if(!days.has(day)) { days.add(day);keep.add(row.id); } }
  return keep;
}
