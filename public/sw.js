// KaraKlas service worker — app shell caching
// Bumping CACHE_NAME forces old caches to be evicted on next install.
const CACHE_NAME = 'karaklas-shell-v1';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(['/'])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Skip cross-origin API / storage requests — always fetch fresh
  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.endsWith('supabase.co') ||
    url.hostname.endsWith('replicate.com') ||
    url.hostname.endsWith('replicate.delivery') ||
    url.hostname.endsWith('anthropic.com') ||
    url.hostname.endsWith('lrclib.net')
  ) return;

  // Stale-while-revalidate: serve from cache immediately, update in background
  e.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(e.request).then(cached => {
        const network = fetch(e.request).then(res => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});
