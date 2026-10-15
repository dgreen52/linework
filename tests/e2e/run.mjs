#!/usr/bin/env node
// End-to-end tests (Playwright, no test-runner dependency).
//   NODE_PATH=<a node_modules folder that has playwright> node tests/e2e/run.mjs [filter]
// Screenshots + perf.json are written to tests/e2e/out/. Only SYNTHETIC fixtures are used.
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, inflateSync } from 'node:zlib';
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
  assert(!startup.has('src/formats/pdf.js') && !startup.has('src/app/pdf-ui.js') && ![...startup].some((p) => p.startsWith('vendor/')), 'the DWG and PDF readers are not loaded at startup');
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
  assert(offGz < 320 * 1024, `offline app shell gzip ${offGz} < 320 KB`);
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
  // CSV: every finished measurement in a list (numbers in drawing units, the unit, the points), downloaded
  assert(!(await page.isHidden('#btn-csv-measure')), 'the CSV button shows once there is a measurement');
  const [mdl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-csv-measure')]);
  eq(mdl.suggestedFilename(), 'house-plan-measurements.csv', 'measurement CSV file name');
  const mPath = join(OUT, 'measurements.csv');
  await mdl.saveAs(mPath);
  const mRows = readFileSync(mPath, 'utf8').split('\r\n');
  eq(mRows[0], 'n,type,value,unit,dx,dy,angle_deg,segments,perimeter,corners,points', 'measurement CSV header');
  eq(mRows.slice(1, 5).map((r) => r.split(',').slice(1, 4).join(' ')).join(' | '),
    'distance 12000 mm | length 20000 mm | area 96000000 mm² | distance 8000 mm', 'one row per measurement, in order');
  eq(mRows[1].split(',').slice(4, 7).join(' '), '12000 0 0', 'dx, dy, angle of the first distance');
  eq(mRows[3].split(',')[10], '0 0; 12000 0; 12000 8000; 0 8000', 'the area\'s corners, snapped');
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
  // resize handles (loaded with Select): select the box by its outline, drag its east handle out, undo;
  // Shift+drag a corner keeps the proportions
  const bbOf = (pts) => { const xs = pts.filter((_, i) => i % 2 === 0), ys = pts.filter((_, i) => i % 2 === 1); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const rectPts = () => page.evaluate(() => window.__linework.markups.find((m) => m.type === 'rect').pts.slice());
  const r0 = await rectPts(), b0 = bbOf(r0);
  await page.waitForFunction(() => !!window.__linework.mh);
  const top = await client(page, (b0[0] + b0[2]) / 2, b0[3]);
  await page.mouse.click(top[0], top[1]);
  eq(await page.evaluate(() => window.__linework.markups.find((m) => m.id === window.__linework.selected).type), 'rect', 'box selected by its outline');
  await shot(page, 'markup-handles-dark-1440');
  const east = await client(page, b0[2], (b0[1] + b0[3]) / 2);
  await dragScreen(page, east, [east[0] + 60, east[1] + 25]);
  const b1 = bbOf(await rectPts());
  assert(b1[2] > b0[2] && Math.abs(b1[0] - b0[0]) < 1e-6 && Math.abs(b1[1] - b0[1]) < 1e-6 && Math.abs(b1[3] - b0[3]) < 1e-6, 'east handle: only the east side moved ' + JSON.stringify([b0, b1]));
  eq(await count(), 9, 'resizing adds nothing');
  await page.keyboard.press('Control+z');
  eq(JSON.stringify(await rectPts()), JSON.stringify(r0), 'undo the resize');
  const ne = await client(page, b0[2], b0[3]);
  await page.keyboard.down('Shift');
  await dragScreen(page, ne, [ne[0] + 50, ne[1] - 4]);
  await page.keyboard.up('Shift');
  const b2 = bbOf(await rectPts());
  assert(Math.abs((b2[2] - b2[0]) / (b2[3] - b2[1]) - (b0[2] - b0[0]) / (b0[3] - b0[1])) < 1e-6 && b2[2] > b0[2] && Math.abs(b2[0] - b0[0]) < 1e-6 && Math.abs(b2[1] - b0[1]) < 1e-6, 'Shift+corner keeps the proportions from the opposite corner');
  await page.keyboard.press('Control+z');
  // the markup list: every markup, filter, a row selects and zooms, × deletes (undo brings it back), close
  await page.click('#btn-markup-list');
  await page.waitForSelector('#markup-list:not([hidden])');
  eq(await page.textContent('#ml-title'), 'Markups (9)', 'the list counts every markup');
  eq(await page.locator('#ml-list li').count(), 9, 'a row each');
  eq(await page.getAttribute('#btn-markup-list', 'aria-pressed'), 'true', 'the List button is pressed');
  await page.fill('#ml-filter', 'door');
  eq(await page.textContent('#ml-title'), 'Markups (1 of 9)', 'filtered by text');
  await page.click('#ml-list [data-go]');
  eq(await page.evaluate(() => window.__linework.markups.find((m) => m.id === window.__linework.selected).type), 'callout', 'a row selects its markup');
  eq(await page.evaluate(() => window.__linework.tool), 'select', 'with the Select tool');
  eq(await page.locator('#ml-list li.on').count(), 1, 'its row is marked');
  await shot(page, 'markup-list-dark-1440');
  await page.evaluate(() => document.querySelector('[data-action="theme"]').click());
  await settle(page);
  await shot(page, 'markup-list-paper-1440');
  await page.evaluate(() => document.querySelector('[data-action="theme"]').click());
  await settle(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.click('#btn-markup-list'); // (closes it: the layer panel, opened on the desktop, covers it now)
  await page.click('#btn-markup-list'); // on a phone it docks at the bottom and the layer panel makes way
  assert(await page.isHidden('#layers-panel'), 'the layer panel closes on a phone');
  const mlBox = await page.locator('#markup-list').boundingBox();
  assert(mlBox && mlBox.y > 844 / 2 && mlBox.x >= 0 && mlBox.x + mlBox.width <= 390, 'docked at the bottom, inside the screen ' + JSON.stringify(mlBox));
  await shot(page, 'markup-list-dark-390');
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page);
  await page.fill('#ml-filter', 'e2e tester');
  eq(await page.locator('#ml-list li').count(), 9, 'filtered by author');
  await page.fill('#ml-filter', '');
  await page.click('#ml-list li:first-child [data-del]');
  eq(await count(), 8, 'x deletes');
  eq(await page.textContent('#ml-title'), 'Markups (8)', 'the list follows');
  await page.keyboard.press('Control+z');
  eq(await count(), 9, 'undo the delete');
  eq(await page.textContent('#ml-title'), 'Markups (9)', 'the list follows undo');
  await page.click('#ml-close');
  assert(await page.isHidden('#markup-list'), 'closed');
  eq(await page.getAttribute('#btn-markup-list', 'aria-pressed'), 'false', 'the List button is released');
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
  assert(await page.isVisible('#print-root svg'), 'print sheet (vector) visible in print media');
  assert(await page.isHidden('.topbar'), 'UI hidden in print media');
  await page.screenshot({ path: join(OUT, 'print-emulation-bracket.png') });
  const pdf = await page.pdf({ landscape: true, printBackground: true, preferCSSPageSize: true });
  writeFileSync(join(OUT, 'print-bracket.pdf'), pdf);
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  eq(pages, 1, 'fits on one landscape page');
  assert(pdfInfo(pdf).box[2] > pdfInfo(pdf).box[3], 'landscape page');
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
  // v0.4 modules loaded after start-up or on first use come from the offline cache too
  await page.waitForFunction(() => !!window.__linework.files, null, { timeout: 10000 });
  assert(await page.evaluate(async () => { const c = await caches.open((await caches.keys()).find((k) => k.startsWith('linework-') && !k.includes('reader'))); return (await Promise.all(['src/app/compare.js', 'src/tools/compare.js', 'src/app/print-svg.js', 'src/app/store.js', 'src/app/files.js'].map((p) => c.match(p)))).every(Boolean); }), 'compare, print and file modules are precached');
  await page.evaluate(() => window.__linework.printSheet({ sheet: 'a4', orient: 'landscape', scale: 'Fit', area: 'all' }));
  assert(await page.evaluate(() => !!document.querySelector('#print-root svg')), 'vector print works offline');
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

test('edit: reshape with handles — drag, add (double-click a side), delete (right-click); circle radius; a block opens the block editor', async () => {
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
  // blocks: a part that is not text opens the block editor (and Cancel without changes leaves at once)
  await page.keyboard.press('Escape');
  await page.keyboard.press('f');
  const door = await page.evaluate(() => { const a = window.__linework, s = a.scene, it = a.edit.doc.items(16); const p = it.prims[0], o = s.start[p] * 2; return [s.coords[o] + s.origin[0], s.coords[o + 1] + s.origin[1]]; });
  await page.mouse.dblclick(...(await client(page, ...door)));
  await page.waitForFunction(() => !!window.__linework.blockEdit);
  eq(await page.evaluate(() => window.__linework.blockEdit.name), 'DOOR', 'the block of the door');
  await page.click('#block-bar [data-act="cancel"]');
  await page.waitForFunction(() => !window.__linework.blockEdit);
  eq((await ED.ent(page, 16)).block, 'DOOR', 'back on the drawing, nothing changed');
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
  await page.waitForFunction(() => !!window.__linework.blockEdit);
  eq(JSON.stringify(await page.evaluate(() => { const B = window.__linework.blockEdit; return [B.cell, B.name, window.__linework.edit.doc.model.entities.length === B.before.children.length]; })), '[true,"NORTH",true]', 'a component opens the cell editor on its parts');
  await clearToasts(page);
  await shot(page, 'edit-dgn-cell-dark-1440');
  await page.click('#block-bar [data-act="cancel"]');
  await page.waitForFunction(() => !window.__linework.blockEdit);
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
  // the frame is not text: it opens the cell editor (Cancel: nothing changed)
  await page.mouse.dblclick(...(await client(page, 60, 2)));
  await page.waitForFunction(() => window.__linework.blockEdit && window.__linework.blockEdit.name === 'TITLE');
  await page.click('#block-bar [data-act="cancel"]');
  await page.waitForFunction(() => !window.__linework.blockEdit);
  eq((await ED.ent(page, ci)).children[5].children[1].text, 'APPROVED', 'the cell as it was');
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
  // DXF: an attribute of one insert is retyped in place; text of the block definition (shared) in the block editor
  await openForEdit(page, 'bracket.dxf');
  const at = await page.evaluate(() => {
    const a = window.__linework, s = a.scene, [ox, oy] = s.origin;
    const c = (t) => [(t.bbox[0] + t.bbox[2]) / 2 + ox, (t.bbox[1] + t.bbox[3]) / 2 + oy];
    const attr = s.texts.find((t) => !t.dead && /^a\d+$/.test(t.sub || '') && t.s.trim());
    const ents = a.edit.doc.model.entities;
    const shared = s.texts.find((t) => !t.dead && (t.sub || '')[0] === '#' && t.s.trim() && ents[t.ent] && ents[t.ent].type === 'insert');
    return { attr: attr && { s: attr.s, ent: attr.ent, k: Number(attr.sub.slice(1)), at: c(attr) }, shared: shared && { s: shared.s, at: c(shared), b: shared.bbox } };
  });
  assert(at.attr && at.shared, 'bracket has an attribute and block text');
  await zoomTo(page, at.attr.at[0] - 400, at.attr.at[1] - 250, at.attr.at[0] + 400, at.attr.at[1] + 250);
  await typeOver(at.attr.s, 'EDITED ATTRIBUTE');
  const ins = await ED.ent(page, at.attr.ent);
  eq(ins.attribs[at.attr.k].text, 'EDITED ATTRIBUTE', 'attribute changed on that insert');
  const sw = at.shared.b[2] - at.shared.b[0];
  await zoomTo(page, at.shared.at[0] - sw * 3, at.shared.at[1] - sw * 2, at.shared.at[0] + sw * 3, at.shared.at[1] + sw * 2);
  await page.mouse.dblclick(...(await client(page, ...at.shared.at)));
  await page.waitForFunction(() => !!window.__linework.blockEdit);
  await typeOver(at.shared.s, 'SHARED TEXT EDITED');
  await page.click('#block-bar [data-act="done"]');
  await page.waitForFunction(() => !window.__linework.blockEdit);
  assert(await page.evaluate(() => window.__linework.scene.texts.some((t) => !t.dead && t.s === 'SHARED TEXT EDITED')), 'the block text changed in the drawing');
  eq((await ED.ent(page, at.attr.ent)).attribs[at.attr.k].text, 'EDITED ATTRIBUTE', 'the attribute edit is kept');
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
  // R2004 (paged, compressed sections; true colours): the same reader, the same drawing
  await openFixture(page, 'dwg2004-truecolor.dwg');
  eq(readerRequests().length, 0, 'R2004: the same reader');
  const tc = await page.evaluate(() => { const s = window.__linework.scene; return { v: s.version, n: s.n, colors: [...new Set(Array.from(s.color.subarray(0, s.n)))].sort((a, b) => a - b).map((c) => c.toString(16)).join(',') }; });
  eq(tc.v, 'AC1018', 'an R2004 file');
  assert(['3366cc', 'ff8000', '10a040', 'c0c0ff', 'aa00aa', 'ffff'].every((c) => tc.colors.split(',').includes(c)), 'its true colours are drawn: ' + tc.colors);
  await clearToasts(page);
  await shot(page, 'dwg2004-truecolor-dark-1440');
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

// ------------------------------------------------------------------ v0.4: files, unsaved-edit recovery, compare, vector print
// The browser's file pickers cannot be driven headlessly: tests hand the app real file handles from
// the page's origin-private file system (OPFS) where a picker would, and cover the fallback
// (plain file chooser, downloads) end to end.
const { parseDgn } = await import('../../src/formats/dgn.js');
const { parseDrawing } = await import('../../src/formats/detect.js');
const { buildScene } = await import('../../src/scene.js');
const { EditDoc } = await import('../../src/edit/doc.js');
const { moveEntity, setText, restyle } = await import('../../src/edit/ops.js');
const { writeDgn } = await import('../../src/formats/dgn-write.js');
const { writeDxf } = await import('../../src/formats/dxf-write.js');

/** Put a file into the page's OPFS folder (default 'e2e'): window.__fs[name] is its handle, window.__dir the folder. */
async function opfsPut(page, name, buf, folder = 'e2e') {
  await page.evaluate(async ([n, b64, f]) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(f, { create: true });
    const fh = await dir.getFileHandle(n, { create: true });
    const w = await fh.createWritable(); await w.write(bin); await w.close();
    window.__dir = dir;
    (window.__fs = window.__fs || {})[n] = fh;
  }, [name, Buffer.from(buf).toString('base64'), folder]);
}
async function opfsGet(page, name, folder = 'e2e') {
  const b64 = await page.evaluate(async ([n, f]) => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(f);
      const b = new Uint8Array(await (await (await dir.getFileHandle(n)).getFile()).arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
      return btoa(s);
    } catch { return null; }
  }, [name, folder]);
  return b64 == null ? null : Buffer.from(b64, 'base64');
}
/** The next file picker hands over this OPFS file (as showOpenFilePicker would). */
const pickerGives = (page, name) => page.evaluate((n) => { window.showOpenFilePicker = async () => [window.__fs[n]]; }, name);
const filesReady = (page) => page.waitForFunction(() => !!window.__linework.files);
/** Original DGN elements: identical, or (edited) only the deleted bit set. Returns [same, deleted]. */
function dgnKept(orig, out) {
  let same = 0, deleted = 0;
  for (let o = 0; o + 4 <= orig.length;) {
    if (orig[o] === 0xff && orig[o + 1] === 0xff) break;
    const size = 4 + 2 * orig.readUInt16LE(o + 2);
    const a = orig.subarray(o, o + size), b = out.subarray(o, o + size);
    if (a.equals(b)) same++;
    else { assert(b[1] === (a[1] | 0x80) && Buffer.compare(a.subarray(2), b.subarray(2)) === 0, `element at ${o} only gets its deleted bit`); deleted++; }
    o += size;
  }
  return [same, deleted];
}
/** Select the Level 2 shape of the site plan and nudge it (one edit). */
async function nudgeShape(page) {
  await setSnap(page, false);
  const st = await page.evaluate(() => { const m = window.__linework.edit.doc.model; const i = m.entities.findIndex((e) => e && e.layer === 'Level 2' && e.pts); return { i, e: m.entities[i] }; });
  if (!/^e/.test(await page.evaluate(() => window.__linework.tool))) await page.click('#tab-edit');
  await clickWorld(page, st.e.pts[0], (st.e.pts[1] + st.e.pts[3]) / 2 + 0.0001);
  await page.keyboard.press('Shift+ArrowRight');
  return st.i;
}
const toastText = (page) => page.evaluate(() => document.querySelector('#toasts').textContent);
function pdfInfo(pdf) {
  const s = pdf.toString('latin1');
  const box = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(s);
  let ops = '';
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const at = m.index + m[0].length, end = s.indexOf('endstream', at);
    try { ops += inflateSync(pdf.subarray(at, end)).toString('latin1') + '\n'; } catch { /* not deflated */ }
  }
  return { pages: (s.match(/\/Type\s*\/Page[^s]/g) || []).length, box: box ? box.slice(1).map(Number) : [], images: (s.match(/\/Subtype\s*\/Image/g) || []).length, ops };
}

test('files: Open through the file picker keeps the handle; Save over the original asks once, keeps a backup in the folder, keeps untouched DGN bytes, reads the file back; changed-on-disk warning; recent drawings reopen it in one click', async () => {
  const page = await newPage();
  await filesReady(page);
  const orig = readFileSync(FIX('site-plan.dgn'));
  await opfsPut(page, 'site-plan.dgn', orig);
  await pickerGives(page, 'site-plan.dgn');
  await page.click('#btn-open');
  await page.waitForFunction(() => window.__linework.doc && window.__linework.doc.name === 'site-plan.dgn' && !window.__linework.loading);
  assert(await page.evaluate(() => !!window.__linework.doc.handle), 'opened with a file handle');
  await page.waitForFunction(() => window.__linework.edit.ready);
  await clearToasts(page);
  await page.click('#tab-edit');
  await nudgeShape(page);
  assert(await ED.dirty(page), 'unsaved');
  const scale0 = await ED.scale(page);
  // first Save: the one-time question
  await page.keyboard.press('Control+s');
  await page.waitForSelector('#dlg-inplace[open]');
  const q = await page.textContent('#dlg-inplace');
  assert(/site-plan\.dgn will be replaced/.test(q) && /byte for byte/.test(q), 'says what happens: ' + q);
  assert(await page.isHidden('#ip-dxf'), 'no DXF warning for a DGN');
  assert(await page.isChecked('#ip-bak'), 'backup copy on by default');
  assert(/access to this file only/.test(await page.textContent('#ip-bak-note')), 'no folder access yet: says so');
  await page.evaluate(() => { window.showDirectoryPicker = async () => window.__dir; });
  await page.click('#ip-dir');
  await page.waitForFunction(() => /goes next to it, in “e2e”/.test(document.querySelector('#ip-bak-note').textContent));
  await shot(page, 'save-over-dialog-dark-1440');
  await page.click('#btn-ip-save');
  await page.waitForFunction(() => /Saved over site-plan\.dgn/.test(document.querySelector('#toasts').textContent), null, { timeout: 20000 });
  assert(/Backup of the file as it was: site-plan\.bak\.dgn/.test(await toastText(page)), 'backup reported');
  const disk1 = await opfsGet(page, 'site-plan.dgn');
  const [same, deleted] = dgnKept(orig, disk1);
  assert(same > 25 && deleted === 1 && disk1.length > orig.length, `untouched elements byte-identical (${same}), the edited one deleted in place (${deleted}), its new version appended`);
  assert((await opfsGet(page, 'site-plan.bak.dgn')).equals(orig), 'the backup is the file as it was');
  const st1 = await page.evaluate(() => ({ dirty: window.__linework.edit.dirty, keep: window.__linework.doc.keep, over: window.__linework.lastSave.over, undo: window.__linework.history.canUndo() }));
  assert(!st1.dirty && st1.keep && st1.over && !st1.undo, 'saved, read back from the file: ' + JSON.stringify(st1));
  assert(Math.abs((await ED.scale(page)) / scale0 - 1) < 1e-9, 'the view is kept');
  assert(await page.isHidden('#doc-dirty'), 'unsaved indicator cleared');
  await page.waitForFunction(() => window.__linework.edit.ready);
  // second Save: no question, the backup is not overwritten
  await clearToasts(page);
  await page.click('#tab-edit');
  await nudgeShape(page);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /Saved over/.test(document.querySelector('#toasts').textContent), null, { timeout: 20000 });
  assert(await page.evaluate(() => !document.querySelector('#dlg-inplace').open), 'asked only once');
  const disk2 = await opfsGet(page, 'site-plan.dgn');
  assert(dgnKept(disk1, disk2)[1] === 1, 'the second save keeps the first one\'s bytes too');
  assert((await opfsGet(page, 'site-plan.bak.dgn')).equals(orig), 'backup still the original');
  // changed on disk by someone else: ask before overwriting
  await page.waitForFunction(() => window.__linework.edit.ready);
  await new Promise((r) => setTimeout(r, 30));
  await opfsPut(page, 'site-plan.dgn', disk2); // same bytes, newer date
  await page.click('#tab-edit');
  await nudgeShape(page);
  await clearToasts(page);
  const dialogs = [];
  page.once('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.__linework.loading);
  await new Promise((r) => setTimeout(r, 500));
  assert(dialogs.length === 1 && /was changed on disk after you opened it/.test(dialogs[0]), 'asks: ' + dialogs.join());
  assert((await opfsGet(page, 'site-plan.dgn')).equals(disk2) && (await ED.dirty(page)), 'refused: nothing written, edits kept');
  page.once('dialog', (d) => d.accept());
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /Saved over/.test(document.querySelector('#toasts').textContent), null, { timeout: 20000 });
  assert(!(await opfsGet(page, 'site-plan.dgn')).equals(disk2), 'accepted: written');
  // recent drawings: the empty state after a reload reopens the file in one click (no picker)
  await page.evaluate(() => { window.showOpenFilePicker = () => { throw new Error('no picker expected'); }; });
  await page.reload();
  await page.waitForFunction(() => !!window.__linework && !!window.__linework.files);
  await page.waitForSelector('#recent [data-recent]');
  await shot(page, 'recent-empty-dark-1440');
  const items = await page.$$eval('#recent [data-recent]', (bs) => bs.map((b) => b.textContent));
  eq(items.length, 1, 'one recent drawing');
  assert(/site-plan\.dgn/.test(items[0]) && /DGN · .* · just now/.test(items[0]), items[0]);
  await page.click('#recent [data-recent]');
  await page.waitForFunction(() => window.__linework.doc && window.__linework.doc.name === 'site-plan.dgn' && !!window.__linework.doc.handle && !window.__linework.loading);
  await page.waitForFunction(() => !!(window.__linework.doc.recent && window.__linework.doc.recent.ok && window.__linework.doc.dir));
  // the Open menu lists it too; Clear list forgets it (the file stays)
  await page.click('#btn-recent');
  assert(/site-plan\.dgn/.test(await page.textContent('#menu-recent')), 'Open menu lists recent drawings');
  await shot(page, 'recent-menu-dark-1440');
  await page.click('#menu-recent [data-recent-clear]');
  await page.waitForFunction(() => document.querySelector('#btn-recent').hidden);
  assert((await opfsGet(page, 'site-plan.dgn')) !== null, 'the file is not touched');
  eq(await page.evaluate(async () => (await window.__linework.files.db.all('recent')).length), 0, 'list cleared in storage');
  await close(page);
});

