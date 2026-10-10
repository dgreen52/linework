#!/usr/bin/env node
// End-to-end tests (Playwright, no test-runner dependency).
//   NODE_PATH=<a node_modules folder that has playwright> node tests/e2e/run.mjs [filter]
// Screenshots + perf.json are written to tests/e2e/out/. Only SYNTHETIC fixtures are used.
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { startServer } from '../../tools/serve.mjs';
import { launch } from './browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'tests', 'e2e', 'out');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const FIX = (n) => (existsSync(join(ROOT, 'samples', n)) ? join(ROOT, 'samples', n) : join(ROOT, 'tests', 'fixtures', n));
const filter = process.argv[2] || '';

const requests = []; // every URL path the server was asked for (to check what loads when)
const server = await startServer(0, '127.0.0.1', { onRequest: (p) => requests.push(p) });
const BASE = `http://127.0.0.1:${server.address().port}/`;
const browser = await launch();
const results = [];
const perf = {};

// ------------------------------------------------------------------ harness
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const assert = (cond, msg) => { if (!cond) throw new Error('Assertion failed: ' + msg); };
const eq = (a, b, msg) => assert(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...opts.context });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.errors = errors;
  page.ctx = ctx;
  await page.goto(BASE + (opts.sw ? '' : '?nosw'));
  await page.waitForFunction(() => !!window.__linework);
  return page;
}
async function close(page) {
  const errs = page.errors.filter((e) => !/Failed to load resource.*(favicon)/.test(e) && !(page.allowErrors || []).some((re) => re.test(e)));
  await page.ctx.close();
  assert(!errs.length, 'no console errors: ' + errs.join(' | '));
}
async function openFixture(page, name) {
  await page.setInputFiles('#file-input', FIX(name));
  await page.waitForFunction((n) => window.__linework.doc && window.__linework.doc.name === n && !window.__linework.loading, name, { timeout: 60000 });
  await settle(page);
}
async function openSample(page, key, expectName) {
  await page.evaluate((k) => window.__linework.openSample(k), key);
  await page.waitForFunction((n) => window.__linework.doc && window.__linework.doc.name === n && !window.__linework.loading, expectName, { timeout: 60000 });
  await settle(page);
}
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
const clearToasts = (page) => page.evaluate(() => { document.querySelector('#toasts').innerHTML = ''; });
async function client(page, x, y) {
  return page.evaluate(([x, y]) => {
    const [sx, sy] = window.__linework.worldToScreen(x, y);
    const r = document.querySelector('#cv-overlay').getBoundingClientRect();
    return [r.left + sx, r.top + sy];
  }, [x, y]);
}
async function clickWorld(page, x, y, dx = 0, dy = 0) {
  const [cx, cy] = await client(page, x, y);
  await page.mouse.move(cx + dx, cy + dy);
  await page.mouse.click(cx + dx, cy + dy);
}
async function dragScreen(page, a, b, steps = 8) {
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  await page.mouse.move(b[0], b[1], { steps });
  await page.mouse.up();
}
async function stageBox(page) { return page.evaluate(() => { const r = document.querySelector('#cv-overlay').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }); }
async function shot(page, name) { await settle(page); await page.screenshot({ path: join(OUT, name + '.png') }); }
const mcValue = (page) => page.textContent('#mc-value');
async function pixelAt(page, x, y) {
  return page.evaluate(([x, y]) => {
    const app = window.__linework;
    const [sx, sy] = app.worldToScreen(x, y);
    const c = document.querySelector('#cv-drawing');
    const d = app.dpr;
    const g = c.getContext('2d').getImageData(Math.round(sx * d) - 2, Math.round(sy * d) - 2, 5, 5).data;
    let best = [0, 0, 0];
    for (let i = 0; i < g.length; i += 4) if (g[i] - g[i + 1] > best[0] - best[1]) best = [g[i], g[i + 1], g[i + 2]];
    return best; // the "reddest" pixel around the point
  }, [x, y]);
}

/** Files reached from `entry` through static import / export-from statements (dynamic import() excluded). */
function staticGraph(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = readFileSync(join(ROOT, entry), 'utf8');
  const re = /^\s*(?:import|export)\s[^;'"`]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
  for (const m of src.matchAll(re)) staticGraph(posix.normalize(posix.join(posix.dirname(entry), m[1] || m[2])), seen);
  return seen;
}

// ------------------------------------------------------------------ tests
test('empty state, privacy promise, app shell size', async () => {
  const page = await newPage();
  assert(await page.isVisible('#empty'), 'empty state visible');
  const promise = await page.textContent('.promise');
  assert(/never leave this device/i.test(promise), 'privacy promise shown');
  eq(await page.locator('.sample').count(), 5, 'sample buttons');
  await shot(page, 'empty-dark-1440');
  // Size budgets (gzip). 1) Startup: what a first visit needs before a drawing can open: index.html,
  // app.css, the module graph statically imported by src/app.js and the parse worker's graph.
  // 2) Offline: everything the service worker precaches except the samples (adds the lazily
  // imported writers, icons, manifest).
  const gz = (p) => gzipSync(readFileSync(join(ROOT, p)), { level: 9 }).length;
  const startup = new Set(['index.html', 'app.css', ...staticGraph('src/app.js'), ...staticGraph('src/worker.js')]);
  assert(startup.has('src/scene.js') && startup.has('src/app/edit-ui.js') && startup.has('src/formats/dxf.js'), 'static import graph found: ' + [...startup].join(' '));
  assert(!startup.has('src/formats/dxf-write.js') && !startup.has('src/formats/dgn-write.js'), 'writers are not loaded at startup');
  let startGz = 0;
  for (const p of startup) startGz += gz(p);
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const list = sw.slice(sw.indexOf('const SHELL = ['), sw.indexOf('];', sw.indexOf('const SHELL = [')));
  const shell = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((p) => p !== './' && !p.startsWith('samples/'));
  for (const p of startup) assert(shell.includes(p), `startup file ${p} is precached`);
  let raw = 0, offGz = 0;
  for (const p of shell) { raw += readFileSync(join(ROOT, p)).length; offGz += gz(p); }
  perf.appShell = { startupFiles: startup.size, startupGzipKB: +(startGz / 1024).toFixed(1), offlineFiles: shell.length, offlineRawKB: +(raw / 1024).toFixed(1), offlineGzipKB: +(offGz / 1024).toFixed(1) };
  assert(startGz < 150 * 1024, `startup code gzip ${startGz} < 150 KB`);
  assert(offGz < 220 * 1024, `offline app shell gzip ${offGz} < 220 KB`);
  // first open timing
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd }; });
  perf.firstOpen = { domContentLoadedMs: Math.round(nav.domContentLoaded), loadMs: Math.round(nav.load) };
  await close(page);
});

test('open every fixture; friendly errors for unsupported files', async () => {
  const page = await newPage();
  for (const [name, layers] of [['house-plan.dxf', 9], ['bracket.dxf', 10], ['schematic.dxf', 7], ['site-plan.dgn', 12]]) {
    await openFixture(page, name);
    const info = await page.evaluate(() => { const a = window.__linework; return { layers: a.scene.layers.length, items: a.scene.n + a.scene.textCount, units: a.scene.units.abbr }; });
    eq(info.layers, layers, name + ' layer count');
    assert(info.items > 20, name + ' has items');
    assert(await page.isHidden('#empty'), 'empty state hidden');
    eq(await page.textContent('#doc-name'), name, 'doc name shown');
  }
  // edge fixtures: open fine and report skipped items
  await openFixture(page, 'edge-unknown-entities.dxf');
  await page.waitForSelector('.toast.warn');
  assert(/6 items not shown/.test(await page.textContent('#toasts')), 'not-shown note');
  await openFixture(page, 'edge-far-coords.dxf');
  await openFixture(page, 'edge-nested-mirror.dxf');
  await openFixture(page, 'edge-crlf-cp1252.dxf');
  await openFixture(page, 'edge-truncated.dxf');
  // errors never crash the app; the previous drawing stays open
  for (const [file, re] of [['edge-fake.dwg', /This DWG could not be read; save it as DXF and open that/], ['edge-binary.dxf', /Binary DXF is not supported/], ['edge-garbage.dxf', /not a drawing|not a DXF/]]) {
    await clearToasts(page);
    await page.setInputFiles('#file-input', FIX(file));
    await page.waitForSelector('.toast.error');
    assert(re.test(await page.textContent('#toasts')), `${file}: friendly error`);
    eq(await page.textContent('#doc-name'), 'edge-truncated.dxf', 'previous drawing still open');
  }
  await close(page);
});

test('fit, wheel zoom at cursor, box zoom, keyboard', async () => {
  const page = await newPage();
  await openFixture(page, 'house-plan.dxf');
  const fitScale = await page.evaluate(() => window.__linework.view.scale);
  const box = await stageBox(page);
  // zoom at cursor keeps the world point under the cursor fixed
  const mx = Math.round(box.x + 300), my = Math.round(box.y + 300); // mouse events use whole pixels
  const before = await page.evaluate(([x, y]) => window.__linework.screenToWorld(x, y), [mx - box.x, my - box.y]);
  await page.mouse.move(mx, my);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
  await settle(page);
  const after = await page.evaluate(([x, y]) => window.__linework.screenToWorld(x, y), [mx - box.x, my - box.y]);
  const s1 = await page.evaluate(() => window.__linework.view.scale);
  assert(s1 > fitScale * 2, 'wheel zoomed in');
  assert(Math.hypot(after[0] - before[0], after[1] - before[1]) < 1e-6 * 12000, 'point under cursor stays fixed');
  await page.keyboard.press('f');
  await settle(page);
  assert(Math.abs((await page.evaluate(() => window.__linework.view.scale)) / fitScale - 1) < 1e-9, 'F fits');
  // box zoom
  await page.keyboard.press('z');
  await dragScreen(page, [box.x + 400, box.y + 300], [box.x + 600, box.y + 450]);
  await settle(page);
  assert((await page.evaluate(() => window.__linework.view.scale)) > fitScale * 2, 'box zoom zoomed in');
  eq(await page.evaluate(() => window.__linework.tool), 'pan', 'back to pan after box zoom');
  await page.keyboard.press('f');
  // drag-pan
  const c0 = await page.evaluate(() => window.__linework.view.cx);
  await dragScreen(page, [box.x + 500, box.y + 400], [box.x + 300, box.y + 400]);
  const c1 = await page.evaluate(() => window.__linework.view.cx);
  assert(c1 > c0, 'drag pans');
  await page.keyboard.press('f');
  await close(page);
});

test('layer toggle hides geometry (pixel check) and isolate works', async () => {
  const page = await newPage();
  await openFixture(page, 'house-plan.dxf');
  await clearToasts(page);
  const leaf = [5300, 7350]; // front door leaf (red, DOORS layer)
  const before = await pixelAt(page, ...leaf);
  assert(before[0] > 150 && before[1] < 90, 'door is red before: ' + before);
  const label = page.locator('#layer-list li', { hasText: 'DOORS' }).locator('input');
  await label.uncheck();
  await settle(page);
  const after = await pixelAt(page, ...leaf);
  assert(!(after[0] > 150 && after[1] < 90), 'door hidden after toggle: ' + after);
  await label.check();
  await settle(page);
  // isolate WALLS
  await page.locator('#layer-list li', { hasText: 'WALLS' }).locator('button.iso').click();
  const vis = await page.evaluate(() => Array.from(window.__linework.layerVisible));
  eq(vis.reduce((a, b) => a + b, 0), 1, 'only one layer visible');
  await page.click('#btn-layers-all');
  await close(page);
});

test('measure: distance, length and area with snaps (DXF and DGN)', async () => {
  const page = await newPage();
  await openFixture(page, 'house-plan.dxf');
  await clearToasts(page);
  await page.click('#tab-measure');
  await page.click('[data-tool="distance"]');
  // click a few pixels away from the exact corners: endpoint snap must make the result exact
  // (offsets point into the building, away from the dimension extension lines)
  await clickWorld(page, 0, 0, 4, -3);
  await clickWorld(page, 12000, 0, -3, -4);
  eq((await mcValue(page)).trim(), '12,000.00 mm', 'distance value');
  await page.selectOption('#sel-precision', '0');
  eq((await mcValue(page)).trim(), '12,000 mm', 'precision setting');
  await page.selectOption('#sel-precision', '2');
  // length along two walls (click the toolbar like a user would)
  await page.click('[data-tool="length"]');
  await clickWorld(page, 0, 0, 3, -3);
  await clickWorld(page, 12000, 0, -3, -3);
  await clickWorld(page, 12000, 8000, -3, 3);
  await page.keyboard.press('Enter');
  eq((await mcValue(page)).trim(), '20,000.00 mm', 'length value');
  // area of the outer wall rectangle, finished by clicking the first point
  await page.keyboard.press('a');
  await clickWorld(page, 0, 0, 3, -3);
  await clickWorld(page, 12000, 0, -3, -3);
  await clickWorld(page, 12000, 8000, -3, 3);
  await clickWorld(page, 0, 8000, 3, 3);
  await clickWorld(page, 0, 0, 2, -2);
  eq((await mcValue(page)).trim(), '96,000,000.00 mm²', 'area value');
  // midpoint snap on the bottom wall
  await page.keyboard.press('d');
  await clickWorld(page, 6000, 0, 5, -2);
  await clickWorld(page, 6000, 8000, -4, -3);
  eq((await mcValue(page)).trim(), '8,000.00 mm', 'midpoint to midpoint');
  await shot(page, 'measure-house-dark-1440');
  // DGN: property boundary corners (0,0) -> (80,0) in metres
  await openFixture(page, 'site-plan.dgn');
  await clearToasts(page);
  await page.keyboard.press('d');
  await clickWorld(page, 0, 0, 4, 3);
  await clickWorld(page, 80, 0, -4, 3);
  eq((await mcValue(page)).trim(), '80.00 m', 'DGN distance in master units');
  await close(page);
});

test('markup: every type, undo/redo, select/move/delete, sidecar save + reload', async () => {
  const page = await newPage();
  await openFixture(page, 'house-plan.dxf');
  await clearToasts(page);
  await page.click('#tab-markup');
  await page.fill('#inp-author', 'E2E Tester');
  await page.press('#inp-author', 'Tab');
  const box = await stageBox(page);
  const P = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy];
  const count = () => page.evaluate(() => window.__linework.markups.length);
  const draw = async (tool, a, b) => { await page.click(`[data-tool="${tool}"]`); await dragScreen(page, a, b, 12); };
  await draw('pen', P(0.10, 0.20), P(0.20, 0.30));
  await draw('line', P(0.25, 0.20), P(0.35, 0.30));
  await draw('arrow', P(0.40, 0.20), P(0.50, 0.30));
  await draw('rect', P(0.55, 0.20), P(0.65, 0.30));
  await draw('ellipse', P(0.70, 0.20), P(0.80, 0.30));
  await draw('cloud', P(0.10, 0.45), P(0.25, 0.60));
  await draw('highlight', P(0.30, 0.50), P(0.45, 0.50));
  // callout: drag from tip to box, then type
  await draw('callout', P(0.55, 0.55), P(0.65, 0.45));
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-callout');
  await page.keyboard.type('Check door clearance');
  await page.keyboard.press('Enter');
  // polygon cloud: click corners, double-click to finish
  await page.click('[data-tool="cloud"]');
  for (const [fx, fy] of [[0.70, 0.45], [0.85, 0.45], [0.85, 0.60]]) { const p = P(fx, fy); await page.mouse.click(p[0], p[1]); }
  { const p = P(0.70, 0.60); await page.mouse.dblclick(p[0], p[1]); }
  eq(await page.evaluate(() => window.__linework.markups.map((m) => m.type).join(',')), 'pen,line,arrow,rect,ellipse,cloud,highlight,callout,cloud', 'markups in drawing order');
  eq(await count(), 9, 'nine markups drawn (all eight types)');
  const types = await page.evaluate(() => window.__linework.markups.map((m) => m.type).sort().join(','));
  eq(types, 'arrow,callout,cloud,cloud,ellipse,highlight,line,pen,rect', 'every markup type');
  const authored = await page.evaluate(() => window.__linework.markups.every((m) => m.author === 'E2E Tester' && !Number.isNaN(Date.parse(m.created))));
  assert(authored, 'author + timestamp on every markup');
  eq(await page.evaluate(() => window.__linework.markups.find((m) => m.type === 'callout').text), 'Check door clearance', 'callout text');
  await shot(page, 'markup-house-dark-1440');
  // undo / redo
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  eq(await count(), 7, 'undo twice');
  await page.keyboard.press('Control+y');
  eq(await count(), 8, 'redo once');
  await page.keyboard.press('Control+Shift+z');
  eq(await count(), 9, 'redo again');
  // markups stay attached to the drawing when zooming
  const lineWorld = await page.evaluate(() => window.__linework.markups.find((m) => m.type === 'line').pts.slice());
  await page.mouse.move(...P(0.5, 0.5));
  await page.mouse.wheel(0, -300);
  await settle(page);
  eq(JSON.stringify(await page.evaluate(() => window.__linework.markups.find((m) => m.type === 'line').pts)), JSON.stringify(lineWorld), 'world coords unchanged by zoom');
  await page.keyboard.press('f');
  await settle(page);
  // select + move + delete
  await page.keyboard.press('v');
  const lineMid = await client(page, (lineWorld[0] + lineWorld[2]) / 2, (lineWorld[1] + lineWorld[3]) / 2);
  await page.mouse.click(lineMid[0], lineMid[1]);
  assert(await page.evaluate(() => !!window.__linework.selected), 'line selected');
  await dragScreen(page, lineMid, [lineMid[0] + 40, lineMid[1] + 30]);
  const moved = await page.evaluate(() => window.__linework.markups.find((m) => m.type === 'line').pts.slice());
  assert(moved[0] > lineWorld[0] && moved[1] < lineWorld[1], 'line moved right/down');
  await page.keyboard.press('Delete');
  eq(await count(), 8, 'deleted');
  await page.keyboard.press('Control+z');
  eq(await count(), 9, 'undo delete');
  // save the sidecar
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="save-markup"]')]);
  eq(dl.suggestedFilename(), 'house-plan.dxf.markup.json', 'sidecar name');
  const sidecarPath = join(OUT, 'house-plan.dxf.markup.json');
  await dl.saveAs(sidecarPath);
  const doc = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  eq(doc.schema, 'linework-markup', 'schema'); eq(doc.version, 1, 'version'); eq(doc.markups.length, 9, 'saved count');
  const saved = await page.evaluate(() => JSON.stringify(window.__linework.markups.map((m) => [m.id, m.type, m.pts])));
  await page.ctx.close();
  // fresh browser context (no local autosave): open drawing, then load the sidecar
  const page2 = await newPage();
  await openFixture(page2, 'house-plan.dxf');
  eq(await page2.evaluate(() => window.__linework.markups.length), 0, 'fresh context has no markups');
  await page2.setInputFiles('#markup-input', sidecarPath);
  await page2.waitForFunction(() => window.__linework.markups.length === 9);
  const loaded = await page2.evaluate(() => JSON.stringify(window.__linework.markups.map((m) => [m.id, m.type, m.pts])));
  eq(loaded, saved, 'sidecar reload restores identical markups');
  await page2.click('#tab-markup');
  await shot(page2, 'markup-reloaded-dark-1440');
  // autosave: reload the page and reopen -> restored from this browser
  await page2.reload();
  await page2.waitForFunction(() => !!window.__linework);
  await openFixture(page2, 'house-plan.dxf');
  eq(await page2.evaluate(() => window.__linework.markups.length), 9, 'autosave restores markups after reload');
  await close(page2);
  assert(!page.errors.length, 'no console errors (first page): ' + page.errors.join(' | '));
});

