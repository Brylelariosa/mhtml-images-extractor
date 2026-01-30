// Updated Cache Name to force refresh
const CACHE_NAME = 'manga-extractor-v2';
const ASSETS = [
    './',
    './index.html',
    './manifest.json'
];

self.addEventListener('install', (e) => {
    // Force the new service worker to take over immediately
    self.skipWaiting(); 
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('activate', (e) => {
    // Clean up old caches (v1) to save space and prevent conflicts
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

self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then((response) => {
            // Return cached response if found, otherwise fetch from network
            return response || fetch(e.request);
        })
    );
});
