// UPDATED: Version 2 to force the browser to reload your new index.html
const CACHE_NAME = 'manga-extractor-v2';
const ASSETS = [
    './',
    './index.html',
    './manifest.json'
];

// Install: Cache files
self.addEventListener('install', (e) => {
    // skipWaiting forces this new service worker to become active immediately
    self.skipWaiting(); 
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

// Activate: Clean up old caches (v1)
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(keyList.map((key) => {
                if (key !== CACHE_NAME) {
                    return caches.delete(key);
                }
            }));
        })
    );
    return self.clients.claim();
});

// Fetch: Serve from cache, fall back to network
self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then((response) => {
            return response || fetch(e.request);
        })
    );
});
