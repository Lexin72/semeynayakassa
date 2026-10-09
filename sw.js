const CACHE_PREFIX = 'semeynaya-kassa-';
const CACHE_NAME = CACHE_PREFIX + 'v2';
const ASSETS = [
  './', './index.html', './manifest.json', './apple-touch-icon.png',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png',
  './vendor/supabase-2.117.3.js', './vendor/fonts.css',
  './vendor/fonts/inter-normal-cyrillic-ext.woff2',
  './vendor/fonts/inter-normal-cyrillic.woff2',
  './vendor/fonts/inter-normal-greek-ext.woff2',
  './vendor/fonts/inter-normal-greek.woff2',
  './vendor/fonts/inter-normal-vietnamese.woff2',
  './vendor/fonts/inter-normal-latin-ext.woff2',
  './vendor/fonts/inter-normal-latin.woff2',
  './vendor/fonts/playfair-display-italic-cyrillic.woff2',
  './vendor/fonts/playfair-display-italic-vietnamese.woff2',
  './vendor/fonts/playfair-display-italic-latin-ext.woff2',
  './vendor/fonts/playfair-display-italic-latin.woff2',
  './vendor/fonts/playfair-display-normal-cyrillic.woff2',
  './vendor/fonts/playfair-display-normal-vietnamese.woff2',
  './vendor/fonts/playfair-display-normal-latin-ext.woff2',
  './vendor/fonts/playfair-display-normal-latin.woff2',
];
const assetPaths = new Set(ASSETS.map(path => new URL(path, self.registration.scope).pathname));
const indexURL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function refreshAsset(request, cacheKey, cache){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(request, {signal:controller.signal});
    // Never store API responses, redirects to another origin, or error pages.
    if(response.ok && response.type === 'basic') await cache.put(cacheKey, response.clone());
    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Supabase requests must reach the API directly; only the app shell is cached here.
  if(url.origin !== self.location.origin) return;
  const navigation = event.request.mode === 'navigate';
  if(!navigation && !assetPaths.has(url.pathname)) return;
  const cacheKey = navigation ? indexURL : url.origin + url.pathname;
  const cachePromise = caches.open(CACHE_NAME);
  const refresh = cachePromise.then(cache => refreshAsset(event.request, cacheKey, cache));
  event.waitUntil(refresh);
  event.respondWith((async () => {
    const cached = await (await cachePromise).match(cacheKey);
    if(cached) return cached;
    const response = await refresh;
    return response || Response.error();
  })());
});
