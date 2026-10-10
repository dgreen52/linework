// Hardening: big drawings through the writers, hostile files, hostile clipboard text, block
// renames at scale, the file hash used for kept markups, the one place the version lives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, ROOT } from './helpers.mjs';
import { parseDrawing } from '../../src/formats/detect.js';
import { buildScene, MAX_EXPANDED, NS_COPIES } from '../../src/scene.js';
import { writeDxf } from '../../src/formats/dxf-write.js';
import { createModel, ensureLayer } from '../../src/model.js';
import { makePayload, preparePaste, clipText, parseClip, PASTE_MAX, CLIP_HEADER } from '../../src/edit/clipboard.js';
import { hashBytes } from '../../src/worker.js';
import { listedLayers } from '../../src/app/layers-panel.js';
import { APP_VERSION } from '../../src/config.js';
import { makeStressDxf } from '../../samples/gen/stress.js';

const enc = (s) => new TextEncoder().encode(s);

test('DXF writer: the 53k-item stress drawing saves (no call-stack overflow from spreading big arrays)', () => {
  const model = parseDrawing(enc(makeStressDxf().text), 'stress.dxf');
  assert.ok(model.entities.length > 50000);
  const out = writeDxf(model, {});
  const back = parseDrawing(enc(out.text), 'back.dxf');
  assert.equal(back.entities.length, model.entities.length, 'every item written and read back');
});

test('DXF writer: 120k plain lines', () => {
  const m = createModel('DXF');
  ensureLayer(m, 'L', 0xff0000);
  for (let i = 0; i < 120000; i++) m.entities.push({ type: 'line', layer: 'L', a: [i, 0], b: [i, 1] });
  const out = writeDxf(m, {});
  assert.equal(out.text.split('\nLINE\r').length - 1, 120000);
});

test('no spread of unbounded arrays in the writers and the app (push(...x) overflows the stack)', () => {
  const files = ['src/formats/dxf-write.js', 'src/app.js', 'src/app/edit-ui.js', 'src/edit/clipboard.js', 'src/scene.js'];
  for (const f of files) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    for (const m of s.matchAll(/\.push\(\.\.\.([A-Za-z_.$]+)\)/g)) assert.fail(`${f}: push(...${m[1]})`);
    assert.ok(!/concat\(\.\.\./.test(s), `${f}: concat(...)`);
  }
});

for (const name of ['edge-huge-array.dxf', 'edge-nested-huge.dxf']) {
  test(`hostile file ${name}: block expansion stops at the budget and says how many copies are not shown`, () => {
    const t0 = Date.now();
    const { scene } = load(name);
    const ms = Date.now() - t0;
    assert.ok(ms < 15000, `built in ${ms} ms`);
    assert.ok(scene.n <= MAX_EXPANDED + 10, `at most the budget: ${scene.n}`);
    assert.ok(scene.notShown[NS_COPIES] > 0, 'copies reported as not shown');
    assert.ok(scene.n > 1000, 'what fits is drawn');
  });
}

test('normal drawings are not affected by the expansion budget', () => {
  for (const name of ['house-plan.dxf', 'bracket.dxf', 'edge-nested-mirror.dxf', 'site-plan.dgn']) {
    const { scene } = load(name);
    assert.equal(scene.notShown[NS_COPIES], undefined, name);
  }
});

// ------------------------------------------------------------------ clipboard text from outside
const target = () => {
  const m = createModel('DXF');
  m.units = { code: 4, name: 'Millimeters', abbr: 'mm' };
  ensureLayer(m, '0');
  m.blocks = { DOOR: { name: 'DOOR', base: [0, 0], entities: [{ type: 'line', layer: '0', a: [0, 0], b: [1, 0] }] } };
  return m;
};
const text = (p) => CLIP_HEADER + '\n' + JSON.stringify(p);

