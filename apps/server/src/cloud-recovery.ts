import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { z } from 'zod';
import { MIGRATIONS, migrate, type Database } from '@forkflow/domain';
import { RecordChange, REPLICATED_TABLES, SyncEnvelope, type SyncEnvelope as Event } from '@forkflow/contracts';
import { atomicJson, syncFile, verifyBackup } from './backups.js';
import { BackupManifest, decryptBackup } from './cloud-backup-crypto.js';
import { restoreDatabase } from './recovery.js';

const Binding = z.object({ outletId:z.string().min(1), installationId:z.string().min(1), credential:z.string().min(1), epoch:z.string().min(1), cloudUrl:z.string().url(), generation:z.string().min(1) }).strict();
const State = z.object({ epoch:z.string(), sequence:z.number().int().nonnegative().safe(), acknowledged:z.number().int().nonnegative().safe(), bootstrapped:z.number().int(), outlet_id:z.string(), installation_id:z.string() });
const Page = z.object({ events:z.array(SyncEnvelope).max(100), highWatermark:z.number().int().nonnegative().safe() }).strict();
const Marker = z.object({ staged:z.string(), oldGeneration:z.string(), outletId:z.string(), installationId:z.string(), epoch:z.string(), sequence:z.number().int().nonnegative(), acknowledged:z.number().int().nonnegative() }).strict();
type Binding = z.infer<typeof Binding>;
type State = z.infer<typeof State>;
export type CloudRecoveryOptions = { snapshot?:string; encrypted?:string; manifest?:string; key?:Buffer; acknowledgeUnsyncedLoss?:boolean; fetch?:typeof fetch };
const quote = (name:string) => `"${name.replaceAll('"','""')}"`;
const canonical = (value:unknown):string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
const keyText = (key:Record<string,string|number>) => JSON.stringify(Object.fromEntries(Object.entries(key).sort(([a],[b])=>a.localeCompare(b))));
const state = (db:Database):State => State.parse(db.prepare('SELECT epoch,sequence,acknowledged,bootstrapped,outlet_id,installation_id FROM cloud_sync_state WHERE id=1').get());
const assertIdentity = (s:State,b:Binding) => { if(s.epoch!==b.epoch||s.outlet_id!==b.outletId||s.installation_id!==b.installationId||!s.bootstrapped) throw new Error('Snapshot belongs to a different outlet, installation, or epoch'); };
const getGeneration = (dataDir:string) => {
  const path=join(dataDir,'recovery-generation.json');
  return existsSync(path) ? z.object({generation:z.string().min(1)}).parse(JSON.parse(readFileSync(path,'utf8'))).generation : 'initial';
};
const eventFromOutbox = (db:Database,s:State,sequence:number):Event|undefined => {
  const row=db.prepare('SELECT event_id,occurred_at,changes_json FROM cloud_outbox WHERE sequence=?').get(sequence) as {event_id:string;occurred_at:number;changes_json:string}|undefined;
  return row ? SyncEnvelope.parse({protocolVersion:1,outletId:s.outlet_id,installationId:s.installation_id,epoch:s.epoch,sequence,eventId:row.event_id,occurredAt:row.occurred_at,changes:JSON.parse(row.changes_json)}) : undefined;
};
type Column = {name:string;pk:number;notnull:number;dflt_value:string|null};
function applyChange(db:Database, input:unknown, revision:number) {
  const change=RecordChange.parse(input);
  if (!REPLICATED_TABLES.includes(change.table)) throw new Error('Cloud event names an unsupported table');
  const columns=db.prepare(`PRAGMA table_info(${quote(change.table)})`).all() as Column[];
  if (!columns.length) throw new Error(`Snapshot lacks replicated table ${change.table}`);
  const allowed=columns.filter(c=>!['photo_data','printer_id','receipt_hash'].includes(c.name));
  const names=new Set(allowed.map(c=>c.name));
  const primary=columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
  if (!primary.length || Object.keys(change.key).length!==primary.length || primary.some(c=>!(c in change.key))) throw new Error(`Invalid primary key for ${change.table}`);
  for(const [name,value] of Object.entries(change.key)) if(!names.has(name)||!(typeof value==='string'||Number.isSafeInteger(value))) throw new Error(`Invalid key column for ${change.table}`);
  const where=primary.map(c=>`${quote(c)}=?`).join(' AND '), keys=primary.map(c=>change.key[c]);
  if(change.row===null) {
    db.prepare(`DELETE FROM ${quote(change.table)} WHERE ${where}`).run(...keys);
    if(change.table==='staff_roster') db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(change.key['id']);
  } else {
    const row=change.row;
    for(const [name,value] of Object.entries(row)) if(!names.has(name)||value===undefined) throw new Error(`Invalid replicated column ${change.table}.${name}`);
    for(const name of primary) if(canonical(row[name])!==canonical(change.key[name])) throw new Error(`Cloud row key mismatch for ${change.table}`);
    const existing=db.prepare(`SELECT 1 FROM ${quote(change.table)} WHERE ${where}`).get(...keys);
    if(existing) {
      const fields=Object.keys(row).filter(name=>!primary.includes(name));
      if(fields.length) db.prepare(`UPDATE ${quote(change.table)} SET ${fields.map(c=>`${quote(c)}=?`).join(',')} WHERE ${where}`).run(...fields.map(c=>row[c]),...keys);
    } else {
      const values:Record<string,unknown>={...row};
      if(change.table==='guest_requests'||change.table==='guest_service_requests') values['receipt_hash']=randomBytes(32).toString('hex');
      const fields=Object.keys(values);
      db.prepare(`INSERT INTO ${quote(change.table)} (${fields.map(quote).join(',')}) VALUES (${fields.map(()=>'?').join(',')})`).run(...fields.map(c=>values[c]));
    }
  }
  db.prepare('INSERT INTO cloud_entity_revision(entity,key_json,revision) VALUES(?,?,?) ON CONFLICT(entity,key_json) DO UPDATE SET revision=excluded.revision').run(change.table,keyText(change.key),revision);
}
function applyEvent(db:Database,event:Event) {
  for(const change of event.changes.filter(change=>change.row===null)) applyChange(db,change,event.sequence);
  for(const change of event.changes.filter(change=>change.row!==null)) applyChange(db,change,event.sequence);
  db.prepare('INSERT INTO cloud_outbox(sequence,event_id,occurred_at,changes_json) VALUES(?,?,?,?)').run(event.sequence,event.eventId,event.occurredAt,JSON.stringify(event.changes));
  db.prepare('UPDATE cloud_sync_state SET sequence=? WHERE id=1').run(event.sequence);
}
function validateStage(db:Database) {
  for(const roster of db.prepare('SELECT id,name,role,is_active,created_at FROM staff_roster').all() as Array<{id:string;name:string;role:string;is_active:number;created_at:number}>) {
    const user=db.prepare('SELECT pin_hash FROM users WHERE id=?').get(roster.id) as {pin_hash:string}|undefined;
    if(!user)
      db.prepare('INSERT INTO users(id,name,pin_hash,role,is_active,created_at) VALUES(?,?,?,?,0,?)').run(roster.id,roster.name,`recovery-disabled:${randomBytes(32).toString('hex')}`,roster.role,roster.created_at);
    else if(!user.pin_hash.startsWith('recovery-disabled:'))
      db.prepare('UPDATE users SET name=?,role=?,is_active=? WHERE id=?').run(roster.name,roster.role,roster.is_active,roster.id);
  }
  // A recovered staff member must be explicitly assigned a new PIN on this host.
  db.prepare('UPDATE users SET is_active=0 WHERE id IN (SELECT id FROM staff_roster) AND pin_hash LIKE ?').run('recovery-disabled:%');
  for(const [name,table,column] of [['bill_no','bills','bill_no'],['credit_note_no','credit_notes','cn_no']] as const) {
    const value=(db.prepare(`SELECT MAX(${quote(column)}) AS n FROM ${quote(table)}`).get() as {n:number|null}).n ?? 0;
    db.prepare('UPDATE sequences SET value=MAX(value,?) WHERE name=?').run(value,name);
  }
  // The original print outcome is unknowable after a rollback or host loss.
  db.prepare("UPDATE print_jobs SET status='unknown' WHERE status IN ('queued','printing')").run();
  if(db.pragma('integrity_check',{simple:true})!=='ok') throw new Error('Replayed snapshot failed full SQLite integrity check');
  if((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Replayed snapshot has broken references');
}
async function fetchPage(b:Binding, after:number, transport:typeof fetch):Promise<z.infer<typeof Page>> {
  const response=await transport(`${b.cloudUrl}/v1/sync/journal?after=${after}&limit=100`,{headers:{authorization:`Bearer ${b.credential}`},signal:AbortSignal.timeout(15_000),redirect:'error'});
  if(!response.ok) throw new Error(`Cloud journal request failed (${response.status})`);
  return Page.parse(await response.json());
}

/** Caller holds the data-directory writer lock and has stopped the outlet service. */
export async function reconcileCloud(dataDir:string, options:CloudRecoveryOptions={}):Promise<{archive:string|null;sequence:number;acknowledged:number}> {
  const bindingPath=join(dataDir,'cloud-binding.json'), markerPath=join(dataDir,'cloud-reconcile-pending.json');
  if(!existsSync(bindingPath)) throw new Error('Outlet is not paired with cloud');
  const binding=Binding.parse(JSON.parse(readFileSync(bindingPath,'utf8')));
  const cloud=new URL(binding.cloudUrl);
  if(cloud.protocol!=='https:'||cloud.origin!==binding.cloudUrl||cloud.username||cloud.password||cloud.search||cloud.hash) throw new Error('Cloud binding must contain a secure server origin');
  if(existsSync(markerPath)) {
    const marker=Marker.parse(JSON.parse(readFileSync(markerPath,'utf8')));
    if(marker.outletId!==binding.outletId||marker.installationId!==binding.installationId||marker.epoch!==binding.epoch) throw new Error('Recovery marker identity does not match the cloud binding');
    const alreadyRebound=binding.generation!==marker.oldGeneration;
    if(alreadyRebound&&(binding.generation!==getGeneration(dataDir)||existsSync(join(dataDir,'restore-pending.json')))) throw new Error('Recovery marker generation does not match the installed database');
    let archive:string|null=null;
    if(!alreadyRebound&&existsSync(join(dataDir,'restore-pending.json'))) archive=restoreDatabase(dataDir);
    else if(!alreadyRebound&&getGeneration(dataDir)===marker.oldGeneration) archive=restoreDatabase(dataDir,marker.staged);
    const db=new DatabaseCtor(join(dataDir,'forkflow.db'),{readonly:true,fileMustExist:true});
    try { const restored=state(db); assertIdentity(restored,binding); if(restored.sequence!==marker.sequence||restored.acknowledged!==marker.acknowledged) throw new Error('Installed recovery database does not match durable marker'); }
    finally {db.close();}
    if(!alreadyRebound) atomicJson(bindingPath,{...binding,generation:getGeneration(dataDir)});
    unlinkSync(markerPath);
    return {archive,sequence:marker.sequence,acknowledged:marker.acknowledged};
  }
  if(existsSync(join(dataDir,'restore-pending.json'))) restoreDatabase(dataDir);
  if((options.snapshot?1:0)+(options.encrypted?1:0)>1) throw new Error('Select one snapshot source');
  if(options.encrypted && (!options.manifest||!options.key)) throw new Error('Encrypted recovery requires manifest and 256-bit key');
  if(!options.encrypted && (options.manifest||options.key)) throw new Error('Manifest/key require encrypted backup');
  const stage=join(dataDir,`cloud-reconcile-${randomUUID()}.db`), live=join(dataDir,'forkflow.db');
  let expectedSnapshotSequence:number|undefined;
  if(options.encrypted) {
    const manifest=BackupManifest.parse(JSON.parse(readFileSync(resolve(options.manifest!),'utf8')));
    if(manifest.outletId!==binding.outletId||manifest.installationId!==binding.installationId||manifest.epoch!==binding.epoch) throw new Error('Encrypted backup belongs to another outlet or epoch');
    expectedSnapshotSequence=manifest.sequence;
    await decryptBackup(resolve(options.encrypted),stage,options.key!,manifest);
  } else {
    const sourcePath=options.snapshot?resolve(options.snapshot):live;
    if(!existsSync(sourcePath)) throw new Error('No live database; choose a verified snapshot');
    const source=new DatabaseCtor(sourcePath,{readonly:true,fileMustExist:true});
    try {await source.backup(stage);} finally {source.close();}
  }
  verifyBackup(stage);
  const staged=new DatabaseCtor(stage), local=existsSync(live)?new DatabaseCtor(live,{readonly:true,fileMustExist:true}):null;
  try {
    staged.pragma('journal_mode = DELETE'); staged.pragma('foreign_keys = ON'); migrate(staged,MIGRATIONS);
    const start=state(staged); assertIdentity(start,binding);
    if(expectedSnapshotSequence!==undefined && expectedSnapshotSequence!==start.sequence) throw new Error('Encrypted backup manifest sequence does not match its database');
    let localState:State|null=null;
    if(local) { try { localState=state(local); assertIdentity(localState,binding); } catch { localState=null; } }
    // Only local schema triggers are removed; the staged copy is never opened by the server.
    for(const row of staged.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'ff_cloud_%' OR name LIKE 'ff_roster_%')").all() as Array<{name:string}>) staged.exec(`DROP TRIGGER ${quote(row.name)}`);
    staged.pragma('foreign_keys = OFF');
    let cursor=start.sequence, highWatermark:number|undefined, pages=0;
    while(true) {
      if(++pages>1_000_000) throw new Error('Cloud journal pagination did not terminate');
      const page=await fetchPage(binding,cursor,options.fetch??fetch);
      if(highWatermark!==undefined && highWatermark!==page.highWatermark) throw new Error('Cloud journal watermark changed during recovery');
      highWatermark=page.highWatermark;
      if(page.highWatermark<start.acknowledged) throw new Error('Cloud history is behind an acknowledged local sequence');
      if(page.events.length===0) { if(cursor<page.highWatermark) throw new Error('Cloud journal has a sequence gap'); break; }
      if(cursor>=page.highWatermark) throw new Error('Cloud returned events beyond its watermark');
      staged.transaction(()=>{
        staged.pragma('defer_foreign_keys = ON');
        for(const event of page.events) {
          if(event.outletId!==binding.outletId||event.installationId!==binding.installationId||event.epoch!==binding.epoch) throw new Error('Cloud event identity or epoch mismatch');
          if(event.sequence!==cursor+1||event.sequence>page.highWatermark) throw new Error('Cloud journal sequence gap or overlap');
          const overlap=local&&localState?eventFromOutbox(local,localState,event.sequence):undefined;
          if(overlap&&canonical(overlap)!==canonical(event)) throw new Error('Cloud event conflicts with retained local outbox');
          applyEvent(staged,event); cursor=event.sequence;
        }
      })();
    }
    const cloudCursor=highWatermark!;
    if(start.sequence>cloudCursor && start.acknowledged>cloudCursor) throw new Error('Snapshot acknowledgement exceeds cloud history');
    // A retained host can prove its unacknowledged suffix. A replaced host cannot.
    const knownHost=localState!==null && getGeneration(dataDir)===binding.generation && localState.sequence>=cloudCursor;
    if(!knownHost && !options.acknowledgeUnsyncedLoss) throw new Error('Possible unsynced host interval; pass --acknowledge-unsynced-loss after operator review');
    if(start.sequence>cloudCursor) {
      for(let next=cloudCursor+1;next<=start.sequence;next++) {
        const retained=eventFromOutbox(staged,start,next);
        if(!retained) throw new Error(`Snapshot unsynced outbox has a sequence gap at ${next}`);
        const liveEvent=local&&localState?eventFromOutbox(local,localState,next):undefined;
        if(liveEvent&&canonical(liveEvent)!==canonical(retained)) throw new Error('Snapshot unsynced outbox conflicts with live host');
      }
    }
    const suffixSource=localState&&localState.sequence>cloudCursor?local:start.sequence>cloudCursor?staged:null;
    const suffixState=suffixSource===local?localState:start;
    if(suffixSource&&suffixState) {
      for(let next=Math.max(cursor,start.sequence)+1;next<=suffixState.sequence;next++) {
        const event=eventFromOutbox(suffixSource,suffixState,next);
        if(!event) throw new Error(`Unsynced local outbox has a sequence gap at ${next}`);
        staged.transaction(()=>{staged.pragma('defer_foreign_keys = ON');applyEvent(staged,event);})();
        cursor=next;
      }
      if(suffixSource===staged && start.sequence>cloudCursor) cursor=start.sequence;
    }
    staged.transaction(()=>{
      staged.pragma('defer_foreign_keys = ON');
      validateStage(staged);
      staged.prepare('UPDATE cloud_sync_state SET sequence=?,acknowledged=?,bootstrapped=1 WHERE id=1').run(cursor,cloudCursor);
      staged.prepare('DELETE FROM cloud_changes').run();
    })();
    staged.pragma('foreign_keys = ON');
    if(staged.pragma('integrity_check',{simple:true})!=='ok'||(staged.pragma('foreign_key_check') as unknown[]).length) throw new Error('Reconciled database failed final SQLite checks');
  } finally {staged.close();local?.close();}
  verifyBackup(stage); syncFile(stage);
  const checked=new DatabaseCtor(stage,{readonly:true,fileMustExist:true});
  let finalState:State;
  try {finalState=state(checked);} finally {checked.close();}
  atomicJson(markerPath,{staged:stage,oldGeneration:binding.generation,outletId:binding.outletId,installationId:binding.installationId,epoch:binding.epoch,sequence:finalState.sequence,acknowledged:finalState.acknowledged});
  return reconcileCloud(dataDir,{});
}