test('files: DXF over the original warns what DXF loses (Download a copy instead); without the File System Access API Open is the plain chooser and Save downloads', async () => {
  const page = await newPage();
  await filesReady(page);
  await opfsPut(page, 'house-plan.dxf', readFileSync(FIX('house-plan.dxf')));
  await pickerGives(page, 'house-plan.dxf');
  await page.keyboard.press('Control+o');
  await page.waitForFunction(() => window.__linework.doc && window.__linework.doc.name === 'house-plan.dxf' && window.__linework.edit.ready);
  await clearToasts(page);
  await page.click('#tab-edit');
  await zoomTo(page, 500, 300, 8300, 7500);
  await clickWorld(page, 2300, 6600);
  await page.keyboard.press('Shift+ArrowRight');
  assert(await ED.dirty(page), 'edited');
  await page.click('#btn-esave');
  await page.waitForSelector('#dlg-inplace[open]');
  assert(await page.isVisible('#ip-dxf') && /layouts, dimension styles/.test(await page.textContent('#ip-dxf')), 'DXF: says what is not kept');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dlg-inplace button[value="download"]')]);
  eq(dl.suggestedFilename(), 'house-plan-edited.dxf', 'Download a copy = the old Save');
  assert((await opfsGet(page, 'house-plan.dxf')).equals(readFileSync(FIX('house-plan.dxf'))), 'the original is untouched');
  // a browser without file handles (or a file from the plain chooser): Save downloads, as before
  const p2 = await newPage();
  await filesReady(p2);
  await p2.evaluate(() => { window.showOpenFilePicker = undefined; });
  const [fc] = await Promise.all([p2.waitForEvent('filechooser'), p2.click('#btn-open')]);
  await fc.setFiles(FIX('site-plan.dgn'));
  await p2.waitForFunction(() => window.__linework.doc && window.__linework.doc.name === 'site-plan.dgn' && window.__linework.edit.ready);
  assert(await p2.evaluate(() => !window.__linework.doc.handle), 'no handle');
  await clearToasts(p2);
  await p2.click('#tab-edit');
  await nudgeShape(p2);
  const [dl2] = await Promise.all([p2.waitForEvent('download'), p2.keyboard.press('Control+s')]);
  eq(dl2.suggestedFilename(), 'site-plan-edited.dgn', 'downloads');
  assert(await p2.evaluate(() => !document.querySelector('#dlg-inplace')), 'no question without a handle');
  await close(p2);
  await close(page);
});

test('unsaved edits survive a crash: reopening the file offers to restore them (DGN and DXF), Restore gives the same drawing, Discard forgets them, Save clears them', async () => {
  const page = await newPage();
  const ctx = page.ctx;
  await filesReady(page);
  await openForEdit(page, 'site-plan.dgn');
  const shape = await nudgeShape(page);
  await page.keyboard.press('Escape');
  await clickWorld(page, ...(await textAt(page, 'STORE')));
  await page.keyboard.press('Delete');
  eq(await page.evaluate(() => window.__linework.edit.doc.log.length), 2, 'two edits');
  await page.evaluate(() => window.__linework.files.flush());
  eq(await page.evaluate(() => window.__linework.journalState), 'kept', 'journal written');
  const want = await page.evaluate(() => JSON.stringify(window.__linework.edit.doc.model.entities));
  // "crash": the tab goes away without a word (no beforeunload), the drawing is opened again
  await page.close();
  const reopen = async () => {
    const p = await ctx.newPage();
    p.errors = []; p.ctx = ctx;
    p.on('pageerror', (e) => p.errors.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') p.errors.push('console: ' + m.text()); });
    await p.goto(BASE + '?nosw');
    await p.waitForFunction(() => !!window.__linework && !!window.__linework.files);
    return p;
  };
  const p2 = await reopen();
  await p2.waitForSelector('#recent [data-recent]');
  assert(/unsaved edits kept/.test(await p2.textContent('#recent')), 'the recent list says which drawing has unsaved edits');
  await openFixture(p2, 'site-plan.dgn');
  await p2.waitForSelector('.toast:has-text("Restore 2 unsaved edits?")');
  await shot(p2, 'restore-offer-dark-1440');
  await p2.click('.toast button:has-text("Restore")');
  await p2.waitForFunction(() => window.__linework.edit.doc && window.__linework.edit.doc.log.length === 2);
  eq(await p2.evaluate(() => JSON.stringify(window.__linework.edit.doc.model.entities)), want, 'the same drawing as before the crash');
  assert(await ED.dirty(p2), 'still unsaved');
  assert(/Restored 2 edits/.test(await toastText(p2)), 'says so');
  await p2.click('#tab-edit');
  await p2.keyboard.press('Control+z');
  eq(await p2.evaluate(() => window.__linework.edit.doc.log.length), 1, 'undo takes them back one by one');
  await p2.keyboard.press('Control+y');
  assert(await p2.evaluate((i) => !!window.__linework.edit.doc.model.entities[i], shape), 'the moved shape is there');
  // Save (download): nothing kept any more
  const [dl] = await Promise.all([p2.waitForEvent('download'), p2.click('#btn-esave')]);
  eq(dgnKept(readFileSync(FIX('site-plan.dgn')), readFileSync(await dl.path()))[1], 2, 'the restored edits are saved');
  await p2.evaluate(() => window.__linework.files.flush());
  eq(await p2.evaluate(async () => (await window.__linework.files.db.all('journal')).length), 0, 'saved: no journal');
  // DXF: edit, crash, Discard
  await openForEdit(p2, 'house-plan.dxf');
  await zoomTo(p2, 500, 300, 8300, 7500);
  await clickWorld(p2, 2300, 6600);
  await p2.keyboard.press('Shift+ArrowUp');
  await p2.evaluate(() => window.__linework.files.flush());
  eq(await p2.evaluate(() => window.__linework.journalState), 'kept', 'DXF journal written');
  const errs = p2.errors.slice();
  await p2.close();
  const p3 = await reopen();
  await openFixture(p3, 'house-plan.dxf');
  await p3.waitForSelector('.toast:has-text("Restore 1 unsaved edit?")');
  // another drawing opened before answering: the offer goes (it belongs to the other file), the edits stay kept
  await openFixture(p3, 'bracket.dxf');
  assert(!/Restore 1/.test(await toastText(p3)), 'offer withdrawn with its drawing');
  await openFixture(p3, 'house-plan.dxf');
  await p3.waitForSelector('.toast:has-text("Restore 1 unsaved edit?")');
  await p3.click('.toast button:has-text("Discard")');
  await p3.waitForFunction(async () => (await window.__linework.files.db.all('journal')).length === 0);
  assert(!(await ED.dirty(p3)), 'discarded: the file as it is');
  await openFixture(p3, 'house-plan.dxf');
  await new Promise((r) => setTimeout(r, 400));
  assert(!/Restore/.test(await toastText(p3)), 'nothing offered any more');
  assert(!p3.errors.length && !errs.length, p3.errors.concat(errs).join(' | '));
  await ctx.close();
});

test('vector print to scale: A3 at 1:2 (mm drawing), 1"=20\' black and white (DGN in metres); markups as vector; one PDF page of the sheet size with lines and text, no images (production CSP)', async () => {
  const page = await newPage();
  await openFixture(page, 'bracket.dxf');
  await clearToasts(page);
  await page.click('#tab-markup'); await page.click('[data-tool="cloud"]');
  const box = await stageBox(page);
  await dragScreen(page, [box.x + box.w * 0.4, box.y + box.h * 0.4], [box.x + box.w * 0.55, box.y + box.h * 0.55]);
  eq(await page.evaluate(() => window.__linework.markups.length), 1, 'a markup to print');
  await page.click('#tab-view');
  await page.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
  await page.click('#btn-print');
  await page.waitForFunction(() => document.querySelector('#pr-info').textContent.length > 0);
  eq(await page.inputValue('#pr-sheet'), 'letter', 'Letter by default for en-US');
  await page.selectOption('#pr-sheet', 'a3');
  await page.check('input[name="area"][value="all"]');
  await page.fill('#pr-scale', 'one to fifty');
  assert(/not understood/.test(await page.textContent('#pr-info')), 'a scale it cannot read is pointed out');
  await page.click('#btn-do-print');
  assert(await page.evaluate(() => document.querySelector('#dlg-print').open && !window.__printed), 'and not printed');
  await page.fill('#pr-scale', '1:2');
  assert(/Prints at 1:2 on A3 landscape/.test(await page.textContent('#pr-info')), await page.textContent('#pr-info'));
  await page.fill('#pr-scale', '1:1');
  assert(/At 1:1 this area is 451 mm × 271 mm: only its middle part fits on A3/.test(await page.textContent('#pr-info')), 'too big for the sheet: says so');
  await page.fill('#pr-scale', '1:2');
  await shot(page, 'print-dialog-scale-dark-1440');
  await page.click('#btn-do-print');
  await page.waitForFunction(() => window.__printed === 1);
  const lp = await page.evaluate(() => window.__linework.lastPrint);
  assert(lp.s === 0.5 && lp.fits && lp.sheet === 'A3 landscape' && lp.W === 420 && lp.H === 297, JSON.stringify(lp));
  const svg = await page.evaluate(() => { const s = document.querySelector('#print-root svg'); return { w: s.getAttribute('width'), paths: s.querySelectorAll('path').length, texts: s.querySelectorAll('text').length, notes: !!s.querySelector('g[transform^="scale"] path') }; });
  assert(svg.w === '404mm' && svg.paths > 3 && svg.texts > 5 && svg.notes, 'vector sheet with text and the markup: ' + JSON.stringify(svg));
  const strip = await page.textContent('#print-root .title-strip');
  assert(/Scale1:2/.test(strip) && /SheetA3 landscape/.test(strip) && strip.includes('bracket.dxf'), strip);
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({ path: join(OUT, 'print-vector-bracket-a3.png') });
  const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
  writeFileSync(join(OUT, 'print-vector-bracket-a3.pdf'), pdf);
  const P = pdfInfo(pdf);
  eq(P.pages, 1, 'one page');
  assert(Math.abs(P.box[2] - 1190.55) < 1 && Math.abs(P.box[3] - 841.89) < 1, 'A3 landscape page: ' + P.box);
  eq(P.images, 0, 'no images: a vector PDF');
  assert((P.ops.match(/ l\b/g) || []).length > 100 && (P.ops.match(/ c\b/g) || []).length > 20, 'lines and curves');
  assert(/T[Jj]\b/.test(P.ops), 'real text');
  await page.emulateMedia({ media: 'screen' });
  // a DGN in metres at 1"=20', black and white, Letter portrait, current view
  await page.evaluate(() => { document.querySelector('#print-root').innerHTML = ''; });
  await openFixture(page, 'site-plan.dgn');
  await clearToasts(page);
  await page.click('#btn-print');
  await page.selectOption('#pr-sheet', 'letter');
  await page.check('input[name="orient"][value="portrait"]');
  await page.check('input[name="area"][value="view"]');
  await page.fill('#pr-scale', '1"=20\'');
  await page.check('#pr-mono');
  await page.click('#btn-do-print');
  await page.waitForFunction(() => window.__printed === 2);
  const l2 = await page.evaluate(() => window.__linework.lastPrint);
  assert(Math.abs(l2.s - 1000 / 240) < 1e-9 && l2.label === '1"=20\'' && l2.sheet === 'Letter portrait', JSON.stringify(l2));
  const cols = await page.evaluate(() => [...new Set([...document.querySelectorAll('#print-root svg [stroke], #print-root svg [fill]')].flatMap((e) => [e.getAttribute('stroke'), e.getAttribute('fill')]).filter((c) => c && c !== 'none'))]);
  assert(cols.every((c) => c === '#000'), 'black and white: ' + cols);
  await page.emulateMedia({ media: 'print' });
  const P2 = pdfInfo(await page.pdf({ printBackground: true, preferCSSPageSize: true }));
  assert(P2.pages === 1 && Math.abs(P2.box[2] - 612) < 1 && Math.abs(P2.box[3] - 792) < 1 && P2.images === 0, 'Letter portrait, vector: ' + JSON.stringify({ ...P2, ops: undefined }));
  await page.emulateMedia({ media: 'screen' });
  await close(page);
});

/** Revision B of the site plan, written by Linework's own round-trip writer: a moved line, a retyped text, a recoloured ellipse, a deleted line, a new line. */
function sitePlanRevB() {
  const b0 = new Uint8Array(readFileSync(FIX('site-plan.dgn')));
  const model = parseDgn(b0);
  const doc = new EditDoc(model, buildScene(model), { bytes: b0 });
  const e = (i) => model.entities[i];
  doc.commit('move', [{ i: 9, before: e(9), after: moveEntity(e(9), 3, 0) }]);
  doc.commit('text', [{ i: 7, before: e(7), after: setText(e(7), 'STORE B') }]);
  doc.commit('colour', [{ i: 13, before: e(13), after: restyle(e(13), { color: 3 }, 'DGN') }]);
  doc.commit('delete', [{ i: 10, before: e(10), after: null }]);
  doc.commit('new', [{ i: doc.nextIndex(), before: null, after: { type: 'line', layer: 'Level 5', color: 256, rgb: 0xff0000, ci: 3, weight: 0, a: [200, 200], b: [205, 207] } }]);
  return Buffer.from(writeDgn(model, { bytes: b0, orig: doc.orig }).bytes);
}

test('compare: a DGN revision over the open drawing (only in A red, only in B green, the rest dimmed), counts, toggles, step through with zoom; DXF revisions; mixed kinds refused; file chooser fallback', async () => {
  const page = await newPage();
  await filesReady(page);
  await openFixture(page, 'site-plan.dgn');
  await page.waitForFunction(() => window.__linework.edit.ready);
  await clearToasts(page);
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  const revB = sitePlanRevB();
  writeFileSync(join(OUT, 'site-plan-rev-b.dgn'), revB);
  await opfsPut(page, 'site-plan-rev-b.dgn', revB);
  await pickerGives(page, 'site-plan-rev-b.dgn');
  const before = await ED.scale(page);
  await page.click('#btn-compare');
  await page.waitForSelector('#compare-panel');
  await page.waitForFunction(() => !!window.__linework.compare);
  const c = await page.evaluate(() => window.__linework.compare);
  assert(c.a === 4 && c.b === 4 && c.same === 18 && c.sameBytes === 18, 'counts: ' + JSON.stringify(c));
  eq(c.changes.slice().sort().join(), 'added,changed,changed,moved,removed', 'kinds');
  eq(await page.textContent('#cmp-na'), '4', 'panel: only in A');
  eq(await page.textContent('#cmp-ns'), '18', 'panel: unchanged');
  assert(/STORE” → “STORE B/.test(await page.textContent('#cmp-list')), 'the retyped text is listed with both strings');
  eq(await page.evaluate(() => document.querySelector('#cv-drawing').style.opacity), '0.32', 'the rest is dimmed');
  await clearToasts(page);
  await shot(page, 'compare-dgn-dark-1440');
  // red and green really drawn: overlay pixels of both colours
  const colours = () => page.evaluate(() => {
    const cv = document.querySelector('#cv-overlay'), d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let red = 0, green = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i] > 200 && d[i + 1] < 120 && d[i + 3] > 200) red++; if (d[i + 1] > 180 && d[i] < 120 && d[i + 3] > 200) green++; }
    return { red, green };
  });
  const c1 = await colours();
  assert(c1.red > 20 && c1.green > 20, 'red and green items drawn: ' + JSON.stringify(c1));
  await page.uncheck('#compare-panel input[data-show="b"]');
  await settle(page);
  const c2b = await colours();
  assert(!(await page.evaluate(() => window.__linework.compare.show.b)) && c2b.green === 0 && c2b.red > 20, 'Only in B hidden: ' + JSON.stringify(c2b));
  await page.uncheck('#compare-panel input[data-show="same"]');
  eq(await page.evaluate(() => document.querySelector('#cv-drawing').style.opacity), '0', 'unchanged hidden');
  await page.check('#compare-panel input[data-show="b"]');
  await page.check('#compare-panel input[data-show="same"]');
  await page.click('#cmp-next');
  await settle(page);
  eq(await page.evaluate(() => window.__linework.compare.cur), 0, 'first change');
  assert((await ED.scale(page)) > before * 1.5, 'zoomed to it');
  eq(await page.textContent('#cmp-pos'), '1 / 5', 'position');
  await page.click('#cmp-prev');
  eq(await page.textContent('#cmp-pos'), '5 / 5', 'wraps around');
  await page.click('#cmp-list [data-k="2"]');
  eq(await page.textContent('#cmp-pos'), '3 / 5', 'a click on the list goes there');
  await page.keyboard.press('b');
  await shot(page, 'compare-dgn-paper-1440');
  await page.keyboard.press('b');
  // edits to A while comparing are taken into account
  await page.evaluate(() => window.__linework.fit());
  await settle(page);
  await page.click('#tab-edit');
  await nudgeShape(page);
  await page.waitForFunction(() => window.__linework.compare && window.__linework.compare.a === 5, null, { timeout: 5000 });
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.__linework.compare && window.__linework.compare.a === 4, null, { timeout: 5000 });
  await page.click('#cmp-close');
  assert(await page.evaluate(() => !document.querySelector('#compare-panel') && !window.__linework.compare && document.querySelector('#cv-drawing').style.opacity === ''), 'closed: as before');
  // mixed kinds are refused, through the plain file chooser
  await page.evaluate(() => { window.showOpenFilePicker = undefined; });
  await clearToasts(page);
  await page.click('#tab-view');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btn-compare')]);
  await fc.setFiles(FIX('house-plan.dxf'));
  await page.waitForSelector('.toast:has-text("Compare needs two drawings of the same kind")');
  assert(await page.evaluate(() => !document.querySelector('#compare-panel')), 'nothing shown');
  // DXF revisions: one line moved
  await openFixture(page, 'house-plan.dxf');
  await page.waitForFunction(() => window.__linework.edit.ready);
  const m = parseDrawing(new Uint8Array(readFileSync(FIX('house-plan.dxf'))), 'house-plan.dxf');
  const li = m.entities.findIndex((e) => e.type === 'line');
  m.entities[li] = moveEntity(m.entities[li], 500, 0);
  const revDxf = join(OUT, 'house-plan-rev-b.dxf');
  writeFileSync(revDxf, writeDxf(m, {}).text);
  const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btn-compare')]);
  await fc2.setFiles(revDxf);
  await page.waitForFunction(() => !!window.__linework.compare);
  const c2 = await page.evaluate(() => window.__linework.compare);
  assert(c2.a === 1 && c2.b === 1 && c2.changes.join() === 'moved', 'DXF: one moved line: ' + JSON.stringify(c2));
  // opening another drawing ends the comparison
  await openFixture(page, 'bracket.dxf');
  assert(await page.evaluate(() => !document.querySelector('#compare-panel') && !window.__linework.compare), 'ends with the drawing');
  await close(page);
});

