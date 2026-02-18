const CACHE_NAME = 'manga-tool-v5'; // Bumped version
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './worker.js',
    './manifest.json'
];

// Install: Cache files AND force activation immediately
self.addEventListener('install', (e) => {
    self.skipWaiting(); // <--- CRITICAL: Forces new SW to take over now
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

// Activate: Clean old caches and claim control
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) return caches.delete(key);
                })
            );
        }).then(() => self.clients.claim()) // <--- CRITICAL: Takes control of open pages
    );
});

// Fetch: Serve from cache
self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then((response) => {
            return response || fetch(e.request);
        })
    );
});