test('export PNG and print / save as PDF', async () => {
  const page = await newPage();
  await openFixture(page, 'bracket.dxf');
  await clearToasts(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  eq(dl.suggestedFilename(), 'bracket.png', 'png name');
  const p = join(OUT, 'export-bracket.png');
  await dl.saveAs(p);
  const b = readFileSync(p);
  eq(b.subarray(1, 4).toString('latin1'), 'PNG', 'png signature');
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  const view = await page.evaluate(() => [window.__linework.view.w, window.__linework.view.h]);
  eq(w, Math.round(view[0] * 2), 'png width = 2x view');
  eq(h, Math.round(view[1] * 2), 'png height = 2x view');
  // print: stub window.print, use our dialog, then emulate print media
  await page.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
  await page.click('#btn-print');
  await page.fill('#pr-title', 'Angle bracket — check print');
  await page.fill('#pr-author', 'E2E Tester');
  await page.check('input[name="area"][value="all"]');
  await page.click('#btn-do-print');
  await page.waitForFunction(() => window.__printed === 1);
  const strip = await page.textContent('#print-root .title-strip');
  assert(strip.includes('Angle bracket — check print') && strip.includes('bracket.dxf') && strip.includes('E2E Tester'), 'title strip');
  await page.emulateMedia({ media: 'print' });
  assert(await page.isVisible('#print-root img'), 'print image visible in print media');
  assert(await page.isHidden('.topbar'), 'UI hidden in print media');
  await page.screenshot({ path: join(OUT, 'print-emulation-bracket.png') });
  const pdf = await page.pdf({ landscape: true, printBackground: true, preferCSSPageSize: true });
  writeFileSync(join(OUT, 'print-bracket.pdf'), pdf);
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  eq(pages, 1, 'fits on one landscape page');
  await page.emulateMedia({ media: 'screen' });
  await close(page);
});

test('touch at 390 px: pinch zoom, one-finger pan, finger markup', async () => {
  const page = await newPage({ context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } });
  await shot(page, 'empty-dark-390');
  await openFixture(page, 'house-plan.dxf');
  await clearToasts(page);
  const box = await stageBox(page);
  const cdp = await page.ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const s0 = await page.evaluate(() => window.__linework.view.scale);
  // pinch out
  await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 40 - i * 12, cy], [cx + 40 + i * 12, cy]]);
  await touch('touchEnd', []);
  await settle(page);
  const s1 = await page.evaluate(() => window.__linework.view.scale);
  assert(s1 > s0 * 1.8, `pinch zoomed (${s0} -> ${s1})`);
  // one-finger pan
  const c0 = await page.evaluate(() => [window.__linework.view.cx, window.__linework.view.cy]);
  await touch('touchStart', [[cx, cy]]);
  for (let i = 1; i <= 6; i++) await touch('touchMove', [[cx - i * 15, cy + i * 10]]);
  await touch('touchEnd', []);
  const c1 = await page.evaluate(() => [window.__linework.view.cx, window.__linework.view.cy]);
  assert(c1[0] > c0[0] && c1[1] > c0[1], 'one-finger pan moved the view');
  await page.evaluate(() => window.__linework.fit());
  // finger drawing with the pen tool
  await page.click('#tab-markup');
  await page.click('[data-tool="pen"]');
  await touch('touchStart', [[cx - 60, cy]]);
  for (let i = 1; i <= 10; i++) await touch('touchMove', [[cx - 60 + i * 12, cy + Math.sin(i / 2) * 20]]);
  await touch('touchEnd', []);
  eq(await page.evaluate(() => window.__linework.markups.length), 1, 'finger stroke created a markup');
  // layout fits at 390 px: no horizontal page overflow
  const layout = await page.evaluate(() => [window.innerWidth, document.documentElement.scrollWidth]);
  eq(layout[0], 390, 'layout viewport stays at device width (nothing forces a wider page)');
  assert(layout[1] <= 390, 'no horizontal overflow at 390px');
  await shot(page, 'house-dark-390');
  await page.click('#tab-view');
  await page.click('[data-action="layers"]');
  await shot(page, 'layers-dark-390');
  await close(page);
});

test('offline: service worker serves the app shell and samples', async () => {
  const page = await newPage({ sw: true });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller || true);
  // wait until install finished caching
  await page.waitForFunction(async () => (await caches.keys()).some((k) => k.startsWith('linework-')) && (await (await caches.open((await caches.keys()).find((k) => k.startsWith('linework-')))).keys()).length >= 30, null, { timeout: 30000 });
  await page.ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !!window.__linework);
  assert(await page.isVisible('#empty'), 'app shell renders offline');
  assert(await page.evaluate(() => !!navigator.serviceWorker.controller), 'controlled by the service worker');
  await openSample(page, 'samples/site-plan.dgn', 'site-plan.dgn');
  eq(await page.evaluate(() => window.__linework.scene.format), 'DGN', 'sample opens offline');
  await openSample(page, 'stress', 'stress-test-53k.dxf');
  assert(await page.evaluate(() => window.__linework.scene.n > 50000), 'generated stress sample works offline');
  await page.ctx.setOffline(false);
  await close(page);
});

test('accessibility basics: help sheet via "?", keyboard focus, labelled controls', async () => {
  const page = await newPage();
  await openFixture(page, 'house-plan.dxf');
  await clearToasts(page);
  await page.keyboard.press('?');
  assert(await page.evaluate(() => document.querySelector('#dlg-help').open), 'help opens with ?');
  await shot(page, 'help-dark-1440');
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => !document.querySelector('#dlg-help').open), 'Esc closes help');
  // every button has an accessible name (text, aria-label or title)
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => !(b.textContent.trim() || b.getAttribute('aria-label') || b.title)).map((b) => b.outerHTML.slice(0, 80)));
  eq(unnamed.length, 0, 'unnamed buttons: ' + unnamed.join(' '));
  // keyboard: Tab reaches the Open button and shows a focus ring
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => { const el = document.activeElement; return { id: el.id, outline: getComputedStyle(el).outlineStyle }; });
  assert(focus.outline !== 'none', 'visible focus ring on ' + focus.id);
  // tabs: arrow keys move between ribbon tabs
  await page.focus('#tab-view');
  await page.keyboard.press('ArrowRight');
  eq(await page.evaluate(() => document.activeElement.id), 'tab-measure', 'arrow key moves to next tab');
  assert(await page.isVisible('#panel-measure'), 'measure panel shown');
  // print dialog
  await page.click('#btn-print');
  await shot(page, 'print-dialog-dark-1440');
  await page.keyboard.press('Escape');
  await page.keyboard.press('b');
  await page.click('#btn-print');
  await shot(page, 'print-dialog-paper-1440');
  await page.keyboard.press('Escape');
  await close(page);
});

test('screenshots: dark + paper at 1440 / 1024 / 390', async () => {
  for (const [w, h, tag, mobile] of [[1440, 900, '1440', false], [1024, 768, '1024', true], [390, 844, '390', true]]) {
    const page = await newPage({ context: { viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, isMobile: w < 800 } });
    for (const [file] of [['house-plan.dxf'], ['bracket.dxf'], ['schematic.dxf'], ['site-plan.dgn']]) {
      await openFixture(page, file);
      await clearToasts(page);
      const base = file.replace(/\.[^.]+$/, '');
      await shot(page, `${base}-dark-${tag}`);
      await page.keyboard.press('b');
      await shot(page, `${base}-paper-${tag}`);
      await page.keyboard.press('b');
    }
    // a zoomed-in detail of the text alignment key (text placement check)
    if (tag === '1440') {
      await openFixture(page, 'schematic.dxf');
      await clearToasts(page);
      await page.evaluate(() => window.__linework.zoomToWorld(0.6, 0.15, 4.6, 1.75));
      await shot(page, 'schematic-text-key-zoom-dark-1440');
      await openFixture(page, 'edge-nested-mirror.dxf');
      await clearToasts(page);
      await shot(page, 'edge-nested-mirror-dark-1440');
      await openFixture(page, 'edge-far-coords.dxf');
      await clearToasts(page);
      await page.evaluate(() => window.__linework.zoomToWorld(6543220.05, 1987664.15, 6543220.45, 1987664.35));
      await shot(page, 'edge-far-coords-deepzoom-dark-1440');
    }
    await close(page);
  }
});

test('drag and drop a drawing and its markups onto the window', async () => {
  const page = await newPage();
  const drop = async (name, mime) => {
    const b64 = readFileSync(FIX(name)).toString('base64');
    await page.evaluate(([b64, name, mime]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: mime }));
      for (const type of ['dragenter', 'dragover', 'drop']) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, [b64, name, mime]);
  };
  await drop('site-plan.dgn', 'application/octet-stream');
  await page.waitForFunction(() => window.__linework.doc && window.__linework.doc.name === 'site-plan.dgn' && !window.__linework.loading);
  assert(await page.isHidden('#drop-overlay'), 'drop overlay hidden after drop');
  eq(await page.evaluate(() => window.__linework.scene.format), 'DGN', 'dropped DGN opened');
  await close(page);
});

test('performance: 53k-entity stress drawing (frame times)', async () => {
  const page = await newPage();
  const t0 = Date.now();
  // the UI must stay responsive while the worker parses: record main-thread frame gaps
  await page.evaluate(() => {
    window.__gaps = []; let last = performance.now(); window.__rec2 = true;
    const tick = (t) => { window.__gaps.push(t - last); last = t; if (window.__rec2) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    // long tasks = main-thread work over 50 ms (what actually freezes clicks, typing and scrolling)
    window.__lt = []; const t0 = performance.now();
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.startTime >= t0) window.__lt.push(e.duration); }).observe({ type: 'longtask' });
  });
  await page.evaluate(() => { window.__linework.openSample('stress'); });
  await page.waitForSelector('#progress:not([hidden])', { timeout: 5000 });
  const sawProgress = true;
  await page.waitForFunction(() => window.__linework.doc && window.__linework.doc.name === 'stress-test-53k.dxf' && !window.__linework.loading, null, { timeout: 60000 });
  const openMs = Date.now() - t0;
  await settle(page);
  await page.waitForTimeout(300); // progressive first draw
  const { gaps, lt } = await page.evaluate(() => { window.__rec2 = false; return { gaps: window.__gaps, lt: window.__lt }; });
  const longTaskMaxMs = lt.length ? +Math.max(...lt).toFixed(1) : 0;
  const sortedGaps = gaps.slice(1).sort((a, b) => a - b);
  const pct = (p) => +sortedGaps[Math.min(sortedGaps.length - 1, Math.floor(p * (sortedGaps.length - 1)))].toFixed(1);
  await clearToasts(page);
  await page.evaluate(() => document.querySelector('#layers-panel').hidden = true);
  await settle(page);
  const box = await stageBox(page);
  // full-quality render cost at a few zoom levels (CPU time to issue the frame)
  const renders = await page.evaluate(async () => {
    const a = window.__linework;
    const out = {};
    const measure = (label, n = 8) => {
      const ms = [];
      for (let i = 0; i < n; i++) { const r = a.renderer.render(a.view, a.renderOpts()); ms.push(r.ms); }
      ms.sort((x, y) => x - y);
      out[label] = +ms[Math.floor(ms.length / 2)].toFixed(2);
    };
    a.fit(); measure('fitAll');
    a.view.zoomAt(a.view.w / 2, a.view.h / 2, 4); measure('zoom4x');
    a.view.zoomAt(a.view.w / 2, a.view.h / 2, 5); measure('zoom20x');
    a.view.zoomAt(a.view.w / 2, a.view.h / 2, 10); measure('zoom200x');
    a.fit();
    return out;
  });
  // real interaction: record rAF frame intervals while the mouse pans and the wheel zooms
  const record = async (label, action) => {
    await page.evaluate(() => { window.__frames = []; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__rec) requestAnimationFrame(tick); }; window.__rec = true; requestAnimationFrame(tick); });
    await action();
    const f = await page.evaluate(() => { window.__rec = false; return window.__frames.slice(2); });
    f.sort((x, y) => x - y);
    const pct = (p) => +f[Math.min(f.length - 1, Math.floor(p * (f.length - 1)))].toFixed(1);
    return { frames: f.length, medianMs: pct(0.5), p95Ms: pct(0.95), maxMs: pct(1) };
  };
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  await settle(page);
  await page.waitForTimeout(400); // let the at-rest full render finish before recording
  const panFit = await record('panFit', async () => { await page.mouse.move(cx, cy); await page.mouse.down(); for (let i = 0; i < 60; i++) await page.mouse.move(cx - i * 4, cy - i * 2); await page.mouse.up(); });
  const zoomFit = await record('zoom', async () => { await page.mouse.move(cx, cy); for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, -40); } await page.waitForTimeout(250); });
  const panZoomed = await record('panZoomed', async () => { await page.mouse.move(cx, cy); await page.mouse.down(); for (let i = 0; i < 60; i++) await page.mouse.move(cx + i * 4, cy + i * 3); await page.mouse.up(); await page.waitForTimeout(250); });
  perf.stress = { entities: 53100, openMs, progressShown: sawProgress, mainThreadDuringLoad: { longTasks: lt.length, longTaskMaxMs, rafFrames: sortedGaps.length, rafMedianMs: pct(0.5), rafMaxMs: pct(1) }, renderMsMedian: renders, interaction: { panAtFit: panFit, wheelZoom: zoomFit, panZoomed4x: panZoomed } };
  // a normal drawing for comparison
  await openFixture(page, 'house-plan.dxf');
  const normal = await record('house', async () => { await page.mouse.move(cx, cy); await page.mouse.down(); for (let i = 0; i < 60; i++) await page.mouse.move(cx - i * 4, cy - i * 2); await page.mouse.up(); });
  const houseRender = await page.evaluate(() => { const a = window.__linework; const ms = []; for (let i = 0; i < 10; i++) ms.push(a.renderer.render(a.view, a.renderOpts()).ms); ms.sort((x, y) => x - y); return +ms[5].toFixed(2); });
  perf.housePlan = { renderMsMedian: houseRender, panAtFit: normal };
  await shot(page, 'perf-end');
  assert(panZoomed.p95Ms < 50, 'stress pan p95 < 50 ms');
  assert(longTaskMaxMs < 100, `UI stays responsive while loading (longest main-thread task ${longTaskMaxMs} ms)`);
  assert(normal.medianMs < 20, 'normal drawing pans at ~60 fps');
  await close(page);
});

