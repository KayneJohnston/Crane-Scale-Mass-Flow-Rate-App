// Service worker: makes the app open offline once it has been loaded.
// Network-first (so updates arrive straight away when there is signal), with
// the cached copy used when offline or when the network is slow.

const CACHE = 'tap-rate-v0.4.0';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/settings.js', 'js/store.js', 'js/export.js', 'js/audio.js', 'js/camera.js', 'js/reader.js',
  'js/crops.js', 'js/zip.js', 'js/ui/chart.js',
  'js/vision/sevenseg.js', 'js/vision/pipeline.js', 'js/vision/tracker.js', 'js/vision/posterior.js', 'js/vision/render7seg.js', 'js/vision/sampler.js',
  'js/analysis/engine.js', 'js/analysis/kalman.js', 'js/analysis/stats.js', 'js/analysis/offline.js', 'js/analysis/sim.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fromNet = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
    try {
      const res = await Promise.race([fromNet, timeout]);
      if (res) return res;
    } catch { /* offline */ }
    const cached = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
    if (cached) return cached;
    try { return await fromNet; } catch { return new Response('Offline', { status: 503, statusText: 'Offline' }); }
  })());
});