test('compare and recent drawings at 390 px: the panel opens over the drawing and closes; the recent list fits', async () => {
  const page = await newPage({ context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } });
  await filesReady(page);
  await openSample(page, 'samples/site-plan.dgn', 'site-plan.dgn');
  await page.waitForFunction(() => window.__linework.edit.ready);
  await clearToasts(page);
  await opfsPut(page, 'rev-b.dgn', sitePlanRevB());
  await pickerGives(page, 'rev-b.dgn');
  await page.click('#btn-compare');
  await page.waitForSelector('#compare-panel');
  await clearToasts(page);
  const w = await page.evaluate(() => [document.querySelector('#compare-panel').getBoundingClientRect().width, document.documentElement.scrollWidth]);
  assert(w[0] <= 390 && w[1] <= 390, 'fits: ' + w);
  await shot(page, 'compare-dark-390');
  await page.click('#cmp-close');
  await page.reload();
  await page.waitForFunction(() => !!window.__linework && !!window.__linework.files);
  await page.waitForSelector('#recent [data-recent]');
  assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'no horizontal overflow');
  await shot(page, 'recent-empty-dark-390');
  await page.click('#recent [data-recent]');
  await page.waitForFunction(() => window.__linework.doc && window.__linework.doc.name === 'site-plan.dgn' && !window.__linework.loading);
  await close(page);
});

// ------------------------------------------------------------------ sheet sets: a folder of drawings as one set
// tests/fixtures/sheets: an invented pump control panel set, PNL-01..03 DGN + PNL-04..05 DXF (repeated wire
// numbers, references between sheets, title blocks).
const SHEETS = ['PNL-01.dgn', 'PNL-02.dgn', 'PNL-03.dgn', 'PNL-04.dxf', 'PNL-05.dxf'];
const SHEET_FIX = (n) => join(ROOT, 'tests', 'fixtures', 'sheets', n);
const shownSheet = (page) => page.evaluate(() => { const a = window.__linework; return !a.loading && a.doc ? a.doc.name : null; });
const waitSheet = (page, name) => page.waitForFunction((n) => { const a = window.__linework; return a.doc && a.doc.name === n && !a.loading && a.edit.ready; }, name, { timeout: 30000 });
const sheetsIndexed = (page, n) => page.waitForFunction((k) => { const s = window.__linework.sheets && window.__linework.sheets.status(); return s && s.indexed === k && !s.indexing; }, n, { timeout: 120000 });
async function putSheets(page, folder, names = SHEETS) {
  for (const n of names) await opfsPut(page, n, readFileSync(SHEET_FIX(n)), folder);
  await opfsPut(page, 'PNL-01.bak.dgn', readFileSync(SHEET_FIX('PNL-01.dgn')), folder); // a Save backup: not a sheet
  await opfsPut(page, 'notes.txt', Buffer.from('not a drawing'), folder);
}

test('sheet sets: open a folder (directory handle), navigator with titles, Page Up / Page Down keep each sheet\'s view and layers, Find in all sheets jumps between sheets, sheet references are links, unsaved edits are asked about, reopen from Recent in one click (index from this browser)', async () => {
  const page = await newPage();
  await filesReady(page);
  await putSheets(page, 'PNL');
  await page.evaluate(() => { window.showDirectoryPicker = async () => window.__dir; });
  await page.click('.topbar [data-action="open-folder"]');
  await waitSheet(page, 'PNL-01.dgn');
  await page.waitForSelector('#sheets-panel:not([hidden])');
  eq(await page.locator('#sheet-list [data-sheet]').count(), 5, 'five sheets (backup copy and text file left out)');
  assert(/^1PNL-01\.dgn/.test(await page.textContent('#sheet-list [aria-current="true"]')), 'the first sheet is current');
  await sheetsIndexed(page, 5);
  const list = await page.evaluate(() => window.__linework.sheets.list());
  eq(list.map((s) => s.title).join('|'), 'PUMP CONTROL POWER|PUMP CONTROL RELAYS|PUMP CONTROL TERMINALS|PUMP CONTROL I/O|PUMP CONTROL CABLES', 'titles from the title blocks (DXF: the TITLE / DWG_TITLE attribute)');
  eq(list.map((s) => s.num).join(''), '12345', 'own sheet numbers');
  assert(/PUMP CONTROL RELAYS/.test(await page.textContent('#sheet-list')), 'titles listed');
  eq(await page.textContent('#sheets-count'), '1 / 5', 'position');
  assert(/All 5 sheets searchable/.test(await page.textContent('#sheets-status')), 'status');
  assert(await page.isVisible('#btn-sheets'), 'View › Sheets button');
  await clearToasts(page);
  await shot(page, 'sheets-panel-dark-1440');
  // Page Down / Page Up; each sheet keeps its view and hidden layers for the session
  await page.keyboard.press('PageDown');
  await waitSheet(page, 'PNL-02.dgn');
  eq(await page.textContent('#sheets-count'), '2 / 5', 'position after Page Down');
  for (let i = 0; i < 3; i++) await page.keyboard.press('+');
  const li = await page.evaluate(() => window.__linework.scene.layers.findIndex((l) => l.name === 'Level 20'));
  await page.click(`#layer-list input[data-i="${li}"]`); // hide Level 20 (the references)
  const v2 = await page.evaluate(() => ({ s: window.__linework.view.scale, cx: window.__linework.view.cx }));
  await page.keyboard.press('PageUp');
  await waitSheet(page, 'PNL-01.dgn');
  await page.keyboard.press('PageUp');
  assert(/first sheet/.test(await toastText(page)), 'Page Up on the first sheet says so');
  await page.click('#sheets-next');
  await waitSheet(page, 'PNL-02.dgn');
  const back = await page.evaluate(() => { const a = window.__linework; return { s: a.view.scale, cx: a.view.cx, off: a.scene.layers.filter((l, i) => !a.layerVisible[i]).map((l) => l.name) }; });
  assert(Math.abs(back.s / v2.s - 1) < 1e-9 && Math.abs(back.cx - v2.cx) < 1e-9, 'the view of sheet 2 is back: ' + JSON.stringify([back, v2]));
  eq(back.off.join(), 'Level 20', 'its hidden level too');
  const st = await page.evaluate(() => window.__linework.sheets.status());
  assert(st.scenes >= 1 && st.scenes <= 3, 'recently shown sheets kept (LRU): ' + st.scenes);
  // Find in all sheets: results by sheet, Enter goes from sheet to sheet and zooms to the match
  await page.keyboard.press('Control+f');
  await page.waitForSelector('.findbar:not([hidden])');
  assert(await page.isVisible('.findbar [data-o="all"]'), 'All sheets scope offered');
  await page.fill('#find-q', 'W201');
  await page.waitForFunction(() => /5 in 3 sheets/.test(document.querySelector('#find-n').textContent));
  const groups = await page.$$eval('.find-sets h4', (hs) => hs.map((h) => h.textContent));
  eq(groups.join('|'), 'PNL-01.dgn2|PNL-02.dgn2|PNL-04.dxf1', 'matches grouped by sheet with counts');
  eq(await page.$$eval('#sheet-list em', (es) => es.map((e) => e.textContent).join()), '2,2,1', 'counts in the navigator');
  const across = await page.evaluate(() => window.__linework.sheets.findAcross('W201'));
  eq(across.map((r) => r.sheetId + ':' + r.hits.length).join(), 'PNL-01.dgn:2,PNL-02.dgn:2,PNL-04.dxf:1', 'app.sheets.findAcross');
  assert(across[0].hits.every((h) => h.text === 'W201' && Number.isFinite(h.x) && Number.isFinite(h.y)) && across[0].hits.some((h) => h.sub), 'hits: text, position, path inside a cell');
  await clearToasts(page);
  await shot(page, 'sheets-find-all-dark-1440');
  await page.keyboard.press('Enter'); // the first match from the shown sheet (2) on
  await page.waitForFunction(() => /^3 of 5/.test(document.querySelector('#find-n').textContent));
  eq(await shownSheet(page), 'PNL-02.dgn', 'stays on sheet 2');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await waitSheet(page, 'PNL-04.dxf');
  await page.waitForFunction(() => /^5 of 5/.test(document.querySelector('#find-n').textContent));
  await settle(page);
  const zoomed = await page.evaluate(() => { const a = window.__linework, t = a.scene.texts.find((x) => x.s === 'W201'), [ox, oy] = a.scene.origin; const [sx, sy] = a.worldToScreen((t.bbox[0] + t.bbox[2]) / 2 + ox, (t.bbox[1] + t.bbox[3]) / 2 + oy); return { sx, sy, w: a.view.w, h: a.view.h, px: (t.bbox[3] - t.bbox[1]) * a.view.scale, k: a.tools.find.k }; });
  assert(zoomed.sx > 0 && zoomed.sx < zoomed.w && zoomed.sy > 0 && zoomed.sy < zoomed.h && zoomed.px > 12 && zoomed.k === 0, 'zoomed to the match on sheet 4: ' + JSON.stringify(zoomed));
  assert(await page.isVisible('.findbar'), 'the find bar stays open across sheets');
  await page.click('.find-sets button[data-g="0"]'); // a listed match on another sheet
  await waitSheet(page, 'PNL-01.dgn');
  eq(await findN(page), '1 of 5', 'listed match picked');
  await page.click('.findbar [data-o="all"]'); // back to this sheet only
  await page.waitForFunction(() => /2 matches|1 of 2/.test(document.querySelector('#find-n').textContent));
  assert(await page.isHidden('.find-sets'), 'no list for this sheet only');
  await page.click('.findbar [data-o="all"]');
  await page.keyboard.press('Escape');
  // sheet references become links: hover shows where, a click opens that sheet
  const refs = await page.evaluate(() => window.__linework.sheets.xrefs().map((r) => r.text + '>' + r.to));
  eq(refs.sort().join(), 'CONT ON SHEET 2>PNL-02.dgn,SEE DWG PNL-05>PNL-05.dxf', 'references on sheet 1 (its own drawing number and "SHEET 1 OF 5" are not links)');
  await page.keyboard.press('f');
  await settle(page);
  const ref = await textAt(page, 'SEE DWG PNL-05');
  const [rx, ry] = await client(page, ...ref);
  await page.mouse.move(rx, ry);
  await page.waitForFunction(() => /Sheet reference: click to open PNL-05\.dxf · PUMP CONTROL CABLES/.test(document.querySelector('#st-info').textContent));
  eq(await page.evaluate(() => document.querySelector('#cv-overlay').style.cursor), 'pointer', 'link cursor');
  await shot(page, 'sheets-link-hover-dark-1440');
  await page.mouse.click(rx, ry);
  await waitSheet(page, 'PNL-05.dxf');
  eq(await page.textContent('#sheets-count'), '5 / 5', 'jumped to sheet 5');
  await page.keyboard.press('PageDown');
  assert(/last sheet/.test(await toastText(page)), 'the last sheet says so');
  // an edited sheet: switching asks first (Cancel stays)
  await page.click('#tab-edit');
  await page.click('[data-tool="eselect"]');
  await clickWorld(page, ...(await textAt(page, 'W202')));
  await page.keyboard.press('Shift+ArrowRight');
  assert(await ED.dirty(page), 'edited');
  const asked = [];
  page.once('dialog', (d) => { asked.push(d.message()); d.dismiss(); });
  await page.keyboard.press('PageUp');
  await new Promise((r) => setTimeout(r, 300));
  assert(asked.length === 1 && /unsaved edits/.test(asked[0]), 'asked: ' + asked.join());
  eq(await shownSheet(page), 'PNL-05.dxf', 'Cancel: still on sheet 5');
  page.once('dialog', (d) => d.accept());
  await page.keyboard.press('PageUp');
  await waitSheet(page, 'PNL-04.dxf');
  await page.click('#tab-view');
  await page.keyboard.press('b');
  await clearToasts(page);
  await shot(page, 'sheets-panel-paper-1440');
  await page.keyboard.press('b');
  // the set is one entry in Recent drawings: one click after a reload opens it at the last sheet, the index comes from this browser
  await page.evaluate(() => { window.showDirectoryPicker = () => { throw new Error('no picker expected'); }; });
  await page.reload();
  await page.waitForFunction(() => !!window.__linework && !!window.__linework.files);
  await page.waitForSelector('#recent [data-recent]');
  const items = await page.$$eval('#recent [data-recent]', (bs) => bs.map((b) => b.textContent));
  eq(items.length, 1, 'one recent entry for the set (not one per sheet)');
  assert(/PNL/.test(items[0]) && /Sheet set · 5 sheets · just now/.test(items[0]), items[0]);
  await page.click('#recent [data-recent]');
  await waitSheet(page, 'PNL-04.dxf');
  await sheetsIndexed(page, 5);
  const st2 = await page.evaluate(() => window.__linework.sheets.status());
  assert(st2.fromCache >= 4, 'indexes read back from this browser: ' + JSON.stringify(st2));
  await close(page);
});

