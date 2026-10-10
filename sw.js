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
  'src/app/compare.js',
  'src/app/edit-ui.js',
  'src/app/files.js',
  'src/app/layers-panel.js',
  'src/app/print-svg.js',
  'src/app/print.js',
  'src/app/store.js',
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
  'src/tools/compare.js',
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
// Loaded only when a DWG is opened (not precached, so the app shell stays small). After the
// first use they are cached and DWGs open offline from then on:
// * ON_DEMAND app modules are cached in the versioned app cache (and fetched again by the next
//   app version's install if the DWG reader has been used);
// * the DWG reader (LibreDWG WebAssembly, ~9.5 MB, ~2.2 MB compressed) has its own cache that
//   survives app updates. Change READER_CACHE whenever vendor/libredwg changes.
const ON_DEMAND = ['src/formats/dwg.js'];
const READER_CACHE = 'linework-reader-libredwg-0.7.16-1';
const READER = ['vendor/libredwg/libredwg-web.js', 'vendor/libredwg/libredwg-web.wasm'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })));
    if (await caches.has(READER_CACHE)) {
      await Promise.all(ON_DEMAND.map((p) => cache.add(new Request(p, { cache: 'reload' })).catch(() => {})));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('linework-') && k !== VERSION && k !== READER_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const isReader = READER.some((p) => new URL(p, self.registration.scope).pathname === url.pathname);
  event.respondWith(
    caches.open(isReader ? READER_CACHE : VERSION).then(async (cache) => {
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
