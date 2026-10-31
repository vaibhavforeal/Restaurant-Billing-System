
const CACHE = "masalapos-kitchen-07a9e7b54a2671de";
const SHELL = "/kitchen/";
const ASSETS = ["/assets/index--TBobyOL.css","/assets/index-Cb8zr6JT.js","/kitchen/manifest.webmanifest","/kitchen/icon-192.png","/kitchen/icon-512.png"];
const STATIC = new Set(ASSETS);
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all([SHELL, ...ASSETS].map(async (url) => {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!response.ok || response.redirected) throw new Error('Captain shell download failed');
      await cache.put(url, response);
    }));
  })());
  // A new version waits until existing Captain windows close. Never reload an order.
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("masalapos-kitchen-") && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate' && (url.pathname === SHELL || url.pathname === SHELL.slice(0, -1))) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      // The shell and its hashed assets must come from the same release. A new
      // worker downloads the next release and waits for Captain windows to close.
      const shell = await cache.match(SHELL);
      if (shell) return shell;
      try { return await fetch(request, { signal: AbortSignal.timeout(4000) }); }
      catch { return new Response('Reconnect to the restaurant Wi-Fi and reopen Kitchen.', { status: 503, headers: { 'Content-Type': 'text/plain' } }); }
    })());
    return;
  }
  if (STATIC.has(url.pathname) && !url.search) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return await cache.match(url.pathname) || fetch(request);
    })());
  }
});