test('clipboard: malformed payloads are refused or cleaned, never thrown', () => {
  const bad = [
    'LINEWORK-CLIPBOARD 1\n{not json', CLIP_HEADER + '\nnull', CLIP_HEADER + '\n[]', text({ v: 2, ents: [] }), text({ v: 1, ents: 'x' }),
    text({ v: 1, ents: [], blocks: { B: { name: 7, base: [0, 0], entities: [] } } }),
  ];
  for (const t of bad) assert.equal(parseClip(t), null, t.slice(0, 60));
  assert.equal(parseClip('some other text'), null);
  // odd but usable: missing tables, junk items, bad extents -> cleaned
  const P = parseClip(text({ v: 1, ents: [null, 3, { type: 'line', layer: 'A', a: [0, 0], b: [5, 5] }, { nope: 1 }], layers: null, ext: ['x'] }));
  assert.ok(P);
  assert.equal(P.ents.length, 1, 'only real items kept');
  assert.deepEqual(P.ext, [0, 0, 0, 0]);
  assert.deepEqual(P.layers, []);
  const r = preparePaste(P, target());
  assert.equal(r.ents.length, 1);
  // a damaged item (no coordinates) is left out with a note, the rest is pasted
  const Q = parseClip(text({ v: 1, ents: [{ type: 'line', layer: 'A', a: [0, 0], b: [5, 5] }, { type: 'line', layer: 'A' }], ext: [0, 0, 5, 5] }));
  const r2 = preparePaste(Q, target());
  assert.equal(r2.ents.length, 1);
  assert.ok(r2.notes.some((n) => /could not be pasted/.test(n)), r2.notes.join(' | '));
});

