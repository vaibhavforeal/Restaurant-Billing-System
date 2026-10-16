import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { decryptBackup, encryptBackup, retainedBackups } from './cloud-backup-crypto.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it('round trips an encrypted backup with outlet context and rejects altered bytes or identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-encrypt-')); dirs.push(dir);
  const source = join(dir,'source.db'), encrypted = join(dir,'encrypted.ffbk'), restored = join(dir,'restored.db');
  writeFileSync(source, 'private restaurant records'); const key = randomBytes(32);
  const context = { outletId: 'outlet', installationId: 'installation', epoch: 'epoch', sequence: 42 };
  const manifest = await encryptBackup(source, encrypted, key, context);
  expect(readFileSync(encrypted).includes(Buffer.from('private restaurant records'))).toBe(false);
  await decryptBackup(encrypted, restored, key, manifest);
  expect(readFileSync(restored,'utf8')).toBe('private restaurant records');
  await expect(decryptBackup(encrypted, join(dir,'wrong.db'), randomBytes(32), manifest)).rejects.toThrow();
  await expect(decryptBackup(encrypted, join(dir,'other.db'), key, { ...manifest, outletId: 'different' })).rejects.toThrow();
  const bytes = readFileSync(encrypted); bytes[20] = bytes[20]! ^ 1; writeFileSync(encrypted, bytes);
  await expect(decryptBackup(encrypted, join(dir,'altered.db'), key, manifest)).rejects.toThrow();
});
it('retains the latest 48 hourly snapshots plus one per day for 30 days', () => {
  const now=Date.UTC(2026,9,12,12); const rows=Array.from({length:1000},(_,i)=>({id:String(i),createdAt:now-i*3_600_000}));
  const keep=retainedBackups(rows,now);
  for(let i=0;i<48;i++) expect(keep.has(String(i))).toBe(true);
  expect(keep.has('999')).toBe(false);
  expect(keep.size).toBeGreaterThan(48); expect(keep.size).toBeLessThanOrEqual(78);
});
