import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { MIGRATIONS, migrate, openDb } from '@forkflow/domain';
import { CloudJournal } from './cloud-journal.js';
import { CloudStorageJobs } from './cloud-storage.js';
import { BackupManifest, decryptBackup } from './cloud-backup-crypto.js';
import { verifyBackup } from './backups.js';
import { writeFile } from 'node:fs/promises';
const cleanup: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();});
it('uploads a verified encrypted snapshot and records success only after cloud confirmation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ff-cloud-storage-')), db=openDb(':memory:');migrate(db,MIGRATIONS);
  const journal=new CloudJournal(db);journal.bind('outlet','installation','epoch');
  let manifest: unknown;let uploaded:Buffer=Buffer.alloc(0);let completed=false;
  const jobs=new CloudStorageJobs(db,dir,journal,async(path,body)=>{
    if(path.endsWith('/upload'))return {uploadUrl:'https://storage.test/object',objectKey:'object'};
    if(path.endsWith('/complete')){manifest=(body as {metadata:unknown}).metadata;completed=true;return {ok:true};}
    throw new Error('Unexpected request');
  },(async(_url,init)=>{const chunks:Buffer[]=[];for await(const c of init!.body as unknown as AsyncIterable<Buffer>)chunks.push(Buffer.from(c));uploaded=Buffer.concat(chunks);return new Response('',{status:200});}) as typeof fetch);
  cleanup.push(async()=>{await jobs.stop();db.close();rmSync(dir,{recursive:true,force:true});});
  await jobs.run();expect(completed).toBe(true);expect(jobs.status().lastBackupAt).toBeGreaterThan(0);
  const encrypted=join(dir,'verify.ffbk'),restored=join(dir,'verify.db');await writeFile(encrypted,uploaded);
  const key=Buffer.from(JSON.parse(readFileSync(join(dir,'cloud-backup-key.json'),'utf8')).key,'base64');
  await decryptBackup(encrypted,restored,key,BackupManifest.parse(manifest));expect(verifyBackup(restored)).toBeGreaterThan(0);
  const before=jobs.status().lastBackupAt;await jobs.run();expect(jobs.status().lastBackupAt).toBe(before);
});
