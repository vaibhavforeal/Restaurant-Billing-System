import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeUpdate } from './update.mjs';

function actions(events, failAt) {
  return {
    stop: async () => { events.push('stop'); },
    configure: async (version, probe) => { events.push(`configure:${version}:${probe}`); },
    start: async () => { events.push('start'); },
    health: async (version) => { events.push(`health:${version}`); if (failAt === version) throw Error('health failed'); },
    restore: async (runtime, backup) => { events.push(`restore:${runtime}:${backup}`); },
    installed: async version => { events.push(`installed:${version}`); },
    save: async journal => { events.push(`journal:${journal.phase}`); },
    clear: async () => { events.push('clear'); },
  };
}
const prepared = () => ({ phase: 'prepared', oldVersion: '0.7.0', newVersion: '0.8.0', backup: 'snapshot.db' });
test('accepts no customer writes until probe passes and commits before enabling traffic', async () => {
  const events = [];
  await completeUpdate(prepared(), actions(events));
  assert.deepEqual(events, ['stop', 'configure:0.8.0:true', 'journal:probe', 'start', 'health:0.8.0', 'stop', 'journal:committed', 'configure:0.8.0:false', 'installed:0.8.0', 'start', 'health:0.8.0', 'clear']);
});
test('restores pre-update database using new runtime before restarting old version', async () => {
  const events = [];
  await assert.rejects(completeUpdate(prepared(), actions(events, '0.8.0')), /rolled back/);
  assert.ok(events.indexOf('restore:0.8.0:snapshot.db') > events.indexOf('health:0.8.0'));
  assert.ok(events.indexOf('configure:0.7.0:false') > events.indexOf('restore:0.8.0:snapshot.db'));
  assert.equal(events.at(-1), 'clear');
});
test('after commit, startup failure preserves migrated DB and recoverable journal', async () => {
  const events = [], journal = { ...prepared(), phase: 'committed' };
  await assert.rejects(completeUpdate(journal, actions(events, '0.8.0')), /health failed/);
  assert.equal(events.some(e => e.startsWith('restore:')), false);
  assert.equal(events.includes('clear'), false);
});
test('resuming interrupted probe rolls back conservatively and does not repeat a completed restore', async () => {
  const events = [];
  await completeUpdate({ ...prepared(), phase: 'probe' }, actions(events), { resume: true });
  assert.ok(events.includes('restore:0.8.0:snapshot.db'));
  const recovered = [];
  await completeUpdate({ ...prepared(), phase: 'rolled-back' }, actions(recovered), { resume: true });
  assert.equal(recovered.some(e => e.startsWith('restore:')), false);
});