test('clipboard: "__proto__" names (blocks, line types, styles, layers) cannot reach Object.prototype', () => {
  const raw = 'LINEWORK-CLIPBOARD 1\n{"v":1,"format":"DXF","units":{"code":4},"ext":[0,0,1,1],'
    + '"ents":[{"type":"insert","layer":"0","block":"__proto__","p":[0,0]},{"type":"line","layer":"__proto__","a":[0,0],"b":[1,1]}],'
    + '"blocks":{"__proto__":{"name":"__proto__","base":[0,0],"entities":[{"type":"line","layer":"0","a":[0,0],"b":[1,1]}]},"constructor":{"name":"x","base":[0,0],"entities":[]}},'
    + '"layers":[{"name":"__proto__","color":1}],"ltypes":{"__proto__":{"polluted":1}},"styles":{"__proto__":{"polluted":1}}}';
  const P = parseClip(raw);
  assert.ok(P);
  assert.deepEqual(Object.keys(P.blocks), [], 'dangerous keys dropped');
  const r = preparePaste(P, target());
  for (const c of r.changes) if (c.table) assert.ok(c.key !== '__proto__' && c.key !== 'constructor', c.key);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('clipboard: a huge array insert pasted into a DGN is capped, with a message', () => {
  const P = {
    app: 'Linework', v: 1, format: 'DXF', units: { code: 4 }, dim: 2, ext: [0, 0, 10, 10],
    ents: [{ type: 'insert', layer: 'A', block: 'DOT', p: [0, 0], sx: 1, sy: 1, rot: 0, cols: 1000, rows: 1000, dc: 1, dr: 1 }],
    blocks: { DOT: { name: 'DOT', base: [0, 0], entities: [{ type: 'line', layer: '0', a: [0, 0], b: [0.5, 0.5] }] } },
    layers: [{ name: 'A', color: 0xff0000 }], ltypes: {}, styles: {},
  };
  const dgn = createModel('DGN');
  dgn.units = { code: 4, name: 'Millimeters', abbr: 'mm' };
  ensureLayer(dgn, 'Level 1');
  const t0 = Date.now();
  const r = preparePaste(parseClip(clipText(P)), dgn, { layer: 'Level 1' });
  assert.ok(Date.now() - t0 < 20000);
  assert.equal(r.ents.length, PASTE_MAX);
  assert.ok(/Only the first/.test(r.capped), String(r.capped));
});

test('clipboard: renaming thousands of clashing blocks is linear (and names stay unique)', () => {
  const n = 3000;
  const src = createModel('DXF'), dst = createModel('DXF');
  for (const m of [src, dst]) { m.units = { code: 4 }; ensureLayer(m, '0'); m.blocks = {}; }
  const ids = [];
  for (let i = 0; i < n; i++) {
    const name = '*U' + (i + 1);
    src.blocks[name] = { name, base: [0, 0], entities: [{ type: 'line', layer: '0', a: [0, 0], b: [i, 1] }] };
    dst.blocks[name] = { name, base: [0, 0], entities: [{ type: 'line', layer: '0', a: [0, 0], b: [i, 2] }] }; // same names, other content
    ids.push(src.entities.push({ type: 'insert', layer: '0', block: name, p: [i, 0], sx: 1, sy: 1, rot: 0 }) - 1);
  }
  // a chain: B uses A; A clashes, so B must be renamed too
  src.blocks.A = { name: 'A', base: [0, 0], entities: [{ type: 'line', layer: '0', a: [0, 0], b: [9, 9] }] };
  src.blocks.B = { name: 'B', base: [0, 0], entities: [{ type: 'insert', layer: '0', block: 'A', p: [0, 0], sx: 1, sy: 1, rot: 0 }] };
  dst.blocks.A = { name: 'A', base: [0, 0], entities: [{ type: 'line', layer: '0', a: [0, 0], b: [1, 1] }] };
  dst.blocks.B = { name: 'B', base: [0, 0], entities: [{ type: 'insert', layer: '0', block: 'A', p: [0, 0], sx: 1, sy: 1, rot: 0 }] };
  ids.push(src.entities.push({ type: 'insert', layer: '0', block: 'B', p: [0, 0], sx: 1, sy: 1, rot: 0 }) - 1);
  const P = parseClip(clipText(makePayload(src, ids, { ext: [0, 0, n, 1] })));
  const t0 = Date.now();
  const r = preparePaste(P, dst);
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `renames took ${ms} ms`);
  const added = r.changes.filter((c) => c.table === 'blocks').map((c) => c.key);
  assert.equal(new Set(added).size, added.length, 'unique names');
  for (const k of added) assert.ok(!dst.blocks[k], `${k} does not overwrite an existing block`);
  const b = r.changes.find((c) => c.table === 'blocks' && c.after.entities.some((e) => e.type === 'insert'));
  assert.ok(b && b.key !== 'B', 'B (uses the renamed A) got a new name');
  assert.notEqual(b.after.entities[0].block, 'A', 'and points at the renamed A');
});

// ------------------------------------------------------------------ misc
test('file hash: same size, different content -> different hash; same bytes -> same hash', () => {
  const a = readFileSync(join(ROOT, 'tests/fixtures/edge-rev-1.dxf')), b = readFileSync(join(ROOT, 'tests/fixtures/edge-rev-2.dxf'));
  assert.equal(a.length, b.length);
  assert.notEqual(hashBytes(new Uint8Array(a)), hashBytes(new Uint8Array(b)));
  assert.equal(hashBytes(new Uint8Array(a)), hashBytes(new Uint8Array(Buffer.from(a))));
  assert.match(hashBytes(new Uint8Array(0)), /^[0-9a-f]{16}$/);
  const big = new Uint8Array(1 << 20).map((_, i) => i * 7);
  const big2 = big.slice(); big2[(1 << 20) - 3] ^= 1;
  assert.notEqual(hashBytes(big), hashBytes(big2), 'a one-bit change near the end');
});

test('the version lives in one place (src/version.js): the about line, saved files and the cache name read it', () => {
  const v = readFileSync(join(ROOT, 'src/version.js'), 'utf8').match(/LINEWORK_VERSION = '([^']+)'/)[1];
  assert.equal(APP_VERSION, v);
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /importScripts\('src\/version\.js'\)/);
  assert.match(sw, /const VERSION = 'linework-' \+ self\.LINEWORK_VERSION;/);
  assert.ok(!/0\.\d+\.\d+/.test(sw), 'no version number written in sw.js');
  assert.ok(!/['"]\d+\.\d+\.\d+['"]/.test(readFileSync(join(ROOT, 'src/config.js'), 'utf8')), 'none in config.js');
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version, v, 'package.json agrees');
  assert.ok(writeDxf(createModel('DXF'), {}).text.includes('Linework ' + v), 'saved DXF names the version');
});

test('layer counts: the open message, the canvas label and the Layers panel count the same layers', () => {
  const { scene } = load('site-plan.dgn');
  const listed = listedLayers(scene.layers);
  assert.ok(scene.layers.some((l) => l.name === '0'), 'the scene has the "0" placeholder');
  assert.ok(!listed.some((i) => scene.layers[i].name === '0'), 'not listed');
  scene.layers.push({ name: 'Level 40', color: 0, count: 0, added: true });
  assert.ok(listedLayers(scene.layers).includes(scene.layers.length - 1), 'a level made in this session is listed while empty');
});