// ------------------------------------------------------------------ v0.2: Edit mode
const ED = {
  sel: (page) => page.evaluate(() => [...window.__linework.edit.sel].sort((a, b) => a - b)),
  ent: (page, i) => page.evaluate((k) => { const e = window.__linework.edit.doc.model.entities[k]; return e ? JSON.parse(JSON.stringify(e)) : null; }, i),
  count: (page) => page.evaluate(() => window.__linework.edit.doc.model.entities.length),
  last: (page) => page.evaluate(() => { const l = window.__linework.edit.doc.model.entities; return JSON.parse(JSON.stringify(l[l.length - 1])); }),
  dirty: (page) => page.evaluate(() => !document.querySelector('#doc-dirty').hidden),
  scale: (page) => page.evaluate(() => window.__linework.view.scale),
};
const nearPt = (p, q, tol) => Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;
async function openForEdit(page, name, sample) {
  if (sample) await openSample(page, sample, name); else await openFixture(page, name);
  await clearToasts(page);
  await page.waitForFunction(() => window.__linework.edit.ready, null, { timeout: 60000 });
  await page.click('#tab-edit');
  await page.click('[data-tool="eselect"]');
  await settle(page);
}
const setSnap = (page, on) => page.evaluate((v) => { if (window.__linework.snapOn !== v) document.querySelector('#panel-edit [data-action="snap"]').click(); }, on);
const zoomTo = async (page, x0, y0, x1, y1) => { await page.evaluate((b) => window.__linework.zoomToWorld(...b), [x0, y0, x1, y1]); await settle(page); };
async function dragWorld(page, a, b, steps = 10) { await dragScreen(page, await client(page, ...a), await client(page, ...b), steps); }
async function textAt(page, s) { // world centre of a drawn text
  return page.evaluate((str) => { const a = window.__linework, t = a.scene.texts.find((x) => !x.dead && x.s === str); const [ox, oy] = a.scene.origin; return [(t.bbox[0] + t.bbox[2]) / 2 + ox, (t.bbox[1] + t.bbox[3]) / 2 + oy]; }, s);
}

test('edit: select (click, Shift+click, window vs crossing box), move with snaps, nudge, delete, shared undo/redo', async () => {
  const page = await newPage();
  await openForEdit(page, 'house-plan.dxf');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 500, 300, 8300, 7500);
  const L0 = await ED.ent(page, 33);
  eq(L0.type, 'line', 'fixture: entity 33 is the FURNITURE line');
  await clickWorld(page, 2300, 6600);
  eq(JSON.stringify(await ED.sel(page)), '[33]', 'click selects the line');
  assert(/1 selected · Line · Layer FURNITURE · ByLayer/.test(await page.textContent('#st-info')), 'status bar: count, type, layer, colour: ' + await page.textContent('#st-info'));
  await page.keyboard.down('Shift'); await clickWorld(page, 3300, 1700); await page.keyboard.up('Shift');
  eq(JSON.stringify(await ED.sel(page)), '[33,34]', 'Shift+click adds the circle');
  await page.keyboard.down('Shift'); await clickWorld(page, 3300, 1700); await page.keyboard.up('Shift');
  eq(JSON.stringify(await ED.sel(page)), '[33]', 'Shift+click again removes it');
  await page.keyboard.press('Escape');
  eq((await ED.sel(page)).length, 0, 'Esc clears the selection');
  // window (left -> right) vs crossing (right -> left) over the lounge
  const a = await client(page, 4900, 500), b = await client(page, 7900, 2700);
  await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(...b, { steps: 8 });
  await shot(page, 'edit-box-window-dark-1440');
  await page.mouse.up();
  const win = await ED.sel(page);
  assert([39, 40, 51, 52].every((i) => win.includes(i)), 'window selects what is fully inside: ' + win);
  assert(!win.includes(2), 'window leaves out the wall that only crosses the box');
  await page.mouse.move(...b); await page.mouse.down(); await page.mouse.move(...a, { steps: 8 });
  await shot(page, 'edit-box-crossing-dark-1440');
  await page.mouse.up();
  const cr = await ED.sel(page);
  assert(cr.includes(2) && win.every((i) => cr.includes(i)), 'crossing adds what it touches: ' + cr);
  assert(!cr.includes(1), 'crossing ignores an outline whose box overlaps but whose lines are not touched');
  await shot(page, 'edit-selection-dark-1440');
  await page.keyboard.press('b'); await shot(page, 'edit-selection-paper-1440'); await page.keyboard.press('b');
  await page.keyboard.press('Escape');
  // move with snaps: grab the line's end, drop it on a wall corner (exact)
  await setSnap(page, true);
  await clickWorld(page, 2300, 6600);
  const g = await client(page, 1000, 6600), t = await client(page, 5100, 3500);
  await dragScreen(page, [g[0] + 3, g[1] + 2], [t[0] + 3, t[1] - 3], 14);
  const L1 = await ED.ent(page, 33);
  assert(nearPt(L1.a, [5100, 3500], 1e-6) && nearPt(L1.b, [7700, 3500], 1e-6), 'moved exactly onto the wall corner (endpoint snap): ' + JSON.stringify(L1));
  assert(await ED.dirty(page), 'dirty indicator after an edit');
  assert((await page.title()).startsWith('•'), 'tab title marks unsaved edits');
  // ortho with Shift: horizontal only
  await setSnap(page, false);
  const m1 = await client(page, 6400, 3500);
  await page.keyboard.down('Shift');
  await dragScreen(page, m1, [m1[0] + 60, m1[1] + 25], 10);
  await page.keyboard.up('Shift');
  const L2 = await ED.ent(page, 33);
  assert(L2.a[1] === 3500 && L2.a[0] > 5100, 'Shift keeps the move horizontal');
  // nudge: 1 px, Shift = 10 px
  const s = await ED.scale(page);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowUp');
  const L3 = await ED.ent(page, 33);
  assert(Math.abs(L3.a[0] - L2.a[0] - 1 / s) < 1e-6 && Math.abs(L3.a[1] - L2.a[1] - 10 / s) < 1e-6, 'arrow nudges in screen pixels');
  // delete, then one undo stack shared with markups
  await page.keyboard.press('Delete');
  eq(await ED.ent(page, 33), null, 'Delete removes the selection');
  await page.click('#tab-markup');
  await page.click('[data-tool="line"]');
  const p0 = await client(page, 1500, 1500);
  await dragScreen(page, p0, [p0[0] + 80, p0[1] + 40]);
  eq(await page.evaluate(() => window.__linework.markups.length), 1, 'markup added after the drawing edits');
  await page.keyboard.press('Control+z');
  eq(await page.evaluate(() => window.__linework.markups.length), 0, 'undo 1: the markup (most recent)');
  assert(await ED.ent(page, 33) === null, 'drawing edit still applied');
  await page.keyboard.press('Control+z');
  assert((await ED.ent(page, 33)) !== null, 'undo 2: the delete');
  for (let k = 0; k < 4; k++) await page.keyboard.press('Control+z');
  const back = await ED.ent(page, 33);
  assert(nearPt(back.a, L0.a, 0) && nearPt(back.b, L0.b, 0), 'undo back to the original position');
  assert(!(await ED.dirty(page)), 'no unsaved edits after undoing them all');
  for (let k = 0; k < 5; k++) await page.keyboard.press('Control+y');
  eq(await ED.ent(page, 33), null, 'redo all the way: deleted again');
  eq(await page.evaluate(() => window.__linework.markups.length), 0, 'markup redo is next in line');
  await page.keyboard.press('Control+y');
  eq(await page.evaluate(() => window.__linework.markups.length), 1, 'markup redone');
  await close(page);
});

test('edit: double-click text to type over it (TEXT and MTEXT); hint outside Edit mode', async () => {
  const page = await newPage();
  await openFixture(page, 'house-plan.dxf');
  await clearToasts(page);
  await page.waitForFunction(() => window.__linework.edit.ready);
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 3000, 1000, 10000, 7000);
  // View mode: a gentle hint with a button that switches to Edit
  const hall = await client(page, ...(await textAt(page, 'HALL')));
  await page.mouse.dblclick(...hall);
  await page.waitForSelector('.toast:has-text("Switch to Edit to change the drawing")');
  await shot(page, 'edit-hint-view-dark-1440');
  await page.click('.toast button:has-text("Edit this text")');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
  eq(await page.evaluate(() => window.__linework.tool), 'eselect', 'switched to Edit');
  eq(await page.inputValue('#ta-edit'), 'HALL', 'type-over box holds the text');
  await shot(page, 'edit-text-dark-1440');
  await page.keyboard.press('End');
  await page.keyboard.press('b'); // shortcuts (b = theme) are ignored while typing
  eq(await page.inputValue('#ta-edit'), 'HALLb', 'typing goes into the box');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('HALLWAY');
  await page.keyboard.press('Enter');
  eq((await ED.ent(page, 53)).text, 'HALLWAY', 'Enter commits single-line text');
  assert(await page.evaluate(() => window.__linework.scene.texts.some((t) => !t.dead && t.s === 'HALLWAY')), 'new text drawn');
  // Esc cancels
  await page.mouse.dblclick(...(await client(page, ...(await textAt(page, 'HALLWAY')))));
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
  await page.keyboard.type('XXX');
  await page.keyboard.press('Escape');
  eq((await ED.ent(page, 53)).text, 'HALLWAY', 'Esc cancels');
  // click-away commits
  await page.mouse.dblclick(...(await client(page, ...(await textAt(page, 'LOUNGE')))));
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
  await page.keyboard.type('SITTING ROOM');
  await page.mouse.click(...(await client(page, 9500, 6500)));
  eq((await ED.ent(page, 51)).text, 'SITTING ROOM', 'clicking away commits');
  // MTEXT: Enter = new line, Ctrl+Enter commits
  await page.keyboard.press('f');
  await page.mouse.dblclick(...(await client(page, ...(await textAt(page, 'GROUND FLOOR PLAN')))));
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
  eq((await page.inputValue('#ta-edit')).split('\n')[0], 'GROUND FLOOR PLAN', 'multi-line text loaded');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('FIRST FLOOR PLAN');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Scale 1:50');
  await page.keyboard.press('b');
  await page.keyboard.press('Backspace');
  assert(await page.isVisible('#edit-text'), 'Enter keeps editing multi-line text');
  await page.keyboard.press('Control+Enter');
  eq((await ED.ent(page, 59)).text, 'FIRST FLOOR PLAN\nScale 1:50', 'Ctrl+Enter commits multi-line text');
  await page.keyboard.press('b');
  await page.mouse.dblclick(...(await client(page, ...(await textAt(page, 'FIRST FLOOR PLAN')))));
  await shot(page, 'edit-text-paper-1440');
  await page.keyboard.press('Escape');
  await page.keyboard.press('b');
  await close(page);
});

test('edit: reshape with handles — drag, add (double-click a side), delete (right-click); circle radius; block hint', async () => {
  const page = await newPage();
  await openForEdit(page, 'house-plan.dxf');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await setSnap(page, false);
  await zoomTo(page, 4900, 300, 8300, 2000);
  const P0 = await ED.ent(page, 39);
  eq(P0.type, 'polyline', 'fixture: entity 39 is a polyline');
  const n0 = P0.pts.length / 2;
  // double-click a side: shows the points
  await page.mouse.dblclick(...(await client(page, (P0.pts[0] + P0.pts[2]) / 2, (P0.pts[1] + P0.pts[3]) / 2)));
  await page.waitForFunction(() => window.__linework.edit.vedit === 39);
  assert(/Drag a point/.test(await page.textContent('#tool-hint')), 'reshape hint shown');
  await shot(page, 'edit-handles-dark-1440');
  await page.keyboard.press('b'); await shot(page, 'edit-handles-paper-1440'); await page.keyboard.press('b');
  // drag the last vertex
  const vx = P0.pts[2 * n0 - 2], vy = P0.pts[2 * n0 - 1];
  await dragWorld(page, [vx, vy], [vx + 200, vy + 150]);
  const P1 = await ED.ent(page, 39);
  const s = await ED.scale(page);
  assert(nearPt([P1.pts[2 * n0 - 2], P1.pts[2 * n0 - 1]], [vx + 200, vy + 150], 1.5 / s), 'vertex dragged: ' + P1.pts.slice(-2));
  // Shift locks the handle horizontally
  await page.keyboard.down('Shift');
  await dragWorld(page, [P1.pts[0], P1.pts[1]], [P1.pts[0] - 150, P1.pts[1] + 120]);
  await page.keyboard.up('Shift');
  const P2 = await ED.ent(page, 39);
  eq(P2.pts[1], P1.pts[1], 'Shift keeps the point on its horizontal');
  // add a point: double-click the middle of the first side
  const mid = [(P2.pts[0] + P2.pts[2]) / 2, (P2.pts[1] + P2.pts[3]) / 2];
  await page.mouse.dblclick(...(await client(page, ...mid)));
  const P3 = await ED.ent(page, 39);
  eq(P3.pts.length / 2, n0 + 1, 'double-click on a side adds a point');
  assert(nearPt([P3.pts[2], P3.pts[3]], mid, 1.5 / s), 'new point on the side');
  // delete it again: right-click the point
  const c = await client(page, P3.pts[2], P3.pts[3]);
  await page.mouse.click(c[0], c[1], { button: 'right' });
  eq((await ED.ent(page, 39)).pts.length / 2, n0, 'right-click on a point deletes it');
  // right-click on a side adds one too
  const c2 = await client(page, ...mid);
  await page.mouse.click(c2[0], c2[1], { button: 'right' });
  eq((await ED.ent(page, 39)).pts.length / 2, n0 + 1, 'right-click on a side adds a point');
  await page.keyboard.press('Escape');
  eq(await page.evaluate(() => window.__linework.edit.vedit), -1, 'Esc leaves reshaping');
  // circle: centre + radius handles
  await zoomTo(page, 1500, 500, 4500, 2900);
  await page.mouse.dblclick(...(await client(page, 2700, 2300)));
  await page.waitForFunction(() => window.__linework.edit.vedit === 34);
  await dragWorld(page, [3300, 1700], [3500, 1700]);
  const C1 = await ED.ent(page, 34);
  assert(Math.abs(C1.r - 800) < 2 / s, 'radius handle: ' + C1.r);
  await dragWorld(page, [2700, 1700], [2900, 1800]);
  const C2 = await ED.ent(page, 34);
  assert(nearPt(C2.c, [2900, 1800], 2 / s) && Math.abs(C2.r - C1.r) < 1e-9, 'centre handle moves the circle');
  // blocks: a part that is not text gets the hint
  await page.keyboard.press('Escape');
  await page.keyboard.press('f');
  const door = await page.evaluate(() => { const a = window.__linework, s = a.scene, it = a.edit.doc.items(16); const p = it.prims[0], o = s.start[p] * 2; return [s.coords[o] + s.origin[0], s.coords[o + 1] + s.origin[1]]; });
  await page.mouse.dblclick(...(await client(page, ...door)));
  await page.waitForFunction(() => /double-click a text inside one to edit it/.test(document.querySelector('#tool-hint').textContent));
  await close(page);
});

