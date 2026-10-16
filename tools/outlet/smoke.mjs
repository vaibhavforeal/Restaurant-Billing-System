import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildOutlet } from './build.mjs';
import { sha256, verifyRelease } from './release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temp = mkdtempSync(join(tmpdir(), 'forkflow-outlet-smoke-'));
try {
  const keys = generateKeyPairSync('ed25519');
  writeFileSync(join(temp, 'signing.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(join(temp, 'license-public.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(join(temp, 'WinSW.fixture.exe'), 'NONEXECUTABLE fixture: no Windows service install is tested');
  const stage = await buildOutlet({ runtime: process.execPath, runtimeSha256: sha256(readFileSync(process.execPath)), winsw: join(temp, 'WinSW.fixture.exe'), winswSha256: sha256(readFileSync(join(temp, 'WinSW.fixture.exe'))), winswVersion: '2.12.0', output: `build/outlet/smoke-${Date.now()}`, version: '0.7.0', minSchema: 1, signingKeyFile: join(temp, 'signing.pem'), licensePublicKeyFile: join(temp, 'license-public.pem') });
  const data = join(temp, 'data'), migrated = join(temp, 'migrated');
  mkdirSync(data); mkdirSync(migrated);
  // Only local generated fixtures; no live restaurant data, ports, cert stores or SCM operations.
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', 'import {openDb,migrate,MIGRATIONS} from "@forkflow/domain"; import {join} from "node:path";const db=openDb(join(process.argv[1],"forkflow.db"));migrate(db,MIGRATIONS);db.close();', data], { cwd: root, windowsHide: true });
  const run = (...args) => JSON.parse(execFileSync(join(stage, 'node.exe'), [join(stage, 'maintenance.mjs'), ...args], { encoding: 'utf8', windowsHide: true }));
  const before = run('status', data), snapshot = run('backup', data);
  if (!snapshot.backup || before.schema !== snapshot.schema) throw new Error('Packaged backup/schema check failed');
  run('restore', data, join(data, 'backups', snapshot.backup));
  run('migrate-data', data, migrated);
  if (run('status', migrated).schema !== before.schema) throw new Error('Packaged full-store migration failed');
  verifyRelease(stage, keys.publicKey);
  console.log(`Isolated signed bundle and packaged status/backup/restore/migrate PASS: ${stage}`);
  console.log('WinSW is a NONEXECUTABLE test fixture; clean Windows install/boot/hardware acceptance is pending.');
} finally {
  // Resolved, explicitly created private temporary directory only.
  if (!resolve(temp).startsWith(resolve(tmpdir()) + '\\')) throw new Error('Unsafe smoke cleanup target');
  rmSync(temp, { recursive: true, force: true });
}
