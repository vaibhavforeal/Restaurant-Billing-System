import { createHash, verify, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const windowsReserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
export function safePayloadPath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /[\x00-\x1f<>"|?*]/.test(p) || windowsReserved.test(p))) throw new Error(`Unsafe payload path: ${name}`);
  return name;
}
export function payloadFiles(folder, prefix = '') {
  const files = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const name = prefix + entry.name;
    safePayloadPath(name);
    const stat = lstatSync(join(folder, entry.name));
    if (stat.isSymbolicLink()) throw new Error(`Unsafe payload path (link): ${name}`);
    if (stat.isDirectory()) files.push(...payloadFiles(join(folder, entry.name), name + '/'));
    else if (stat.isFile()) files.push(name);
    else throw new Error(`Unsafe payload path (special file): ${name}`);
  }
  return files.sort();
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function versionParts(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must be stable major.minor.patch');
  const parts = version.split('.').map(Number);
  if (parts.some(p => !Number.isSafeInteger(p))) throw new Error('Invalid release version');
  return parts;
}
function isNewer(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
export function verifyRelease(folder, publicKey, compatibility = {}) {
  for (const name of ['release.json', 'release.sig']) if (!lstatSync(join(folder, name)).isFile() || lstatSync(join(folder, name)).isSymbolicLink()) throw new Error('Invalid release signature metadata path');
  const bytes = readFileSync(join(folder, 'release.json'));
  const signature = readFileSync(join(folder, 'release.sig'), 'utf8').trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || !verify(null, bytes, publicKey, Buffer.from(signature, 'base64'))) throw new Error('Release signature verification failed');
  const manifest = JSON.parse(bytes);
  if (manifest.format !== 1 || manifest.product !== 'forkflow-outlet' || manifest.platform !== 'win32-x64' || !/^24\.\d+\.\d+$/.test(manifest.runtime)) throw new Error('Unsupported outlet release format/platform/runtime');
  versionParts(manifest.version);
  if (!Number.isInteger(manifest.schema) || !Number.isInteger(manifest.minSchema) || manifest.minSchema < 0 || manifest.schema < manifest.minSchema) throw new Error('Invalid release schema range');
  if (compatibility.currentVersion && !isNewer(manifest.version, compatibility.currentVersion)) throw new Error('Update must be newer than installed version');
  if (compatibility.schema !== undefined && (compatibility.schema > manifest.schema || compatibility.schema < manifest.minSchema)) throw new Error('Release schema is incompatible with outlet database');
  if (!manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object' || !Object.keys(manifest.files).length) throw new Error('Missing release payload');
  const expected = new Set(['release.json', 'release.sig']);
  const caseNames = new Set(['release.json', 'release.sig']);
  for (const [name, checksum] of Object.entries(manifest.files)) {
    safePayloadPath(name);
    if (expected.has(name) || caseNames.has(name.toLowerCase())) throw new Error(`Duplicate payload path: ${name}`);
    caseNames.add(name.toLowerCase()); expected.add(name);
    if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`Invalid checksum for ${name}`);
  }
  const actual = payloadFiles(folder);
  for (const name of actual) if (!expected.has(name)) throw new Error(`Release contains unlisted payload: ${name}`);
  for (const [name, checksum] of Object.entries(manifest.files)) {
    if (!actual.includes(name)) throw new Error(`Missing payload path: ${name}`);
    if (sha256(readFileSync(join(folder, name))) !== checksum) throw new Error(`Release checksum mismatch: ${name}`);
  }
  return manifest;
}
export function stageRelease(source, target, publicKey, compatibility = {}) {
  const manifest = verifyRelease(source, publicKey, compatibility);
  const rel = relative(resolve(source), resolve(target));
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Staging path must be outside source release');
  if (existsSync(target)) throw new Error('Staging target already exists');
  const temporary = `${resolve(target)}.${randomUUID()}.partial`;
  mkdirSync(temporary, { recursive: true });
  try {
    for (const name of [...Object.keys(manifest.files), 'release.json', 'release.sig']) {
      const destination = join(temporary, name);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      writeFileSync(destination, readFileSync(join(source, name)), { flag: 'wx' });
    }
    // Validate the copied bytes too: a source changed during the copy cannot be activated.
    verifyRelease(temporary, publicKey, compatibility);
    renameSync(temporary, target);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, source, keyPath, target, compatibilityPath] = process.argv.slice(2);
  if (!['verify', 'stage'].includes(command) || !source || !keyPath || (command === 'stage' && !target)) throw new Error('Usage: release.mjs verify|stage <release-dir> <trusted-public-key> [target-dir] [compatibility.json]');
  const compatibility = compatibilityPath ? JSON.parse(readFileSync(compatibilityPath, 'utf8').replace(/^\uFEFF/, '')) : {};
  const result = command === 'verify' ? verifyRelease(source, readFileSync(keyPath), compatibility) : stageRelease(source, target, readFileSync(keyPath), compatibility);
  console.log(JSON.stringify(result));
}