test('edit: draw line (+typed length), polyline (C closes), rectangle, circle, text on a new layer; layer and colour changes', async () => {
  const page = await newPage();
  await openForEdit(page, 'house-plan.dxf');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await setSnap(page, false);
  await zoomTo(page, -3000, -6000, 15000, -500);
  const before = await ED.count(page);
  // new layer with a colour
  await page.selectOption('#sel-elayer', '__new');
  await page.waitForSelector('#dlg-layer[open]');
  await page.fill('#layer-name', 'E2E NEW');
  await page.click('#layer-swatches [aria-label="Green"]');
  await shot(page, 'edit-new-layer-dark-1440');
  await page.click('#btn-do-layer');
  await page.waitForFunction(() => document.querySelector('#sel-elayer').value !== '__new');
  eq(await page.inputValue('#sel-elayer'), 'E2E NEW', 'new layer is current');
  assert(await page.evaluate(() => window.__linework.scene.layers.some((l) => l.name === 'E2E NEW' && l.color === 0x00ff00)), 'layer in the drawing, green');
  // colour for new items
  await page.click('#btn-ecolor');
  await page.click('#color-pop button:has-text("Red")');
  eq((await page.textContent('#ecolor-label')).trim(), 'Red');
  const s = await ED.scale(page);
  const tol = 1.5 / s;
  // line chain: two clicks, then a typed length along the cursor direction
  await page.keyboard.press('n');
  eq(await page.evaluate(() => window.__linework.tool), 'eline', 'N = line in Edit');
  await clickWorld(page, 0, -2000);
  await clickWorld(page, 2000, -2000);
  const ln = await ED.last(page);
  eq(ln.type, 'line'); eq(ln.layer, 'E2E NEW'); eq(ln.color, 1);
  assert(nearPt(ln.a, [0, -2000], tol) && nearPt(ln.b, [2000, -2000], tol), 'line endpoints');
  const dir = await client(page, 2000, -1000); // straight up from the last point
  await page.mouse.move(...dir);
  await page.keyboard.type('1500');
  assert(await page.isVisible('#len-box'), 'typing a number opens the length box');
  await shot(page, 'edit-draw-length-dark-1440');
  await page.keyboard.press('Enter');
  const l2 = await ED.last(page);
  assert(Math.abs(Math.hypot(l2.b[0] - l2.a[0], l2.b[1] - l2.a[1]) - 1500) < 1e-6, 'typed length is exact');
  assert(Math.abs(l2.b[0] - l2.a[0]) < tol, 'along the cursor direction');
  await page.keyboard.press('Enter'); // stop the chain
  // polyline closed with C
  await page.keyboard.press('p');
  for (const q of [[4000, -2000], [6000, -2000], [5000, -4000]]) await clickWorld(page, ...q);
  await page.keyboard.press('c');
  const pl = await ED.last(page);
  eq(pl.type, 'polyline'); eq(pl.closed, true); eq(pl.pts.length, 6, 'three vertices, closed');
  // rectangle
  await page.keyboard.press('r');
  await clickWorld(page, 7000, -4500); await clickWorld(page, 9000, -2000);
  const rc = await ED.last(page);
  eq(rc.closed, true); eq(rc.pts.length, 8, 'rectangle = closed 4-vertex polyline');
  assert(nearPt([rc.pts[0], rc.pts[1]], [7000, -4500], tol) && nearPt([rc.pts[4], rc.pts[5]], [9000, -2000], tol), 'rectangle corners');
  // circle
  await page.keyboard.press('o');
  await clickWorld(page, 11000, -3000); await clickWorld(page, 12000, -3000);
  const ci = await ED.last(page);
  eq(ci.type, 'circle'); assert(Math.abs(ci.r - 1000) < tol, 'circle radius');
  // text
  await page.keyboard.press('t');
  await clickWorld(page, 0, -5000);
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
  await page.keyboard.type('NEW NOTE');
  await shot(page, 'edit-draw-text-dark-1440');
  await page.keyboard.press('Enter');
  const tx = await ED.last(page);
  eq(tx.type, 'text'); eq(tx.text, 'NEW NOTE'); eq(tx.layer, 'E2E NEW');
  eq(await ED.count(page), before + 6, 'six new items');
  await shot(page, 'edit-draw-dark-1440');
  // change layer and colour of a selection
  await page.keyboard.press('v');
  await clickWorld(page, 12000, -3000);
  eq(JSON.stringify(await ED.sel(page)), JSON.stringify([before + 4]), 'circle selected');
  await page.selectOption('#sel-elayer', 'TEXT');
  eq((await ED.last(page)) && (await ED.ent(page, before + 4)).layer, 'TEXT', 'selection moved to layer TEXT');
  await page.click('#btn-ecolor');
  await shot(page, 'edit-colours-dark-1440');
  await page.click('#color-pop button:has-text("Blue")');
  eq((await ED.ent(page, before + 4)).color, 5, 'selection recoloured');
  await page.click('#btn-ecolor');
  await page.click('#color-pop button:has-text("ByLayer")');
  eq((await ED.ent(page, before + 4)).color, 256, 'back to ByLayer');
  // undo everything: the new layer disappears again
  while (await page.evaluate(() => window.__linework.history.canUndo())) await page.click('#btn-eundo');
  eq(await page.evaluate(() => window.__linework.edit.doc.model.entities.filter(Boolean).length), before, 'all new items undone');
  assert(!(await page.evaluate(() => [...document.querySelectorAll('#sel-elayer option')].some((o) => o.value === 'E2E NEW'))), 'new layer undone');
  assert(!(await ED.dirty(page)), 'clean again');
  await close(page);
});

test('edit: Save DXF and re-open it; Save as DGN; DGN round trip keeps untouched bytes; lost-item warning; dirty + beforeunload', async () => {
  const page = await newPage();
  await openForEdit(page, 'house-plan.dxf');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await setSnap(page, true);
  await zoomTo(page, 500, 300, 8300, 7500);
  await clickWorld(page, 2300, 6600);
  const g = await client(page, 1000, 6600), t = await client(page, 5100, 3500);
  await dragScreen(page, [g[0] + 3, g[1] + 2], [t[0] + 3, t[1] - 3], 14);
  await page.mouse.dblclick(...(await client(page, ...(await textAt(page, 'HALL')))));
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
  await page.keyboard.press('Control+a'); await page.keyboard.type('HALL 2'); await page.keyboard.press('Enter');
  assert(await ED.dirty(page), 'unsaved');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-esave')]);
  eq(dl.suggestedFilename(), 'house-plan-edited.dxf', 'Save = same format, -edited name');
  const out1 = join(OUT, 'house-plan-edited.dxf');
  await dl.saveAs(out1);
  assert(!(await ED.dirty(page)), 'saved: indicator cleared');
  // re-open the downloaded file: the edits survived
  await page.setInputFiles('#file-input', out1);
  await page.waitForFunction(() => window.__linework.doc.name === 'house-plan-edited.dxf' && window.__linework.edit.ready);
  const moved = await page.evaluate(() => window.__linework.edit.doc.model.entities.some((e) => e && e.type === 'line' && e.layer === 'FURNITURE' && e.a[0] === 5100 && e.a[1] === 3500 && e.b[0] === 7700));
  assert(moved, 'moved line is in the saved file');
  assert(await page.evaluate(() => window.__linework.scene.texts.some((x) => x.s === 'HALL 2')), 'edited text is in the saved file');
  eq(await page.evaluate(() => window.__linework.scene.layers.length), 9, 'layers kept');
  // Save as DGN from a DXF
  await page.click('#tab-edit');
  await page.click('#btn-esaveas');
  await page.waitForSelector('#dlg-save[open]');
  await page.check('input[name="fmt"][value="DGN"]');
  eq(await page.inputValue('#save-name'), 'house-plan-edited-edited.dgn', 'name follows the format');
  assert(/levels 1–63/.test(await page.textContent('#save-notes')), 'explains layers -> levels');
  await shot(page, 'save-dialog-dark-1440');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btn-do-save')]);
  eq(dl2.suggestedFilename(), 'house-plan-edited-edited.dgn');
  const out2 = join(OUT, 'house-plan-as.dgn');
  await dl2.saveAs(out2);
  await page.setInputFiles('#file-input', out2);
  await page.waitForFunction(() => window.__linework.doc.name === 'house-plan-as.dgn');
  const dg = await page.evaluate(() => ({ fmt: window.__linework.scene.format, n: window.__linework.scene.n + window.__linework.scene.textCount, lv: window.__linework.scene.layers.filter((l) => l.count).map((l) => l.name) }));
  eq(dg.fmt, 'DGN', 'opens as DGN');
  assert(dg.n > 100 && dg.lv.every((n) => /^Level \d+$/.test(n)), 'items on levels: ' + JSON.stringify(dg));
  assert(await page.evaluate(() => window.__linework.scene.texts.some((x) => x.s === 'HALL 2')), 'edited text in the DGN too');
  // DGN round trip
  await openForEdit(page, 'site-plan.dgn');
  await setSnap(page, false);
  const orig = readFileSync(FIX('site-plan.dgn'));
  const st = await page.evaluate(() => { const m = window.__linework.edit.doc.model; const i = m.entities.findIndex((e) => e.layer === 'Level 2'); return { i, e: m.entities[i] }; });
  await clickWorld(page, st.e.pts[0], (st.e.pts[1] + st.e.pts[3]) / 2 + 0.0001);
  await page.keyboard.press('Shift+ArrowRight');
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  eq(dl3.suggestedFilename(), 'site-plan-edited.dgn', 'DGN saves as DGN');
  const out3 = join(OUT, 'site-plan-edited.dgn');
  await dl3.saveAs(out3);
  const nb = readFileSync(out3);
  let same = 0, deleted = 0;
  for (let o = 0; o + 4 <= orig.length;) {
    if (orig[o] === 0xff && orig[o + 1] === 0xff) break;
    const size = 4 + 2 * orig.readUInt16LE(o + 2);
    const a2 = orig.subarray(o, o + size), b2 = nb.subarray(o, o + size);
    if (a2.equals(b2)) same++;
    else { assert(b2[1] === (a2[1] | 0x80) && Buffer.compare(a2.subarray(2), b2.subarray(2)) === 0, `element at ${o} only gets its deleted bit`); deleted++; }
    o += size;
  }
  assert(same > 25 && deleted === 1, `untouched elements byte-identical (${same}), edited one deleted in place (${deleted})`);
  await page.setInputFiles('#file-input', out3);
  await page.waitForFunction(() => window.__linework.doc.name === 'site-plan-edited.dgn' && window.__linework.edit.ready);
  const after = await page.evaluate((x0) => window.__linework.edit.doc.model.entities.some((e) => e && e.layer === 'Level 2' && e.pts && Math.abs(e.pts[0] - x0) > 1e-9), st.e.pts[0]);
  assert(after, 'the moved shape is in the saved DGN');
  // items the reader could not load: warn before saving
  await openForEdit(page, 'edge-unknown-entities.dxf');
  await clickWorld(page, 5, 0); await page.keyboard.press('Delete');
  await page.click('#btn-esave');
  await page.waitForSelector('#dlg-save[open]');
  assert(/6 items from the original file weren.t loaded and won.t be in the saved copy/.test(await page.textContent('#save-warn')), 'lost-item warning');
  await page.click('#dlg-save button[value="cancel"]');
  // beforeunload while dirty
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.type()); d.dismiss().catch(() => {}); });
  const errs = page.errors.slice();
  await page.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 400));
  assert(dialogs.includes('beforeunload'), 'leaving with unsaved edits asks first');
  await page.ctx.close();
  assert(!errs.length, 'no console errors: ' + errs.join(' | '));
});

test('edit at 390 px with touch: tap to select, finger-drag to move, long-press menu, pinch still zooms', async () => {
  const page = await newPage({ context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } });
  await openFixture(page, 'house-plan.dxf');
  await clearToasts(page);
  await page.waitForFunction(() => window.__linework.edit.ready);
  await page.tap('#tab-edit');
  await page.tap('[data-tool="eselect"]');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 600, 5000, 4000, 8000);
  const cdp = await page.ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) });
  const m = await client(page, 2300, 6600);
  await touch('touchStart', [m]); await touch('touchEnd', []);
  eq(JSON.stringify(await ED.sel(page)), '[33]', 'tap selects');
  await shot(page, 'edit-selection-dark-390');
  // finger drag moves the selection
  await touch('touchStart', [m]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[m[0] + i * 6, m[1] - i * 4]]);
  await touch('touchEnd', []);
  const L = await ED.ent(page, 33);
  assert(L.a[0] > 1000 && L.a[1] > 6600, 'finger drag moved the line: ' + L.a);
  // long-press: context menu, Edit shows the points (big handles), Delete removes
  const m2 = await client(page, (L.a[0] + L.b[0]) / 2, L.a[1]);
  await touch('touchStart', [m2]); await page.waitForTimeout(750); await touch('touchEnd', []);
  await page.waitForSelector('#ctx-menu:not([hidden])');
  await shot(page, 'edit-longpress-dark-390');
  await page.tap('#ctx-menu button:has-text("Edit")');
  await page.waitForFunction(() => window.__linework.edit.vedit === 33);
  await shot(page, 'edit-handles-dark-390');
  await page.keyboard.press('b'); await shot(page, 'edit-handles-paper-390'); await page.keyboard.press('b');
  await touch('touchStart', [m2]); await page.waitForTimeout(750); await touch('touchEnd', []);
  await page.waitForSelector('#ctx-menu:not([hidden])');
  await page.tap('#ctx-menu button:has-text("Delete")');
  eq(await ED.ent(page, 33), null, 'long-press > Delete');
  await page.tap('#btn-eundo');
  assert((await ED.ent(page, 33)) !== null, 'Undo button brings it back');
  // two fingers still pan/zoom in Edit mode
  const s0 = await ED.scale(page);
  const box = await stageBox(page);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 40 - i * 12, cy], [cx + 40 + i * 12, cy]]);
  await touch('touchEnd', []);
  await settle(page);
  assert((await ED.scale(page)) > s0 * 1.8, 'pinch zooms in Edit mode');
  const layout = await page.evaluate(() => [window.innerWidth, document.documentElement.scrollWidth]);
  assert(layout[1] <= 390, 'no horizontal overflow at 390px');
  // text on a phone: long-press > Edit opens the type-over box
  await zoomTo(page, 1000, 4000, 4000, 5200);
  const bed = await client(page, ...(await textAt(page, 'BEDROOM')));
  await touch('touchStart', [bed]); await page.waitForTimeout(750); await touch('touchEnd', []);
  await page.waitForSelector('#ctx-menu:not([hidden])');
  await page.tap('#ctx-menu button:has-text("Edit")');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
  await shot(page, 'edit-text-dark-390');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__linework.fit());
  await settle(page);
  const lm = await client(page, (L.a[0] + L.b[0]) / 2, L.a[1]);
  await touch('touchStart', [lm]); await touch('touchEnd', []);
  await page.keyboard.press('b'); await shot(page, 'edit-selection-paper-390'); await page.keyboard.press('b');
  await shot(page, 'edit-dark-390');
  await close(page);
});

test('performance: Edit mode on the 53k stress drawing (box-select ~500 items, drag, commit, undo)', async () => {
  const page = await newPage();
  await openForEdit(page, 'stress-test-53k.dxf', 'stress');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await settle(page);
  await page.waitForTimeout(400);
  const record = async (action) => {
    await page.evaluate(() => { window.__frames = []; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__rec) requestAnimationFrame(tick); }; window.__rec = true; requestAnimationFrame(tick); });
    await action();
    const f = await page.evaluate(() => { window.__rec = false; return window.__frames.slice(2); });
    f.sort((x, y) => x - y);
    const pct = (p) => +f[Math.min(f.length - 1, Math.floor(p * (f.length - 1)))].toFixed(1);
    return { frames: f.length, medianMs: pct(0.5), p95Ms: pct(0.95), maxMs: pct(1) };
  };
  await page.evaluate(() => { window.__lt = []; const t0 = performance.now(); new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.startTime >= t0) window.__lt.push(+e.duration.toFixed(1)); }).observe({ type: 'longtask' }); });
  const a = await client(page, -3000, -3000), b = await client(page, 30500, 30500); // start in empty space (a press on an item moves it)
  const boxSelect = await record(async () => { await page.mouse.move(...a); await page.mouse.down(); for (let i = 1; i <= 30; i++) await page.mouse.move(a[0] + ((b[0] - a[0]) * i) / 30, a[1] + ((b[1] - a[1]) * i) / 30); await page.mouse.up(); await settle(page); });
  const sel = await page.evaluate(() => window.__linework.edit.lastSelect);
  assert(sel.count >= 450 && sel.count <= 700, `about 500 items selected (${sel.count})`);
  // drag the selection by grabbing one of its items
  await zoomTo(page, -1000, -1000, 31000, 31000);
  // grab a selected line near the middle (lines on the box edge overlap the next bay's lines)
  const grab = await page.evaluate(() => {
    const E = window.__linework.edit;
    let best = null, bd = Infinity;
    for (const k of E.sel) { const e = E.doc.model.entities[k]; if (e.type !== 'line') continue; const m = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]; const d = Math.hypot(m[0] - 15000, m[1] - 15000); if (d < bd) { bd = d; best = m; } }
    return best;
  });
  await setSnap(page, false);
  const g = await client(page, ...grab);
  const drag = await record(async () => { await page.mouse.move(...g); await page.mouse.down(); for (let i = 1; i <= 40; i++) await page.mouse.move(g[0] + i * 5, g[1] + i * 3); await page.mouse.up(); await settle(page); });
  const commit = await page.evaluate(() => window.__linework.edit.lastCommit);
  assert(commit.items === sel.count, 'one move for the whole selection');
  const after = await page.evaluate(async () => { const a2 = window.__linework; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const ms = []; for (let i = 0; i < 6; i++) ms.push(a2.renderer.render(a2.view, a2.renderOpts()).ms); ms.sort((x, y) => x - y); return +ms[3].toFixed(2); });
  const undoMs = await page.evaluate(() => { const t0 = performance.now(); window.__linework.undo(); return +(performance.now() - t0).toFixed(1); });
  const lt = await page.evaluate(() => window.__lt);
  // copy the ~500 items, paste them: the ghost follows the cursor smoothly, one quick commit
  const copyMs = await page.evaluate(() => { const t0 = performance.now(); window.__linework.edit.n = window.__linework.edit.doc.model.entities.length; document.execCommand('copy'); return +(performance.now() - t0).toFixed(1); });
  await page.mouse.move(g[0], g[1]);
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => !!window.__linework.edit.place);
  const ghost = await record(async () => { for (let i = 1; i <= 40; i++) await page.mouse.move(g[0] - i * 5, g[1] - i * 3); });
  const t1 = Date.now();
  await page.mouse.click(g[0] - 200, g[1] - 120);
  const pasted = await page.evaluate(() => ({ n: window.__linework.edit.doc.model.entities.length - window.__linework.edit.n, ms: window.__linework.edit.lastCommit.ms }));
  eq(pasted.n, sel.count, 'pasted every copied item');
  perf.editStress = { selected: sel.count, boxSelectMs: +sel.ms.toFixed(1), boxDragFrames: boxSelect, moveDragFrames: drag, commitMs: +commit.ms.toFixed(1), renderAfterCommitMs: after, undoMs, longTasks: lt,
    copyMs, pasteGhostFrames: ghost, pasteCommitMs: +pasted.ms.toFixed(1), pasteClickToDoneMs: Date.now() - t1 };
  await shot(page, 'perf-edit-stress');
  assert(drag.p95Ms < 50, `dragging ~500 items stays smooth (p95 ${drag.p95Ms} ms)`);
  assert(commit.ms < 300, `committing the move is quick (${commit.ms} ms)`);
  assert(copyMs < 300 && ghost.p95Ms < 50 && pasted.ms < 400, `copy ${copyMs} ms, paste ghost p95 ${ghost.p95Ms} ms, paste commit ${pasted.ms} ms`);
  await close(page);
});

