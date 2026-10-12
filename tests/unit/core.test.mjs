// The library entry (lib/core.js, package export "linework/core"): everything it promises is there and
// works in Node, and it stays out of the web app (not imported by src/, not precached, not deployed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ROOT, bytes } from './helpers.mjs';
import * as core from 'linework/core';

const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

test('core: the package export resolves to lib/core.js and names the version and the DWG reader', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./core'], './lib/core.js');
  assert.equal(core.VERSION, pkg.version);
  assert.ok(core.DWG_WASM_URL instanceof URL && statSync(core.DWG_WASM_URL).size > 1e6, 'DWG reader wasm is where DWG_WASM_URL points');
  for (const name of ['detectFormat', 'parseDrawing', 'parseDrawingAsync', 'buildScene', 'findTexts', 'describeScene', 'diffScenes',
    'writeDxf', 'writeDgn', 'buildSvg', 'printLayout', 'cssColor', 'entityItems', 'entityInfo', 'typeName', 'queryRect', 'primPoints',
    'measure', 'bulgePolylineLength', 'hashBytes', 'flatEntities', 'FormatError',
    'buildNetGraph', 'buildNetGraphAsync', 'pickWire', 'traceNet', 'endText', 'netText', 'textQuad',
    'isSheetName', 'stemOf', 'naturalCmp', 'indexSheet', 'searchIndex', 'searchSheets', 'compilePatterns', 'xrefContext', 'resolveRef',
    'findXrefs']) assert.equal(typeof core[name], 'function', name);
  assert.deepEqual(Object.keys(core.ROLE), ['WIRE', 'DOT', 'PART', 'SHAPE']);
  assert.ok(Array.isArray(core.SHEET_EXTS) && Array.isArray(core.XREF_DEFAULT));
});

test('core: stays out of the web app (no src/ import, not in the service worker, not deployed)', async () => {
  for (const f of walk(join(ROOT, 'src'))) assert.ok(!/lib\/core|linework\/core/.test(readFileSync(f, 'utf8')), `${relative(ROOT, f)} imports the library entry`);
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  assert.ok(!sw.includes('lib/'), 'sw.js does not cache lib/');
  const { distEntries } = await import('../../tools/make_dist.mjs');
  for (const [, to] of distEntries()) assert.ok(!to.split(sep).join('/').startsWith('lib/'), `dist contains ${to}`);
});

