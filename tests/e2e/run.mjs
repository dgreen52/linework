#!/usr/bin/env node
// End-to-end tests (Playwright, no test-runner dependency).
//   NODE_PATH=<a node_modules folder that has playwright> node tests/e2e/run.mjs [filter]
// Screenshots + perf.json are written to tests/e2e/out/. Only SYNTHETIC fixtures are used.
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

const server = await startServer(0);
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
  const errs = page.errors.filter((e) => !/Failed to load resource.*(favicon)/.test(e));
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

// ------------------------------------------------------------------ tests
test('empty state, privacy promise, app shell size', async () => {
  const page = await newPage();
  assert(await page.isVisible('#empty'), 'empty state visible');
  const promise = await page.textContent('.promise');
  assert(/never leave this device/i.test(promise), 'privacy promise shown');
  eq(await page.locator('.sample').count(), 5, 'sample buttons');
  await shot(page, 'empty-dark-1440');
  // transferred size of the app shell (everything the SW precaches except samples)
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const list = sw.slice(sw.indexOf('const SHELL = ['), sw.indexOf('];', sw.indexOf('const SHELL = [')));
  const shell = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((p) => p !== './' && !p.startsWith('samples/'));
  let raw = 0, gz = 0, codeGz = 0;
  for (const p of shell) {
    const b = readFileSync(join(ROOT, p));
    raw += b.length;
    const z = gzipSync(b, { level: 9 }).length;
    gz += z;
    if (!p.startsWith('icons/')) codeGz += z;
  }
  perf.appShell = { files: shell.length, rawKB: +(raw / 1024).toFixed(1), gzipKB: +(gz / 1024).toFixed(1), codeGzipKB: +(codeGz / 1024).toFixed(1) };
  assert(gz < 150 * 1024, `app shell gzip ${gz} < 150 KB`);
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
  for (const [file, re] of [['edge-fake.dwg', /DWG support is coming/], ['edge-binary.dxf', /Binary DXF is not supported/], ['edge-garbage.dxf', /not a drawing|not a DXF/]]) {
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