test('edit: DGN drawing — cells move as one, colours come from the file colour table', async () => {
  const page = await newPage();
  await openForEdit(page, 'site-plan.dgn');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await setSnap(page, false);
  const cell = await page.evaluate(() => { const m = window.__linework.edit.doc.model; const i = m.entities.findIndex((e) => e.type === 'cell' && e.name === 'NORTH'); return { i, o: m.entities[i].origin }; });
  await zoomTo(page, cell.o[0] - 6, cell.o[1] - 6, cell.o[0] + 6, cell.o[1] + 6);
  const tip = [cell.o[0] - Math.sin(Math.PI / 6) * 3 * 1, cell.o[1] + Math.cos(Math.PI / 6) * 3];
  await clickWorld(page, ...tip);
  eq(JSON.stringify(await ED.sel(page)), JSON.stringify([cell.i]), 'clicking a component selects the whole cell');
  assert(/Cell “NORTH”/.test(await page.textContent('#st-info')), 'status names the cell');
  await page.click('#btn-erotate');
  const c2 = await ED.ent(page, cell.i);
  assert(Math.abs(Math.atan2(c2.mv[1], c2.mv[0]) - Math.PI / 2) < 1e-9, 'rotated 90 degrees as a whole');
  await page.click('#btn-ecolor');
  const labels = await page.$$eval('#color-pop button', (bs) => bs.map((b) => b.textContent.trim()));
  eq(labels.length, 256, 'DGN: the whole colour table of the file');
  assert(labels[3] === 'Colour 3' && labels[255] === 'Colour 255', 'labelled by colour index');
  await page.click('#color-pop button[title="Colour 3"]');
  const c3 = await ED.ent(page, cell.i);
  assert(c3.children.every((k) => k.ci === 3), 'components recoloured with table entry 3');
  const on = await page.evaluate((k) => { const a = window.__linework, s = a.scene, it = a.edit.doc.items(k); const p = it.prims[0], o = s.start[p] * 2; return [s.coords[o] + s.origin[0], s.coords[o + 1] + s.origin[1]]; }, cell.i);
  await page.mouse.dblclick(...(await client(page, ...on)));
  await page.waitForFunction(() => /double-click a text inside one to edit it/.test(document.querySelector('#tool-hint').textContent));
  await shot(page, 'edit-dgn-cell-dark-1440');
  await close(page);
});

test('edit: double-click a text inside a cell (DGN title block) or a block attribute (DXF) to type over it; saved', async () => {
  const page = await newPage();
  const typeOver = async (str, value) => {
    await page.mouse.dblclick(...(await client(page, ...(await textAt(page, str)))));
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
    eq(await page.inputValue('#ta-edit'), str, `editor holds "${str}"`);
    await page.keyboard.press('Control+a'); await page.keyboard.type(value); await page.keyboard.press('Enter');
  };
  await openForEdit(page, 'dgn-titleblock.dgn');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 46, -2, 93, 20);
  const ci = await page.evaluate(() => window.__linework.edit.doc.model.entities.findIndex((e) => e && e.type === 'cell' && e.name === 'TITLE'));
  assert(ci >= 0, 'title block cell');
  // a field of the title block
  await page.mouse.dblclick(...(await client(page, ...(await textAt(page, 'SHEET 1 OF 2')))));
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
  await shot(page, 'edit-cell-text-dark-1440');
  await page.keyboard.press('Control+a'); await page.keyboard.type('SHEET 2 OF 2'); await page.keyboard.press('Enter');
  let cell = await ED.ent(page, ci);
  eq(cell.children[3].text, 'SHEET 2 OF 2', 'field changed inside the cell');
  eq(cell.children.length, 6, 'cell keeps all its parts');
  assert(await page.evaluate(() => window.__linework.scene.texts.some((t) => !t.dead && t.s === 'SHEET 2 OF 2')), 'new text drawn');
  assert(await ED.dirty(page), 'unsaved');
  // text in a cell nested inside the cell
  await typeOver('OK', 'APPROVED');
  eq((await ED.ent(page, ci)).children[5].children[1].text, 'APPROVED', 'nested cell text');
  await page.keyboard.press('Control+z');
  eq((await ED.ent(page, ci)).children[5].children[1].text, 'OK', 'undo: one step');
  eq((await ED.ent(page, ci)).children[3].text, 'SHEET 2 OF 2', 'undo keeps the earlier edit');
  await page.keyboard.press('Control+y');
  eq((await ED.ent(page, ci)).children[5].children[1].text, 'APPROVED', 'redo');
  // the frame is not text: the cell still moves as a whole
  await page.mouse.dblclick(...(await client(page, 60, 2)));
  await page.waitForFunction(() => /double-click a text inside one to edit it/.test(document.querySelector('#tool-hint').textContent));
  // Save (same format) and reopen
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-esave')]);
  const out = join(OUT, 'titleblock-edited.dgn');
  await dl.saveAs(out);
  await page.setInputFiles('#file-input', out);
  await page.waitForFunction(() => window.__linework.doc.name === 'titleblock-edited.dgn' && window.__linework.edit.ready);
  const texts = await page.evaluate(() => window.__linework.scene.texts.filter((t) => !t.dead).map((t) => t.s).sort());
  eq(JSON.stringify(texts), JSON.stringify(['APPROVED', 'DRAWING TITLE', 'LOOSE NOTE', 'REV A', 'SHEET 2 OF 2']), 'the saved DGN has both edits');
  cell = await page.evaluate(() => { const c = window.__linework.edit.doc.model.entities.find((e) => e && e.type === 'cell' && e.name === 'TITLE'); return { n: c.children.length, nested: c.children[5].name }; });
  eq(JSON.stringify(cell), JSON.stringify({ n: 6, nested: 'STAMP' }), 'still one TITLE cell with the nested STAMP cell');
  // outside Edit mode, the hint's button opens the editor on that field
  await page.click('#tab-view');
  await page.click('[data-tool="pan"]');
  await zoomTo(page, 46, -2, 93, 20);
  await page.mouse.dblclick(...(await client(page, ...(await textAt(page, 'DRAWING TITLE')))));
  await page.waitForSelector('.toast:has-text("Switch to Edit to change the drawing")');
  await page.click('.toast button:has-text("Edit this text")');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
  eq(await page.inputValue('#ta-edit'), 'DRAWING TITLE', 'View-mode hint opens that field');
  await page.keyboard.press('Escape');
  // DXF: an attribute of one insert is editable; text from the block definition is shared, so it explains
  await openForEdit(page, 'bracket.dxf');
  const at = await page.evaluate(() => {
    const a = window.__linework, s = a.scene, [ox, oy] = s.origin;
    const c = (t) => [(t.bbox[0] + t.bbox[2]) / 2 + ox, (t.bbox[1] + t.bbox[3]) / 2 + oy];
    const attr = s.texts.find((t) => !t.dead && /^a\d+$/.test(t.sub || '') && t.s.trim());
    const ents = a.edit.doc.model.entities;
    const shared = s.texts.find((t) => !t.dead && (t.sub || '')[0] === '#' && t.s.trim() && ents[t.ent] && ents[t.ent].type === 'insert');
    return { attr: attr && { s: attr.s, ent: attr.ent, k: Number(attr.sub.slice(1)), at: c(attr) }, shared: shared && { at: c(shared), b: shared.bbox } };
  });
  assert(at.attr && at.shared, 'bracket has an attribute and block text');
  await zoomTo(page, at.attr.at[0] - 400, at.attr.at[1] - 250, at.attr.at[0] + 400, at.attr.at[1] + 250);
  await typeOver(at.attr.s, 'EDITED ATTRIBUTE');
  const ins = await ED.ent(page, at.attr.ent);
  eq(ins.attribs[at.attr.k].text, 'EDITED ATTRIBUTE', 'attribute changed on that insert');
  const sw = at.shared.b[2] - at.shared.b[0];
  await zoomTo(page, at.shared.at[0] - sw * 3, at.shared.at[1] - sw * 2, at.shared.at[0] + sw * 3, at.shared.at[1] + sw * 2);
  await page.mouse.dblclick(...(await client(page, ...at.shared.at)));
  await page.waitForFunction(() => /shared by every copy/.test(document.querySelector('#tool-hint').textContent));
  await close(page);
});

// ------------------------------------------------------------------ v0.3: DWG (LibreDWG WebAssembly)
const SW_SRC = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const READER_CACHE = /READER_CACHE = '([^']+)'/.exec(SW_SRC)[1];
const readerRequests = () => requests.filter((p) => /\/vendor\/libredwg\/|\/src\/formats\/dwg\.js$/.test(p)).map((p) => p.split('/').pop());

test('DWG: the reader loads only when a DWG is opened; open + measure under the deployed CSP (wasm-unsafe-eval, no unsafe-eval)', async () => {
  const page = await newPage();
  const csp = await page.evaluate(async () => (await fetch('index.html', { method: 'HEAD' })).headers.get('content-security-policy'));
  assert(/script-src 'self' 'wasm-unsafe-eval';/.test(csp) && !/'unsafe-eval'/.test(csp.replace(/'wasm-unsafe-eval'/g, '')), 'page served with the deployed CSP: ' + csp);
  // the CSP is enforced: code compiled from a string by the page itself is refused (DevTools'
  // page.evaluate is exempt, so the string goes through a timer)
  const evalBlocked = await page.evaluate(() => new Promise((res) => {
    document.addEventListener('securitypolicyviolation', (e) => res(`${e.violatedDirective} ${e.blockedURI}`), { once: true });
    setTimeout('window.__ranFromString = true', 0); // eslint-disable-line no-implied-eval
    setTimeout(() => res(window.__ranFromString ? 'ran' : 'no report'), 1000);
  }));
  assert(/^script-src/.test(evalBlocked) && /eval/.test(evalBlocked), 'the CSP blocks eval: ' + evalBlocked);
  page.allowErrors = [/Evaluating a string as JavaScript violates|Refused to evaluate a string/]; // the expected report of that test
  requests.length = 0;
  await openFixture(page, 'house-plan.dxf');
  const dxfItems = await page.evaluate(() => window.__linework.scene.n + window.__linework.scene.textCount);
  await openFixture(page, 'site-plan.dgn');
  eq(readerRequests().length, 0, 'DXF and DGN never load the DWG reader');
  await page.evaluate(() => { window.__labels = []; new MutationObserver(() => window.__labels.push(document.querySelector('#progress-label').textContent)).observe(document.querySelector('#progress-label'), { childList: true, characterData: true, subtree: true }); });
  await openFixture(page, 'dwg-house-plan.dwg');
  const loaded = readerRequests();
  assert(['dwg.js', 'libredwg-web.js', 'libredwg-web.wasm'].every((f) => loaded.filter((x) => x === f).length === 1), 'reader loaded once: ' + loaded);
  assert(await page.evaluate(() => window.__labels.some((l) => /Loading the DWG reader for dwg-house-plan\.dwg/.test(l))), 'progress names the reader download');
  const info = await page.evaluate(() => { const a = window.__linework; return { fmt: a.scene.format, v: a.scene.version, layers: a.scene.layers.length, n: a.scene.n + a.scene.textCount, title: document.querySelector('#doc-name').title }; });
  eq(info.fmt, 'DWG', 'format');
  eq(info.v, 'AC1015', 'version');
  eq(info.layers, 9, 'layers');
  eq(info.n, dxfItems, 'same number of items as the same drawing in DXF');
  assert(/DWG/.test(info.title), 'file info: ' + info.title);
  assert(!(await page.textContent('#toasts')).includes('not shown'), 'nothing reported as not shown');
  await shot(page, 'dwg-house-plan-dark-1440');
  // measure exactly as on the DXF (endpoint snaps -> exact)
  await clearToasts(page);
  await page.click('#tab-measure');
  await page.click('[data-tool="distance"]');
  await clickWorld(page, 0, 0, 4, -3);
  await clickWorld(page, 12000, 0, -3, -4);
  eq((await mcValue(page)).trim(), '12,000.00 mm', 'distance on the DWG');
  await page.keyboard.press('d');
  await clickWorld(page, 6000, 0, 5, -2);
  await clickWorld(page, 6000, 8000, -4, -3);
  eq((await mcValue(page)).trim(), '8,000.00 mm', 'midpoint snaps on the DWG');
  // layer toggle works on DWG layers (pixel check, as for DXF)
  await page.keyboard.press('Escape');
  const before = await pixelAt(page, 5300, 7350);
  assert(before[0] > 150 && before[1] < 90, 'door drawn red: ' + before);
  await page.locator('#layer-list li', { hasText: 'DOORS' }).locator('input').uncheck();
  await settle(page);
  const after = await pixelAt(page, 5300, 7350);
  assert(!(after[0] > 150 && after[1] < 90), 'door hidden: ' + after);
  // a second DWG: no second download
  requests.length = 0;
  await openFixture(page, 'dwg-bracket.dwg');
  eq(readerRequests().length, 0, 'the reader is downloaded once per session');
  eq(await page.evaluate(() => window.__linework.scene.format), 'DWG', 'second DWG');
  await shot(page, 'dwg-bracket-dark-1440');
  await close(page); // no console errors: a CSP violation would show here
});

