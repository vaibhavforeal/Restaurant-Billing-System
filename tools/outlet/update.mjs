import { readFileSync, writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

/** Journal commits before normal traffic is enabled; recovery never rewinds an accepted write. */
export async function completeUpdate(journal, actions, { resume = false } = {}) {
  if (!['prepared', 'probe', 'rollback-needed', 'rolled-back', 'committed'].includes(journal.phase)) throw new Error('Invalid update journal phase');
  const save = async phase => { journal.phase = phase; await actions.save({ ...journal }); };
  const rollback = async () => {
    await actions.stop();
    if (journal.phase !== 'rolled-back') {
      await save('rollback-needed');
      await actions.restore(journal.newVersion, journal.backup);
      await save('rolled-back');
    }
    await actions.configure(journal.oldVersion, false);
    await actions.installed(journal.oldVersion);
    await actions.start();
    await actions.health(journal.oldVersion);
    await actions.clear();
  };
  if (journal.phase === 'rollback-needed' || journal.phase === 'rolled-back' || (resume && journal.phase !== 'committed')) { await rollback(); return; }
  if (journal.phase !== 'committed') {
    try {
      await actions.stop();
      await actions.configure(journal.newVersion, true);
      await save('probe');
      await actions.start();
      await actions.health(journal.newVersion);
      await actions.stop();
      await save('committed');
    } catch (error) {
      if (journal.phase === 'committed') throw error;
      try { await rollback(); } catch (recoveryError) { throw new Error(`Update failed; recovery requires operator action: ${String(recoveryError)}`, { cause: error }); }
      throw new Error('Update failed and was rolled back to the verified snapshot', { cause: error });
    }
  }
  // From this durable boundary, automatic database restore is forbidden.
  await actions.configure(journal.newVersion, false);
  await actions.installed(journal.newVersion);
  await actions.start();
  await actions.health(journal.newVersion);
  await actions.clear();
}
function atomicJson(path, value) {
  const temp = path + '.tmp'; writeFileSync(temp, JSON.stringify(value));
  const fd = openSync(temp, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [installationDirectory, actionScript, mode] = process.argv.slice(2);
  if (!installationDirectory || !actionScript || !['run', 'resume'].includes(mode)) throw new Error('Usage: update.mjs <installation-dir> <trusted-action-script> run|resume');
  const journalPath = join(installationDirectory, 'update-pending.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8').replace(/^\uFEFF/, ''));
  const ps = (action, version = '', backup = '', probe = false) => execFileSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-File', actionScript, '-Action', action, ...(version ? ['-Version', version] : []), ...(backup ? ['-Backup', backup] : []), ...(probe ? ['-Probe'] : [])], { stdio: 'inherit', windowsHide: true,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath')), PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } });
  await completeUpdate(journal, {
    stop: async () => ps('stop'), configure: async (version, probe) => ps('configure', version, '', probe), start: async () => ps('start'),
    health: async version => ps('health', version), restore: async (version, backup) => ps('restore', version, backup),
    installed: async version => atomicJson(join(installationDirectory, 'installed.json'), { version, installedAt: new Date().toISOString() }),
    save: async value => atomicJson(journalPath, value), clear: async () => unlinkSync(journalPath),
  }, { resume: mode === 'resume' });
}
