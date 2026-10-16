import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyRelease, stageRelease } from './release.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
function fixture(t, override = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'forkflow-release-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, 'node.exe'), 'fixture runtime');
  const manifest = { format: 1, product: 'forkflow-outlet', version: '0.8.0', runtime: '24.19.0', platform: 'win32-x64', schema: 21, minSchema: 1,
    files: { 'node.exe': createHash('sha256').update('fixture runtime').digest('hex') }, ...override };
  const bytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(folder, 'release.json'), bytes); writeFileSync(join(folder, 'release.sig'), sign(null, bytes, keys.privateKey).toString('base64'));
  return folder;
}
test('authenticates manifest and every payload byte before staging', (t) => {
  const folder = fixture(t), target = join(folder, '..', `${folder.split(/[\\/]/).at(-1)}-stage`);
  t.after(() => rmSync(target, { recursive: true, force: true }));
  assert.equal(verifyRelease(folder, publicKey, { currentVersion: '0.7.0', schema: 20 }).version, '0.8.0');
  stageRelease(folder, target, publicKey, { currentVersion: '0.7.0', schema: 20 });
  assert.equal(readFileSync(join(target, 'node.exe'), 'utf8'), 'fixture runtime');
  writeFileSync(join(folder, 'node.exe'), 'tampered runtime');
  assert.throws(() => verifyRelease(folder, publicKey), /checksum/);
});
test('refuses a substituted signer and unsigned manifests', (t) => {
  const folder = fixture(t), other = generateKeyPairSync('ed25519');
  assert.throws(() => verifyRelease(folder, other.publicKey), /signature/);
  writeFileSync(join(folder, 'release.json'), '{}');
  assert.throws(() => verifyRelease(folder, publicKey), /signature/);
});
test('rejects rollback, incompatible schema and extra payload files', (t) => {
  const folder = fixture(t);
  assert.throws(() => verifyRelease(folder, publicKey, { currentVersion: '0.9.0' }), /newer/);
  assert.throws(() => verifyRelease(folder, publicKey, { schema: 22 }), /schema/);
  assert.throws(() => verifyRelease(folder, publicKey, { schema: 0 }), /schema/);
  writeFileSync(join(folder, 'unexpected.dll'), 'injection');
  assert.throws(() => verifyRelease(folder, publicKey), /unlisted/);
});
test('rejects unsafe Windows payload paths before reading them', (t) => {
  for (const name of ['../outside', 'C:/outside', 'server/a:stream', 'CON', 'a/../node.exe', 'a\\b', 'a.', 'a ']) {
    const folder = fixture(t, { files: { [name]: 'a'.repeat(64) } });
    assert.throws(() => verifyRelease(folder, publicKey), /path/);
  }
});
test('does not create a staging directory for a damaged release', (t) => {
  const folder = fixture(t), target = join(folder, 'stage');
  writeFileSync(join(folder, 'node.exe'), 'bad');
  assert.throws(() => stageRelease(folder, target, publicKey), /checksum/);
  assert.equal(existsSync(target), false);
});