test('DWG under a CSP without wasm-unsafe-eval: the reader is refused and the app says so (proves the CSP applies to it)', async () => {
  const strict = await startServer(0, '127.0.0.1', { headers: (h) => ({ ...h, 'Content-Security-Policy': h['Content-Security-Policy'].replace(" 'wasm-unsafe-eval'", '') }) });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${strict.address().port}/?nosw`);
  await page.waitForFunction(() => !!window.__linework);
  await page.setInputFiles('#file-input', FIX('dwg-bracket.dwg'));
  await page.waitForSelector('.toast.error');
  assert(/DWG reader could not be loaded/.test(await page.textContent('#toasts')), 'friendly message when WebAssembly is not allowed: ' + await page.textContent('#toasts'));
  await openSample(page, 'samples/bracket.dxf', 'bracket.dxf');
  eq(await page.evaluate(() => window.__linework.scene.format), 'DXF', 'DXF still works');
  await ctx.close();
  strict.close();
});

test('DWG: edit, Save (as DXF: Linework does not write DWG), re-open the DXF', async () => {
  const page = await newPage();
  await openForEdit(page, 'dwg-house-plan.dwg');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 500, 300, 8300, 7500);
  await page.mouse.dblclick(...(await client(page, ...(await textAt(page, 'HALL')))));
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
  await page.keyboard.press('Control+a'); await page.keyboard.type('HALL 2'); await page.keyboard.press('Enter');
  assert(await ED.dirty(page), 'unsaved');
  await page.click('#btn-esaveas');
  await page.waitForSelector('#dlg-save[open]');
  assert(/^Opened from a DWG\. Linework does not write DWG: save a DXF copy/.test(await page.textContent('#save-notes li')), 'the dialog says first, plainly, that DWG is not written');
  assert(await page.isChecked('input[name="fmt"][value="DXF"]'), 'DXF is the default');
  eq(await page.inputValue('#save-name'), 'dwg-house-plan-edited.dxf', 'default name');
  assert(/DWG-only data/.test(await page.textContent('#save-notes')), 'and what a DXF copy of a DWG leaves out');
  await shot(page, 'save-dialog-dwg-dark-1440');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-do-save')]);
  eq(dl.suggestedFilename(), 'dwg-house-plan-edited.dxf', 'downloads a DXF');
  const out = join(OUT, 'dwg-house-plan-edited.dxf');
  await dl.saveAs(out);
  assert(/Linework does not write DWG, so this is a DXF copy/.test(await page.textContent('#toasts')), 'save toast says so');
  assert(!(await ED.dirty(page)), 'saved');
  await page.setInputFiles('#file-input', out);
  await page.waitForFunction(() => window.__linework.doc.name === 'dwg-house-plan-edited.dxf' && window.__linework.edit.ready);
  eq(await page.evaluate(() => window.__linework.scene.format), 'DXF', 're-opened as DXF');
  assert(await page.evaluate(() => window.__linework.scene.texts.some((x) => x.s === 'HALL 2')), 'the edit is in the saved file');
  eq(await page.evaluate(() => window.__linework.scene.layers.length), 9, 'layers kept');
  // the Save button (same format) on a DWG also gives a DXF
  await openForEdit(page, 'dwg-bracket.dwg');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btn-esave')]);
  eq(dl2.suggestedFilename(), 'dwg-bracket-edited.dxf', 'Save on a DWG writes DXF');
  await close(page);
});

test('DWG offline: after the first DWG, the reader is cached and DWGs open with no network', async () => {
  const page = await newPage({ sw: true });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  await openFixture(page, 'dwg-schematic.dwg');
  await page.waitForFunction(async (name) => (await (await caches.open(name)).keys()).length === 2, READER_CACHE, { timeout: 30000 });
  assert(await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('linework-')).length === 2), 'app cache + reader cache');
  await page.ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !!window.__linework);
  await openFixture(page, 'dwg-schematic.dwg');
  eq(await page.evaluate(() => window.__linework.scene.format), 'DWG', 'DWG opens offline');
  assert(await page.evaluate(() => window.__linework.scene.n > 100), 'with its content');
  await page.ctx.setOffline(false);
  await close(page);
});

test('DWG guard rails: a time limit stops a stuck read (friendly message, previous drawing kept, next DWG opens)', async () => {
  const page = await newPage();
  await openFixture(page, 'house-plan.dxf');
  await page.evaluate(() => { window.__linework.readTimeLimitMs = 1; });
  await clearToasts(page);
  await page.setInputFiles('#file-input', FIX('dwg-bracket.dwg'));
  await page.waitForSelector('.toast.error');
  assert(/This DWG took too long to read; save it as DXF/.test(await page.textContent('#toasts')), 'friendly time-limit message');
  eq(await page.textContent('#doc-name'), 'house-plan.dxf', 'previous drawing still open');
  await page.evaluate(() => { window.__linework.readTimeLimitMs = 120000; });
  await openFixture(page, 'dwg-bracket.dwg');
  eq(await page.evaluate(() => window.__linework.scene.format), 'DWG', 'a fresh reader opens the next DWG');
  await close(page);
});

// ------------------------------------------------------------------ copy / paste, duplicate, line weights
const CLIP = { context: { permissions: ['clipboard-read', 'clipboard-write'] } };
const clipText = (page) => page.evaluate(() => navigator.clipboard.readText());
const entCount = (page) => page.evaluate(() => window.__linework.edit.doc.model.entities.filter(Boolean).length);
/** Line thickness (CSS px) where a column of the drawing canvas crosses the world point (x, y). */
async function strokeWidthAt(page, x, y) {
  return page.evaluate(([x, y]) => {
    const a = window.__linework, [sx, sy] = a.worldToScreen(x, y), d = a.dpr;
    const g = document.querySelector('#cv-drawing').getContext('2d').getImageData(Math.round(sx * d), Math.round(sy * d) - 40, 1, 81).data;
    let n = 0;
    for (let i = 0; i < g.length; i += 4) if (Math.abs(g[i] - g[0]) + Math.abs(g[i + 1] - g[1]) + Math.abs(g[i + 2] - g[2]) > 90) n++;
    return n / d;
  }, [x, y]);
}

test('copy / paste: a DGN line into a DXF (m -> mm), placed with a snapped click; save + reopen; Ctrl+Shift+V in place; one undo step', async () => {
  const page = await newPage(CLIP);
  await openForEdit(page, 'site-plan.dgn');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await setSnap(page, true);
  await zoomTo(page, 0, -2, 20, 12);
  await clickWorld(page, 8.6, 5.2);
  const src = await page.evaluate(() => { const E = window.__linework.edit; return JSON.parse(JSON.stringify(E.doc.model.entities[[...E.sel][0]])); });
  eq(src.type + ' ' + src.layer, 'line Level 5', 'selected the survey line');
  await page.keyboard.press('Control+c');
  const text = await clipText(page);
  assert(text.startsWith('LINEWORK-CLIPBOARD 1\n{'), 'system clipboard: header line + JSON');
  const clip = JSON.parse(text.slice(text.indexOf('{')));
  assert(clip.fid && clip.ents[0].dgn, 'DGN items carry their byte range with the file fingerprint (only the same file uses it)');
  assert(/Copied 1 item/.test(await page.textContent('#toasts')), 'copy toast');
  // another drawing in the same tab: Ctrl+V, the line follows the cursor, a click places it (snapped)
  await openForEdit(page, 'house-plan.dxf');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 500, 300, 8300, 7500);
  const n0 = await entCount(page);
  const corner = await client(page, 5100, 3500);
  await page.mouse.move(corner[0] + 30, corner[1] + 30);
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => !!window.__linework.edit.place);
  assert(/Click to place 1 item/.test(await page.textContent('#tool-hint')), 'placing hint');
  await page.mouse.move(corner[0] + 3, corner[1] - 2, { steps: 4 });
  await shot(page, 'paste-ghost-dark-1440');
  await page.mouse.click(corner[0] + 3, corner[1] - 2);
  eq(await entCount(page), n0 + 1, 'one item pasted');
  const p = await ED.last(page);
  assert(nearPt(p.a, [5100, 3500], 1e-6), 'base point (lower-left) snapped exactly onto the wall corner: ' + JSON.stringify(p.a));
  assert(nearPt(p.b, [5100 + (src.b[0] - src.a[0]) * 1000, 3500 + (src.b[1] - src.a[1]) * 1000], 1e-6), 'scaled from m to mm');
  eq(p.layer, 'Level 5', 'DGN level kept as a layer name');
  assert(/Scaled from m to mm/.test(await page.textContent('#toasts')), 'toast says it was scaled');
  eq(JSON.stringify(await ED.sel(page)), JSON.stringify([await page.evaluate(() => window.__linework.edit.doc.model.entities.length - 1)]), 'the pasted item is selected');
  assert(await page.evaluate(() => window.__linework.scene.layers.some((l) => l.name === 'Level 5' && !l.removed)), 'layer created');
  // save, reopen: still there
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  const out = join(OUT, 'house-plan-pasted.dxf');
  await dl.saveAs(out);
  await page.setInputFiles('#file-input', out);
  await page.waitForFunction(() => window.__linework.doc.name === 'house-plan-pasted.dxf' && window.__linework.edit.ready);
  assert(await page.evaluate(() => window.__linework.edit.doc.model.entities.some((e) => e && e.type === 'line' && e.layer === 'Level 5' && e.a[0] === 5100 && e.a[1] === 3500)), 'pasted line saved');
  // paste in place (original coordinates, scaled about the origin), one undo step
  await page.click('#tab-edit'); await page.click('[data-tool="eselect"]');
  const n1 = await entCount(page);
  await page.keyboard.press('Control+Shift+v');
  await page.waitForFunction((n) => window.__linework.edit.doc.model.entities.filter(Boolean).length === n + 1, n1);
  const q = await ED.last(page);
  assert(nearPt(q.a, [src.a[0] * 1000, src.a[1] * 1000], 1e-6), 'in place: ' + JSON.stringify(q.a));
  await page.keyboard.press('Control+z');
  eq(await entCount(page), n1, 'undo removes the paste in one step');
  // nothing open / typing: ignored
  await page.evaluate(() => { document.querySelector('#layer-filter').focus(); });
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(250);
  assert(!(await page.evaluate(() => window.__linework.edit.place)), 'a paste into a text box is left to the text box');
  await close(page);
});

test('copy / paste across two tabs (DGN title block cell -> site plan DGN), retype text in the pasted cell, save: original bytes untouched', async () => {
  const a = await newPage(CLIP);
  await openForEdit(a, 'dgn-titleblock.dgn');
  await a.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(a, 46, -2, 93, 20);
  await clickWorld(a, 60, 2);
  const ci = await a.evaluate(() => [...window.__linework.edit.sel][0]);
  eq((await ED.ent(a, ci)).name, 'TITLE', 'cell selected');
  await a.keyboard.press('Control+c');
  // a second tab in the same browser
  const b = await a.ctx.newPage();
  b.errors = [];
  b.on('pageerror', (e) => b.errors.push(e.message));
  b.on('console', (m) => { if (m.type() === 'error') b.errors.push(m.text()); });
  await b.goto(BASE + '?nosw');
  await b.waitForFunction(() => !!window.__linework);
  b.ctx = a.ctx;
  await openForEdit(b, 'site-plan.dgn');
  await b.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await setSnap(b, false);
  await zoomTo(b, -10, -20, 110, 70);
  const n0 = await entCount(b);
  const at = await client(b, 0, 60);
  await b.mouse.move(at[0], at[1]);
  await b.keyboard.press('Control+v');
  await b.waitForFunction(() => !!window.__linework.edit.place);
  await b.mouse.click(at[0], at[1]);
  eq(await entCount(b), n0 + 1, 'pasted in the other tab (system clipboard)');
  const cell = await ED.last(b);
  eq(cell.type + ' ' + cell.name, 'cell TITLE', 'still a cell');
  assert(!JSON.stringify(cell).includes('"dgn":'), 'no source byte ranges');
  assert(Math.abs(cell.origin[0] - 0) < 0.05 && Math.abs(cell.origin[1] - 60) < 0.05, 'lower-left at the click: ' + cell.origin);
  await shot(b, 'paste-cell-dgn-dark-1440');
  // the text inside the pasted cell can be retyped
  await zoomTo(b, -4, 56, 44, 78);
  await b.mouse.dblclick(...(await client(b, ...(await textAt(b, 'DRAWING TITLE')))));
  await b.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
  await b.keyboard.press('Control+a'); await b.keyboard.type('PASTED TITLE'); await b.keyboard.press('Enter');
  eq((await ED.last(b)).children[2].text, 'PASTED TITLE', 'retyped inside the pasted cell');
  const [dl] = await Promise.all([b.waitForEvent('download'), b.click('#btn-esave')]);
  const out = join(OUT, 'site-plan-pasted.dgn');
  await dl.saveAs(out);
  const orig = readFileSync(FIX('site-plan.dgn')), nb = readFileSync(out);
  let eod = 0;
  for (let o = 0; o + 2 <= orig.length;) { if (orig[o] === 0xff && orig[o + 1] === 0xff) { eod = o; break; } o += 4 + 2 * orig.readUInt16LE(o + 2); }
  assert(eod > 0 && nb.subarray(0, eod).equals(orig.subarray(0, eod)), 'every original element byte-identical');
  await b.setInputFiles('#file-input', out);
  await b.waitForFunction(() => window.__linework.doc.name === 'site-plan-pasted.dgn' && window.__linework.edit.ready);
  const back = await b.evaluate(() => { const c = window.__linework.edit.doc.model.entities.find((e) => e && e.type === 'cell' && e.name === 'TITLE'); return c && c.children.map((k) => k.text || k.type); });
  assert(back && back.includes('PASTED TITLE') && back.includes('cell'), 'reopened: the pasted cell (with its nested cell) and the new text: ' + back);
  assert(!b.errors.length, 'no console errors in the second tab: ' + b.errors.join(' | '));
  await close(a);
});

test('duplicate: Ctrl+D (click places), Ctrl+drag copy, ribbon Duplicate; each is one undo step (DGN)', async () => {
  const page = await newPage();
  await openForEdit(page, 'site-plan.dgn');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await setSnap(page, false);
  await zoomTo(page, 10, 5, 50, 35);
  await clickWorld(page, 30, 12);
  const i = await page.evaluate(() => [...window.__linework.edit.sel][0]);
  const orig = await ED.ent(page, i);
  eq(orig.layer, 'Level 2', 'building selected');
  const n0 = await entCount(page);
  // Ctrl+D: the copy follows the cursor; a click places its lower-left corner there
  const to = await client(page, 20, 20);
  await page.mouse.move(to[0] - 20, to[1]);
  await page.keyboard.press('Control+d');
  await page.waitForFunction(() => !!window.__linework.edit.place);
  await page.mouse.move(to[0], to[1], { steps: 3 });
  await page.mouse.click(to[0], to[1]);
  eq(await entCount(page), n0 + 1, 'Ctrl+D + click: one copy');
  const d = await ED.last(page);
  assert(nearPt([d.pts[0], d.pts[1]], [20, 20], 0.05), 'placed at the click: ' + d.pts.slice(0, 2));
  eq(JSON.stringify(await ED.ent(page, i)), JSON.stringify(orig), 'original untouched');
  eq(d.ci, orig.ci, 'same colour-table entry');
  await page.keyboard.press('Control+z');
  eq(await entCount(page), n0, 'undo: one step');
  // Esc cancels a duplicate
  await page.keyboard.press('Control+d');
  await page.keyboard.press('Escape');
  assert(!(await page.evaluate(() => window.__linework.edit.place)), 'Esc cancels');
  eq(await entCount(page), n0, 'nothing added');
  // Ctrl+drag: drop a copy, the original stays
  await clickWorld(page, 30, 12);
  const g = await client(page, 30, 12);
  await page.keyboard.down('Control');
  await page.mouse.move(g[0], g[1]); await page.mouse.down();
  await page.mouse.move(g[0] + 40, g[1] - 60, { steps: 8 });
  assert(/Copy/.test(await page.textContent('#tool-hint')), 'hint says Copy while Ctrl is held');
  eq(await page.evaluate(() => document.querySelector('#cv-overlay').className), 'copy', 'copy cursor');
  await page.mouse.up();
  await page.keyboard.up('Control');
  eq(await entCount(page), n0 + 1, 'Ctrl+drag: a copy');
  eq(JSON.stringify(await ED.ent(page, i)), JSON.stringify(orig), 'original not moved');
  const s = await ED.scale(page);
  const c = await ED.last(page);
  assert(Math.abs(c.pts[0] - orig.pts[0] - 40 / s) < 1e-6 && Math.abs(c.pts[1] - orig.pts[1] - 60 / s) < 1e-6, 'copy moved by the drag');
  await page.keyboard.press('Control+z');
  eq(await entCount(page), n0, 'undo: one step');
  // the ribbon button
  await clickWorld(page, 30, 12);
  await page.click('#btn-edup');
  await page.waitForFunction(() => !!window.__linework.edit.place);
  await page.mouse.click(to[0], to[1]);
  eq(await entCount(page), n0 + 1, 'ribbon Duplicate');
  await close(page);
});

test('line weight: ribbon Weight changes the selection (DXF lineweight, DGN weight); drawn thicker; saved and reopened', async () => {
  const page = await newPage();
  await openForEdit(page, 'house-plan.dxf');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 500, 5000, 4000, 8000);
  const w0 = await strokeWidthAt(page, 2300, 6600);
  await clickWorld(page, 2300, 6600);
  eq(JSON.stringify(await ED.sel(page)), '[33]', 'line selected');
  assert(/Weight ByLayer/.test(await page.textContent('#st-info')), 'status shows the weight');
  await page.click('#btn-eweight');
  const labels = await page.$$eval('#color-pop button', (bs) => bs.map((x) => x.textContent.trim()));
  eq(labels.length, 25, 'ByLayer + 24 standard lineweights');
  eq(labels[0] + '|' + labels[labels.length - 1], 'ByLayer|2.11 mm', 'list');
  await shot(page, 'edit-weight-menu-dark-1440');
  await page.click('#color-pop button:has-text("2.00 mm")');
  eq((await ED.ent(page, 33)).lw, 200, 'lineweight set');
  assert(/Weight 2\.00 mm/.test(await page.textContent('#st-info')), 'status: ' + await page.textContent('#st-info'));
  await page.keyboard.press('Escape');
  await settle(page);
  const w1 = await strokeWidthAt(page, 2300, 6600);
  assert(w0 <= 2.5 && w1 >= 6, `drawn thicker: ${w0} px -> ${w1} px`);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-esave')]);
  const out = join(OUT, 'house-plan-weight.dxf');
  await dl.saveAs(out);
  assert(/\n370\r?\n200\r?\n/.test(readFileSync(out, 'latin1')), 'group 370 written');
  await page.setInputFiles('#file-input', out);
  await page.waitForFunction(() => window.__linework.doc.name === 'house-plan-weight.dxf' && window.__linework.edit.ready);
  await zoomTo(page, 500, 5000, 4000, 8000);
  eq((await ED.ent(page, 33)).lw, 200, 'reopened: lineweight kept');
  assert((await strokeWidthAt(page, 2300, 6600)) >= 6, 'and drawn thick');
  // DGN: weight 0-31
  await openForEdit(page, 'site-plan.dgn');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await setSnap(page, false);
  await zoomTo(page, 10, 5, 50, 35);
  const v0 = await strokeWidthAt(page, 30, 12);
  await clickWorld(page, 30, 12);
  const i = await page.evaluate(() => [...window.__linework.edit.sel][0]);
  await page.click('#btn-eweight');
  eq(await page.locator('#color-pop button').count(), 32, 'DGN weights 0-31');
  await page.click('#color-pop button:text-is("6")');
  eq((await ED.ent(page, i)).weight, 6, 'weight set');
  await page.keyboard.press('Escape');
  await settle(page);
  const v1 = await strokeWidthAt(page, 30, 12);
  assert(v1 >= v0 + 3, `DGN: drawn thicker: ${v0} px -> ${v1} px`);
  // changing the selection's weight leaves the weight for new items alone; without a selection it sets it
  eq((await page.textContent('#eweight-label')).trim(), '0', 'deselected: the Weight box shows the current weight again');
  await page.click('#btn-eweight');
  await page.click('#color-pop button:text-is("6")');
  await page.click('[data-tool="eline"]');
  await clickWorld(page, 12, 30); await clickWorld(page, 25, 30); await page.keyboard.press('Escape');
  eq((await ED.last(page)).weight, 6, 'a new line has the current weight');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btn-esave')]);
  const out2 = join(OUT, 'site-plan-weight.dgn');
  await dl2.saveAs(out2);
  await page.setInputFiles('#file-input', out2);
  await page.waitForFunction(() => window.__linework.doc.name === 'site-plan-weight.dgn' && window.__linework.edit.ready);
  const ws = await page.evaluate(() => window.__linework.edit.doc.model.entities.filter((e) => e && e.weight === 6).map((e) => e.type));
  eq(JSON.stringify(ws.sort()), JSON.stringify(['line', 'polyline']), 'reopened: weights kept');
  await close(page);
});

test('copy / paste / duplicate at 390 px with touch: ribbon buttons, tap to place, long-press menu Duplicate', async () => {
  const page = await newPage({ context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } });
  await openFixture(page, 'site-plan.dgn');
  await clearToasts(page);
  await page.waitForFunction(() => window.__linework.edit.ready);
  await page.tap('#tab-edit');
  await page.tap('[data-tool="eselect"]');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 10, 5, 50, 35);
  const cdp = await page.ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) });
  const tap = async (pt) => { await touch('touchStart', [pt]); await touch('touchEnd', []); };
  const m = await client(page, 30, 12);
  await tap(m);
  const i = await page.evaluate(() => [...window.__linework.edit.sel][0]);
  assert(i >= 0, 'tap selects');
  const n0 = await entCount(page);
  await page.tap('#btn-ecopy');
  await page.tap('#btn-epaste');
  await page.waitForFunction(() => !!window.__linework.edit.place);
  assert(/Tap to place/.test(await page.textContent('#tool-hint')), 'touch hint');
  assert(await page.isVisible('#finish-bar'), 'Finish / Cancel bar while placing');
  await shot(page, 'paste-ghost-dark-390');
  const t = await client(page, 15, 25);
  await tap(t);
  eq(await entCount(page), n0 + 1, 'tap places the paste');
  assert(nearPt((await ED.last(page)).pts.slice(0, 2), [15, 25], 0.1), 'at the tap');
  // long-press > Duplicate, then Finish places it where it is shown
  await touch('touchStart', [m]); await page.waitForTimeout(750); await touch('touchEnd', []);
  await page.waitForSelector('#ctx-menu:not([hidden])');
  await shot(page, 'edit-longpress-menu-dark-390');
  await page.tap('#ctx-menu button:has-text("Duplicate")');
  await page.waitForFunction(() => !!window.__linework.edit.place);
  await page.tap('#btn-finish');
  eq(await entCount(page), n0 + 2, 'Duplicate from the long-press menu');
  await page.tap('#btn-eundo');
  eq(await entCount(page), n0 + 1, 'Undo: one step');
  // long-press on empty space: Paste here
  const e = await client(page, 48, 33);
  await touch('touchStart', [e]); await page.waitForTimeout(750); await touch('touchEnd', []);
  await page.waitForSelector('#ctx-menu:not([hidden])');
  await page.tap('#ctx-menu button:has-text("Paste here")');
  eq(await entCount(page), n0 + 2, 'Paste here');
  const layout = await page.evaluate(() => [window.innerWidth, document.documentElement.scrollWidth]);
  assert(layout[1] <= 390, 'no horizontal overflow at 390px');
  await page.tap('#btn-eweight');
  await shot(page, 'edit-weight-menu-dark-390');
  await close(page);
});

// ------------------------------------------------------------------ UI fixes and hardening
/** A screen point over empty drawing space (the Select tool's hover finds nothing there). */
async function emptySpot(page) {
  const box = await stageBox(page);
  for (const [fx, fy] of [[0.5, 0.06], [0.04, 0.5], [0.96, 0.5], [0.5, 0.94], [0.1, 0.1], [0.9, 0.9], [0.1, 0.9], [0.9, 0.1]]) {
    const p = [box.x + box.w * fx, box.y + box.h * fy];
    await page.mouse.move(p[0], p[1]);
    if (await page.evaluate(() => window.__linework.edit.hover === -1)) return p;
  }
  throw new Error('no empty spot');
}
const toastTexts = (page) => page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()));

test('edit keys and menus: the Edit tab starts Select; desktop right-click menu; keys after a layer checkbox; Ctrl+D / Ctrl+A kept from the browser; Esc in a draw tool; C in a short polyline', async () => {
  const page = await newPage();
  await openFixture(page, 'house-plan.dxf');
  await clearToasts(page);
  await page.waitForFunction(() => window.__linework.edit.ready);
  const prevented = await page.evaluate(() => ['d', 'a'].map((key) => { const e = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; }));
  eq(JSON.stringify(prevented), '[true,true]', 'Ctrl+D (bookmark) and Ctrl+A (select the page) never reach the browser');
  await page.click('#tab-edit');
  eq(await page.evaluate(() => window.__linework.tool), 'eselect', 'the Edit tab starts the Select tool');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 500, 5000, 4000, 8000);
  // right-click on an item: the menu opens (and stays open)
  const p = await client(page, 2300, 6600);
  await page.mouse.click(p[0], p[1], { button: 'right' });
  await settle(page);
  assert(await page.isVisible('#ctx-menu'), 'right-click menu is shown');
  eq(JSON.stringify(await ED.sel(page)), '[33]', 'the item under the cursor is selected');
  await shot(page, 'edit-context-menu-dark-1440');
  const n0 = await entCount(page);
  await page.click('#ctx-menu button:has-text("Delete")');
  eq(await entCount(page), n0 - 1, 'Delete from the menu');
  assert(await page.isHidden('#ctx-menu'), 'the menu closes');
  await page.keyboard.press('Control+z');
  eq(await entCount(page), n0, 'undone');
  // keyboard in the menu: arrow keys move, Esc closes
  await page.mouse.click(p[0], p[1], { button: 'right' });
  await settle(page);
  eq(await page.evaluate(() => document.activeElement.textContent), 'Edit…', 'the menu has the keyboard focus');
  await page.keyboard.press('ArrowDown');
  eq(await page.evaluate(() => document.activeElement.textContent), 'Copy', 'ArrowDown moves to the next item');
  await page.keyboard.press('Escape');
  assert(await page.isHidden('#ctx-menu'), 'Esc closes the menu');
  // right-click on empty space after a copy: Paste here
  await page.mouse.click(p[0], p[1]);
  await page.keyboard.press('Control+c');
  const e = await emptySpot(page);
  await page.mouse.click(e[0], e[1], { button: 'right' });
  await settle(page);
  assert(await page.isVisible('#ctx-menu button:has-text("Paste here")'), 'Paste here on empty space');
  await page.click('#ctx-menu button:has-text("Paste here")');
  eq(await entCount(page), n0 + 1, 'pasted where clicked');
  // single-key shortcuts still work after clicking a layer checkbox; Space toggles the checkbox
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = false; });
  const walls = await page.evaluate(() => window.__linework.scene.layers.findIndex((l) => l.name === 'WALLS'));
  const cb = `#layer-list input[data-i="${walls}"]`;
  await page.click(cb);
  const off = await page.evaluate((s) => !document.querySelector(s).checked, cb);
  assert(off, 'the click switched the layer off');
  await page.keyboard.press('Space');
  assert(await page.evaluate((s) => document.querySelector(s).checked, cb), 'Space toggles the focused checkbox (no pan)');
  eq(await page.evaluate(() => document.activeElement.type), 'checkbox', 'focus is still on the checkbox');
  await page.keyboard.press('n');
  eq(await page.evaluate(() => window.__linework.tool), 'eline', 'N after a checkbox picks the Line tool');
  // Esc in a draw tool with nothing in progress: back to Select (not out of Edit)
  await page.keyboard.press('Escape');
  eq(await page.evaluate(() => window.__linework.tool), 'eselect', 'Esc in Line: back to Select');
  // C in a polyline with fewer than 3 points: nothing is lost, no markup cloud
  await page.click('#btn-close-layers');
  await page.keyboard.press('p');
  await clickWorld(page, 1000, 6000); await clickWorld(page, 2000, 6000);
  await page.keyboard.press('c');
  eq(await page.evaluate(() => window.__linework.tool), 'epoly', 'C does not switch to the markup cloud');
  assert(await page.evaluate(() => !!window.__linework.edit.draft && window.__linework.edit.draft.pts.length === 4), 'the polyline being drawn is kept');
  await clickWorld(page, 1500, 7000);
  await page.keyboard.press('c');
  const pl = await ED.last(page);
  eq(pl.type, 'polyline'); eq(pl.closed, true); eq(pl.pts.length, 6, 'C closes it once it has 3 points');
  await close(page);
});