test('sheet sets: several files from the plain chooser (no File System Access API) and dropped files; 390 px panel; a 120-sheet set stays within a memory bound', async () => {
  const page = await newPage({ context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } });
  await filesReady(page);
  await page.evaluate(() => { window.showOpenFilePicker = undefined; window.showDirectoryPicker = undefined; });
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btn-open-empty')]);
  assert(fc.isMultiple(), 'the chooser takes several files');
  await fc.setFiles(SHEETS.map(SHEET_FIX));
  await waitSheet(page, 'PNL-01.dgn');
  eq(await page.evaluate(() => window.__linework.sheets.list().length), 5, 'five sheets');
  assert(await page.isHidden('#sheets-panel'), 'phone: the list starts hidden');
  await sheetsIndexed(page, 5);
  await clearToasts(page);
  await page.click('#btn-sheets');
  await page.waitForSelector('#sheets-panel:not([hidden])');
  const fit = await page.evaluate(() => [document.querySelector('#sheets-panel').getBoundingClientRect().width, document.documentElement.scrollWidth]);
  assert(fit[0] <= 390 && fit[1] <= 390, 'fits at 390 px: ' + fit);
  await shot(page, 'sheets-panel-dark-390');
  await page.tap('#sheet-list [data-sheet="PNL-03.dgn"]');
  await waitSheet(page, 'PNL-03.dgn');
  assert(await page.isHidden('#sheets-panel'), 'phone: the list closes when a sheet opens');
  // a reference tapped
  const ref = await textAt(page, 'PNL-04');
  const [rx, ry] = await client(page, ...ref);
  await page.touchscreen.tap(rx, ry);
  await waitSheet(page, 'PNL-04.dxf');
  await page.keyboard.press('Control+f');
  await page.fill('#find-q', 'W202');
  await page.waitForFunction(() => /4 in 3 sheets/.test(document.querySelector('#find-n').textContent));
  assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'find with results fits');
  await shot(page, 'sheets-find-all-dark-390');
  await close(page);

  // dropped files (no handles): a set too; a sheet that does not read is marked, Page Down goes past it
  const p2 = await newPage();
  await p2.evaluate(async (files) => {
    const dt = new DataTransfer();
    for (const [n, b64] of files) dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], n));
    for (const type of ['dragenter', 'drop']) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [...SHEETS.slice(3).map((n) => [n, readFileSync(SHEET_FIX(n)).toString('base64')]), ['PNL-04b.dxf', Buffer.from('not a drawing').toString('base64')]]);
  await waitSheet(p2, 'PNL-04.dxf');
  eq(await p2.evaluate(() => window.__linework.sheets.list().map((s) => s.id).join()), 'PNL-04.dxf,PNL-04b.dxf,PNL-05.dxf', 'dropped files, in order');
  await p2.waitForFunction(() => { const s = window.__linework.sheets.status(); return s.indexed === 2 && s.failed === 1 && !s.indexing; });
  assert(/PNL-04b\.dxf[^3]*not a DXF/.test(await p2.textContent('#sheet-list')), 'marked: ' + await p2.textContent('#sheet-list'));
  await p2.keyboard.press('PageDown');
  await p2.waitForSelector('.toast.error');
  eq(await shownSheet(p2), 'PNL-04.dxf', 'still the sheet before');
  await p2.keyboard.press('PageDown');
  await waitSheet(p2, 'PNL-05.dxf');
  await close(p2);

  // 120 sheets: every sheet is read once in the background, only a few drawings stay in memory
  const p3 = await newPage();
  await filesReady(p3);
  const base = readFileSync(SHEET_FIX('PNL-04.dxf'), 'latin1');
  await p3.evaluate(async ([text]) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('BIG', { create: true });
    for (let k = 1; k <= 120; k++) {
      const fh = await dir.getFileHandle(`BIG-${String(k).padStart(3, '0')}.dxf`, { create: true });
      const w = await fh.createWritable();
      await w.write(`999\nsynthetic sheet ${k}\n` + text.replace('W240', `W${3000 + k}`).replace('SHEET 4 OF 5', `SHEET ${k} OF 120`));
      await w.close();
    }
    window.showDirectoryPicker = async () => dir;
  }, [base]);
  const heap0 = await p3.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0));
  const t0 = Date.now();
  await p3.evaluate(() => window.__linework.loadSheets().then((S) => S.pickFolder()));
  await waitSheet(p3, 'BIG-001.dxf');
  await sheetsIndexed(p3, 120);
  const indexMs = Date.now() - t0;
  for (let i = 0; i < 8; i++) { await p3.keyboard.press('PageDown'); await waitSheet(p3, `BIG-${String(i + 2).padStart(3, '0')}.dxf`); }
  const st = await p3.evaluate(() => window.__linework.sheets.status());
  const heap1 = await p3.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0));
  assert(st.sheets === 120 && st.indexed === 120 && st.failed === 0, 'all read: ' + JSON.stringify(st));
  assert(st.scenes <= 3, 'at most 3 drawings kept besides the one shown: ' + st.scenes);
  assert(st.indexBytes < 2 * 1024 * 1024, 'the text index is small: ' + st.indexBytes);
  assert(!heap0 || heap1 - heap0 < 150 * 1024 * 1024, `heap grew ${((heap1 - heap0) / 2 ** 20).toFixed(1)} MB`);
  const one = await p3.evaluate(() => window.__linework.sheets.findAcross('W3077', { wholeWord: true }));
  eq(one.map((r) => r.sheetId).join(), 'BIG-077.dxf', 'one sheet has W3077');
  perf.sheetSet = { sheets: 120, indexMs, indexKB: +(st.indexBytes / 1024).toFixed(1), scenesKept: st.scenes, heapGrowthMB: +((heap1 - heap0) / 2 ** 20).toFixed(1) };
  await close(p3);
});

// ------------------------------------------------------------------ v0.4: editing tools (DGN first: the synthetic wiring sheet)
const WIRE = 'dgn-wiring.dgn';
const findN = (page) => page.textContent('#find-n');
const toolsReady = (page) => page.waitForFunction(() => !!window.__linework.tools);
/** OK in a tool dialog; the change follows the dialog's close event. */
async function okDialog(page) { await page.click('#tool-ok'); await page.waitForFunction(() => !document.querySelector('dialog[open]')); await settle(page); }
/** Read a saved DGN in the page (the app's own reader): its texts and its bytes. */
async function savedDgn(page, dl, name) {
  const out = join(OUT, name);
  await dl.saveAs(out);
  return readFileSync(out);
}
/** The original file's elements (up to the end-of-design marker) are byte-identical in `nb`. */
function originalsIdentical(orig, nb) {
  let eod = 0;
  for (let o = 0; o + 2 <= orig.length;) { if (orig[o] === 0xff && orig[o + 1] === 0xff) { eod = o; break; } o += 4 + 2 * orig.readUInt16LE(o + 2); }
  return eod > 0 && nb.subarray(0, eod).equals(orig.subarray(0, eod));
}
/** Original elements outside `ranges` are byte-identical (inside, only the deleted bit may differ). */
function originalsKeptExcept(orig, nb, ranges) {
  for (let o = 0; o + 2 <= orig.length;) {
    if (orig[o] === 0xff && orig[o + 1] === 0xff) return true;
    const size = 4 + 2 * orig.readUInt16LE(o + 2);
    const inside = ranges.some(([s, e]) => o >= s && o < e);
    for (let k = 0; k < size; k++) if (nb[o + k] !== orig[o + k] && !(inside && k === 1 && nb[o + 1] === (orig[o + 1] | 0x80))) return false;
    o += size;
  }
  return false;
}