test('core: parse, scene, find (literal and RegExp), compare and both writers run through the entry', () => {
  const model = core.parseDrawing(bytes('house-plan.dxf'), 'house-plan.dxf');
  const scene = core.buildScene(model, { fileName: 'house-plan.dxf' });
  assert.ok(scene.n > 0 && scene.texts.length > 0);
  const word = scene.texts[0].s.split(/\s+/)[0];
  const lit = core.findTexts(scene, word);
  assert.ok(lit.length >= 1);
  const rx = core.findTexts(scene, new RegExp('^' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  assert.ok(rx.length >= 1 && rx.every((h) => h.s.toLowerCase().startsWith(word.toLowerCase())), 'a RegExp query is used as it is');
  assert.equal(core.findTexts(scene, /zz-no-such-text-zz/).length, 0);
  const d = core.describeScene(scene, { q: core.quantum(scene) });
  const r = core.diffScenes(d, d);
  assert.equal(r.changes.length, 0);
  assert.ok(core.writeDxf(model).text.includes('SECTION'));
  assert.ok(core.writeDgn(model).bytes.length > 0);
});

test('core: buildSvg themes (paper by default, dark: foreground white) and an optional frame', () => {
  const model = core.parseDrawing(bytes('house-plan.dxf'), 'house-plan.dxf');
  const scene = core.buildScene(model);
  const L = core.printLayout({ sheet: 'a4', orientation: 'landscape', scale: 'Fit', rect: scene.extents, units: scene.units });
  const paper = core.buildSvg(scene, L);
  const dark = core.buildSvg(scene, L, { theme: 'dark' });
  assert.equal(paper, core.buildSvg(scene, L, { theme: 'paper' }), 'paper is the default');
  assert.ok(/stroke="#000000"/.test(paper) && !/stroke="#ffffff"/.test(paper), 'foreground is black on paper');
  assert.ok(/stroke="#ffffff"/.test(dark), 'foreground is white on dark');
  assert.ok(/<rect x="\.15"[^>]*stroke="#000"/.test(paper) && /<rect x="\.15"[^>]*stroke="#fff"/.test(dark), 'frame follows the theme');
  const bare = core.buildSvg(scene, L, { frame: false });
  assert.ok(!/<rect x="\.15"/.test(bare) && bare.endsWith('</svg>'), 'frame: false leaves the border out');
  const monoDark = core.buildSvg(scene, L, { theme: 'dark', mono: true });
  const inks = new Set([...monoDark.matchAll(/(?:stroke|fill)="(#[0-9a-f]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...inks], ['#fff'], 'mono on dark draws everything white');
});

test('core: wire tracing runs through the entry (net length, labels, ends with cell + pin; crossings; through pins) and as slices', async () => {
  const model = core.parseDrawing(bytes('trace-sheet.dxf'), 'trace-sheet.dxf');
  const scene = core.buildScene(model);
  const G = core.buildNetGraph(scene), [ox, oy] = scene.origin;
  const at = (x, y) => core.pickWire(G, x - ox, y - oy, 0.5);
  assert.ok(at(100, 160) >= 0 && core.pickWire(G, 1e6, 1e6, 0.5) === -1, 'a wire there; nothing far away');
  const n = core.traceNet(G, at(100, 160));
  assert.ok(Math.abs(n.length - 282) < 1e-6 && n.count === 5, `length ${n.length}, ${n.count} wires`);
  assert.deepEqual(n.labels.map((l) => l.s), ['W9434']);
  assert.deepEqual(n.ends.map(core.endText), ['J4 · 1 (J4CONN)', 'P1 · P1-A (P1CONN)']);
  assert.ok(n.wires.every((w) => G.role[w] === core.ROLE.WIRE));
  assert.ok(core.traceNet(G, at(60, 140), { crossings: true }).count >= 17, 'crossings connect');
  assert.deepEqual(core.traceNet(G, at(100, 160), { throughPins: true }).labels.map((l) => l.s), ['W9434', 'W9435'], 'through the connector P1');
  assert.ok(core.netText(n, { name: 'trace-sheet.dxf', origin: scene.origin, dec: 2 }).startsWith('Net W9434 · trace-sheet.dxf\nLength 282.00 · 5 wires'));
  const q = core.textQuad(scene.texts[n.labels[0].texts[0]]);
  assert.equal(q.length, 8);
  const A = await core.buildNetGraphAsync(scene, {}, 1);
  assert.equal(core.traceNet(A, at(100, 160)).wires.length, n.wires.length, 'the sliced build gives the same net');
});

test('core: sheet sets through the entry (titles, own numbers, search across sheets, sheet references)', () => {
  const names = ['PNL-01.dgn', 'PNL-02.dgn', 'PNL-03.dgn', 'PNL-04.dxf', 'PNL-05.dxf'];
  assert.ok(names.every(core.isSheetName) && !core.isSheetName('PNL-01.bak.dgn'));
  assert.equal(core.stemOf('sub/PNL-04.dxf'), 'PNL-04');
  assert.deepEqual(['SH10.dxf', 'SH2.dxf'].sort(core.naturalCmp), ['SH2.dxf', 'SH10.dxf']);
  const set = names.map((name) => {
    const model = core.parseDrawing(new Uint8Array(readFileSync(join(ROOT, 'tests', 'fixtures', 'sheets', name))), name);
    return { id: name, name, idx: core.indexSheet(core.buildScene(model, { fileName: name }), model) };
  });
  assert.deepEqual(set.map((s) => s.idx.title), ['PUMP CONTROL POWER', 'PUMP CONTROL RELAYS', 'PUMP CONTROL TERMINALS', 'PUMP CONTROL I/O', 'PUMP CONTROL CABLES']);
  assert.deepEqual(set.map((s) => s.idx.num), ['1', '2', '3', '4', '5']);
  const hits = core.searchSheets(set, core.findRegex('W201', { wholeWord: true }));
  assert.deepEqual(hits.map((r) => `${r.sheetId}:${r.hits.length}`), ['PNL-01.dgn:2', 'PNL-02.dgn:2', 'PNL-04.dxf:1']);
  assert.ok(hits[0].hits.every((h) => Number.isFinite(h.x) && Number.isFinite(h.y)), 'positions in drawing coordinates');
  assert.equal(core.searchIndex(set[2].idx, /W230/).length, 1);
  const C = core.xrefContext(set, core.compilePatterns(core.XREF_DEFAULT));
  assert.deepEqual(core.findXrefs(C, set[0].idx.s, set[0].id).map((r) => `${set[0].idx.s[r.k]}>${r.to}`), ['CONT ON SHEET 2>PNL-02.dgn', 'SEE DWG PNL-05>PNL-05.dxf']);
  assert.equal(core.resolveRef(C, '3', 'PNL-01.dgn'), 'PNL-03.dgn');
});
