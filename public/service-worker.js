/* service-worker.js — Offline-first cache for Field Companion */

const CACHE_NAME = 'field-companion-v52';

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/auth.js',
  './js/sync.js',
  './js/plant-id.js',
  './js/logger.js',
  './js/zones.js',
  './js/tasks.js',
  './js/data/zones.json',
  './js/data/tasks.json',
  './js/data/drive-links.json',
  './js/data/property-context.json',
  './js/map-picker.js',
  './js/map.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* Cache all shell files on install */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

/* Remove old caches on activate */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Cache-first for app shell; network-only for Anthropic API */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  /* Never intercept API calls — always go to network */
  if (url.hostname === 'api.anthropic.com') return;
  if (url.hostname.endsWith('workers.dev')) return;
  if (url.hostname === 'accounts.google.com') return;

  /* Cache-first strategy for everything else */
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        /* Cache valid same-origin responses */
        if (
          response.ok &&
          event.request.method === 'GET' &&
          url.origin === self.location.origin
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        /* Offline fallback for navigation requests */
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