test('hidden layers: Ctrl+A, box and click skip them; new items on a hidden level offer "Show"; the default layer is a visible one; DGN Level box without "0"; Layers panel follows edits', async () => {
  const page = await newPage();
  await openForEdit(page, 'edge-first-layer-off.dxf');
  eq(await page.inputValue('#sel-elayer'), 'B-SHOWN', 'the current layer starts on a visible layer');
  await openForEdit(page, 'site-plan.dgn');
  const opts = await page.$$eval('#sel-elayer option', (os) => os.map((o) => o.value));
  assert(!opts.includes('0') && opts.includes('Level 2'), 'DGN Level box: levels only, no "0": ' + opts.join(','));
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = false; });
  await zoomTo(page, 10, 5, 50, 35);
  const lv2 = await page.evaluate(() => window.__linework.scene.layers.findIndex((l) => l.name === 'Level 2'));
  const onL2 = () => page.evaluate(() => window.__linework.edit.doc.model.entities.filter((x) => x && x.layer === 'Level 2').length);
  const selOnL2 = () => page.evaluate(() => { const E = window.__linework.edit; return [...E.sel].filter((i) => E.doc.model.entities[i].layer === 'Level 2').length; });
  // a selected item disappears from the selection when its level is hidden
  await clickWorld(page, 30, 12);
  eq(await selOnL2(), 1, 'a Level 2 item selected');
  await page.click(`#layer-list input[data-i="${lv2}"]`);
  eq((await ED.sel(page)).length, 0, 'hiding its level drops it from the selection');
  const n2 = await onL2();
  assert(n2 > 0, 'Level 2 has items');
  await page.keyboard.press('Control+a');
  assert((await ED.sel(page)).length > 5 && (await selOnL2()) === 0, 'Ctrl+A selects what can be seen, nothing on the hidden level');
  await page.keyboard.press('Delete');
  eq(await onL2(), n2, 'so Delete leaves the hidden items alone');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__linework.fit());
  await settle(page);
  const box = await stageBox(page);
  await dragScreen(page, [box.x + 4, box.y + 4], [box.x + box.w - 4, box.y + box.h - 4]);
  assert((await ED.sel(page)).length > 5 && (await selOnL2()) === 0, 'a box around everything skips the hidden level');
  await page.keyboard.press('Escape');
  await zoomTo(page, 10, 5, 50, 35);
  await clickWorld(page, 30, 12);
  eq(await selOnL2(), 0, 'a hidden item cannot be clicked');
  // the Layers panel follows edits (counts), undo and redo
  const countL2 = () => page.evaluate((i) => Number(document.querySelector(`#layer-list .ln-count[data-i="${i}"]`).textContent), lv2);
  const c0 = await countL2();
  // drawing on a hidden level: say so, with a button that shows it
  await page.selectOption('#sel-elayer', 'Level 2');
  await page.keyboard.press('n');
  await clickWorld(page, 12, 30); await clickWorld(page, 25, 30); await page.keyboard.press('Escape');
  eq((await ED.last(page)).layer, 'Level 2', 'drawn on Level 2');
  eq(await countL2(), c0 + 1, 'the panel count follows the edit');
  await page.waitForSelector('.toast:has-text("hidden level")');
  await shot(page, 'edit-hidden-level-toast-dark-1440');
  await page.click('.toast button:has-text("Show level")');
  assert(await page.evaluate((i) => !!window.__linework.layerVisible[i] && document.querySelector(`#layer-list input[data-i="${i}"]`).checked, lv2), 'Show level switched it on');
  await page.keyboard.press('Control+z');
  eq(await countL2(), c0, 'and undo');
  await page.keyboard.press('Control+y');
  eq(await countL2(), c0 + 1, 'and redo');
  // a new level appears in the panel at once (even before it has items)
  await page.keyboard.press('Escape');
  await page.selectOption('#sel-elayer', '__new');
  await page.waitForSelector('#dlg-layer[open]');
  const lname = await page.inputValue('#layer-name');
  await page.click('#btn-do-layer');
  await page.waitForFunction((n) => [...document.querySelectorAll('#layer-list .lname')].some((x) => x.textContent === n), lname);
  eq(await page.inputValue('#sel-elayer'), lname, 'the new level is current');
  const counts = await page.evaluate(() => [document.querySelector('#layers-count').textContent, document.querySelectorAll('#layer-list li').length]);
  eq(counts[0], `(${counts[1]})`, 'the panel count matches its rows');
  await close(page);
});

test('paste: other text on the clipboard falls back to the copy made in this tab, else "Nothing to paste"; damaged copies are refused safely', async () => {
  const page = await newPage({ context: { permissions: ['clipboard-read', 'clipboard-write'] } });
  await openForEdit(page, 'site-plan.dgn');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 10, 5, 50, 35);
  const pasteEvent = (txt) => page.evaluate((t) => { const dt = new DataTransfer(); dt.setData('text/plain', t); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, txt);
  await pasteEvent('some text from another program');
  await page.waitForSelector('.toast:has-text("Nothing to paste")');
  await clearToasts(page);
  // copy an item; other text on the system clipboard then pastes this tab's copy (keyboard path)
  await clickWorld(page, 30, 12);
  await page.keyboard.press('Control+c');
  await page.evaluate(() => navigator.clipboard.writeText('some text from another program'));
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => !!window.__linework.edit.place, null, { timeout: 3000 });
  eq(await page.evaluate(() => window.__linework.edit.place.r.ents.length), 1, 'the in-tab copy follows the cursor');
  await page.keyboard.press('Escape');
  // a damaged or hostile Linework copy: nothing half-pasted, no error, nothing polluted
  const n0 = await entCount(page);
  await clearToasts(page);
  await pasteEvent('LINEWORK-CLIPBOARD 1\n{"v":1,"ents":[{"type":"line","layer":"x"}],"blocks":{"__proto__":{"name":"x","base":[0,0],"entities":[]}},"ltypes":{"__proto__":{"p":1}}}');
  await page.waitForSelector('.toast:has-text("Nothing could be pasted")');
  eq(await entCount(page), n0, 'nothing added');
  assert(!(await page.evaluate(() => window.__linework.edit.place)), 'nothing to place');
  eq(await page.evaluate(() => ({}).p === undefined && ({}).polluted === undefined), true, 'Object.prototype untouched');
  await close(page);
});

