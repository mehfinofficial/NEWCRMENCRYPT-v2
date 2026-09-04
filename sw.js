/* =============================================
   sw.js — Xetel CRM Service Worker
   Strategy:
     • Shell (HTML/CSS/JS/fonts) → Cache First
     • API calls (/api/) → Network First, fall back to cache
     • Everything else → Network First
   ============================================= */

// ── DEV / LIVE SWITCH ─────────────────────────────────────────────────
// true  = dev mode: caching is fully bypassed, every file always comes
//         fresh from the network, no version bumping needed while building.
// false = live mode: normal caching as described above.
// Flip this to false AND bump CACHE_NAME below before deploying live.
const DEV_MODE = true;

const CACHE_NAME   = 'xetel-crm-v24';
const SHELL_ASSETS = [
  './',
  './index.html',
  './css/main.css',
  './js/app.js',
  './js/api.js',
  './assests/logo/icon-192.png',
  './assests/logo/icon-512.png',
];

/* ── INSTALL: cache the app shell (skipped in dev mode) ── */
self.addEventListener('install', event => {
  if (DEV_MODE) { self.skipWaiting(); return; }
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE: delete old caches (deletes ALL caches in dev mode) ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => DEV_MODE || k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── FETCH ── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET and browser-extension requests
  if (event.request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // Dev mode: always go straight to the network, never touch the cache.
  if (DEV_MODE) return;

  // API calls → Network First (fresh data), fall back to cache
  if (url.pathname.includes('/api/')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Google Fonts → Cache First (they never change)
  if (url.hostname.includes('fonts.g')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // App shell → Cache First, update in background (stale-while-revalidate)
  event.respondWith(staleWhileRevalidate(event.request));
});

/* ── Strategies ── */

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, res.clone());
  }
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(req);
    return cached || new Response(
      JSON.stringify({ error: 'Offline — no cached data available' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function staleWhileRevalidate(req) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);

  const fetchPromise = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);

  return cached || await fetchPromise || new Response('Offline', { status: 503 });
}