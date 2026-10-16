import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, migrate, openDb } from '@forkflow/domain';
import { CloudJournal } from './cloud-journal.js';
import { Backups } from './backups.js';
import { maintainOutlet } from '../../outlet-service/src/maintenance.js';
import { restoreDatabase } from './recovery.js';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'ff-reconcile-')); folders.push(folder);
  const db = openDb(join(folder, 'forkflow.db')); migrate(db, MIGRATIONS);
  const journal = new CloudJournal(db);
  journal.bind('outlet-1', 'install-1', 'epoch-1');
  writeFileSync(join(folder, 'cloud-binding.json'), JSON.stringify({ outletId:'outlet-1', installationId:'install-1', epoch:'epoch-1', credential:'secret', cloudUrl:'https://cloud.example', generation:'initial' }));
  db.prepare("INSERT INTO categories (id,name) VALUES ('meal','Meals')").run();
  journal.acknowledge(1, true);
  db.prepare("INSERT INTO print_jobs(id,printer_id,status,job_json,target_json,payload) VALUES ('old-print','missing','queued','{}','{}',?)").run(Buffer.from('old receipt'));
  const snapshot = join(folder, 'backups', new Backups(db, folder).create('manual').name);
  return { folder, db, journal, snapshot };
}

it('replays a newer cloud sale state into an older verified SQLite snapshot without recreating print jobs', async () => {
  const { folder, db, journal, snapshot } = setup();
  db.transaction(() => {
    db.prepare("INSERT INTO users(id,name,pin_hash,role,created_at) VALUES ('u','Cashier','private hash','cashier',1)").run();
    db.prepare("INSERT INTO orders(id,client_ref,type,opened_by,opened_at) VALUES ('o','client-o','parcel','u',1)").run();
    db.prepare("INSERT INTO bills(id,bill_no,order_id,subtotal_paise,cgst_paise,sgst_paise,total_paise,created_at,created_by) VALUES ('b',42,'o',100,0,0,100,2,'u')").run();
    db.prepare("UPDATE sequences SET value=42 WHERE name='bill_no'").run();
  })();
  const event = journal.pending()[0]!;
  journal.acknowledge(event.sequence);
  db.close();
  const fetched: number[] = [];
  const transport: typeof fetch = async input => {
    expect(String(input)).toContain('/v1/sync/journal');
    const after = Number(new URL(String(input)).searchParams.get('after')); fetched.push(after);
    return Response.json({ events: after < 2 ? [event] : [], highWatermark: 2 });
  };
  const result = await maintainOutlet(folder, 'reconcile-cloud', { snapshot, fetch: transport, acknowledgeUnsyncedLoss: true });
  expect(result.archive).toBeTruthy();
  expect(fetched).toEqual([1,2]);
  const restored = openDb(join(folder, 'forkflow.db'));
  try {
    expect(restored.prepare("SELECT value FROM sequences WHERE name='bill_no'").get()).toEqual({ value: 42 });
    expect(restored.prepare("SELECT bill_no,total_paise FROM bills WHERE id='b'").get()).toEqual({bill_no:42,total_paise:100});
    expect(restored.prepare("SELECT is_active FROM users WHERE id='u'").get()).toEqual({is_active:0});
    expect(restored.prepare('SELECT sequence,acknowledged,bootstrapped FROM cloud_sync_state').get()).toEqual(expect.objectContaining({ sequence:2, acknowledged:2, bootstrapped:1 }));
    expect(restored.prepare("SELECT status FROM print_jobs WHERE id='old-print'").get()).toEqual({status:'unknown'});
  } finally { restored.close(); }
  expect(existsSync(join(folder, 'cloud-reconcile-pending.json'))).toBe(false);
});

it('leaves the live database intact when cloud history has a gap', async () => {
  const { folder, db, journal, snapshot } = setup();
  db.prepare("UPDATE sequences SET value=9 WHERE name='bill_no'").run();
  const event = { ...journal.pending()[0]!, sequence: 3 };
  db.close();
  await expect(maintainOutlet(folder, 'reconcile-cloud', { snapshot, fetch: async () => Response.json({ events:[event], highWatermark:3 }), acknowledgeUnsyncedLoss:true })).rejects.toThrow(/gap|sequence/i);
  const live = openDb(join(folder, 'forkflow.db'));
  try { expect(live.prepare("SELECT value FROM sequences WHERE name='bill_no'").get()).toEqual({ value:9 }); } finally { live.close(); }
});

