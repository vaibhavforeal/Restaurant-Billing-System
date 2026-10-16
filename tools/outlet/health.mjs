import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { X509Certificate } from 'node:crypto';

export function probeHealth(address, version, options = {}) {
  return new Promise((done, reject) => {
    const url = new URL(address), client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, { ...(options.ca ? { ca: options.ca } : {}), rejectUnauthorized: true, timeout: 2500 }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Health HTTP ${response.statusCode}`)); return; }
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 16384) request.destroy(new Error('Oversized health response')); });
      response.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.ok !== true) throw new Error('Outlet is not healthy');
          if (result.version !== version) throw new Error('Outlet health version differs from expected release');
          if (options.generation && result.generation !== options.generation) throw new Error('Health outlet generation mismatch');
          if (options.identity && result.outletIdentity !== options.identity) throw new Error('Health outlet identity mismatch');
          done(result);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Health timeout')));
    request.on('error', reject);
  });
}
export async function waitOutletHealth(dataDirectory, version, { timeoutMs = 45_000, delayMs = 500 } = {}) {
  const config = JSON.parse(readFileSync(resolve(dataDirectory, 'captain-https.json'), 'utf8').replace(/^\uFEFF/, ''));
  const certPath = resolve(dataDirectory, config.caFile), rel = relative(resolve(dataDirectory), certPath);
  if (isAbsolute(config.caFile) || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Health CA path must stay in data directory');
  const ca = new X509Certificate(readFileSync(certPath)).toString();
  const deadline = Date.now() + timeoutMs;
  let error;
  do {
    try {
      const local = await probeHealth('http://127.0.0.1:4100/api/health', version);
      const secure = await probeHealth('https://127.0.0.1:4443/api/health', version, { ca, generation: local.generation, identity: local.outletIdentity });
      if (local.maintenance !== secure.maintenance) throw new Error('Health transport state differs');
      return secure;
    } catch (failure) { error = failure; }
    await new Promise(done => setTimeout(done, delayMs));
  } while (Date.now() < deadline);
  throw new Error(`Outlet health checks failed: ${String(error)}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: health.mjs <data-dir> <expected-version>');
  console.log(JSON.stringify(await waitOutletHealth(process.argv[2], process.argv[3])));
}
