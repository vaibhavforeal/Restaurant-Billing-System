import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freshApp, setupAdmin } from './test-helpers.js';
import type { FastifyInstance } from 'fastify';
import { CloudJournal } from './cloud-journal.js';
import { CloudSync } from './cloud-sync.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function fixture(transport: typeof fetch) {
  const app = freshApp(); await setupAdmin(app);
  const dir = mkdtempSync(join(tmpdir(), 'forkflow-cloud-test-'));
  const journal = new CloudJournal(app.db);
  const sync = new CloudSync(app, journal, { dataDir: dir, installationId: 'installation', generation: 'initial', fetch: transport, allowLoopback: true });
  cleanup.push(async () => { await sync.stop(); await app.close(); app.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { app, journal, sync, dir };
}
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
describe('outlet cloud synchronization', () => {
  it('retries the exact initial snapshot after an acknowledgement is lost while billing continues', async () => {
    const snapshots:unknown[]=[];let uploads=0;
    const transport=(async(url:string|URL|Request,init?:RequestInit)=>{
      const path=new URL(String(url)).pathname,data=init?.body?JSON.parse(String(init.body)):{};
      if(path.endsWith('/pair'))return response({outletId:'outlet',installationId:'installation',credential:'secret',epoch:'epoch'});
      if(path.endsWith('/bootstrap')){snapshots.push(data);if(snapshots.length===1)throw new Error('Lost response');return response({acknowledgedSequence:data.sequence});}
      if(path.endsWith('/push')){uploads++;return response({acknowledgedSequence:data.events.at(-1).sequence});}
      return response({commands:[]});
    })as typeof fetch;
    const {sync,app}=await fixture(transport);await sync.pair('http://127.0.0.1:4500','code');await sync.tick();
    app.db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run('c','During outage',0,1);
    await sync.tick();expect(snapshots).toHaveLength(2);expect(snapshots[1]).toEqual(snapshots[0]);expect(uploads).toBe(1);expect(sync.status().pendingUploads).toBe(0);
  });
  it('serializes pairing so a second request cannot overwrite the accepted identity', async () => {
    let release!: () => void;
    const wait=new Promise<void>(resolve=>{release=resolve;});
    const {sync,journal}=await fixture((async()=>{await wait;return response({outletId:'outlet',installationId:'installation',credential:'secret',epoch:'epoch'});}) as typeof fetch);
    const first=sync.pair('http://127.0.0.1:4500','first');
    await expect(sync.pair('http://127.0.0.1:4500','second')).rejects.toThrow('pairing');
    release();await first;expect(journal.state().outlet_id).toBe('outlet');
  });
  it('bootstraps once and keeps local writes available through upload failure and retry', async () => {
    let disconnected = false; const received: number[] = []; let bootstraps = 0;
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
      if (disconnected) throw new Error('Internet disconnected');
      const path = new URL(String(url)).pathname;
      const data = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/pair')) return response({ outletId: 'outlet', installationId: 'installation', credential: 'secret', epoch: 'epoch' });
      if (path.endsWith('/bootstrap')) { bootstraps++; return response({ acknowledgedSequence: data.sequence }); }
      if (path.endsWith('/push')) { received.push(...data.events.map((e: { sequence: number }) => e.sequence)); return response({ acknowledgedSequence: data.events.at(-1).sequence }); }
      return response({ commands: [] });
    }) as typeof fetch;
    const { app, journal, sync } = await fixture(transport);
    await sync.pair('http://127.0.0.1:4500', '123456'); await sync.tick();
    expect(sync.status().initialSyncComplete).toBe(true);
    disconnected = true;
    app.db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run('c', 'Meals', 0, 1);
    await sync.tick();
    expect(sync.status().state).toBe('offline'); expect(journal.pending()).toHaveLength(1);
    disconnected = false; await sync.tick();
    expect(sync.status().pendingUploads).toBe(0); expect(bootstraps).toBe(1); expect(received).toEqual([1]);
    expect(JSON.stringify(sync.status())).not.toContain('secret');
  });
  it('rejects an acknowledgement beyond the local sequence without dropping the outbox', async () => {
    const transport = (async (url: string | URL | Request) => String(url).endsWith('/pair')
      ? response({ outletId: 'outlet', installationId: 'installation', credential: 'secret', epoch: 'epoch' })
      : response({ acknowledgedSequence: 999 })) as typeof fetch;
    const { app, journal, sync } = await fixture(transport);
    await sync.pair('http://127.0.0.1:4500', '123456');
    app.db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run('c', 'Meals', 0, 1);
    await sync.tick();
    expect(sync.status().state).toBe('error'); expect(journal.pending()).toHaveLength(1);
  });
  it('requires HTTPS and refuses an identity belonging to a different installation', async () => {
    const { sync } = await fixture((async () => response({ outletId: 'outlet', installationId: 'other', credential: 'secret', epoch: 'epoch' })) as typeof fetch);
    await expect(sync.pair('http://example.com', '123456')).rejects.toThrow('HTTPS');
    await expect(sync.pair('http://127.0.0.1:4500', '123456')).rejects.toThrow('installation');
  });
});
