// sw.js — EFNL Dashboard Service Worker
// Strategy:
//   - App shell (HTML, fonts): cache-first with background refresh
//   - data.json: network-first, fall back to cache so offline still works
//   - Everything else (Cloudinary logos, Google Fonts): network-first, cache on success

const CACHE_NAME = 'efnl-v1';

// Files that make up the app shell — cached on install
const SHELL_URLS = [
  './',
  './index.html',
];

// ── Install: cache the app shell ─────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // data.json — network first, cache fallback
  // Always try to get fresh results; serve cached copy if offline
  if (url.pathname.endsWith('data.json')) {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell (HTML) — cache first, background refresh
  if (SHELL_URLS.some(u => url.pathname.endsWith(u.replace('./', '')))) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const networkFetch = fetch(event.request).then(res => {
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, res.clone()));
          return res;
        });
        return cached || networkFetch;
      })
    );
    return;
  }

  // Everything else (logos, fonts) — network first, cache on success
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok) {
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
