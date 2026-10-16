import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** The cashier worker owns a release shell, never API responses or mutation queues. */
export function posWorker(version: string, assets: string[]): string {
  return `
const CACHE = ${JSON.stringify(`forkflow-pos-${version}`)};
const ASSETS = ${JSON.stringify(assets)};
const STATIC = new Set(ASSETS);
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(['/', ...ASSETS].map(async url => {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!response.ok || response.redirected) throw new Error('Cashier shell download failed');
      await cache.put(url, response);
    }));
  })());
  // Intentionally no skipWaiting: an active till remains on its current release.
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('forkflow-pos-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) return;
  if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith((async () => {
      const shell = await (await caches.open(CACHE)).match('/');
      if (shell) return shell;
      try { return await fetch(request, { signal: AbortSignal.timeout(4000) }); }
      catch { return new Response('Reconnect to the restaurant network and reopen ForkFlow.', { status: 503, headers: { 'Content-Type': 'text/plain' } }); }
    })());
  } else if (STATIC.has(url.pathname) && !url.search) {
    event.respondWith((async () => await (await caches.open(CACHE)).match(url.pathname) || fetch(request))());
  }
});`;
}
export function posPwa(): Plugin {
  let publicDir = "";
  return { name: "forkflow-pos-pwa", apply: "build", enforce: "post",
    configResolved(config) { publicDir = config.publicDir; },
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter(file => /\.(js|css)$/.test(file) && !file.endsWith("sw.js")).map(file => `/${file}`).sort();
      const manifest = JSON.stringify({ id: "/", name: "ForkFlow POS", short_name: "ForkFlow", start_url: "/", scope: "/", display: "standalone", background_color: "#f6f7f9", theme_color: "#d12d3b", icons: [192, 512].map(size => ({ src: `/pos/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png" })) });
      const hash = createHash("sha256").update(manifest).update(posWorker("version", assets));
      for (const file of Object.keys(bundle).sort()) { const output = bundle[file]!; hash.update(file).update(output.type === "chunk" ? output.code : output.source); }
      this.emitFile({ type: "asset", fileName: "pos/manifest.webmanifest", source: manifest });
      for (const size of [192, 512]) { const source = readFileSync(resolve(publicDir, "captain", `icon-${size}.png`)); hash.update(source); this.emitFile({ type: "asset", fileName: `pos/icon-${size}.png`, source }); }
      this.emitFile({ type: "asset", fileName: "pos-sw.js", source: posWorker(hash.digest("hex").slice(0, 16), [...assets, "/pos/manifest.webmanifest", "/pos/icon-192.png", "/pos/icon-512.png"]) });
    },
  };
}
