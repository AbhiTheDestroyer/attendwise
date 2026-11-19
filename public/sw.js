/* AttendWise service worker — installable app shell.
 *
 * Rules, learned the hard way:
 *  - /api/** is ALWAYS network-only. Never cache API responses (least of all
 *    auth answers); if the network is gone, return a clear 503 JSON so the
 *    app's honest error handling ("cannot reach the server") engages.
 *  - The static shell caches for offline/startup speed, invalidated by
 *    APP_CACHE version bumps on every frontend deploy.
 */
const APP_CACHE = 'attendwise-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/js/core.js',
  '/js/pages1.js',
  '/js/pages2.js',
  '/js/pages3.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/favicon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== APP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== 'GET') return;

  // API traffic: strictly network (see header comment).
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(
        JSON.stringify({ error: { code: 'offline', message: 'Offline — changes resume when the connection returns.', details: null } }),
        { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      )),
    );
    return;
  }

  // Navigations: network-first, fall back to the cached shell when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(APP_CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/') || caches.match('/index.html')),
    );
    return;
  }

  // Static assets: cache-first with background refresh.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fresh = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(APP_CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
