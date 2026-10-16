import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { probeHealth } from './health.mjs';
async function fixture(t, result, status = 200) {
  const server = createServer((_req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/health`;
}
test('checks actual HTTP version, identity and probe state', async t => {
  const address = await fixture(t, { ok: true, version: '0.8.0', maintenance: true });
  assert.equal((await probeHealth(address, '0.8.0')).maintenance, true);
  await assert.rejects(probeHealth(address, '0.7.0'), /version/);
});
test('refuses nonhealthy responses even when a process owns the expected port', async t => {
  const address = await fixture(t, { ok: false, version: '0.8.0' });
  await assert.rejects(probeHealth(address, '0.8.0'), /healthy/);
  const unavailable = await fixture(t, { ok: true, version: '0.8.0' }, 503);
  await assert.rejects(probeHealth(unavailable, '0.8.0'), /HTTP 503/);
});
