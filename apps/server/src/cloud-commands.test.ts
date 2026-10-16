import { afterEach, describe, expect, it } from 'vitest';
import { freshApp, setupAdmin } from './test-helpers.js';
import type { FastifyInstance } from 'fastify';
import { CloudJournal } from './cloud-journal.js';
import { applyCommand } from './cloud-commands.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) { await app.close(); if (app.db.open) app.db.close(); } });
async function fixture() {
  const app = freshApp(); apps.push(app); await setupAdmin(app);
  const journal = new CloudJournal(app.db); journal.bind('outlet','installation','epoch');
  return { app, journal };
}
describe('remote management commands', () => {
  it('rejects a misleading target for singleton configuration', async () => {
    const { app, journal }=await fixture();
    expect(()=>applyCommand(app,journal,{id:'bypass',kind:'features.update',targetId:'other',expectedRevision:0,payload:{enabled:{kds:true}},requestedBy:'owner',createdAt:1})).toThrow();
  });
  it('uses cloud owner policy after pairing and preserves entitlement checks', async () => {
    const { app, journal } = await fixture();
    const result = applyCommand(app, journal, { id: 'policy', kind: 'features.update', targetId: 'policy', expectedRevision: 0, payload: { enabled: { kds: true } }, requestedBy: 'owner', createdAt: 1 });
    expect(result.status).toBe('applied');
    expect(app.licensing.featurePolicy()?.enabled['kds']).toBe(true);
  });
  it('applies a settings update exactly once and keeps result and journal in one commit', async () => {
    const { app, journal } = await fixture();
    const command = { id: 'command-1', kind: 'settings.update' as const, targetId: '1', expectedRevision: 0, payload: { restaurantName: 'Remote Cafe' }, requestedBy: 'owner-1', createdAt: 1 };
    const result = applyCommand(app, journal, command);
    expect(result.status).toBe('applied');
    expect(app.db.prepare('SELECT restaurant_name FROM settings').get()).toEqual({ restaurant_name: 'Remote Cafe' });
    const sequence = journal.state().sequence;
    expect(applyCommand(app, journal, command)).toEqual(result);
    expect(journal.state().sequence).toBe(sequence);
    expect(journal.pending()[0]!.changes.some(c => c.table === 'settings')).toBe(true);
  });
  it('rejects stale edits after a local change without overwriting the local menu', async () => {
    const { app, journal } = await fixture();
    app.db.prepare('UPDATE settings SET restaurant_name=?').run('Local Cafe');
    const result = applyCommand(app, journal, { id: 'stale', kind: 'settings.update', targetId: '1', expectedRevision: 0, payload: { restaurantName: 'Stale' }, requestedBy: 'owner', createdAt: 1 });
    expect(result.status).toBe('conflict');
    expect(app.db.prepare('SELECT restaurant_name FROM settings').get()).toEqual({ restaurant_name: 'Local Cafe' });
  });
  it('uses local validation and does not accept unknown catalog references', async () => {
    const { app, journal } = await fixture();
    const result = applyCommand(app, journal, { id: 'invalid', kind: 'product.update', targetId: 'missing', expectedRevision: 0, payload: { name: 'Dish' }, requestedBy: 'owner', createdAt: 1 });
    expect(result.status).toBe('rejected');
    expect(app.db.prepare('SELECT * FROM products').all()).toEqual([]);
  });
});