it('retains a provably contiguous unsynced local suffix after the cloud watermark', async () => {
  const {folder,db,journal,snapshot}=setup();
  db.prepare("UPDATE categories SET name='Cloud version' WHERE id='meal'").run();
  const cloudEvent=journal.pending()[0]!;
  journal.acknowledge(2);
  db.prepare("UPDATE categories SET name='Offline version' WHERE id='meal'").run();
  db.close();
  await maintainOutlet(folder,'reconcile-cloud',{snapshot,fetch:async input=>Response.json({events:Number(new URL(String(input)).searchParams.get('after'))<2?[cloudEvent]:[],highWatermark:2})});
  const restored=openDb(join(folder,'forkflow.db'));
  try {
    expect(restored.prepare("SELECT name FROM categories WHERE id='meal'").get()).toEqual({name:'Offline version'});
    expect(restored.prepare('SELECT sequence,acknowledged FROM cloud_sync_state').get()).toEqual({sequence:3,acknowledged:2});
    expect(restored.prepare('SELECT sequence FROM cloud_outbox ORDER BY sequence').all()).toEqual([{sequence:1},{sequence:2},{sequence:3}]);
  } finally {restored.close();}
});

it('requires explicit lost-host acknowledgement when the available live database is behind cloud history', async () => {
  const {folder,db,snapshot}=setup(); db.close();
  const event={protocolVersion:1 as const,outletId:'outlet-1',installationId:'install-1',epoch:'epoch-1',sequence:2,eventId:'event-2',occurredAt:2,changes:[{table:'categories' as const,key:{id:'meal'},row:{id:'meal',name:'Cloud version',sort_order:0,is_active:1}}]};
  await expect(maintainOutlet(folder,'reconcile-cloud',{snapshot,fetch:async input=>Response.json({events:Number(new URL(String(input)).searchParams.get('after'))<2?[event]:[],highWatermark:2})})).rejects.toThrow(/acknowledge-unsynced-loss/);
  const live=openDb(join(folder,'forkflow.db'));
  try { expect(live.prepare("SELECT name FROM categories WHERE id='meal'").get()).toEqual({name:'Meals'}); }
  finally {live.close();}
});

it('keeps the live database and binding unchanged when replay violates SQLite references', async () => {
  const {folder,db,snapshot}=setup(); db.close();
  const bad={protocolVersion:1 as const,outletId:'outlet-1',installationId:'install-1',epoch:'epoch-1',sequence:2,eventId:'event-2',occurredAt:2,changes:[{table:'orders' as const,key:{id:'orphan'},row:{id:'orphan',client_ref:'orphan',type:'parcel',opened_by:'missing-user',opened_at:2,status:'open',table_id:null,closed_at:null}}]};
  await expect(maintainOutlet(folder,'reconcile-cloud',{snapshot,fetch:async input=>Response.json({events:Number(new URL(String(input)).searchParams.get('after'))<2?[bad]:[],highWatermark:2}),acknowledgeUnsyncedLoss:true})).rejects.toThrow(/references/);
  expect(existsSync(join(folder,'cloud-reconcile-pending.json'))).toBe(false);
  const live=openDb(join(folder,'forkflow.db'));
  try { expect(live.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({n:0}); }
  finally {live.close();}
});

it('finishes generation rebinding after an interrupted install without replaying or replacing again', async () => {
  const {folder,db,snapshot}=setup(); db.close();
  writeFileSync(join(folder,'cloud-reconcile-pending.json'),JSON.stringify({staged:snapshot,oldGeneration:'initial',outletId:'outlet-1',installationId:'install-1',epoch:'epoch-1',sequence:1,acknowledged:1}));
  restoreDatabase(folder,snapshot);
  const installedGeneration=JSON.parse(readFileSync(join(folder,'recovery-generation.json'),'utf8')).generation;
  await maintainOutlet(folder,'reconcile-cloud');
  expect(JSON.parse(readFileSync(join(folder,'cloud-binding.json'),'utf8')).generation).toBe(installedGeneration);
  expect(JSON.parse(readFileSync(join(folder,'recovery-generation.json'),'utf8')).generation).toBe(installedGeneration);
  expect(existsSync(join(folder,'cloud-reconcile-pending.json'))).toBe(false);
});

it('clears the durable marker after a crash between binding update and marker removal', async () => {
  const {folder,db,snapshot}=setup(); db.close();
  writeFileSync(join(folder,'cloud-reconcile-pending.json'),JSON.stringify({staged:snapshot,oldGeneration:'initial',outletId:'outlet-1',installationId:'install-1',epoch:'epoch-1',sequence:1,acknowledged:1}));
  restoreDatabase(folder,snapshot);
  const generation=JSON.parse(readFileSync(join(folder,'recovery-generation.json'),'utf8')).generation;
  const binding=JSON.parse(readFileSync(join(folder,'cloud-binding.json'),'utf8'));
  writeFileSync(join(folder,'cloud-binding.json'),JSON.stringify({...binding,generation}));
  await maintainOutlet(folder,'reconcile-cloud');
  expect(existsSync(join(folder,'cloud-reconcile-pending.json'))).toBe(false);
});
