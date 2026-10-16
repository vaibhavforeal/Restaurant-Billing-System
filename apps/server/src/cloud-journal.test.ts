import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, openDb, type Database } from '@forkflow/domain';
import { CloudJournal } from './cloud-journal.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backups } from './backups.js';

const databases: Database[] = [];
function fixture() {
  const db = openDb(':memory:'); databases.push(db); migrate(db, MIGRATIONS);
  const journal = new CloudJournal(db);
  return { db, journal };
}
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });
describe('transactional cloud journal', () => {
  it('allows verified SQLite backups outside write transactions', () => {
    const { db } = fixture(); const dir = mkdtempSync(join(tmpdir(), 'ff-journal-backup-'));
    try { expect(new Backups(db, dir).create('manual').name).toMatch(/\.db$/); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps successful nested transactions in their outer envelope and journals RETURNING writes', () => {
    const { db, journal } = fixture();
    db.transaction(() => {
      db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run('a', 'Good', 0, 1);
      db.transaction(() => db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run('b', 'Also good', 0, 1))();
      db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run('c', 'After inner', 0, 1);
    }).immediate();
    expect(journal.pending()).toHaveLength(1);
    expect(journal.pending()[0]!.changes).toHaveLength(3);
    db.prepare('UPDATE categories SET name=? WHERE id=? RETURNING name').get('New', 'a');
    expect(journal.pending()).toHaveLength(2);
    expect(journal.pending()[1]!.changes[0]!.row!['name']).toBe('New');
  });
  it('commits changes and one ordered envelope atomically for a multi-row transaction', () => {
    const { db, journal } = fixture();
    db.transaction(() => {
      db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run('c', 'Meals', 0, 1);
      db.prepare('UPDATE settings SET restaurant_name=? WHERE id=1').run('Cafe');
    })();
    const events = journal.pending();
    expect(events).toHaveLength(1);
    expect(events[0]!.sequence).toBe(1);
    expect(events[0]!.changes.map(c => c.table).sort()).toEqual(['categories', 'settings']);
    expect(journal.revision('categories', { id: 'c' })).toBe(1);
  });
  it('rolls back the business write and outbox when a transaction fails', () => {
    const { db, journal } = fixture();
    expect(() => db.transaction(() => {
      db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run('c', 'Meals', 0, 1);
      throw new Error('interrupted');
    })()).toThrow('interrupted');
    expect(db.prepare('SELECT * FROM categories').all()).toEqual([]);
    expect(journal.pending()).toEqual([]);
  });
  it('keeps nested rollback changes out of the committed event and captures standalone writes', () => {
    const { db, journal } = fixture();
    db.transaction(() => {
      db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run('a', 'Good', 0, 1);
      try { db.transaction(() => { db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run('b', 'Rolled back', 0, 1); throw new Error('rollback'); })(); } catch { /* outer transaction continues */ }
    })();
    db.prepare('UPDATE categories SET name=? WHERE id=?').run('Updated', 'a');
    expect(journal.pending()).toHaveLength(2);
    expect(journal.pending()[0]!.changes).toHaveLength(1);
    expect(journal.pending()[1]!.changes[0]!.row!['name']).toBe('Updated');
  });
  it('captures roster attribution without PINs and excludes sessions and printer credentials', () => {
    const { db, journal } = fixture();
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run('u','Asha','sensitive-pin-hash','admin',1,1);
    const snapshot = journal.snapshot();
    expect(snapshot.records.find(c => c.table === 'staff_roster')!.row!['name']).toBe('Asha');
    expect(JSON.stringify(snapshot)).not.toContain('sensitive-pin-hash');
    expect(snapshot.records.some(c => ['users','sessions','printers'].includes(c.table))).toBe(false);
  });
  it('preserves tombstones and refuses acknowledgement past the local watermark', () => {
    const { db, journal } = fixture();
    db.prepare('INSERT INTO categories VALUES (?,?,?,?)').run('c', 'Meals', 0, 1);
    db.prepare('DELETE FROM categories WHERE id=?').run('c');
    expect(journal.pending()[1]!.changes[0]).toMatchObject({ table: 'categories', key: { id: 'c' }, row: null });
    expect(() => journal.acknowledge(99)).toThrow();
    journal.acknowledge(1);
    expect(journal.pending().map(e => e.sequence)).toEqual([2]);
  });
});
