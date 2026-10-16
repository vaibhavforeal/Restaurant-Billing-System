import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import type { Database } from '@forkflow/domain';
import { z } from 'zod';
import { atomicJson, verifyBackup } from './backups.js';
import { BackupManifest, encryptBackup } from './cloud-backup-crypto.js';
import type { CloudJournal } from './cloud-journal.js';

const Saved = z.object({ lastBackupAt: z.number().default(0), media: z.record(z.string(), z.string()).default({}), pending: BackupManifest.nullable().default(null) });
export class CloudStorageJobs {
  private readonly folder: string;
  private readonly statePath: string;
  private saved: z.infer<typeof Saved>;
  private lastError: string | null = null;
  private active: Promise<void> | null = null;
  private stopped = false;
  private readonly abort = new AbortController();
  constructor(private readonly db: Database, private readonly dataDir: string, private readonly journal: CloudJournal, private readonly request: (path: string, body?: unknown) => Promise<unknown>, private readonly transport: typeof fetch = fetch) {
    this.folder=join(dataDir,'cloud-transfers');mkdirSync(this.folder,{recursive:true});this.statePath=join(this.folder,'state.json');
    this.saved=Saved.parse(existsSync(this.statePath)?JSON.parse(readFileSync(this.statePath,'utf8')):{});
  }
  status() { return { lastBackupAt:this.saved.lastBackupAt||null,pendingBackup:!!this.saved.pending,lastError:this.lastError,uploading:!!this.active }; }
  run(): Promise<void> {
    if(!this.active)this.active=this.execute().catch(error=>{this.lastError=error instanceof Error?error.message:'Cloud storage failed';}).finally(()=>{this.active=null;});return this.active;
  }
  private async upload(kind:'backup'|'media',objectId:string,sha256:string,bytes:number,metadata:unknown,body:()=>RequestInit['body']) {
    const data={kind,objectId,sha256,bytes,metadata};
    const ticket=z.object({uploadUrl:z.string().url(),objectKey:z.string(),headers:z.record(z.string(),z.string()).optional()}).parse(await this.request('/v1/storage/upload',data));
    const upload=await this.transport(ticket.uploadUrl,{method:'PUT',body:body(),headers:ticket.headers??{},signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(120_000)]),redirect:'error',duplex:'half'} as RequestInit);
    if(!upload.ok)throw new Error(`Object upload failed (${upload.status})`);
    await this.request('/v1/storage/complete',data);
  }
  private async execute() {
    if(this.stopped || this.journal.state().outlet_id==='unpaired')return;
    if(this.saved.pending || Date.now()-this.saved.lastBackupAt>=3600_000) {
      const encrypted=join(this.folder,'pending.ffbk');
      if(!this.saved.pending) {
        const keyPath=join(this.dataDir,'cloud-backup-key.json');
        if(!existsSync(keyPath))atomicJson(keyPath,{version:1,key:randomBytes(32).toString('base64')});
        const key=Buffer.from(z.object({key:z.string()}).parse(JSON.parse(readFileSync(keyPath,'utf8'))).key,'base64');
        const snapshot=join(this.folder,`${randomUUID()}.db`);
        try {
          await this.db.backup(snapshot);verifyBackup(snapshot);
          const check=new DatabaseCtor(snapshot,{readonly:true});
          let state:ReturnType<CloudJournal['state']>;
          try { state=check.prepare('SELECT * FROM cloud_sync_state WHERE id=1').get() as ReturnType<CloudJournal['state']>; } finally {check.close();}
          // A crash before saving the manifest may leave only our unreferenced encrypted staging file.
          if(existsSync(encrypted))await unlink(encrypted);
          this.saved.pending=await encryptBackup(snapshot,encrypted,key,{outletId:state.outlet_id,installationId:state.installation_id,epoch:state.epoch,sequence:state.sequence});
          atomicJson(this.statePath,this.saved);
        } finally {await unlink(snapshot).catch(()=>{});}
      }
      const manifest=this.saved.pending!;
      if(!existsSync(encrypted)||statSync(encrypted).size!==manifest.bytes)throw new Error('Pending encrypted backup is missing or incomplete');
      await this.upload('backup',manifest.id,manifest.sha256,manifest.bytes,manifest,()=>createReadStream(encrypted) as unknown as RequestInit['body']);
      this.saved.lastBackupAt=manifest.createdAt;this.saved.pending=null;atomicJson(this.statePath,this.saved);await unlink(encrypted).catch(()=>{});
    }
    const photos=this.db.prepare('SELECT id,photo_hash,photo_data FROM products WHERE photo_data IS NOT NULL').all() as Array<{id:string;photo_hash:string;photo_data:string}>;
    for(const row of photos) {
      if(this.stopped)break;
      if(this.saved.media[row.id]===row.photo_hash)continue;
      const bytes=Buffer.from(row.photo_data.split(',')[1]??'','base64'),sha256=createHash('sha256').update(bytes).digest('hex');
      if(sha256!==row.photo_hash)throw new Error('Menu image checksum does not match its catalog record');
      // Stable object id for retry after a lost completion acknowledgement.
      const hex=createHash('sha256').update(`${this.journal.state().outlet_id}:${row.id}:${sha256}`).digest('hex');
      const objectId=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
      await this.upload('media',objectId,sha256,bytes.length,{productId:row.id,photoHash:sha256},()=>new Uint8Array(bytes));
      this.saved.media[row.id]=row.photo_hash;atomicJson(this.statePath,this.saved);
    }
    this.lastError=null;
  }
  async stop(){this.stopped=true;this.abort.abort();await this.active;}
}