test('find (Ctrl+F) in any mode: count, Enter / Shift+Enter / F3, zoom + highlight, whole word, match case, visible levels, text inside cells; replace and replace all in Edit (one undo step); the saved DGN keeps every other byte', async () => {
  const page = await newPage();
  await openFixture(page, WIRE);
  await clearToasts(page);
  await page.keyboard.press('Control+f');
  await page.waitForSelector('.findbar:not([hidden]) #find-q');
  eq(await page.evaluate(() => document.activeElement.id), 'find-q', 'the find box has the focus');
  assert(await page.isHidden('#find-rep'), 'no Replace outside Edit');
  await page.keyboard.type('W101');
  eq(await findN(page), '4 matches', 'W101 also in W1010, in a cell and in a note');
  const s0 = await ED.scale(page);
  await page.keyboard.press('Enter');
  eq(await findN(page), '1 of 4', 'Enter: the first match');
  const cur = await page.evaluate(() => { const a = window.__linework, t = a.tools.find; return t.k; });
  eq(cur, 0, 'current match');
  const hitPx = await page.evaluate(() => {
    const a = window.__linework, s = a.scene, h = s.texts.filter((t) => !t.dead && t.s === 'W101' && t.sub)[0];
    const [x0, y0] = a.view.toScreen(h.bbox[0], h.bbox[3]), [x1, y1] = a.view.toScreen(h.bbox[2], h.bbox[1]);
    return { x0, y0, x1, y1, w: a.view.w, h: a.view.h, cap: Math.hypot(h.m[2], h.m[3]) * a.view.scale };
  });
  assert((await ED.scale(page)) > s0 * 2, 'zoomed in to the match');
  assert(hitPx.x0 > 0 && hitPx.x1 < hitPx.w && hitPx.y0 > 0 && hitPx.y1 < hitPx.h && hitPx.cap > 15, 'the match is on screen and readable: ' + JSON.stringify(hitPx));
  await shot(page, 'find-dark-1440');
  await page.keyboard.press('Shift+Enter');
  eq(await findN(page), '4 of 4', 'Shift+Enter: previous (wraps)');
  await page.keyboard.press('F3');
  eq(await findN(page), '1 of 4', 'F3: next');
  await page.click('.findbar [data-o="wholeWord"]');
  assert(/of 3$|^3 matches$/.test(await findN(page)), 'whole word: 3, got ' + (await findN(page)));
  // visible levels only: hide level 20 (the note) in the Layers panel
  const toggle20 = () => page.evaluate(() => { const li = [...document.querySelectorAll('#layer-list .layer')].find((l) => l.dataset.name === 'level 20'); li.querySelector('input').click(); });
  await toggle20();
  assert(/of 2$|^2 matches$/.test(await findN(page)), 'a hidden level is not searched: ' + (await findN(page)));
  await page.click('.findbar [data-o="vis"]');
  assert(/of 3$|^3 matches$/.test(await findN(page)), 'Visible off: every level: ' + (await findN(page)));
  await page.click('.findbar [data-o="vis"]');
  await toggle20();
  await page.fill('#find-q', 'W104');
  eq(await findN(page), '1 match', 'case is ignored by default');
  await page.click('.findbar [data-o="matchCase"]');
  eq(await findN(page), 'No matches', 'match case');
  await page.click('.findbar [data-o="matchCase"]');
  await page.click('#find-q');
  await page.keyboard.press('Escape');
  assert(await page.isHidden('.findbar'), 'Esc closes the find bar');
  // ---- Edit mode: replace
  await page.waitForFunction(() => window.__linework.edit.ready);
  await page.click('#tab-edit');
  await page.click('[data-action="e-tools"]');
  await page.click('#ctx-menu button:has-text("Find and replace")');
  await page.waitForSelector('#find-rep:not([hidden])');
  await page.fill('#find-q', 'W101');
  eq(await findN(page), '3 matches', 'the options are kept (whole word)');
  await page.fill('#find-r', 'W201');
  const before = await page.evaluate(() => window.__linework.edit.doc.model.entities.map((e) => e && e.dgn && e.dgn.slice()));
  await page.click('#find-one');
  eq(await findN(page), '1 of 3', 'the first Replace shows the first match');
  const sel = await ED.sel(page);
  eq(sel.length, 1, 'in Edit the match is selected');
  await page.click('#find-one');
  eq(await findN(page), '1 of 2', 'replaced; on to the next one');
  const marker = await page.evaluate(() => window.__linework.edit.doc.model.entities.find((e) => e && e.name === 'MARKER').children[1].text);
  eq(marker, 'W201', 'the text inside the cell was replaced');
  await page.click('#find-all');
  eq(await findN(page), 'No matches', 'replace all');
  await page.waitForSelector('.toast:has-text("Replaced 2 texts")');
  const texts = () => page.evaluate(() => window.__linework.scene.texts.filter((t) => !t.dead).map((t) => t.s).filter((s) => /W[12]01/.test(s)).sort());
  eq(JSON.stringify(await texts()), JSON.stringify(['NOTE: W201 FEEDS RELAY K1', 'W1010', 'W201', 'W201']), 'drawn texts');
  await page.click('#btn-eundo');
  eq(JSON.stringify(await texts()), JSON.stringify(['NOTE: W101 FEEDS RELAY K1', 'W101', 'W1010', 'W201']), 'one undo step undoes the whole Replace all');
  await settle(page);
  eq(await findN(page), '2 matches', 'the hits follow the undo');
  await page.click('#btn-eredo');
  await shot(page, 'find-replace-dark-1440');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-esave')]);
  const nb = await savedDgn(page, dl, 'wiring-replaced.dgn');
  const orig = readFileSync(FIX(WIRE));
  const changed = await page.evaluate((b4) => window.__linework.edit.doc.model.entities.map((e, i) => (e && b4[i] && e !== window.__linework.edit.doc.orig[i] ? b4[i] : null)).filter(Boolean), before);
  eq(changed.length, 3, 'three items changed');
  assert(originalsKeptExcept(orig, nb, changed), 'every other element byte-identical; the edited ones flagged deleted');
  await page.setInputFiles('#file-input', join(OUT, 'wiring-replaced.dgn'));
  await page.waitForFunction(() => window.__linework.doc.name === 'wiring-replaced.dgn');
  eq(JSON.stringify(await texts()), JSON.stringify(['NOTE: W201 FEEDS RELAY K1', 'W1010', 'W201', 'W201']), 'reopened');
  await close(page);
  // 390 px: the find bar fits the phone
  const ph = await newPage({ context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  await openFixture(ph, WIRE);
  await clearToasts(ph);
  await ph.click('[data-action="find"]');
  await ph.fill('#find-q', 'TB1');
  await ph.click('#find-next');
  eq(await findN(ph), '1 of 3', 'the Find button and the arrows (touch)');
  const r = await ph.evaluate(() => { const b = document.querySelector('.findbar').getBoundingClientRect(); return [b.left, b.right, window.innerWidth]; });
  assert(r[0] >= 0 && r[1] <= r[2], 'the find bar fits at 390 px: ' + r);
  await shot(ph, 'find-dark-390');
  await close(ph);
});

test('key-ins: XY= DL= DI= in the draw tools (preview first, Esc cancels, errors stay open), a typed radius; move / copy / rotate the selection by typed values; AA= for new text', async () => {
  const page = await newPage();
  await openForEdit(page, WIRE);
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await setSnap(page, false);
  await zoomTo(page, 0, 0, 200, 120);
  const n0 = await entCount(page);
  const keyin = async (text, opts = {}) => {
    await page.keyboard.type(text.slice(0, 1));
    await page.waitForSelector('#len-box:not([hidden])');
    await page.keyboard.type(text.slice(1));
    await page.waitForFunction((t) => document.querySelector('#len-prev').textContent !== '' && document.querySelector('#inp-len').value === t, text);
    const prev = await page.textContent('#len-prev');
    if (opts.copy) await page.check('#len-copy');
    if (opts.shot) await shot(page, opts.shot);
    await page.keyboard.press(opts.key || 'Enter');
    await settle(page);
    return prev;
  };
  // line: XY= starts it, DL= and DI= continue from the last point
  await page.keyboard.press('n');
  let prev = await keyin('xy=10,10');
  assert(/Point X 10\.00\s+Y 10\.00 m/.test(prev), 'the preview names the point: ' + prev);
  eq(await page.evaluate(() => window.__linework.edit.draft && window.__linework.edit.draft.pts.join()), '10,10', 'the line starts there');
  prev = await keyin('dl=20,0', { shot: 'keyin-preview-dark-1440' });
  assert(/20\.00 m from the last point/.test(prev), prev);
  let L = await ED.last(page);
  eq(JSON.stringify([L.a, L.b]), JSON.stringify([[10, 10], [30, 10]]), 'DL=20,0 from the last point');
  await keyin('di=10,90');
  L = await ED.last(page);
  assert(nearPt(L.a, [30, 10], 1e-9) && nearPt(L.b, [30, 20], 1e-9), 'DI=10,90: up from the last point: ' + JSON.stringify(L));
  eq(await entCount(page), n0 + 2, 'two lines');
  await keyin('dl=5,5', { key: 'Escape' });
  eq(await entCount(page), n0 + 2, 'Esc cancels a key-in');
  assert(await page.isHidden('#len-box'), 'the box is closed');
  await keyin('xy=abc');
  assert(await page.isVisible('#len-box'), 'a key-in with a mistake stays open');
  assert(await page.evaluate(() => document.querySelector('#len-prev').classList.contains('bad')), 'and says what is wrong');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape'); // end the line chain
  // circle: centre by XY=, a typed radius
  await page.keyboard.press('o');
  await keyin('xy=50,50');
  prev = await keyin('5');
  assert(/Radius 5\.00 m/.test(prev), prev);
  const C = await ED.last(page);
  eq(C.type, 'circle'); assert(nearPt(C.c, [50, 50], 1e-9) && Math.abs(C.r - 5) < 1e-9, 'circle at 50,50 with radius 5');
  // move, copy and rotate the selection
  await page.keyboard.press('Escape');
  await clickWorld(page, 75, 95);
  const wi = (await ED.sel(page))[0];
  const w0 = await ED.ent(page, wi);
  eq(w0.type + ' ' + w0.a[1], 'line 95', 'a wire is selected');
  prev = await keyin('dl=0,5');
  assert(/Move 1 item by ΔX 0\.00\s+ΔY 5\.00 m/.test(prev), prev);
  let w1 = await ED.ent(page, wi);
  assert(nearPt(w1.a, [30, 100], 1e-9) && nearPt(w1.b, [120, 100], 1e-9), 'moved up by 5');
  const n1 = await entCount(page);
  await keyin('di=10,90', { copy: true });
  eq(await entCount(page), n1 + 1, 'Copy: a copy, the original stays');
  const cp = await ED.last(page);
  assert(nearPt(cp.a, [30, 110], 1e-9), 'the copy is 10 up');
  await clickWorld(page, 75, 100);
  await keyin('aa=90');
  w1 = await ED.ent(page, wi);
  assert(nearPt(w1.a, [75, 55], 1e-9) && nearPt(w1.b, [75, 145], 1e-9), 'rotated 90° about its centre: ' + JSON.stringify([w1.a, w1.b]));
  await page.keyboard.press('Control+z');
  w1 = await ED.ent(page, wi);
  assert(nearPt(w1.a, [30, 100], 1e-9), 'one undo step');
  // the menu opens the box ready for a value
  await page.click('[data-action="e-tools"]');
  await page.click('#ctx-menu button:has-text("Move by a distance")');
  eq(await page.inputValue('#inp-len'), 'DL=', 'Move by a distance: DL= typed for you');
  await page.keyboard.press('Escape');
  // AA= then text: placed at the active angle; XY= places text
  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  await keyin('aa=45');
  await keyin('xy=5,115');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
  await page.keyboard.type('KEYED');
  await page.keyboard.press('Enter');
  const T = await ED.last(page);
  eq(T.text, 'KEYED');
  assert(nearPt(T.p, [5, 115], 1e-9) && Math.abs(T.rot - Math.PI / 4) < 1e-12, 'text at XY= and at the active angle');
  await close(page);
});

test('mirror, scale and array from Edit › More (one undo step each), mirror about a picked point; select same; match attributes; element info (I)', async () => {
  const page = await newPage();
  await openForEdit(page, WIRE);
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await setSnap(page, false);
  await zoomTo(page, 0, 0, 200, 120);
  const more = async (label) => { await page.click('[data-action="e-tools"]'); await page.click(`#ctx-menu button:has-text("${label}")`); };
  const idxOf = (pred) => page.evaluate((p) => window.__linework.edit.doc.model.entities.findIndex(new Function('e', 'return e && ' + p)), pred);
  // mirror the ground bus and its GND label (left <-> right about their centre); the text stays readable
  await clickWorld(page, 60, 40);
  await clickWorld(page, 16, 42.5, 0, 0);
  await page.keyboard.down('Shift'); await clickWorld(page, 60, 40); await page.keyboard.up('Shift');
  const gnd = await idxOf("e.text === 'GND'");
  eq((await ED.sel(page)).length, 2, 'bus + label selected');
  const t0 = await ED.ent(page, gnd);
  await more('Mirror left ↔ right');
  const t1 = await ED.ent(page, gnd);
  assert(t1.p[0] > 175 && Math.abs(t1.p[1] - t0.p[1]) < 1e-9, 'the label moved to the mirrored side: ' + t1.p);
  assert(Math.abs(t1.rot) < 1e-12 && !t1.mirrorY, 'not reversed');
  await page.click('#btn-eundo');
  eq(JSON.stringify((await ED.ent(page, gnd)).p), JSON.stringify(t0.p), 'one undo step');
  // mirror about a picked point: up <-> down about y = 60
  await more('Mirror about a point');
  await page.waitForFunction(() => /mirror about/.test(document.querySelector('#tool-hint').textContent));
  await clickWorld(page, 100, 60);
  await page.click('#ctx-menu button:has-text("Mirror up ↕ down here")');
  const t2 = await ED.ent(page, gnd);
  assert(Math.abs(t2.p[1] - (120 - t0.p[1] - 1.6)) < 0.3 && Math.abs(t2.p[0] - t0.p[0]) < 1e-9, 'its box mirrored about y = 60: ' + t2.p);
  await page.click('#btn-eundo');
  // scale the title block cell (x 2 about its centre)
  await page.keyboard.press('Escape');
  await clickWorld(page, 198, 10);
  const tb = await idxOf("e.name === 'TBLOCK'");
  eq(JSON.stringify(await ED.sel(page)), JSON.stringify([tb]), 'title block selected');
  await more('Scale');
  await page.waitForSelector('dialog[open] input[name="f"]');
  await page.fill('dialog[open] input[name="f"]', '0');
  assert(await page.isDisabled('#tool-ok'), 'a factor of 0 is refused');
  await page.fill('dialog[open] input[name="f"]', '2');
  await okDialog(page);
  const c1 = await ED.ent(page, tb);
  assert(Math.abs(Math.hypot(c1.mv[0], c1.mv[1]) - 2) < 1e-9, 'scaled ×2');
  await page.click('#btn-eundo');
  // array: three copies of a wire label, 3 m apart downwards
  await page.keyboard.press('Escape');
  await clickWorld(page, 62, 87);
  eq((await ED.ent(page, (await ED.sel(page))[0])).text, 'W102', 'label selected');
  const n0 = await entCount(page);
  await more('Array');
  await page.fill('dialog[open] input[name="n"]', '3');
  await page.fill('dialog[open] input[name="dx"]', '0');
  await page.fill('dialog[open] input[name="dy"]', '-3');
  await shot(page, 'array-dialog-dark-1440');
  await okDialog(page);
  eq(await entCount(page), n0 + 3, 'three copies');
  eq((await ED.sel(page)).length, 3, 'the copies are selected');
  const ys = await page.evaluate(() => window.__linework.edit.doc.model.entities.filter((e) => e && e.text === 'W102').map((e) => e.p[1]).sort((a, b) => a - b));
  eq(JSON.stringify(ys.map((y) => +y.toFixed(9))), JSON.stringify([77, 80, 83, 86]), 'at the offset');
  await page.click('#btn-eundo');
  eq(await entCount(page), n0, 'one undo step');
  // select same: level of a wire -> the 5 wires; + colour + weight -> the 4 green ones
  await page.keyboard.press('Escape');
  await clickWorld(page, 75, 85);
  await more('Select same');
  await page.waitForSelector('dialog[open] select[name="v-layer"]');
  eq(await page.textContent('#tool-note'), '5 items match', 'live count');
  await page.check('dialog[open] input[name="on-color"]');
  await page.check('dialog[open] input[name="on-weight"]');
  eq(await page.textContent('#tool-note'), '4 items match');
  await shot(page, 'select-same-dark-1440');
  await okDialog(page);
  eq((await ED.sel(page)).length, 4, 'selected');
  // from the lists, without a selection
  await page.keyboard.press('Escape');
  await more('Select same');
  await page.uncheck('dialog[open] input[name="on-layer"]');
  await page.check('dialog[open] input[name="on-type"]');
  await page.selectOption('dialog[open] select[name="v-type"]', 'CELL');
  if (process.env.DBG) console.log(await page.evaluate(() => [...document.querySelector('dialog[open] select[name="v-type"]').options].map((o) => o.value + '=' + o.textContent).join(' | ') + ' sel=' + window.__linework.edit.sel.size + ' val=' + document.querySelector('dialog[open] select[name="v-type"]').value));
  eq(await page.textContent('#tool-note'), '5 items match', 'every cell');
  await okDialog(page);
  eq((await ED.sel(page)).length, 5);
  // match attributes: the blue weight-1 wire takes the green wire's symbology
  await page.keyboard.press('Escape');
  const blue = await idxOf('e.type === "line" && e.ci === 1');
  await more('Match attributes');
  await clickWorld(page, 75, 85);
  await page.waitForFunction(() => /Click items to give them/.test(document.querySelector('#tool-hint').textContent));
  await clickWorld(page, 75, 65);
  const b1 = await ED.ent(page, blue);
  eq(`${b1.ci} ${b1.weight} ${b1.layer}`, '2 2 Level 5', 'matched');
  await page.keyboard.press('Escape');
  assert(!(await page.evaluate(() => window.__linework.edit.pick)), 'Esc ends Match');
  // element info: I with a selection
  await clickWorld(page, 75, 65);
  await page.keyboard.press('i');
  await page.waitForSelector('.info-card:not([hidden])');
  const info = await page.textContent('.info-card');
  for (const s of ['Selected item', 'Line (type 3)', 'Level 5', 'Weight2', 'File offset', 'rebuilt from those bytes (edited)', 'Length90.00 m']) assert(info.replace(/\s+/g, '').includes(s.replace(/\s+/g, '')), `info shows ${s}: ${info}`);
  await clickWorld(page, 198, 10);
  await page.waitForFunction(() => /TBLOCK/.test(document.querySelector('.info-card').textContent));
  assert(/4 components/.test(await page.textContent('.info-card')), 'cell components');
  await shot(page, 'info-card-dark-1440');
  // outside Edit: the item under the cursor
  await page.keyboard.press('h');
  await page.mouse.move(...(await client(page, 75, 55)));
  await page.waitForFunction(() => /Under the cursor/.test(document.querySelector('.info-card').textContent));
  await page.keyboard.press('i');
  assert(await page.isHidden('.info-card'), 'I hides it again');
  await close(page);
});

test('level names (DGN): name a level in the Layers panel, import a names file, names in the Level box and the status bar, kept per drawing after a reload, export; the DGN bytes never change', async () => {
  const page = await newPage();
  await openFixture(page, WIRE);
  await clearToasts(page);
  assert(await page.isVisible('#level-names'), 'DGN: the level names row');
  const rowOf = (lv) => page.locator(`#layer-list .layer:has(button.ren[data-lv="${lv}"])`);
  await rowOf(5).locator('button.ren').click();
  await page.waitForSelector('#layer-list input.lvin');
  await page.keyboard.type('Wires');
  await page.keyboard.press('Enter');
  assert(/Level 5\s*Wires/.test(await rowOf(5).textContent()), 'named in the panel');
  await page.setInputFiles('#names-input', { name: 'levels.csv', mimeType: 'text/csv', buffer: Buffer.from('level,name\n10,Labels\n12,"Terminals, TB1"\n99,Bad\n') });
  await page.waitForSelector('.toast:has-text("Imported 2 level names")');
  assert(/Level 12\s*Terminals, TB1/.test(await rowOf(12).textContent()), 'imported');
  await page.fill('#layer-filter', 'termin');
  eq(await page.locator('#layer-list .layer:not([hidden])').count(), 1, 'the filter finds level names');
  await page.fill('#layer-filter', '');
  await shot(page, 'level-names-dark-1440');
  // status bar on hover, Level box in Edit
  await page.waitForFunction(() => window.__linework.edit.ready);
  const at = await client(page, ...(await textAt(page, 'W102')));
  await page.mouse.move(at[0], at[1]);
  await page.waitForFunction(() => /Level 10 · Labels/.test(document.querySelector('#st-info').textContent));
  await page.click('#tab-edit');
  const opts = await page.$$eval('#sel-elayer option', (os) => os.map((o) => o.textContent));
  assert(opts.includes('Level 10 · Labels') && opts.includes('Level 5 · Wires'), 'the Level box shows names: ' + opts.join(' | '));
  // export
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-names-export')]);
  eq(dl.suggestedFilename(), 'dgn-wiring-levels.csv');
  const csv = readFileSync(await dl.path(), 'utf8');
  assert(csv.includes('5,Wires') && csv.includes('10,Labels') && csv.includes('12,"Terminals, TB1"'), csv);
  // names never touch the file: saving without edits gives the original bytes
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btn-esave')]);
  const nb = await savedDgn(page, dl2, 'wiring-names.dgn');
  assert(nb.equals(readFileSync(FIX(WIRE))), 'the saved DGN is the original, byte for byte');
  // kept per drawing name: a reload brings them back; another drawing has none
  await page.reload();
  await page.waitForFunction(() => !!window.__linework);
  await openFixture(page, WIRE);
  assert(/Level 5\s*Wires/.test(await rowOf(5).textContent()), 'kept after a reload');
  await openFixture(page, 'site-plan.dgn');
  eq(await page.locator('#layer-list .lvn').count(), 0, 'another drawing: no names');
  await openFixture(page, 'house-plan.dxf');
  assert(await page.isHidden('#level-names'), 'DXF: layers have names already');
  await openFixture(page, WIRE);
  await page.click('#btn-names-clear');
  await page.waitForSelector('.toast:has-text("Level names cleared")');
  eq(await page.locator('#layer-list .lvn').count(), 0, 'Clear');
  await page.click('.toast button:has-text("Undo")');
  assert(/Level 5\s*Wires/.test(await rowOf(5).textContent()), 'Clear can be undone');
  await close(page);
});

// ------------------------------------------------------------------ Trace (wire / net tracing)
const TRACE = 'dgn-trace.dgn';
/** The "pinkest" opaque pixel of the overlay canvas around a drawing point. */
async function overlayPx(page, x, y) {
  return page.evaluate(([x, y]) => {
    const a = window.__linework, [sx, sy] = a.worldToScreen(x, y), d = a.dpr;
    const g = document.querySelector('#cv-overlay').getContext('2d').getImageData(Math.round(sx * d) - 2, Math.round(sy * d) - 2, 5, 5).data;
    let best = [0, 0, 0, 0];
    for (let i = 0; i < g.length; i += 4) if (g[i + 3] > 200 && g[i] + g[i + 2] - 2 * g[i + 1] > best[0] + best[2] - 2 * best[1]) best = [g[i], g[i + 1], g[i + 2], g[i + 3]];
    return best;
  }, [x, y]);
}
// dark #ff4fd8, paper #c4007a
const traceColour = (p, theme = 'dark') => (theme === 'dark' ? p[0] > 235 && p[1] > 50 && p[1] < 120 && p[2] > 180 : p[0] > 150 && p[0] < 225 && p[1] < 40 && p[2] > 80 && p[2] < 170);
const trNet = (page) => page.evaluate(() => { const n = window.__linework.trace && window.__linework.trace.net; return n && { wires: n.wires.length, count: n.count, ends: n.ends.length, labels: n.labels.map((l) => l.s) }; });
const endsShown = (page) => page.$$eval('#tr-ends button', (b) => b.map((x) => x.textContent));
async function traceAt(page, x, y) {
  await page.evaluate(() => { window.__linework.trace && window.__linework.trace.clear(); });
  await clickWorld(page, x, y);
  await page.waitForFunction(() => window.__linework.trace && window.__linework.trace.net);
  const b = await stageBox(page);
  await page.mouse.move(b.x + 4, b.y + b.h - 4); // (no hover highlight over the probes)
  await settle(page);
}

test('trace (View › Trace, J): a click lights up the net (pixel probes), panel with length, labels and ends; step, zoom, copy, Esc; options; paper; edits re-trace; a drag pans', async () => {
  const page = await newPage(CLIP);
  await openFixture(page, TRACE);
  await clearToasts(page);
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  // a host traces the wire a text labels without reading the graph: app.loadTrace('label', k) loads the tool's code
  // (in any tool), then app.trace.run('label', k); a text next to no wire gives null; clearing empties the status line
  const byLabel = await page.evaluate(async () => {
    const a = window.__linework, k = (s) => a.scene.texts.findIndex((t) => t.s === s);
    const n = await a.loadTrace('label', k('W2001')), none = await a.trace.run('label', k('TRACE TEST SHEET'));
    const r = { tool: a.tool, labels: n && n.labels.map((l) => l.s), ends: n && n.ends.length, none, info: document.querySelector('#st-info').textContent };
    a.trace.clear();
    return { ...r, after: document.querySelector('#st-info').textContent, net: a.trace.net };
  });
  eq(JSON.stringify(byLabel), JSON.stringify({ tool: 'pan', labels: ['W2001'], ends: 3, none: null, info: 'Net W2001 · 312.00 m · 3 ends', after: '', net: null }), 'trace by label');
  await page.keyboard.press('j');
  eq(await page.evaluate(() => window.__linework.tool), 'trace', 'J picks Trace');
  assert(await page.evaluate(() => document.querySelector('[data-tool="trace"]').getAttribute('aria-pressed')) === 'true', 'the View tab button is pressed');
  await page.waitForFunction(() => window.__linework.trace && window.__linework.trace.graph); // built as the tool is picked
  // a drag pans and does not trace
  const v0 = await page.evaluate(() => window.__linework.view.cx);
  await dragWorld(page, [60, 140], [80, 120]);
  assert((await page.evaluate(() => window.__linework.view.cx)) !== v0, 'a drag pans');
  eq(await trNet(page), null, 'a drag does not trace');
  await page.evaluate(() => window.__linework.fit());
  await settle(page);
  // net A: the long one
  await traceAt(page, 100, 160);
  eq(JSON.stringify(await trNet(page)), JSON.stringify({ wires: 5, count: 5, ends: 2, labels: ['W9434'] }), 'net A');
  assert(traceColour(await overlayPx(page, 120, 160)), 'net A is lit: ' + (await overlayPx(page, 120, 160)));
  assert(traceColour(await overlayPx(page, 40, 163)), 'its meander too');
  for (const [x, y] of [[120, 150], [130, 100], [60, 140]]) assert(!traceColour(await overlayPx(page, x, y)), `not lit: ${x}, ${y}`);
  eq(await page.textContent('#tr-title'), 'Net W9434', 'title');
  const sum = await page.textContent('#tr-sum');
  assert(/282\.00 m · 5 wires · 26 segments/.test(sum), sum);
  eq(await page.textContent('#tr-labels'), 'W9434 ×2', 'labels');
  eq(JSON.stringify(await endsShown(page)), JSON.stringify(['J4 · 1 (CONN)', 'P1 · P1-A (CONN)']), 'ends');
  eq(await page.evaluate(() => document.querySelector('#cv-drawing').style.opacity), '0.35', 'the rest is dimmed');
  assert(await page.isHidden('#tr-sheets'), 'no sheet set: no cross-sheet button');
  await shot(page, 'trace-dark-1440');
  // step through the ends, zoom to the net, copy
  await page.click('#tr-next');
  eq(await page.evaluate(() => window.__linework.trace.cur), 0, 'first end');
  const c = await page.evaluate(() => { const a = window.__linework; return [a.view.cx + a.scene.origin[0], a.view.cy + a.scene.origin[1], a.view.scale * 2]; });
  assert(nearPt(c, [34, 160], 0.01) && c[2] >= 14, 'zoomed to J4 pin 1, pin texts readable: ' + c);
  assert(await page.isVisible('#tr-ends li.on'), 'the current end is marked');
  await page.click('#tr-next');
  const c2 = await page.evaluate(() => { const a = window.__linework; return [a.view.cx + a.scene.origin[0], a.view.cy + a.scene.origin[1]]; });
  assert(nearPt(c2, [256, 160], 0.01), 'next end: P1-A');
  await page.click('#tr-zoom');
  const box = await page.evaluate(() => { const a = window.__linework, b = a.trace.net.bbox, [x0, y0] = a.view.toScreen(b[0], b[3]), [x1, y1] = a.view.toScreen(b[2], b[1]); return [x0, y0, x1, y1, a.view.w, a.view.h]; });
  assert(box[0] >= 0 && box[1] >= 0 && box[2] <= box[4] && box[3] <= box[5], 'zoom to net: all of it in view ' + box);
  await page.click('#tr-copy');
  const txt = (await clipText(page)).replace(/\r\n/g, '\n'); // (the system clipboard may use CRLF)
  assert(txt.startsWith('Net W9434 · dgn-trace.dgn\nLength 282.00 m · 5 wires · 26 segments\nEnds (2):\n  1. J4 · 1 (CONN) at X 34.00 Y 160.00'), txt);
  // Netlist (CSV): every net of the sheet as a from-to wire list, downloaded; a host gets the same list from app.trace.run('netlist')
  const [nl] = await Promise.all([page.waitForEvent('download'), page.click('#tr-list')]);
  eq(nl.suggestedFilename(), 'dgn-trace-netlist.csv', 'netlist file name');
  const nlPath = join(OUT, 'trace-netlist.csv');
  await nl.saveAs(nlPath);
  const nlCsv = readFileSync(nlPath, 'utf8'), nlRows = nlCsv.split('\r\n');
  eq(nlRows[0], 'net,labels,from,to,length,wires,junctions', 'netlist header');
  eq(nlRows[1], 'N1,W4100,TB2-1,TO SH 2,130,1,0', 'netlist: the first net (reading order)');
  assert(nlRows.includes('N3,W9434,J4-1,P1-A,282,5,0'), 'netlist: the traced net is listed: ' + nlRows.join(' / '));
  eq(await page.evaluate(async () => (await window.__linework.trace.run('netlist')).csv), nlCsv, 'a host gets the same netlist');
  // Esc clears (the net, the panel and the status line)
  eq(await page.textContent('#st-info'), 'Net W9434 · 282.00 m · 2 ends', 'the net in the status line');
  await page.keyboard.press('Escape');
  await settle(page);
  eq(await trNet(page), null, 'Esc clears the net');
  eq(await page.textContent('#st-info'), '', 'and the status line');
  assert(await page.isHidden('#trace-card'), 'and the panel');
  eq(await page.evaluate(() => document.querySelector('#cv-drawing').style.opacity), '', 'no longer dimmed');
  assert(!traceColour(await overlayPx(page, 120, 160)), 'nothing lit');
  eq(await page.evaluate(() => window.__linework.tool), 'trace', 'the tool stays (a second Esc goes back to Pan)');
  // a T-junction to the coil; a junction dot; crossings connect; through pins
  await page.evaluate(() => window.__linework.fit());
  await traceAt(page, 60, 150);
  eq(JSON.stringify(await endsShown(page)), JSON.stringify(['J4 · 2 (CONN)', 'P1 · P1-B (CONN)', 'K1 (circle)']), 'T-junction: ends');
  assert(traceColour(await overlayPx(page, 100, 100)), 'the branch is lit');
  await traceAt(page, 60, 140);
  assert(/1 junction dot/.test(await page.textContent('#tr-sum')), 'junction dot counted');
  assert(traceColour(await overlayPx(page, 220, 100)), 'the wire behind the dot is lit');
  assert(!traceColour(await overlayPx(page, 130, 100)), 'a crossing wire is not');
  await page.click('#trace-card summary');
  await page.check('#trace-card [data-o="crossings"]');
  await settle(page);
  assert((await trNet(page)).count >= 17, 'crossings connect: ' + JSON.stringify(await trNet(page)));
  assert(traceColour(await overlayPx(page, 130, 100)), 'the crossing wire is lit now');
  await page.uncheck('#trace-card [data-o="crossings"]');
  await traceAt(page, 100, 160);
  await page.check('#trace-card [data-o="throughPins"]');
  await settle(page);
  eq(JSON.stringify((await trNet(page)).labels), JSON.stringify(['W9434', 'W9435']), 'through pins: on across P1');
  assert(traceColour(await overlayPx(page, 290, 160)), 'the wire beyond the connector is lit');
  await page.uncheck('#trace-card [data-o="throughPins"]');
  await page.uncheck('#trace-card [data-o="dim"]');
  eq(await page.evaluate(() => document.querySelector('#cv-drawing').style.opacity), '', 'Dim the rest off');
  await page.check('#trace-card [data-o="dim"]');
  // paper (the shortcut works with the focus on a panel checkbox)
  await page.keyboard.press('b');
  eq(await page.evaluate(() => window.__linework.theme), 'paper', 'B from the panel');
  await settle(page);
  assert(traceColour(await overlayPx(page, 120, 160), 'paper'), 'paper colour: ' + (await overlayPx(page, 120, 160)));
  await shot(page, 'trace-paper-1440');
  await page.keyboard.press('b');
  // (Find on other sheets in a real sheet set: the test after the next one)
  // works in Edit too: an edit re-traces (the branch deleted: the coil is no longer an end), undo restores it
  await page.evaluate(() => window.__linework.fit());
  await traceAt(page, 60, 150);
  await page.waitForFunction(() => window.__linework.edit.ready);
  await page.keyboard.press('e');
  assert(await page.isVisible('#trace-card'), 'the net stays lit in Edit');
  await clickWorld(page, 100, 100);
  eq((await ED.sel(page)).length, 1, 'the branch selected');
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.__linework.trace.net && window.__linework.trace.net.ends.length === 2);
  eq(JSON.stringify(await endsShown(page)), JSON.stringify(['J4 · 2 (CONN)', 'P1 · P1-B (CONN)']), 'traced again after the edit');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.__linework.trace.net && window.__linework.trace.net.ends.length === 3);
  await page.keyboard.press('j');
  eq(await page.evaluate(() => window.__linework.tool), 'trace', 'J from Edit');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  eq(await page.evaluate(() => window.__linework.tool), 'pan', 'second Esc: Pan');
  await close(page);
});

