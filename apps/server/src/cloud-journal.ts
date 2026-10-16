import { randomUUID } from 'node:crypto';
import type { Database } from '@forkflow/domain';
import { Bootstrap, REPLICATED_TABLES, RecordChange, type SyncEnvelope } from '@forkflow/contracts';

type Column = { name: string; pk: number };
type State = { epoch: string; sequence: number; acknowledged: number; bootstrapped: number; outlet_id: string; installation_id: string };
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const keyText = (key: Record<string, string | number>) => JSON.stringify(Object.fromEntries(Object.entries(key).sort(([a], [b]) => a.localeCompare(b))));

/** SQLite triggers collect changes within their originating transaction. The wrapper seals
 * those changes into one envelope before COMMIT, including writes from existing handlers.
 * Nested savepoint rollback also rolls back captured changes. No network runs here. */
export class CloudJournal {
  private readonly prepare: Database['prepare'];
  private readonly execute: Database['exec'];
  private readonly transact: Database['transaction'];
  private readonly columns = new Map<string, Column[]>();
  constructor(readonly db: Database) {
    this.prepare = db.prepare.bind(db); this.execute = db.exec.bind(db); this.transact = db.transaction.bind(db);
    this.execute(`
      CREATE TABLE IF NOT EXISTS cloud_sync_state (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0, bootstrapped INTEGER NOT NULL DEFAULT 0,
        outlet_id TEXT NOT NULL DEFAULT 'unpaired', installation_id TEXT NOT NULL DEFAULT 'unpaired');
      CREATE TABLE IF NOT EXISTS cloud_changes (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, key_json TEXT NOT NULL, row_json TEXT);
      CREATE TABLE IF NOT EXISTS cloud_outbox (sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, occurred_at INTEGER NOT NULL, changes_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_entity_revision (entity TEXT NOT NULL, key_json TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(entity,key_json));
      CREATE TABLE IF NOT EXISTS cloud_command_results (id TEXT PRIMARY KEY, result_json TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cloud_feature_policy (id TEXT PRIMARY KEY, enabled TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_staff_policy (id TEXT PRIMARY KEY, overrides TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_audit (id TEXT PRIMARY KEY, actor TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, occurred_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS staff_roster (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outlet_meta (id INTEGER PRIMARY KEY CHECK(id=1), timezone TEXT NOT NULL);
      INSERT OR IGNORE INTO staff_roster SELECT id,name,role,is_active,created_at FROM users;
      CREATE TRIGGER IF NOT EXISTS ff_roster_insert AFTER INSERT ON users BEGIN
        INSERT INTO staff_roster VALUES (NEW.id,NEW.name,NEW.role,NEW.is_active,NEW.created_at); END;
      CREATE TRIGGER IF NOT EXISTS ff_roster_update AFTER UPDATE OF name,role,is_active ON users BEGIN
        UPDATE staff_roster SET name=NEW.name,role=NEW.role,is_active=NEW.is_active WHERE id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS ff_roster_delete AFTER DELETE ON users BEGIN DELETE FROM staff_roster WHERE id=OLD.id; END;
    `);
    this.prepare('INSERT OR IGNORE INTO cloud_sync_state (id,epoch) VALUES (1,?)').run(randomUUID());
    this.prepare('INSERT INTO outlet_meta VALUES (1,?) ON CONFLICT(id) DO UPDATE SET timezone=excluded.timezone').run(Intl.DateTimeFormat().resolvedOptions().timeZone);
    for (const table of REPLICATED_TABLES) {
      const cols = (this.prepare(`PRAGMA table_info(${quote(table)})`).all() as Column[]).filter(c => !['photo_data','printer_id','receipt_hash'].includes(c.name));
      if (!cols.length) continue;
      if (!cols.some(c => c.pk)) throw new Error(`Replicated table lacks a primary key: ${table}`);
      this.columns.set(table, cols);
      const key = (ref: string) => `json_object(${cols.filter(c => c.pk).map(c => `'${c.name}',${ref}.${quote(c.name)}`).join(',')})`;
      const row = (ref: string) => `json_object(${cols.map(c => `'${c.name}',${ref}.${quote(c.name)}`).join(',')})`;
      this.execute(`
        DROP TRIGGER IF EXISTS ff_cloud_${table}_insert;
        DROP TRIGGER IF EXISTS ff_cloud_${table}_update;
        DROP TRIGGER IF EXISTS ff_cloud_${table}_delete;
        CREATE TRIGGER IF NOT EXISTS ff_cloud_${table}_insert AFTER INSERT ON ${quote(table)} BEGIN
          INSERT INTO cloud_changes(entity,key_json,row_json) VALUES ('${table}',${key('NEW')},${row('NEW')}); END;
        CREATE TRIGGER IF NOT EXISTS ff_cloud_${table}_update AFTER UPDATE ON ${quote(table)} BEGIN
          INSERT INTO cloud_changes(entity,key_json,row_json) VALUES ('${table}',${key('OLD')},NULL);
          INSERT INTO cloud_changes(entity,key_json,row_json) VALUES ('${table}',${key('NEW')},${row('NEW')}); END;
        CREATE TRIGGER IF NOT EXISTS ff_cloud_${table}_delete AFTER DELETE ON ${quote(table)} BEGIN
          INSERT INTO cloud_changes(entity,key_json,row_json) VALUES ('${table}',${key('OLD')},NULL); END;
      `);
    }
    // Catch writes from tools that committed through the same database before attachment.
    this.transact(() => this.seal())();
    this.wrapDatabase();
  }

