import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBuildOptions, serviceXml } from './build.mjs';

test('requires externally pinned runtime and service wrapper artifacts', () => {
  assert.throws(() => validateBuildOptions({}), /runtime/);
  assert.throws(() => validateBuildOptions({ runtime: 'node.exe', runtimeSha256: 'bad' }), /SHA-256/);
  assert.throws(() => validateBuildOptions({ runtime: 'node.exe', runtimeSha256: 'a'.repeat(64), winsw: 'winsw.exe', winswSha256: 'b'.repeat(64), output: '../unsafe' }), /output/);
});
test('service runs at boot as virtual account with loopback HTTP, restart and bounded logs', () => {
  const xml = serviceXml('C:\\Program Files\\ForkFlow\\Outlet\\releases\\0.8.0', 'C:\\ProgramData\\ForkFlow\\Outlet', '0.8.0');
  assert.match(xml, /<domain>NT SERVICE<\/domain><user>ForkFlowOutlet<\/user>/);
  assert.match(xml, /<startmode>Automatic<\/startmode>/);
  assert.match(xml, /name="FORKFLOW_HOST" value="127.0.0.1"/);
  assert.match(xml, /action="restart"/);
  assert.match(xml, /<log mode="roll-by-size">/);
  assert.match(xml, /<sizeThreshold>10240/);
  assert.match(xml, /Program Files\\ForkFlow/);
  assert.match(xml, /server\\main.mjs/);
});
test('escapes XML attribute and path values', () => {
  const xml = serviceXml('C:\\A & B', 'C:\\data', '0.8.0');
  assert.match(xml, /A &amp; B/);
});