test('trace at 390 px with touch: tap Trace, tap a wire; the panel docks at the bottom and fits; the close button clears', async () => {
  const ph = await newPage({ context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  await openFixture(ph, TRACE);
  await clearToasts(ph);
  await ph.tap('[data-tool="trace"]');
  await ph.waitForFunction(() => window.__linework.trace && window.__linework.trace.graph);
  eq(await ph.textContent('#tool-hint'), 'Tap a wire to light up everything connected to it', 'touch wording');
  const [x, y] = await client(ph, 60, 150);
  await ph.touchscreen.tap(x, y);
  await ph.waitForFunction(() => window.__linework.trace.net);
  await settle(ph);
  eq(JSON.stringify(await endsShown(ph)), JSON.stringify(['J4 · 2 (CONN)', 'P1 · P1-B (CONN)', 'K1 (circle)']), 'traced by a tap');
  const r = await ph.evaluate(() => { const b = document.querySelector('#trace-card').getBoundingClientRect(), s = document.querySelector('#stage').getBoundingClientRect(); return [b.left, b.right, b.top, b.bottom, window.innerWidth, s.top, s.bottom]; });
  assert(r[0] >= 0 && r[1] <= r[4], 'the panel fits the width: ' + r);
  assert(r[3] <= r[6] && r[2] > (r[5] + r[6]) / 2, 'docked in the lower half of the drawing area: ' + r);
  assert(traceColour(await overlayPx(ph, 60, 150)), 'lit');
  await shot(ph, 'trace-dark-390');
  await ph.tap('#tr-close');
  eq(await trNet(ph), null, 'the close button clears');
  eq(await ph.textContent('#st-info'), '', 'the status line too');
  await close(ph);
});

test('trace in a sheet set: Find on other sheets opens Find in all sheets with the label of the net (whole words): matches listed by sheet, a listed match opens that sheet; 390 px', async () => {
  const page = await newPage();
  await filesReady(page);
  await putSheets(page, 'PNL-trace');
  await page.evaluate(() => { window.showDirectoryPicker = async () => window.__dir; });
  await page.click('.topbar [data-action="open-folder"]');
  await waitSheet(page, 'PNL-01.dgn');
  await sheetsIndexed(page, 5);
  await page.click('#sheets-hide');
  await clearToasts(page);
  await page.keyboard.press('j');
  await page.waitForFunction(() => window.__linework.trace && window.__linework.trace.graph);
  await traceAt(page, 90, 95); // the wire numbered W201 (also on sheets 2 and 4)
  eq(JSON.stringify((await trNet(page)).labels), JSON.stringify(['W201']), 'the net of W201');
  assert(await page.isVisible('#tr-sheets'), 'Find on other sheets is offered in a set');
  assert(await page.evaluate(() => !window.__linework.tools || !window.__linework.tools.find.open), 'the find bar is closed');
  // the real sheet search (nothing stubbed): the find bar opens with the label, whole words, all sheets
  await page.click('#tr-sheets');
  await page.waitForSelector('.findbar:not([hidden])');
  eq(await page.inputValue('#find-q'), 'W201', 'the label is the query');
  eq(await page.getAttribute('.findbar [data-o="wholeWord"]', 'aria-pressed'), 'true', 'whole words');
  eq(await page.getAttribute('.findbar [data-o="all"]', 'aria-pressed'), 'true', 'all sheets');
  await page.waitForFunction(() => /5 in 3 sheets/.test(document.querySelector('#find-n').textContent));
  eq((await page.$$eval('.find-sets h4', (hs) => hs.map((h) => h.textContent))).join('|'), 'PNL-01.dgn2|PNL-02.dgn2|PNL-04.dxf1', 'matches listed by sheet');
  eq(await page.$$eval('.find-sets button[data-g]', (bs) => bs.map((b) => b.textContent).join()), 'W201,W201,W201,W201,W201', 'each match listed');
  eq(await page.$$eval('#sheet-list em', (es) => es.map((e) => e.textContent).join()), '2,2,1', 'counts in the navigator');
  assert(await page.isVisible('#trace-card'), 'the net stays traced');
  await shot(page, 'trace-sheets-find-dark-1440');
  // a listed match on another sheet opens it and zooms to it
  await page.click('.find-sets button[data-g="2"]');
  await waitSheet(page, 'PNL-02.dgn');
  eq(await findN(page), '3 of 5', 'the listed match on sheet 2');
  await settle(page);
  const z = await page.evaluate(() => { const a = window.__linework, t = a.scene.texts.find((x) => x.s === 'W201'), [ox, oy] = a.scene.origin, [sx, sy] = a.worldToScreen((t.bbox[0] + t.bbox[2]) / 2 + ox, (t.bbox[1] + t.bbox[3]) / 2 + oy); return [sx, sy, a.view.w, a.view.h]; });
  assert(z[0] > 0 && z[0] < z[2] && z[1] > 0 && z[1] < z[3], 'W201 on sheet 2 in view: ' + z);
  // the same on a phone-sized window: the trace panel and the find bar both fit
  await page.click('#find-close');
  await page.keyboard.press('j');
  eq(await page.evaluate(() => window.__linework.tool), 'trace', 'still tracing');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; }); // (it covers the drawing at this width)
  await settle(page);
  await page.evaluate(() => window.__linework.fit());
  await traceAt(page, 90, 95);
  eq(JSON.stringify((await trNet(page)).labels), JSON.stringify(['W201']), 'W201 on sheet 2');
  await page.click('#tr-sheets');
  await page.waitForFunction(() => /in 3 sheets|of 5/.test(document.querySelector('#find-n').textContent));
  const fit = await page.evaluate(() => [...document.querySelectorAll('#trace-card, .findbar')].map((el) => { const r = el.getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom]; }));
  assert(fit.every((r) => r[0] >= 0 && r[1] <= 390 && r[2] >= 0 && r[3] <= 844), 'both fit the window: ' + JSON.stringify(fit));
  await clearToasts(page);
  await shot(page, 'trace-sheets-find-dark-390');
  await close(page);
});

test('performance: Trace on the 53k stress drawing — the graph is built in slices (no long task), < 300 ms of work; a trace < 50 ms', async () => {
  const page = await newPage();
  await openSample(page, 'stress', 'stress-test-53k.dxf');
  await clearToasts(page);
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; window.__lt = []; const t0 = performance.now(); new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.startTime >= t0) window.__lt.push(e.duration); }).observe({ type: 'longtask' }); });
  await page.click('[data-tool="trace"]');
  await page.waitForFunction(() => window.__linework.trace && window.__linework.trace.graph, null, { timeout: 30000 });
  await page.evaluate(() => window.__linework.zoomToWorld(-500, -500, 10500, 10500));
  await settle(page);
  await traceAt(page, 5000, 0);
  const s = await page.evaluate(() => ({ ...window.__linework.traceStats, wires: window.__linework.trace.net.wires.length, lt: window.__lt }));
  const longest = s.lt.length ? Math.max(...s.lt) : 0;
  // the same build in one go, best of three (the first one above also pays for compiling the code)
  const again = await page.evaluate(async () => {
    const m = await import('./src/tools/trace.js'), a = window.__linework, ms = [], tr = [];
    for (let k = 0; k < 3; k++) { const G = m.buildNetGraph(a.scene); ms.push(G.ms); tr.push(m.traceNet(G, a.trace.net.seed, {}).ms); }
    return { build: Math.min(...ms), trace: Math.min(...tr) };
  });
  perf.trace = { entities: 53100, firstBuildMs: +s.buildMs.toFixed(1), firstBuildWallMs: +s.buildWallMs.toFixed(1), firstTraceMs: +s.traceMs.toFixed(2), buildMs: +again.build.toFixed(1), traceMs: +again.trace.toFixed(2), netWires: s.wires, longTaskMaxMs: +longest.toFixed(1) };
  eq(s.wires, 3600, 'the bay grid: 3600 lines joined at their ends and Ts');
  assert(again.build < 300, `graph build ${again.build.toFixed(0)} ms`);
  assert(s.traceMs < 50 && again.trace < 50, `trace ${s.traceMs.toFixed(1)} / ${again.trace.toFixed(1)} ms`);
  assert(longest < 100, `no long main-thread task while the graph is built (${longest.toFixed(0)} ms)`);
  await close(page);
});

// ------------------------------------------------------------------ PDF (pdf.js)
const PDF_READER_CACHE = /PDF_READER_CACHE = '([^']+)'/.exec(SW_SRC)[1];
const PDF_FILES = /\/vendor\/pdfjs\/|\/src\/formats\/pdf\.js$|\/src\/app\/pdf-ui\.js$/;
/**
 * A page on its own server whose Content-Security-Policy (the deployed one, or without
 * 'wasm-unsafe-eval' when strict) reports every violation to /csp-report: violations in the parse
 * worker are reported too (Playwright does not see a worker's console). page.reports, page.paths.
 */
async function reportingPage(strict = false, viewport = { width: 1440, height: 900 }) {
  const reports = [], paths = [];
  const srv = await startServer(0, '127.0.0.1', {
    onRequest: (p) => paths.push(p),
    handle: (req, res, p) => { if (p !== '/csp-report') return false; reports.push(p); req.resume(); res.writeHead(204).end(); return true; },
    headers: (h) => ({ ...h, 'Content-Security-Policy': (strict ? h['Content-Security-Policy'].replace(" 'wasm-unsafe-eval'", '') : h['Content-Security-Policy']) + '; report-uri /csp-report' }),
  });
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  Object.assign(page, { ctx, reports, paths, srv });
  await page.goto(`http://127.0.0.1:${srv.address().port}/?nosw`);
  await page.waitForFunction(() => !!window.__linework);
  return page;
}
const pdfPaths = (page) => page.paths.filter((p) => PDF_FILES.test(p)).map((p) => p.split('/').pop());
const sceneInfo = (page) => page.evaluate(() => { const a = window.__linework, s = a.scene; return { fmt: s.format, units: s.units.abbr, page: s.page && { n: s.page.n, count: s.page.count, label: s.page.label, box: s.page.box, raster: s.page.raster }, n: s.n, texts: s.textCount, layers: s.layers.map((l) => l.name), u: s.underlay && { w: s.underlay.w, h: s.underlay.h, dark: !!s.underlay.dark } }; });
/** World corners of the closed four-sided outline that is w x h drawing units (a wall, a box). */
const boxOf = (page, w, h) => page.evaluate(([w, h]) => {
  const s = window.__linework.scene, [ox, oy] = s.origin;
  for (let i = 0; i < s.n; i++) {
    if (s.count[i] !== 4 || !(s.flags[i] & 1)) continue;
    const b = s.bbox.subarray(4 * i, 4 * i + 4);
    if (Math.abs(b[2] - b[0] - w) < 0.01 && Math.abs(b[3] - b[1] - h) < 0.01) return [b[0] + ox, b[1] + oy, b[2] + ox, b[3] + oy];
  }
  return null;
}, [w, h]);

