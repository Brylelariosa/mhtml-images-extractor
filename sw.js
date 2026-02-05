// We updated the version to v4 so the browser knows to reload everything
const CACHE_NAME = 'manga-tool-v4'; 

const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './worker.js',      // <--- IMPORTANT: New file added
    './fflate.min.js'   // <--- IMPORTANT: New file added
];

// Install Event: Caches all files immediately
self.addEventListener('install', (e) => {
    self.skipWaiting(); // Forces this new service worker to activate right away
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

// Activate Event: Cleans up old versions (v1, v2, v3...)
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) return caches.delete(key);
                })
            );
        })
    );
    return self.clients.claim();
});

// Fetch Event: Serves files from cache when offline
self.addEventListener('fetch', (e) => {
    // Strategy: Cache First, falling back to Network
    e.respondWith(
        caches.match(e.request).then((cachedResponse) => {
            return cachedResponse || fetch(e.request);
        })
    );
});