  state(): State { return this.prepare('SELECT * FROM cloud_sync_state WHERE id=1').get() as State; }
  bind(outletId: string, installationId: string, epoch: string) {
    const state = this.state();
    if (state.outlet_id !== 'unpaired' && (state.outlet_id !== outletId || state.installation_id !== installationId || state.epoch !== epoch)) throw new Error('Outlet is already paired; assisted retirement is required');
    this.prepare('UPDATE cloud_sync_state SET outlet_id=?,installation_id=?,epoch=? WHERE id=1').run(outletId, installationId, epoch);
  }
  revision(table: string, key: Record<string, string | number>): number {
    return (this.prepare('SELECT revision FROM cloud_entity_revision WHERE entity=? AND key_json=?').get(table, keyText(key)) as { revision: number } | undefined)?.revision ?? 0;
  }
  pending(limit = 100): SyncEnvelope[] {
    const state = this.state();
    const rows = this.prepare('SELECT * FROM cloud_outbox WHERE sequence>? ORDER BY sequence LIMIT ?').all(state.acknowledged, limit) as Array<{ sequence: number; event_id: string; occurred_at: number; changes_json: string }>;
    return rows.map(r => ({ protocolVersion: 1, outletId: state.outlet_id, installationId: state.installation_id, epoch: state.epoch, sequence: r.sequence, eventId: r.event_id, occurredAt: r.occurred_at, changes: JSON.parse(r.changes_json) as RecordChange[] }));
  }
  acknowledge(sequence: number, bootstrap = false) {
    const state = this.state();
    if (!Number.isSafeInteger(sequence) || sequence > state.sequence || sequence < state.acknowledged) throw new Error('Cloud acknowledgement is outside the local journal');
    this.prepare('UPDATE cloud_sync_state SET acknowledged=?, bootstrapped=MAX(bootstrapped,?) WHERE id=1').run(sequence, bootstrap ? 1 : 0);
  }
  snapshot(): Bootstrap {
    return this.transact(() => {
      const state = this.state(); const records: RecordChange[] = [];
      for (const [table, cols] of this.columns) {
        for (const row of this.prepare(`SELECT ${cols.map(c => quote(c.name)).join(',')} FROM ${quote(table)}`).all() as Record<string, unknown>[]) {
          const key = Object.fromEntries(cols.filter(c => c.pk).map(c => [c.name, row[c.name]])) as Record<string, string | number>;
          records.push(RecordChange.parse({ table, key, row, revision: this.revision(table, key) }));
        }
      }
      return Bootstrap.parse({ protocolVersion: 1, outletId: state.outlet_id, installationId: state.installation_id, epoch: state.epoch, sequence: state.sequence, records });
    })();
  }
  private seal() {
    const captured = this.prepare('SELECT entity,key_json,row_json FROM cloud_changes ORDER BY ordinal').all() as Array<{ entity: string; key_json: string; row_json: string | null }>;
    if (!captured.length) return;
    const changed = new Map<string, RecordChange>();
    for (const entry of captured) {
      const key = JSON.parse(entry.key_json) as Record<string, string | number>;
      const change = RecordChange.parse({ table: entry.entity, key, row: entry.row_json === null ? null : JSON.parse(entry.row_json) });
      changed.set(`${entry.entity}:${keyText(key)}`, change);
    }
    const sequence = this.state().sequence + 1;
    this.prepare('INSERT INTO cloud_outbox VALUES (?,?,?,?)').run(sequence, randomUUID(), Date.now(), JSON.stringify([...changed.values()]));
    for (const change of changed.values()) this.prepare('INSERT INTO cloud_entity_revision VALUES (?,?,?) ON CONFLICT(entity,key_json) DO UPDATE SET revision=excluded.revision').run(change.table, keyText(change.key), sequence);
    this.prepare('UPDATE cloud_sync_state SET sequence=? WHERE id=1').run(sequence);
    this.prepare('DELETE FROM cloud_changes').run();
  }
  private wrapDatabase() {
    const journal = this;
    const within = <T>(action: () => T): T => {
      if (journal.db.inTransaction) return action();
      return journal.transact(() => { const result = action(); journal.seal(); return result; })();
    };
    this.db.prepare = ((...args: Parameters<Database['prepare']>) => {
      const statement = journal.prepare(...args);
      // VACUUM INTO creates a consistent backup and SQLite forbids it in a transaction.
      if (/^\s*VACUUM\b/i.test(statement.source)) return statement;
      const run = statement.run.bind(statement);
      statement.run = (...params: unknown[]) => within(() => run(...params));
      if (!statement.readonly) {
        const get = statement.get.bind(statement), all = statement.all.bind(statement);
        statement.get = (...params: unknown[]) => within(() => get(...params));
        statement.all = (...params: unknown[]) => within(() => all(...params));
        statement.iterate = function* (...params: unknown[]) { yield* within(() => all(...params)); };
      }
      return statement;
    }) as Database['prepare'];
    this.db.exec = (sql: string) => within(() => journal.execute(sql));
    this.db.transaction = ((fn: (...args: unknown[]) => unknown) => {
      const mode = (kind: 'deferred' | 'immediate' | 'exclusive') => function (this: unknown, ...args: unknown[]) {
        const outermost = !journal.db.inTransaction;
        return journal.transact(() => {
          const value = fn.apply(this, args);
          if (value && typeof (value as { then?: unknown }).then === 'function') throw new Error('SQLite transactions must be synchronous');
          if (outermost) journal.seal(); return value;
        })[kind]();
      };
      const wrapped = mode('deferred');
      return Object.assign(wrapped, { default: wrapped, deferred: wrapped, immediate: mode('immediate'), exclusive: mode('exclusive') });
    }) as Database['transaction'];
  }
}
