// Keeps the app available offline. Books stay in on-device storage and never pass through here.
const CACHE = 'stillpoint-v15';
const APP_FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/engine.js', 'js/importers.js', 'js/pdfclean.js', 'js/bookclean.js', 'js/db.js', 'js/sounds.js', 'js/streaks.js',
  'js/narration.js',
  'js/updates.js',
  'js/book-reader.js',
  'js/audiobook-zip.js',
  'js/follow-scroll.js', 'js/covers.js',
  'js/reading-state.js', 'js/sleep-timer.js',
  'vendor/jszip.min.js', 'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_FILES.map(url => new Request(url, { cache: 'reload' })));
    // Fonts are cached when requested below. A blocked font CDN must not hold
    // the entire app update in the installing state on a phone.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === location.origin && url.pathname.startsWith(new URL('api/', self.registration.scope).pathname)) return;
  if (url.origin === 'https://cdn.jsdelivr.net') {
    event.respondWith((async () => {
      const cached = await caches.match(request.url);
      if (cached) return cached;
      const response = await fetch(request.url, { mode: 'cors' });
      if (response.ok) (await caches.open(CACHE)).put(request.url, response.clone());
      return response;
    })());
    return;
  }
  if (url.origin !== location.origin) return;
  // Uses the newest app files when online and the saved copy when offline.
  event.respondWith((async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(request, { signal: controller.signal, cache: 'no-cache' });
      clearTimeout(timer);
      if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
      return response;
    } catch {
      const cached = await caches.match(request, { ignoreSearch: true })
        || (request.mode === 'navigate' ? await caches.match('index.html') : null);
      return cached || Response.error();
    }
  })());
});