test('PDF: pdf.js loads only when a PDF is opened, once; no CSP violation from the page or the parse worker (reported to the server); a vector page: mm, layers, exact measure with snaps, find; Linework\'s own vector print reads back to scale', async () => {
  const page = await reportingPage();
  // reports reach the server: code compiled from a string by the page is refused and reported
  page.allowErrors = [/Evaluating a string as JavaScript violates|Refused to evaluate a string/];
  await page.evaluate(() => setTimeout('window.__ranFromString = true', 0)); // eslint-disable-line no-implied-eval
  for (let t = 0; t < 40 && !page.reports.length; t++) await page.waitForTimeout(100);
  eq(page.reports.length, 1, 'a violation is reported');
  page.reports.length = 0;
  await page.setInputFiles('#file-input', FIX('house-plan.dxf'));
  await page.waitForFunction(() => window.__linework.doc && window.__linework.doc.name === 'house-plan.dxf' && !window.__linework.loading);
  await page.setInputFiles('#file-input', FIX('site-plan.dgn'));
  await page.waitForFunction(() => window.__linework.doc && window.__linework.doc.name === 'site-plan.dgn' && !window.__linework.loading);
  eq(pdfPaths(page).length, 0, 'DXF and DGN never load the PDF reader');
  await page.evaluate(() => { window.__labels = []; new MutationObserver(() => window.__labels.push(document.querySelector('#progress-label').textContent)).observe(document.querySelector('#progress-label'), { childList: true, characterData: true, subtree: true }); });
  await openFixture(page, 'pdf-plan.pdf');
  await page.waitForFunction(() => !!window.__linework.pages);
  for (let t = 0; t < 30 && pdfPaths(page).length < 6; t++) await page.waitForTimeout(100);
  const loaded = pdfPaths(page);
  assert(['pdf.js', 'pdf-ui.js', 'pdf.min.mjs', 'pdf.worker.min.mjs', 'openjpeg.wasm', 'jbig2.wasm'].every((f) => loaded.filter((x) => x === f).length === 1), 'reader loaded once (and its image decoders fetched for offline use): ' + loaded);
  assert(await page.evaluate(() => window.__labels.some((l) => /Loading the PDF reader for pdf-plan\.pdf/.test(l))), 'progress names the reader download');
  const info = await sceneInfo(page);
  eq(info.fmt, 'PDF', 'format');
  eq(info.units, 'mm', 'A4: millimetres');
  assert(info.layers.includes('Lines (red)') && info.layers.includes('Annotations') && info.layers.includes('Text'), 'layers: ' + info.layers);
  eq(info.page.count, 1, 'one page');
  assert((await page.$eval('#doc-pages', (e) => e.style.display)) === 'none', 'no page picker for a one-page PDF');
  assert(/PDF 1\.7/.test(await page.getAttribute('#doc-name', 'title')), 'file info');
  eq(await page.textContent('#doc-units'), 'mm', 'units chip');
  await shot(page, 'pdf-plan-dark-1440');
  // measure exactly as drawn: the 100 mm line, endpoints snapped
  await clearToasts(page);
  await page.click('#tab-measure');
  await page.click('[data-tool="distance"]');
  await clickWorld(page, 20, 20, 4, -3);
  await clickWorld(page, 120, 20, -3, 4);
  eq((await mcValue(page)).trim(), '100.00 mm', 'a 100 mm line measures 100.00 mm');
  await page.keyboard.press('Escape');
  await page.keyboard.press('h');
  // find text
  await page.keyboard.press('Control+f');
  await page.waitForSelector('.findbar:not([hidden]) #find-q');
  await page.keyboard.type('PUMP-7');
  eq(await findN(page), '1 match', 'find text in a PDF');
  await page.keyboard.press('Escape');
  // layers by colour: hide the red lines (pixel check)
  await page.evaluate(() => window.__linework.fit());
  await settle(page);
  const before = await pixelAt(page, 100, 100);
  assert(before[0] > 150 && before[1] < 90, 'red line drawn red: ' + before);
  await page.locator('#layer-list li', { hasText: 'Lines (red)' }).locator('input').uncheck();
  await settle(page);
  const after = await pixelAt(page, 100, 100);
  assert(!(after[0] > 150 && after[1] < 90), 'red layer hidden: ' + after);
  // Linework's own vector print of the house plan (A3, 1:100), opened as a PDF: the 12 x 8 m outer wall is 120 x 80 mm
  await openFixture(page, 'pdf-print-house-plan.pdf');
  const wall = await boxOf(page, 120, 80);
  assert(wall, 'the outer wall is a 120 x 80 mm outline');
  await clearToasts(page);
  await zoomTo(page, wall[0] - 4, wall[1] - 4, wall[2] + 4, wall[1] + 4);
  await page.click('#tab-measure');
  await page.click('[data-tool="distance"]');
  await clickWorld(page, wall[0], wall[1], 2, -2);
  await clickWorld(page, wall[2], wall[1], -2, -2);
  eq((await mcValue(page)).trim(), '120.00 mm', 'to scale: 1:100');
  await page.keyboard.press('Escape');
  await page.keyboard.press('h');
  await shot(page, 'pdf-print-house-plan-dark-1440');
  await openFixture(page, 'pdf-schematic.pdf');
  eq((await sceneInfo(page)).units, 'in', 'Tabloid: inches');
  await page.waitForTimeout(1500); // reports are sent asynchronously
  eq(page.reports.length, 0, 'no CSP violation while reading PDFs, in the page or the parse worker');
  await page.ctx.close();
  page.srv.close();
  const errs = page.errors.filter((e) => !(page.allowErrors || []).some((re) => re.test(e)));
  assert(!errs.length, 'no console errors: ' + errs.join(' | '));
});

test('PDF under a CSP without wasm-unsafe-eval: the parse worker\'s refused WebAssembly is reported (so the test above would see one); the PDF still opens', async () => {
  const page = await reportingPage(true);
  await openFixture(page, 'pdf-plan.pdf');
  for (let t = 0; t < 40 && !page.reports.length; t++) await page.waitForTimeout(100);
  assert(page.reports.length >= 1, 'pdf.js compiles the spot colour\'s PostScript function to WebAssembly in the parse worker: refused and reported');
  const info = await sceneInfo(page);
  eq(info.fmt, 'PDF', 'opens anyway: pdf.js falls back to JavaScript');
  assert(info.layers.includes('Lines (red)'), 'the spot colour line is still red');
  await page.ctx.close();
  page.srv.close();
});

test('block editor: double-click a block, edit its definition on its own, Done: every copy changes in one undo step; Cancel; guards; 390 px', async () => {
  const page = await newPage();
  await openForEdit(page, 'house-plan.dxf');
  await setSnap(page, false);
  const doors = () => page.evaluate(() => { const a = window.__linework, s = a.scene, m = a.edit.doc.model, out = []; m.entities.forEach((e, i) => { if (e && e.type === 'insert' && e.block === 'DOOR') { let n = 0; const ov = s.override && s.override.get(i); if (ov) n = ov.prims.filter((p) => !s.dead[p]).length; else for (let k = s.entPrim[i]; k < s.entPrim[i + 1]; k++) n++; out.push(n); } }); return out.join(','); });
  eq(await doors(), '2,2,2,2,2,2,2', 'seven doors: a leaf and a swing each');
  // the first door's swing (the insert at 3900,4100, not turned): double-click it
  await zoomTo(page, 3600, 3800, 5400, 5300);
  await page.mouse.dblclick(...(await client(page, 3900 + 900 * Math.SQRT1_2, 4100 + 900 * Math.SQRT1_2)));
  await page.waitForFunction(() => !!window.__linework.blockEdit && !!document.querySelector('#block-bar'));
  eq(await page.textContent('#block-bar b'), 'DOOR', 'the bar names the block');
  eq(await page.$$eval('#block-bar button', (b) => b.map((x) => x.textContent).join(',')), 'Done,Cancel');
  eq(await page.evaluate(() => window.__linework.scene.n), 2, 'the door on its own');
  assert(/Editing block DOOR/.test(await page.textContent('#toasts')), 'a note says what is being edited');
  const ext = await page.evaluate(() => { const s = window.__linework.scene, [ox, oy] = s.origin; return s.extents.map((v, k) => Math.round(v + (k % 2 ? oy : ox))).join(','); });
  eq(ext, '0,0,900,900', 'in its own coordinates');
  await clearToasts(page);
  await shot(page, 'block-editor-dark-1440');
  // a line across the door (block coordinates), undo / redo inside the editor
  await page.click('[data-tool="eline"]');
  await clickWorld(page, 0, 450);
  await clickWorld(page, 900, 450);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__linework.edit.doc.model.entities.filter(Boolean).length === 3);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.__linework.edit.doc.model.entities.filter(Boolean).length === 2);
  await page.keyboard.press('Control+y');
  await page.waitForFunction(() => window.__linework.edit.doc.model.entities.filter(Boolean).length === 3);
  assert(await page.isVisible('#doc-dirty'), 'unsaved changes are shown');
  // guards: saving, opening another drawing, markups wait for Done or Cancel
  await page.keyboard.press('Control+s');
  await page.waitForSelector('#toasts [data-key="block"]');
  assert(/Close the block editor first/.test(await page.textContent('#toasts [data-key="block"]')), 'Save waits');
  await clearToasts(page);
  await page.evaluate(() => window.__linework.openSample('samples/bracket.dxf'));
  await settle(page);
  assert(await page.evaluate(() => !!window.__linework.blockEdit && window.__linework.doc.name === 'house-plan.dxf'), 'another drawing does not replace the block editor');
  await page.click('#tab-markup'); await page.click('[data-tool="rect"]');
  assert(await page.evaluate(() => window.__linework.tool !== 'rect'), 'no markups on a block');
  await page.click('#tab-edit');
  await clearToasts(page);
  // Done: one undo step of the drawing; every door has the line
  await page.click('#block-bar [data-act="done"]');
  await page.waitForFunction(() => !window.__linework.blockEdit && !document.querySelector('#block-bar'));
  eq(await doors(), '3,3,3,3,3,3,3', 'every door has the line');
  eq(await page.evaluate(() => window.__linework.edit.doc.model.blocks.DOOR.entities.length), 3);
  eq(await page.evaluate(() => window.__linework.history.undoStack.map((e) => e.label).join('|')), 'Edit block DOOR', 'the editor\'s steps are one step of the drawing');
  eq(await page.evaluate(() => [...window.__linework.edit.sel].length), 1, 'the door stays selected');
  await zoomTo(page, 3600, 3800, 5400, 5300);
  await clearToasts(page);
  await shot(page, 'block-edited-dark-1440');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.__linework.edit.doc.model.blocks.DOOR.entities.length === 2);
  eq(await doors(), '2,2,2,2,2,2,2', 'undo: the doors as they were');
  await page.keyboard.press('Control+y');
  await page.waitForFunction(() => window.__linework.edit.doc.model.blocks.DOOR.entities.length === 3);
  // Cancel (right-click › Edit block…): asks, then leaves the drawing as it was
  const [cx, cy] = await client(page, 3900 + 900 * Math.SQRT1_2, 4100 + 900 * Math.SQRT1_2);
  await page.mouse.click(cx, cy, { button: 'right' });
  await page.click('#ctx-menu >> text=Edit block…');
  await page.waitForFunction(() => !!window.__linework.blockEdit);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.__linework.edit.doc.model.entities.filter(Boolean).length === 0);
  const asked = [];
  page.once('dialog', (d) => { asked.push(d.message()); d.accept(); });
  await page.click('#block-bar [data-act="cancel"]');
  await page.waitForFunction(() => !window.__linework.blockEdit);
  assert(/Drop the changes to block DOOR/.test(asked[0] || ''), 'Cancel asks first: ' + asked);
  eq(await doors(), '3,3,3,3,3,3,3', 'Cancel: nothing changed');
  eq(await page.evaluate(() => window.__linework.history.undoStack.length), 1, 'and nothing added to the history');
  await close(page);
  // 390 px: the bar fits
  const phone = await newPage({ context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } });
  await openForEdit(phone, 'house-plan.dxf');
  await zoomTo(phone, 3600, 3800, 5400, 5300);
  await phone.mouse.dblclick(...(await client(phone, 3900 + 900 * Math.SQRT1_2, 4100 + 900 * Math.SQRT1_2)));
  await phone.waitForFunction(() => !!document.querySelector('#block-bar'));
  await clearToasts(phone);
  const bb = await phone.evaluate(() => { const b = document.querySelector('#block-bar').getBoundingClientRect(); return [b.left, b.right, b.top, innerWidth]; });
  assert(bb[0] >= 0 && bb[1] <= bb[3], 'the bar fits at 390 px: ' + bb);
  await shot(phone, 'block-editor-dark-390');
  await close(phone);
});

test('line types at their true size and hatch patterns as lines: dashes in drawing units, solid when too small to see, pattern lines that move with their hatch', async () => {
  const page = await newPage();
  await openForEdit(page, 'linetypes.dxf');
  const lines = () => page.evaluate(() => { const s = window.__linework.scene; let n = 0, added = 0; for (let i = 0; i < s.n; i++) if ((s.flags[i] & 96) === 64 && !(s.dead && s.dead[i])) { n++; if (i >= (window.__n0 ?? Infinity)) added++; } return [n, added]; }); // FLAG.HL without FLAG.PATTERN; added: since __n0
  eq((await lines())[0], 4, 'the parse worker drew four hatches as lines (the dense one is a tone)');
  await page.click('#tab-view');
  // a line within 2 px of a drawing point (the dark background is about 60)
  const lit = (x, y) => page.evaluate(([x, y]) => { const a = window.__linework, [sx, sy] = a.worldToScreen(x, y), d = a.dpr; const g = document.querySelector('#cv-drawing').getContext('2d').getImageData(Math.round(sx * d) - 2, Math.round(sy * d) - 2, 5, 5).data; let m = 0; for (let i = 0; i < g.length; i += 4) m = Math.max(m, g[i] + g[i + 1] + g[i + 2]); return m > 150; }, [x, y]);
  // DASHED at $LTSCALE 10: 5 on, 2.5 off, from the line's start
  await zoomTo(page, 0, -4, 30, 14);
  eq(JSON.stringify(await Promise.all([2.5, 6.25, 10, 13.75, 17.5].map((x) => lit(x, 0)))), '[true,false,true,false,true]', 'dashes 5 and gaps 2.5 drawing units long');
  eq(JSON.stringify(await Promise.all([5, 12.5, 20].map((x) => lit(x, 10)))), '[true,false,true]', 'its own scale 2: dashes 10, gaps 5');
  await clearToasts(page);
  await shot(page, 'linetypes-zoom-dark-1440');
  // the pattern lines: 5 apart inside the first hatch
  await zoomTo(page, 0, 40, 40, 80);
  await shot(page, 'linetypes-hatch-dark-1440');
  eq(JSON.stringify(await Promise.all([62.5, 65, 67.5].map((y) => lit(20, y)))), '[true,false,true]', 'hatch lines 5 apart');
  // zoomed far out a whole pattern is under 3 px: drawn solid (no dash pattern set)
  await page.evaluate(() => { window.__dashes = []; const f = CanvasRenderingContext2D.prototype.setLineDash; CanvasRenderingContext2D.prototype.setLineDash = function (a) { window.__dashes.push([...a].join(' ')); return f.call(this, a); }; });
  await zoomTo(page, -40000, -40000, 40000, 40000);
  await page.evaluate(() => window.__linework.invalidate(true)); await settle(page);
  const far = await page.evaluate(() => window.__dashes.filter((d) => d));
  assert(!far.some((d) => /^(5 2\.5|10 5|15 7\.5|5 2\.5 0 2\.5)$/.test(d)), 'no drawing-unit dashes when they would be under 3 px: ' + far);
  await page.keyboard.press('f'); await settle(page);
  const fit = await page.evaluate(() => window.__dashes.filter((d) => d));
  assert(['5 2.5', '10 5', '15 7.5', '5 2.5 0 2.5'].every((d) => fit.includes(d)), 'fitted: the dashes in drawing units: ' + [...new Set(fit)]);
  await clearToasts(page);
  await shot(page, 'linetypes-dark-1440');
  await page.keyboard.press('b');
  await shot(page, 'linetypes-paper-1440');
  await page.keyboard.press('b');
  // move a hatch in Edit: its lines are made again with it (src/hatch.js in this tab too)
  await page.click('#tab-edit'); await page.click('[data-tool="eselect"]');
  await zoomTo(page, -10, 30, 50, 90);
  await clickWorld(page, 20, 63.75);
  eq(await page.evaluate(() => window.__linework.edit.sel.size), 1, 'the hatch is selected by a click inside it');
  await page.evaluate(() => { window.__n0 = window.__linework.scene.n; });
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForFunction(() => window.__linework.edit.doc.dirty);
  eq(JSON.stringify(await lines()), '[4,1]', 'the moved hatch still has its lines (one new item, the old one gone)');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => !window.__linework.edit.doc.dirty);
  eq((await lines())[0], 4, 'undo: the lines are back where they were');
  await close(page);
});