test('performance + saving: Ctrl+A on the 53k drawing < 300 ms, panning with all selected >= 30 fps, undo of delete-all < 1 s; Save as DXF of 53k items; a failing save is reported and keeps the edits', async () => {
  const page = await newPage();
  await openForEdit(page, 'stress-test-53k.dxf', 'stress');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await page.focus('#stage');
  await page.waitForTimeout(300);
  const key = (k, o) => page.evaluate(async ([k, o]) => {
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    await raf();
    const t0 = performance.now();
    document.querySelector('#stage').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
    await raf(); await raf(); // the frame that shows the result has been drawn
    return performance.now() - t0;
  }, [k, o]);
  const selectAllMs = await key('a', { ctrlKey: true });
  const n = await page.evaluate(() => window.__linework.edit.sel.size);
  eq(n, 53100, 'Ctrl+A selected everything');
  // pan with the middle button while everything is selected
  const box = await stageBox(page);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  await page.evaluate(() => { window.__frames = []; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__rec) requestAnimationFrame(tick); }; window.__rec = true; requestAnimationFrame(tick); });
  await page.mouse.move(cx, cy); await page.mouse.down({ button: 'middle' });
  for (let i = 0; i < 40; i++) await page.mouse.move(cx - i * 5, cy - i * 2);
  await page.mouse.up({ button: 'middle' });
  const f = (await page.evaluate(() => { window.__rec = false; return window.__frames.slice(2); })).sort((a, b) => a - b);
  const panMedian = +f[Math.floor(f.length / 2)].toFixed(1);
  await page.waitForTimeout(300);
  await key('Delete', {});
  eq(await entCount(page), 0, 'deleted everything');
  const undoMs = await key('z', { ctrlKey: true });
  eq(await entCount(page), 53100, 'undo brings everything back');
  perf.bigSelection = { selectAllMs: +selectAllMs.toFixed(0), panMedianMs: panMedian, panFrames: f.length, undoDeleteAllMs: +undoMs.toFixed(0) };
  assert(selectAllMs < 300, `Ctrl+A on 53k items: ${selectAllMs.toFixed(0)} ms`);
  assert(panMedian <= 34, `pan with everything selected: median frame ${panMedian} ms`);
  assert(undoMs < 1000, `undo of delete-all: ${undoMs.toFixed(0)} ms`);
  await shot(page, 'edit-select-all-53k-dark-1440');
  // Save as DXF of all 53k items (this used to overflow the call stack)
  await page.keyboard.press('Escape');
  await page.click('#btn-esaveas');
  await page.check('#save-form input[value="DXF"]');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#btn-do-save')]);
  const out = join(OUT, 'stress-saved.dxf');
  await dl.saveAs(out);
  const lines = readFileSync(out, 'latin1').split(/\r?\n/);
  assert(lines.length > 53100 * 10, 'a full DXF was written');
  // a failing save (an item the writer cannot handle): an error message, no download, the edits stay
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.evaluate(() => { const bad = {}; Object.defineProperty(bad, 'type', { get() { throw new Error('damaged item'); } }); window.__linework.edit.doc.model.entities.push(bad); });
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.click('#btn-esave');
  await page.waitForSelector('.toast.error:has-text("Could not save")');
  await page.waitForTimeout(300);
  assert(!downloaded, 'nothing downloaded');
  assert(await ED.dirty(page), 'still marked unsaved');
  await close(page);
});

test('hostile files and Cancel: tiny files expanding to 10^8 copies open quickly with "copies not shown"; Cancel stops an open; a new file replaces one still opening', async () => {
  const page = await newPage();
  for (const name of ['edge-huge-array.dxf', 'edge-nested-huge.dxf']) {
    const t0 = Date.now();
    await openFixture(page, name);
    const ms = Date.now() - t0;
    const ns = await page.evaluate(() => window.__linework.scene.notShown);
    assert(ms < 20000, `${name} opened in ${ms} ms`);
    assert(ns['Block copies (too many to draw)'] > 0, name + ': copies reported: ' + JSON.stringify(ns));
    assert((await toastTexts(page)).some((t) => /not shown/.test(t)), 'the "not shown" message');
    perf['hostile:' + name] = ms;
  }
  await shot(page, 'hostile-nested-dark-1440');
  // Cancel while the stress drawing is being read
  await page.evaluate(() => { window.__linework.openSample('stress'); });
  await page.waitForSelector('#btn-cancel-load:visible');
  await page.click('#btn-cancel-load');
  await page.waitForFunction(() => !window.__linework.loading, null, { timeout: 5000 });
  assert(await page.isHidden('#progress'), 'progress closed');
  eq(await page.evaluate(() => window.__linework.doc.name), 'edge-nested-huge.dxf', 'the open drawing stays');
  // a file chosen while another is still opening replaces it
  await page.evaluate(() => { window.__linework.openSample('stress'); });
  await page.waitForSelector('#progress:not([hidden])');
  await openFixture(page, 'house-plan.dxf');
  await page.waitForTimeout(2500);
  eq(await page.evaluate(() => window.__linework.doc.name), 'house-plan.dxf', 'the later file wins');
  assert(!(await page.evaluate(() => window.__linework.loading)), 'not stuck loading');
  await close(page);
});

test('390 px: toasts sit below the multi-line tool hint; touch wording (tap Paste / tap Cancel); long-press after a tap opens the menu without reshaping', async () => {
  const page = await newPage({ context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } });
  await openFixture(page, 'site-plan.dgn');
  await clearToasts(page);
  await page.waitForFunction(() => window.__linework.edit.ready);
  await page.tap('#tab-edit');
  eq(await page.evaluate(() => window.__linework.tool), 'eselect', 'tapping the Edit tab starts Select');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 10, 5, 50, 35);
  const cdp = await page.ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) });
  const tap = async (pt) => { await touch('touchStart', [pt]); await touch('touchEnd', []); };
  const m = await client(page, 30, 12);
  await tap(m);
  await page.tap('#btn-ecopy');
  await page.waitForSelector('#toasts .toast');
  const r = await page.evaluate(() => { const h = document.querySelector('#tool-hint'), t = document.querySelector('#toasts .toast'); return { hint: h.hidden ? null : h.getBoundingClientRect().bottom, top: t.getBoundingClientRect().top, lines: Math.round(h.getBoundingClientRect().height / 16) }; });
  assert(r.hint !== null && r.top >= r.hint, `the toast (top ${r.top}) is below the hint (bottom ${r.hint})`);
  const t = (await toastTexts(page)).join(' ');
  assert(/tap Paste/.test(t) && !/Ctrl/.test(t), 'touch wording: ' + t);
  await shot(page, 'edit-toast-below-hint-dark-390');
  await page.tap('#btn-epaste');
  await page.waitForFunction(() => !!window.__linework.edit.place);
  const hint = await page.textContent('#tool-hint');
  assert(/Tap to place/.test(hint) && /tap Cancel/.test(hint) && !/Esc/.test(hint), 'placing hint: ' + hint);
  await page.tap('#btn-cancel-draft');
  await close(page);
  // a quick tap, then a long-press on the same item (a fresh page): the browser reports the
  // long-press's release as a double-tap; it must open the menu only, not the reshape handles
  const pg = await newPage({ context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  await openFixture(pg, 'site-plan.dgn');
  await clearToasts(pg);
  await pg.waitForFunction(() => window.__linework.edit.ready);
  await pg.tap('#tab-edit');
  await pg.evaluate(() => { window.__dbl = 0; document.querySelector('#cv-overlay').addEventListener('dblclick', () => window.__dbl++); });
  const cdp2 = await pg.ctx.newCDPSession(pg);
  const q = await client(pg, 30, 12);
  await pg.touchscreen.tap(q[0], q[1]);
  await pg.waitForTimeout(300);
  await cdp2.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: q[0], y: q[1] }] });
  await pg.waitForTimeout(800);
  await cdp2.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pg.waitForTimeout(300);
  assert(await pg.isVisible('#ctx-menu'), 'long-press menu');
  assert(await pg.evaluate(() => window.__dbl > 0), 'the browser sent the double-tap this checks');
  eq(await pg.evaluate(() => window.__linework.edit.vedit), -1, 'no reshape handles');
  await close(pg);
});

test('ribbon: Layer, Colour and Weight show the selection and change only it, the current values for new items stay; DGN colour grid (whole table) with arrow keys; a toast never blocks starting a markup', async () => {
  const page = await newPage();
  await openForEdit(page, 'house-plan.dxf');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 500, 5000, 4000, 8000);
  const label = (id) => page.evaluate((s) => document.querySelector(s).textContent.trim(), id);
  // current colour for new items: Red
  await page.click('#btn-ecolor');
  await page.click('#color-pop button:has-text("Red")');
  eq(await label('#ecolor-label'), 'Red', 'current colour');
  const cur = await page.inputValue('#sel-elayer');
  // the selection's own values are shown
  await clickWorld(page, 2300, 6600);
  eq(await label('#ecolor-label'), 'ByLayer', "the selection's colour");
  assert(await page.evaluate(() => document.querySelector('#btn-ecolor').closest('.field').classList.contains('for-sel')), 'marked as the selection');
  await page.click('#btn-ecolor');
  await page.click('#color-pop button:has-text("Blue")');
  eq((await ED.ent(page, 33)).color, 5, 'the selection is recoloured');
  eq(await label('#ecolor-label'), 'Blue', 'and shown');
  await page.click('#btn-eweight');
  await page.click('#color-pop button:has-text("0.50 mm")');
  eq((await ED.ent(page, 33)).lw, 50, 'the selection gets the weight');
  await page.selectOption('#sel-elayer', 'TEXT');
  eq((await ED.ent(page, 33)).layer, 'TEXT', 'the selection moves to the layer');
  await zoomTo(page, 500, 1000, 4000, 8000);
  await page.keyboard.down('Shift'); await clickWorld(page, 3300, 1700); await page.keyboard.up('Shift');
  eq(JSON.stringify(await ED.sel(page)), '[33,34]', 'two items');
  eq(await label('#ecolor-label'), 'Varies', 'a mixed selection says so');
  eq(await page.evaluate(() => document.querySelector('#sel-elayer').selectedOptions[0].textContent), 'Varies', 'the Layer box too');
  await page.keyboard.press('Escape');
  eq(await label('#ecolor-label'), 'Red', 'the current colour for new items did not change');
  eq(await label('#eweight-label'), 'ByLayer', 'nor the current weight');
  eq(await page.inputValue('#sel-elayer'), cur, 'nor the current layer');
  await page.keyboard.press('n');
  await clickWorld(page, 1000, 6000); await clickWorld(page, 2000, 6000); await page.keyboard.press('Escape');
  const ln = await ED.last(page);
  eq(ln.color, 1, 'a new line gets the current colour'); eq(ln.layer, cur, 'and layer'); eq(ln.lw, undefined, 'and weight (ByLayer)');
  // a toast at the top centre does not block a markup started under it (its buttons still work)
  await page.click('#tab-markup');
  eq(await page.evaluate(() => window.__linework.tool), 'pan', 'leaving the Edit tab leaves Edit mode');
  await page.click('[data-tool="rect"]');
  await page.evaluate(() => { document.querySelector('#toasts').innerHTML = '<div class="toast info"><div class="msg">A message at the top of the drawing<small>with some detail under it</small></div><button type="button" class="btn sm">OK</button></div>'; });
  const tb = await page.evaluate(() => { const r = document.querySelector('#toasts .toast .msg').getBoundingClientRect(); const b = document.querySelector('#toasts .toast button').getBoundingClientRect(); return { m: [r.left + r.width / 2, r.top + r.height / 2], b: [b.left + b.width / 2, b.top + b.height / 2] }; });
  eq(await page.evaluate(([x, y]) => document.elementFromPoint(x, y).tagName, tb.b), 'BUTTON', "the toast's button still takes clicks");
  const mk0 = await page.evaluate(() => window.__linework.markups.length);
  await dragScreen(page, tb.m, [tb.m[0] + 80, tb.m[1] + 60]);
  eq(await page.evaluate(() => window.__linework.markups.length), mk0 + 1, 'the markup was drawn from under the toast');
  // DGN: the whole colour table as a grid, keyboard friendly
  page.once('dialog', (d) => d.accept()); // "unsaved edits: open another drawing anyway?"
  await openForEdit(page, 'site-plan.dgn');
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 10, 5, 50, 35);
  await clickWorld(page, 30, 12);
  const i = await page.evaluate(() => [...window.__linework.edit.sel][0]);
  await page.click('#btn-ecolor');
  eq(await page.locator('#color-pop button').count(), 256, '256 colours');
  await shot(page, 'edit-dgn-colour-grid-dark-1440');
  const start = await page.evaluate(() => Number(document.activeElement.title.replace('Colour ', '')));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  const want = start + 17;
  eq(await page.evaluate(() => document.activeElement.title), 'Colour ' + want, 'arrow keys move through the grid');
  await page.keyboard.press('Enter');
  eq((await ED.ent(page, i)).ci, want, 'Enter picks the colour');
  assert(await page.isHidden('#color-pop'), 'and closes the grid');
  eq(await page.evaluate(() => document.activeElement.id), 'btn-ecolor', 'focus goes back to the Colour button');
  await close(page);
});

test('version, help, kept markups: about shows src/version.js; help lists Ctrl+A, arrow keys and touch; markups are kept per file revision; Clear stored markups; writers load when Edit opens', async () => {
  const page = await newPage();
  const v = readFileSync(join(ROOT, 'src/version.js'), 'utf8').match(/LINEWORK_VERSION = '([^']+)'/)[1];
  assert((await page.textContent('#about-line')).includes(`Linework ${v} `), 'about line has the version');
  const help = await page.textContent('#dlg-help');
  for (const s of ['Select everything on the visible layers', 'Arrow keys', 'Long-press', 'Two fingers', 'Esc'] ) assert(help.includes(s), 'help mentions ' + s);
  // markups are kept per file revision: same name, same size, other content
  const openAs = async (fixture, name) => {
    await page.evaluate(() => { window.__prev = window.__linework.scene; });
    await page.setInputFiles('#file-input', { name, mimeType: 'application/dxf', buffer: readFileSync(FIX(fixture)) });
    await page.waitForFunction(() => window.__linework.scene && window.__linework.scene !== window.__prev && !window.__linework.loading);
    await settle(page);
  };
  await openAs('edge-rev-1.dxf', 'revision.dxf');
  const h1 = await page.evaluate(() => window.__linework.doc.hash);
  assert(/^[0-9a-f]{16}$/.test(h1), 'content hash: ' + h1);
  await page.click('#tab-markup'); await page.click('[data-tool="rect"]');
  const box = await stageBox(page);
  await dragScreen(page, [box.x + box.w * 0.4, box.y + box.h * 0.4], [box.x + box.w * 0.6, box.y + box.h * 0.6]);
  eq(await page.evaluate(() => window.__linework.markups.length), 1, 'a markup');
  await openAs('edge-rev-2.dxf', 'revision.dxf');
  assert(await page.evaluate((h) => window.__linework.doc.hash !== h, h1), 'the other revision has another hash');
  eq(await page.evaluate(() => window.__linework.markups.length), 0, 'the other revision does not get those markups');
  await openAs('edge-rev-1.dxf', 'revision.dxf');
  eq(await page.evaluate(() => window.__linework.markups.length), 1, 'the same revision gets them back');
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('linework:autosave:')));
  assert(keys.length === 1 && keys[0].endsWith(':' + h1), 'kept under name + size + hash: ' + keys.join(','));
  await page.click('#btn-help');
  await page.click('#btn-clear-stored');
  await page.waitForSelector('.toast:has-text("Cleared")');
  eq(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('linework:autosave:')).length), 0, 'Clear stored markups');
  await page.keyboard.press('Escape');
  // the writers are fetched when Edit opens, not at save time (a page saves with its own code)
  const fetched = () => page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((n) => /(dxf|dgn)-write\.js/.test(n)).length);
  eq(await fetched(), 0, 'not loaded before Edit');
  await page.waitForFunction(() => window.__linework.edit.ready);
  await page.click('#tab-edit');
  await page.waitForFunction(() => performance.getEntriesByType('resource').filter((r) => /(dxf|dgn)-write\.js/.test(r.name)).length === 2, null, { timeout: 5000 });
  await close(page);
});

// ------------------------------------------------------------------ run
let failed = 0;
for (const t of tests) {
  if (filter && !t.name.includes(filter)) continue;
  const t0 = Date.now();
  try {
    await t.fn();
    results.push({ name: t.name, ok: true, ms: Date.now() - t0 });
    console.log(`ok   ${t.name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    results.push({ name: t.name, ok: false, error: String(e.stack || e) });
    console.log(`FAIL ${t.name}\n     ${String(e.message || e).split('\n').join('\n     ')}`);
  }
}
writeFileSync(join(OUT, 'perf.json'), JSON.stringify(perf, null, 2));
writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log('\nperf:', JSON.stringify(perf, null, 2));
console.log(`\n${results.length - failed}/${results.length} e2e tests passed; screenshots in ${OUT}`);
console.log(readdirSync(OUT).filter((f) => f.endsWith('.png')).length + ' screenshots');
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
