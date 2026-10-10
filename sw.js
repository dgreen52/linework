// Service worker: caches the app shell so the viewer works fully offline.
// It never sees drawings: files opened by the user are read in the page and are not fetched.
// When you change ANY file below, bump the version in src/version.js (the one place it lives;
// tests/unit/shell.test.mjs checks the list).
importScripts('src/version.js');
const VERSION = 'linework-' + self.LINEWORK_VERSION;
const SHELL = [
  './',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'src/app.js',
  'src/app/edit-ui.js',
  'src/app/layers-panel.js',
  'src/app/print.js',
  'src/app/ui.js',
  'src/config.js',
  'src/edit/clipboard.js',
  'src/edit/doc.js',
  'src/edit/live-scene.js',
  'src/edit/ops.js',
  'src/formats/detect.js',
  'src/formats/dgn-seed.js',
  'src/formats/dgn-write.js',
  'src/formats/dgn.js',
  'src/formats/dxf-write.js',
  'src/formats/dxf.js',
  'src/geom.js',
  'src/markup/history.js',
  'src/markup/model.js',
  'src/markup/render.js',
  'src/markup/sidecar.js',
  'src/model.js',
  'src/palettes.js',
  'src/scene.js',
  'src/tools/measure.js',
  'src/tools/snap.js',
  'src/version.js',
  'src/view/batches.js',
  'src/view/colors.js',
  'src/view/renderer2d.js',
  'src/view/viewport.js',
  'src/worker.js',
  'samples/gen/dxf-writer.js',
  'samples/gen/stress.js',
  'samples/house-plan.dxf',
  'samples/bracket.dxf',
  'samples/schematic.dxf',
  'samples/site-plan.dgn',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })))).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('linework-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch (e) {
        if (req.mode === 'navigate') {
          const shell = await cache.match('index.html');
          if (shell) return shell;
        }
        throw e;
      }
    }),
  );
});
