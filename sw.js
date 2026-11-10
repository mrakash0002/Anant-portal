// Anant Portal service worker.
// - Keeps the app shell + CDN libraries available offline.
// - Never touches Supabase / API calls (live data, and the app has its own offline queue).
const VERSION = 'anant-portal-v1';
const SHELL = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const CDN_HOSTS = ['cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION).then(cache => Promise.all(SHELL.map(u => cache.add(u).catch(() => {})))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Page loads: network first (so updates arrive), cached copy when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put('./', copy)); return res; })
        .catch(() => caches.match('./'))
    );
    return;
  }

  // Same-origin files + known CDN libraries: serve cached, refresh in background.
  if (url.origin === self.location.origin || CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then(cached => {
        const fresh = fetch(req).then(res => {
          if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
          return res;
        }).catch(() => cached);
        return cached || fresh;
      })
    );
  }
  // everything else (Supabase API etc.) goes straight to the network
});