test('layouts (DXF): Model and the layouts in the picker; a layout shows its sheet and the model through its viewports; read-only; markups per layout; 390 px', async () => {
  const page = await newPage();
  await openFixture(page, 'layouts.dxf');
  await page.waitForFunction(() => !!window.__linework.pages && document.querySelector('#doc-pages').style.display !== 'none');
  eq(await page.$$eval('#sel-page option', (o) => o.map((x) => x.textContent).join(',')), 'Model,A3 Plan,Detail,Empty', 'Model first, layouts in tab order');
  eq(await page.getAttribute('#sel-page', 'aria-label'), 'Layout', 'labelled as layouts, not pages');
  eq(await page.evaluate(() => window.__linework.scene.page.n), 1, 'opens on Model');
  assert(await page.evaluate(() => window.__linework.scene.texts.some((t) => t.s === 'MODEL ONLY')), 'model space');
  // a markup on the model page
  await page.click('#tab-markup'); await page.click('[data-tool="rect"]');
  const box = await stageBox(page);
  await dragScreen(page, [box.x + box.w * 0.4, box.y + box.h * 0.4], [box.x + box.w * 0.5, box.y + box.h * 0.5]);
  eq(await page.evaluate(() => window.__linework.markups.length), 1, 'a markup on Model');
  await page.click('#tab-view');
  await page.selectOption('#sel-page', '2');
  await page.waitForFunction(() => window.__linework.scene.page.n === 2 && !window.__linework.loading);
  const lay = await page.evaluate(() => { const s = window.__linework.scene; return { label: s.page.label, layout: s.page.layout, texts: s.texts.map((t) => t.s).sort().join('|'), markups: window.__linework.markups.length }; });
  eq(JSON.stringify(lay), JSON.stringify({ label: 'A3 Plan', layout: true, texts: 'A3 PLAN SHEET|MODEL ONLY', markups: 0 }), 'the layout: its sheet, the model through the viewport, its own markups');
  assert(/Opened layouts\.dxf, layout A3 Plan/.test(await page.textContent('#toasts')), 'the open note names the layout');
  await clearToasts(page);
  await shot(page, 'layout-a3-dark-1440');
  // read-only: the Edit tab and the edit keys say so and stay out
  await page.click('#tab-edit');
  await page.waitForSelector('#toasts [data-key="layout"]');
  assert(/read-only/.test(await page.textContent('#toasts [data-key="layout"]')), 'a layout is read-only');
  assert(!(await page.evaluate(() => /^e/.test(window.__linework.tool))), 'no editing tool on a layout: ' + (await page.evaluate(() => window.__linework.tool)));
  await page.keyboard.press('e');
  assert(!(await page.evaluate(() => /^e/.test(window.__linework.tool))), 'E does not start editing on a layout');
  await clearToasts(page);
  // measuring works on paper: the sheet's bottom edge is 420 units
  await page.click('#tab-measure'); await page.click('[data-tool="distance"]');
  await clickWorld(page, 0, 297, 3, 3); // (the top edge: the measure card sits over the bottom left)
  await clickWorld(page, 420, 297, -3, 3);
  eq((await mcValue(page)).trim(), '420.00 mm', 'paper units on a layout');
  await page.click('[data-action="clear-measure"]');
  await page.click('#tab-view');
  await page.keyboard.press('PageDown');
  await page.waitForFunction(() => window.__linework.scene.page.n === 3 && !window.__linework.loading);
  eq(await page.evaluate(() => window.__linework.scene.texts.map((t) => t.s).join('|')), 'DETAIL SHEET', 'the detail: the model text is outside its viewport');
  await clearToasts(page);
  await shot(page, 'layout-detail-dark-1440');
  await page.keyboard.press('b');
  await shot(page, 'layout-detail-paper-1440');
  await page.keyboard.press('b');
  await page.selectOption('#sel-page', '1');
  await page.waitForFunction(() => window.__linework.scene.page.n === 1 && !window.__linework.loading);
  eq(await page.evaluate(() => window.__linework.markups.length), 1, 'the Model markup is back');
  await page.click('#tab-edit');
  eq(await page.evaluate(() => window.__linework.tool), 'eselect', 'Model is editable');
  await close(page);
  // 390 px: the picker in the status bar, on screen
  const phone = await newPage({ context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } });
  await openFixture(phone, 'layouts.dxf');
  await phone.waitForFunction(() => !!window.__linework.pages && document.querySelector('#doc-pages').style.display !== 'none');
  await phone.selectOption('#sel-page', '2');
  await phone.waitForFunction(() => window.__linework.scene.page.n === 2 && !window.__linework.loading);
  await clearToasts(phone);
  const pr = await phone.evaluate(() => { const b = document.querySelector('#doc-pages').getBoundingClientRect(); return [b.left, b.right, b.bottom, innerWidth, innerHeight]; });
  assert(pr[0] >= 0 && pr[1] <= pr[3] && pr[2] <= pr[4], 'picker on screen at 390 px: ' + pr);
  await shot(phone, 'layout-a3-dark-390');
  await close(phone);
});

test('PDF pages: picker with the PDF\'s page labels, Page Down / Page Up / list / buttons; markups kept per page; a /Rotate page is landscape; app.pages; a non-PDF hides the picker; 390 px', async () => {
  const page = await newPage();
  await openFixture(page, 'pdf-multipage.pdf');
  await page.waitForFunction(() => !!window.__linework.pages && document.querySelector('#doc-pages').style.display !== 'none');
  assert(/Opened pdf-multipage\.pdf, page i of 3/.test(await page.textContent('#toasts')), 'the open note names the page');
  eq(await page.$eval('#sel-page', (s) => s.selectedOptions[0].textContent), 'Page i / 3', 'page label');
  eq(await page.$$eval('#sel-page option', (o) => o.map((x) => x.textContent).join(',')), 'Page i / 3,Page 1 / 3,Page 2 / 3', 'all pages');
  assert(await page.isDisabled('#btn-page-prev') && !(await page.isDisabled('#btn-page-next')), 'first page');
  eq((await sceneInfo(page)).units, 'in', 'Letter: inches');
  await clearToasts(page);
  await shot(page, 'pdf-pages-dark-1440');
  // a markup on page 1
  await page.click('#tab-markup'); await page.click('[data-tool="rect"]');
  const box = await stageBox(page);
  await dragScreen(page, [box.x + box.w * 0.4, box.y + box.h * 0.4], [box.x + box.w * 0.5, box.y + box.h * 0.5]);
  eq(await page.evaluate(() => window.__linework.markups.length), 1, 'a markup on page 1');
  await page.click('#tab-view');
  await page.keyboard.press('PageDown');
  await page.waitForFunction(() => window.__linework.scene.page.n === 2 && !window.__linework.loading);
  let info = await sceneInfo(page);
  eq(info.page.label, '1', 'page 2 is labelled 1');
  eq(info.units, 'mm', 'A4 landscape: mm');
  eq(await page.evaluate(() => window.__linework.markups.length), 0, 'page 2 has its own markups');
  assert(await page.evaluate(() => window.__linework.scene.texts.some((t) => t.s === 'PAGE TWO')), 'page 2 content');
  eq(await page.$eval('#sel-page', (s) => s.value), '2', 'picker follows');
  await page.selectOption('#sel-page', '3');
  await page.waitForFunction(() => window.__linework.scene.page.n === 3 && !window.__linework.loading);
  info = await sceneInfo(page);
  assert(info.page.box[2] - info.page.box[0] > info.page.box[3] - info.page.box[1], 'a /Rotate 90 page shows landscape');
  const rot = await page.evaluate(() => { const t = window.__linework.scene.texts.find((x) => x.s === 'PAGE THREE'); return Math.atan2(t.m[1], t.m[0]); });
  assert(Math.abs(rot + Math.PI / 2) < 1e-6, 'its text reads downwards: ' + rot);
  assert(await page.isDisabled('#btn-page-next'), 'last page');
  await clearToasts(page);
  await shot(page, 'pdf-page3-rotated-dark-1440');
  await page.keyboard.press('b');
  await shot(page, 'pdf-page3-rotated-paper-1440');
  await page.keyboard.press('b');
  await page.click('#btn-page-prev');
  await page.waitForFunction(() => window.__linework.scene.page.n === 2 && !window.__linework.loading);
  await page.keyboard.press('PageUp');
  await page.waitForFunction(() => window.__linework.scene.page.n === 1 && !window.__linework.loading);
  eq(await page.evaluate(() => window.__linework.markups.length), 1, 'page 1 markup back');
  // the pages API (sheet sets can use it)
  const api = await page.evaluate(async () => { const p = window.__linework.pages; const r = { count: p.count, current: p.current, l2: p.label(2), ok: await p.goto(3) }; r.after = p.current; return r; });
  assert(api.count === 3 && api.current === 1 && api.l2 === '1' && api.ok === true && api.after === 3, 'app.pages: ' + JSON.stringify(api));
  await openFixture(page, 'bracket.dxf');
  eq(await page.$eval('#doc-pages', (e) => e.style.display), 'none', 'no picker for a DXF');
  eq(await page.evaluate(() => window.__linework.pages.count), 0, 'app.pages: not a PDF');
  await close(page);
  // 390 px: the picker (in the status bar) is on screen and overlaps nothing
  const phone = await newPage({ context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } });
  await openFixture(phone, 'pdf-multipage.pdf');
  await phone.waitForFunction(() => !!window.__linework.pages);
  await clearToasts(phone);
  const r = await phone.evaluate(() => {
    const box = (e) => e.getBoundingClientRect(), p = box(document.querySelector('#doc-pages'));
    const others = [...document.querySelectorAll('.statusbar > *, .topbar > *')].filter((e) => e.id !== 'doc-pages' && !e.classList.contains('spacer') && box(e).width > 0);
    return { p: [p.left, p.right, p.top, p.bottom], w: innerWidth, h: innerHeight, hits: others.filter((e) => { const b = box(e); return b.left < p.right && b.right > p.left && b.top < p.bottom && b.bottom > p.top; }).map((e) => e.id || e.className) };
  });
  assert(r.p[0] >= 0 && r.p[1] <= r.w && r.p[3] <= r.h && !r.hits.length, 'page picker on screen at 390 px, overlapping nothing: ' + JSON.stringify(r));
  await shot(phone, 'pdf-pages-dark-390');
  await close(phone);
});

test('PDF scanned page: shown as a picture with a note (no text recognition), inverted on the dark background; measure and mark up on it; its invisible text on a hidden layer; printed with the picture', async () => {
  const page = await newPage();
  await openFixture(page, 'pdf-scan.pdf');
  await page.waitForSelector('.toast.warn');
  assert(/scanned image: it is shown as a picture.*no text recognition/.test(await page.textContent('#toasts')), 'the open note says so: ' + await page.textContent('#toasts'));
  const info = await sceneInfo(page);
  assert(info.page.raster && info.u && info.u.w === 1700 && info.u.h === 2200 && info.u.dark, 'picture at 200 dpi, with a dark-theme copy: ' + JSON.stringify(info.u));
  await clearToasts(page);
  // the scan's frame line (left edge, image column 12-13 of 425 = 0.25 in) and empty paper
  const at = (x, y) => page.evaluate(([x, y]) => { const a = window.__linework, [sx, sy] = a.worldToScreen(x, y), d = a.dpr; const g = document.querySelector('#cv-drawing').getContext('2d').getImageData(Math.round(sx * d) - 3, Math.round(sy * d), 7, 1).data; let mx = 0, mn = 765; for (let i = 0; i < g.length; i += 4) { const v = g[i] + g[i + 1] + g[i + 2]; mx = Math.max(mx, v); mn = Math.min(mn, v); } return [mx, mn]; }, [x, y]);
  let line = await at(0.25, 5), paper = await at(6, 1.5);
  assert(line[0] > 600 && paper[0] < 100, `dark theme: the scan is inverted (line ${line}, paper ${paper})`);
  await shot(page, 'pdf-scan-dark-1440');
  await page.keyboard.press('b');
  await settle(page);
  line = await at(0.25, 5); paper = await at(6, 1.5);
  assert(line[1] < 200 && paper[1] > 700, `paper theme: as scanned (line ${line}, paper ${paper})`);
  await shot(page, 'pdf-scan-paper-1440');
  // measure on the picture (inches) and mark it up
  await page.click('#tab-measure'); await page.click('[data-tool="distance"]');
  await clickWorld(page, 1, 1); await clickWorld(page, 4, 1);
  eq((await mcValue(page)).trim(), '3.00 in', 'measure across the page');
  await page.keyboard.press('Escape');
  await page.click('#tab-markup'); await page.click('[data-tool="cloud"]');
  const box = await stageBox(page);
  await dragScreen(page, [box.x + box.w * 0.45, box.y + box.h * 0.4], [box.x + box.w * 0.55, box.y + box.h * 0.5]);
  eq(await page.evaluate(() => window.__linework.markups.length), 1, 'a markup on the scan');
  // the scanner's invisible text: hidden, searchable once shown
  await page.click('#tab-view');
  await page.keyboard.press('Control+f');
  await page.waitForSelector('.findbar:not([hidden]) #find-q');
  await page.keyboard.type('PUMP-7');
  assert(!/^1 match/.test(await findN(page)), 'a hidden layer is not searched: ' + (await findN(page)));
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const li = [...document.querySelectorAll('#layer-list li')].find((l) => /Text \(invisible\)/.test(l.textContent)); li.querySelector('input').click(); });
  await page.keyboard.press('Control+f');
  await page.fill('#find-q', 'PUMP-7');
  eq(await findN(page), '1 match', 'shown: found');
  await page.keyboard.press('Escape');
  // print: the vector sheet carries the picture
  await page.evaluate(() => window.__linework.printSheet({ sheet: 'letter', orient: 'portrait', scale: 'Fit', area: 'all' }));
  assert(await page.evaluate(() => { const i = document.querySelector('#print-root svg image'); return !!i && /^data:image\/png;base64,/.test(i.getAttribute('href')); }), 'the print sheet has the scan');
  await page.evaluate(() => { document.querySelector('#print-root').innerHTML = ''; });
  await close(page);
});

test('PDF: password-protected and damaged files give friendly messages and keep the open drawing; a PDF with only an owner password opens', async () => {
  const page = await newPage();
  await openFixture(page, 'pdf-plan.pdf');
  for (const [file, re] of [['pdf-password.pdf', /protected by a password/], ['pdf-broken.pdf', /This PDF could not be read/]]) {
    await clearToasts(page);
    await page.setInputFiles('#file-input', FIX(file));
    await page.waitForSelector('.toast.error');
    assert(re.test(await page.textContent('#toasts')), `${file}: ${await page.textContent('#toasts')}`);
    eq(await page.textContent('#doc-name'), 'pdf-plan.pdf', 'the previous drawing is still open');
  }
  await openFixture(page, 'pdf-owner.pdf');
  assert(await page.evaluate(() => window.__linework.scene.texts.some((t) => t.s === 'OWNER ONLY')), 'owner-only encryption: opens');
  await close(page);
});

test('PDF: Edit and Save give a DXF copy (Linework does not write PDF), named after the page; it reopens', async () => {
  const page = await newPage();
  await openForEdit(page, 'pdf-plan.pdf');
  // retype a text of the page (Edit works on a PDF page like on any drawing)
  await page.evaluate(() => { document.querySelector('#layers-panel').hidden = true; });
  await zoomTo(page, 10, 230, 80, 270);
  await page.mouse.dblclick(...(await client(page, ...(await textAt(page, 'PLAN VIEW A')))));
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'ta-edit');
  await page.keyboard.press('Control+a'); await page.keyboard.type('PLAN VIEW B'); await page.keyboard.press('Enter');
  assert(await ED.dirty(page), 'unsaved edit');
  assert(await page.evaluate(() => !!window.__linework.scene.page), 'still a PDF page after the edit');
  await page.click('#btn-esaveas');
  await page.waitForSelector('#dlg-save[open]');
  assert(/^Opened from a PDF\. Linework does not write PDF/.test(await page.textContent('#save-notes li')), 'the dialog says first, plainly, that PDF is not written');
  assert(/Pictures and fonts are not kept/.test(await page.textContent('#save-notes')), 'and what a copy leaves out');
  assert(await page.isChecked('input[name="fmt"][value="DXF"]'), 'DXF by default');
  eq(await page.inputValue('#save-name'), 'pdf-plan-edited.dxf', 'default name');
  await shot(page, 'save-dialog-pdf-dark-1440');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-do-save')]);
  eq(dl.suggestedFilename(), 'pdf-plan-edited.dxf', 'downloads a DXF');
  const out = join(OUT, 'pdf-plan-edited.dxf');
  await dl.saveAs(out);
  assert(/Linework does not write PDF, so this is a DXF copy/.test(await page.textContent('#toasts')), 'the save note says so');
  await page.setInputFiles('#file-input', out);
  await page.waitForFunction(() => window.__linework.doc.name === 'pdf-plan-edited.dxf' && !window.__linework.loading);
  const info = await sceneInfo(page);
  eq(info.fmt, 'DXF', 'reopened as DXF');
  eq(info.units, 'mm', 'in millimetres');
  assert(await page.evaluate(() => window.__linework.scene.texts.some((t) => t.s === 'PLAN VIEW B') && window.__linework.scene.texts.some((t) => t.s === 'PUMP-7 INLET')), 'with its text and the edit');
  // page 2 of a multi-page PDF: the name says which page
  await openForEdit(page, 'pdf-multipage.pdf');
  await page.waitForFunction(() => !!window.__linework.pages);
  await page.evaluate(() => window.__linework.pages.goto(2));
  await page.waitForFunction(() => window.__linework.scene.page.n === 2 && !window.__linework.loading && window.__linework.edit.ready);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btn-esave')]);
  eq(dl2.suggestedFilename(), 'pdf-multipage-p2-edited.dxf', 'Save on page 2');
  await close(page);
});

test('PDF offline: after the first PDF, pdf.js is cached in its own cache and PDFs (scanned pages too) open with no network', async () => {
  const page = await newPage({ sw: true });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  await openFixture(page, 'pdf-scan.pdf');
  await page.waitForFunction(async (name) => (await (await caches.open(name)).keys()).length === 4, PDF_READER_CACHE, { timeout: 30000 });
  assert(await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('linework-')).length === 2), 'app cache + PDF reader cache');
  await page.ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !!window.__linework);
  await openFixture(page, 'pdf-multipage.pdf');
  await page.waitForFunction(() => !!window.__linework.pages);
  await page.keyboard.press('PageDown');
  await page.waitForFunction(() => window.__linework.scene.page.n === 2 && !window.__linework.loading);
  assert(await page.evaluate(() => window.__linework.scene.texts.some((t) => t.s === 'PAGE TWO')), 'pages switch offline');
  await openFixture(page, 'pdf-scan.pdf');
  assert(await page.evaluate(() => !!window.__linework.scene.underlay), 'a scanned page opens offline');
  await page.ctx.setOffline(false);
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
