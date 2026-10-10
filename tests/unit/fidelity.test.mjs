// DGN v7 fidelity: edits are made on the ORIGINAL bytes of an item (nothing the reader does not model
// is lost), nothing is ever written wrong (word counts, coordinate range, byte ranges), 3D rotations and
// per-vertex Z, arc directions, colour tables, fills, text encoding, "not shown" reports. Fixtures:
// tests/fixtures/dgn-fidelity.dgn and dgn-3d-rot.dgn (tools/make_dgn_fixtures.py, synthetic). Everything
// written is also read back with GDAL/OGR when it is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytes, fixture, liveItems, compareItems, gdalPython, ogrDump, load } from './helpers.mjs';
import { parseDgn, decodeDgnText, quatToMatrix } from '../../src/formats/dgn.js';
import { writeDgn, dgnPalette, elementTree, textBytes } from '../../src/formats/dgn-write.js';
import { writeDxf } from '../../src/formats/dxf-write.js';
import { parseDrawing } from '../../src/formats/detect.js';
import { buildScene, FLAG, KIND } from '../../src/scene.js';
import { EditDoc } from '../../src/edit/doc.js';
import { moveEntity, rotateEntity, setText, restyle, partAt, withPart, insertVertex, transformEntity } from '../../src/edit/ops.js';
import { makePayload, preparePaste, duplicate, clipText, parseClip } from '../../src/edit/clipboard.js';
import { createModel, ensureLayer, flatEntities } from '../../src/model.js';
import { mul, translate, rotate } from '../../src/geom.js';

const TMP = mkdtempSync(join(tmpdir(), 'linework-fid-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
const ogrSkip = gdalPython() ? false : 'Python with GDAL (osgeo) not found: GDAL/OGR read-back checks skipped';
const FID = 'dgn-fidelity.dgn';
const enc = (s) => new TextEncoder().encode(s);

// ------------------------------------------------------------------ helpers
function open(name) {
  const b = bytes(name);
  const model = parseDgn(b);
  const scene = buildScene(model);
  return { b, model, scene, doc: new EditDoc(model, scene, { bytes: b }) };
}
const find = (t, pred) => t.model.entities.findIndex((e) => e && pred(e));
function edit(t, i, fn) { const before = t.model.entities[i]; t.doc.commit('edit', [{ i, before, after: fn(before) }]); return t.model.entities[i]; }
const save = (t, opts = {}) => writeDgn(t.model, { bytes: t.b, orig: t.doc.orig, ...opts });
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const i32 = (b, o) => b[o + 2] | (b[o + 3] << 8) | (b[o] << 16) | (b[o + 1] << 24);
/** What was appended to the original file (before the new end-of-design marker). */
const appended = (t, w) => w.bytes.subarray(t.model.header.eod, t.model.header.eod + (w.bytes.length - t.b.length));
/** Original elements outside `ranges` are byte-identical; inside, only the deleted bit differs. */
function originalsKept(t, w, ranges) {
  const b = t.b, out = w.bytes;
  for (let o = 0; o < t.model.header.eod;) {
    const size = 4 + 2 * u16(b, o + 2);
    const inside = ranges.some(([s, e]) => o >= s && o < e);
    for (let k = 0; k < size; k++) {
      if (k === 1 && inside) assert.equal(out[o + 1], b[o + 1] | 0x80, `element at ${o}: deleted`);
      else assert.equal(out[o + k], b[o + k], `element at ${o} byte ${k} untouched`);
    }
    o += size;
  }
}
/** Byte offsets where two elements differ. */
const diffAt = (x, y) => { const d = []; for (let k = 0; k < Math.max(x.length, y.length); k++) if (x[k] !== y[k]) d.push(k); return d; };
/** Every node of a tree, depth first: [{ o, size, type, depth }] */
const flat = (nodes, d = 0, out = []) => { for (const n of nodes) { out.push({ ...n, depth: d }); flat(n.kids || [], d + 1, out); } return out; };
const sameScene = (model, back, tol = 2e-3) => assert.deepEqual(compareItems(liveItems(buildScene(model)), liveItems(buildScene(back)), (x) => tol + (x.kind === 't' ? 0 : 1e-6 * Math.max(1, ...x.bbox.map(Math.abs)))), []);
function ogr(file, data) { writeFileSync(join(TMP, file), data); const r = ogrDump([join(TMP, file)])[join(TMP, file)]; assert.ok(r && !r.error, `OGR opened ${file}: ${r && r.error}`); return r.features; }
const cellOf = (t) => find(t, (e) => e.type === 'cell' && e.name === 'TBLOCK');

// ------------------------------------------------------------------ reader
test('reader: not-shown report (tags, reference file, shared cell, point string, B-splines counted once), last colour table, byte ranges, NUL-padded text', () => {
  const { model } = load(FID);
  const ns = model.stats.notShown;
  assert.equal(ns.TAG_VALUE, 2, 'tag values (one inside a cell)');
  assert.equal(ns['Reference file attachment (BORDER.DGN)'], 1, 'reference file named');
  assert.equal(ns.SHARED_CELL, 1);
  assert.equal(ns.POINT_STRING, 1);
  assert.equal(ns.BSPLINE_CURVE, 2, 'one per curve: header, poles and knots are one item');
  assert.ok(!('BSPLINE_POLE' in ns) && !('BSPLINE_KNOT' in ns), 'components not counted again');
  assert.deepEqual(model.header.refs, ['BORDER.DGN']);
  // two colour tables: the last one counts, in the reader and the writer (as in GDAL)
  const note = model.entities.find((e) => e.text === 'NOTE A');
  assert.equal(note.rgb, 0x00c800);
  assert.equal(dgnPalette(bytes(FID))[5], 0x00c800);
  // a complex chain whose word count claims the next element ends where reading it stopped
  const chain = model.entities.find((e) => e.layer === 'Level 10');
  const line = model.entities.find((e) => e.layer === 'Level 11');
  assert.equal(chain.dgn[1], line.dgn[0], 'chain range ends at the line');
  // text stored with NUL padding stops at the first NUL (as GDAL reads it)
  assert.ok(model.entities.some((e) => e.text === 'PAD'));
  // shared cell definition components are definitions, not drawn
  assert.ok(!flatEntities(model.entities).some((e) => e.type === 'line' && e.a[0] === 0 && e.b[0] === 1));
  // text node texts at top level know their node
  assert.deepEqual(note.ctr, model.entities.find((e) => e.text === 'NOTE B').ctr);
});

test('reader: complex chains keep their arcs (bulges, clockwise negative); elliptical arcs are points; GDAL sees the same path', () => {
  const { model } = load(FID);
  const [chain, ell] = model.entities.filter((e) => e.src === 'COMPLEX_CHAIN' && e.layer === 'Level 3');
  assert.deepEqual(chain.pts, [10, 30, 20, 30, 20, 40, 10, 40, 10, 50, 25, 50]);
  assert.deepEqual(chain.bulges.map((v) => +v.toFixed(9)), [0, 1, 0, -1, 0, 0], 'half circles: counter-clockwise +1, clockwise -1');
  assert.ok(!ell.bulges && ell.tess, 'elliptical arc: approximated (and said so when written)');
  const shape = model.entities.find((e) => e.src === 'COMPLEX_SHAPE');
  assert.ok(shape.closed && shape.bulges && shape.bulges.filter(Boolean).length === 1);
  if (ogrSkip) return;
  const f = ogrDump([fixture(FID)]);
  const feats = Object.values(f)[0].features.filter((x) => x.Type === 12 && x.Level === 3);
  const pts = feats[0].parts.flat();
  // every OGR point lies on our path (straight runs or the bulge arcs)
  const onPath = ([x, y]) => {
    for (let k = 0; k + 1 < chain.pts.length / 2; k++) {
      const [ax, ay, bx, by] = chain.pts.slice(2 * k, 2 * k + 4), bu = chain.bulges[k];
      if (!bu) { const L = Math.hypot(bx - ax, by - ay), d = Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / L; if (d < 1e-3 && (x - ax) * (x - bx) + (y - ay) * (y - by) <= 1e-6) return true; continue; }
      const cx = (ax + bx) / 2 - ((by - ay) / 2) * (1 - bu * bu) / (2 * bu), cy = (ay + by) / 2 + ((bx - ax) / 2) * (1 - bu * bu) / (2 * bu);
      if (Math.abs(Math.hypot(x - cx, y - cy) - 5) < 1e-3 && (bu > 0 ? x >= cx - 1e-6 : x <= cx + 1e-6)) return true;
    }
    return false;
  };
  assert.ok(pts.length > 20 && pts.every(onPath), 'GDAL tessellates the same arcs, same sides');
});

test('reader: DGN fills (shape, complex shape, ellipse, cell junction dot) are drawn filled in the fill colour', () => {
  const { model, scene } = load(FID);
  const pal = model.header.palette;
  const fills = [];
  for (let i = 0; i < scene.n; i++) if (scene.flags[i] & FLAG.FILL) fills.push({ kind: scene.kind[i], color: scene.color[i] });
  assert.equal(fills.length, 4, 'terminal, arrowhead, junction dot, dot in the title block');
  assert.equal(fills.filter((f) => f.kind === KIND.CONIC).length, 2, 'circles are filled conics');
  assert.ok(fills.some((f) => f.color === pal[3]), 'fill colour of the terminal (3), not its outline colour (1)');
  const o = { ...model.entities.find((e) => e.src === 'COMPLEX_SHAPE') };
  assert.equal(o.fci, 3);
});

// ------------------------------------------------------------------ editing inside cells: the original bytes
test('retype a text in a cell: the cell is its original bytes with only that text changed (text node, empty node, point string, blank text, B-spline, linkages kept)', () => {
  const t = open(FID);
  const ci = cellOf(t), cell = t.model.entities[ci];
  edit(t, ci, (c) => withPart(c, 'c1', setText(partAt(c, 'c1'), 'PUMP STATION 4')));
  const w = save(t);
  assert.deepEqual(w.notes, [], 'nothing lost, nothing to say');
  originalsKept(t, w, [cell.dgn]);
  const a = appended(t, w);
  assert.equal(a.length, cell.dgn[1] - cell.dgn[0], 'same size (same text length)');
  const was = t.b.subarray(cell.dgn[0], cell.dgn[1]);
  const title = partAt(cell, 'c1').dgn[0] - cell.dgn[0];
  const d = diffAt(was, a);
  assert.ok(d.length > 0 && d.every((k) => k >= title + 60 && k < title + 74), `only the characters of the title changed: ${d}`);
  assert.equal(String.fromCharCode(...a.subarray(title + 60, title + 74)), 'PUMP STATION 4');
  const back = parseDgn(w.bytes);
  sameScene(t.model, back);
  if (!ogrSkip) {
    const f = ogr('retype-cell.dgn', w.bytes);
    assert.ok(f.some((x) => x.Text === 'PUMP STATION 4') && !f.some((x) => x.Text === 'PUMP STATION 3'));
    assert.equal(f.filter((x) => x.Type === 21).length, 2, 'both B-spline pole elements still there');
  }
});

test('retype a longer text inside the text node of a cell: node and cell word counts grow, the rest stays byte for byte', () => {
  const t = open(FID);
  const ci = cellOf(t), cell = t.model.entities[ci];
  edit(t, ci, (c) => withPart(c, 'c2', setText(partAt(c, 'c2'), 'LINE ONE, NOW LONGER')));
  const w = save(t);
  const a = appended(t, w);
  const grow = 'LINE ONE, NOW LONGER'.length - 'LINE ONE'.length;
  assert.equal(a.length, cell.dgn[1] - cell.dgn[0] + grow, 'grew by the new characters (even count)');
  const T0 = flat(elementTree(t.b, cell.dgn[0], cell.dgn[1])), T1 = flat(elementTree(a, 0, a.length));
  assert.deepEqual(T1.map((n) => [n.type, n.depth]), T0.map((n) => [n.type, n.depth]), 'same structure');
  T0.forEach((n0, k) => {
    const n1 = T1[k], x = t.b.subarray(n0.o, n0.o + n0.size), y = a.subarray(n1.o, n1.o + n1.size);
    const d = diffAt(x, y);
    if (n0.o === cell.dgn[0]) assert.ok(d.every((j) => (j >= 4 && j < 28) || j === 36 || j === 37 || (j >= 52 && j < 68)), `cell header: range / word count only (${d})`);
    else if (n0.type === 7 && n0.kids && n0.kids.length) {
      assert.equal(u16(y, 36), u16(x, 36) + grow / 2, 'text node word count');
      assert.equal(u16(y, 38), 2, 'still two lines');
      assert.equal(y[43], 'LINE ONE, NOW LONGER'.length, 'longest line');
      assert.ok(d.every((j) => (j >= 4 && j < 28) || j === 36 || j === 42 || j === 43), `text node: ${d}`);
    } else if (n0.o === partAt(cell, 'c2').dgn[0]) assert.equal(decodeDgnText(y.subarray(60, 60 + y[58])), 'LINE ONE, NOW LONGER');
    else assert.deepEqual(d, [], `${n0.type} at ${n0.o} unchanged`);
  });
  assert.equal(u16(a, 36), u16(t.b, cell.dgn[0] + 36) + grow / 2, 'cell word count');
  const back = parseDgn(w.bytes);
  sameScene(t.model, back);
  if (!ogrSkip) assert.ok(ogr('retype-node.dgn', w.bytes).some((x) => x.Text === 'LINE ONE, NOW LONGER'));
});

test('retype a text with an enter-data field / attribute data: the field descriptor and the linkage stay (with a note for the field)', () => {
  const t = open(FID);
  const ci = cellOf(t), cell = t.model.entities[ci];
  edit(t, ci, (c) => withPart(withPart(c, 'c4', setText(partAt(c, 'c4'), 'DWG NO 1234')), 'c5', setText(partAt(c, 'c5'), 'REV 12')));
  const w = save(t);
  assert.ok(w.notes.some((n) => /1 retyped text has enter-data fields/.test(n)), w.notes.join(' | '));
  const a = appended(t, w);
  const nodes = flat(elementTree(a, 0, a.length));
  const dwg = nodes.find((n) => n.type === 17 && String.fromCharCode(...a.subarray(n.o + 60, n.o + 60 + a[n.o + 58])) === 'DWG NO 1234');
  assert.ok(dwg, 'retyped');
  assert.equal(a[dwg.o + 59], 1, 'one enter-data field');
  assert.deepEqual([...a.subarray(dwg.o + 60 + 11, dwg.o + 60 + 13)], [8, 4], 'its descriptor right after the characters');
  const rev = nodes.find((n) => n.type === 17 && String.fromCharCode(...a.subarray(n.o + 60, n.o + 60 + a[n.o + 58])) === 'REV 12');
  const att = rev.o + 32 + 2 * u16(a, rev.o + 30);
  assert.deepEqual([...a.subarray(att, rev.o + rev.size)], [0x03, 0x10, 0x34, 0x12, 0x01, 0x00, 0x02, 0x00], 'attribute data');
  assert.ok(a[rev.o + 33] & 0x08, 'attributes-present bit kept');
  sameScene(t.model, parseDgn(w.bytes));
  // a new length of the other parity: a space keeps the descriptors word-aligned, and the note says so
  const t2 = open(FID);
  edit(t2, ci, (c) => withPart(c, 'c4', setText(partAt(c, 'c4'), 'DWG NO 12345')));
  const w2 = save(t2);
  assert.ok(w2.notes.some((n) => /got a space at the end/.test(n)), w2.notes.join(' | '));
  assert.ok(flatEntities(parseDgn(w2.bytes).entities).some((e) => e.text === 'DWG NO 12345 '));
  void cell;
});

test('delete a text of a cell (cleared): removed from its text node (count and word counts fixed)', () => {
  const t = open(FID);
  const ci = cellOf(t), cell = t.model.entities[ci];
  edit(t, ci, (c) => withPart(c, 'c3', null));
  const w = save(t);
  const a = appended(t, w);
  const lineTwo = partAt(cell, 'c3').dgn;
  assert.equal(a.length, cell.dgn[1] - cell.dgn[0] - (lineTwo[1] - lineTwo[0]));
  const node = flat(elementTree(a, 0, a.length)).find((n) => n.type === 7 && n.kids.length);
  assert.equal(u16(a, node.o + 38), 1, 'one line left');
  const back = parseDgn(w.bytes);
  assert.ok(!flatEntities(back.entities).some((e) => e.text === 'LINE TWO'));
  sameScene(t.model, back);
  if (!ogrSkip) assert.ok(!ogr('delete-in-cell.dgn', w.bytes).some((x) => x.Text === 'LINE TWO'));
});

test('move and rotate a cell: every element is transformed in place (point string, B-spline poles, text node, origin, transform); nothing re-encoded', () => {
  const t = open(FID);
  const ci = cellOf(t), cell = t.model.entities[ci];
  edit(t, ci, (c) => rotateEntity(moveEntity(c, 3.5, -1.25), Math.PI / 2, 53.5, 0.75));
  const w = save(t);
  assert.deepEqual(w.notes, []);
  originalsKept(t, w, [cell.dgn]);
  const a = appended(t, w);
  assert.equal(a.length, cell.dgn[1] - cell.dgn[0], 'same size: nothing re-encoded');
  const M = mul(mul(translate(53.5, 0.75), mul(rotate(Math.PI / 2), translate(-53.5, -0.75))), translate(3.5, -1.25));
  const P = (x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  const T0 = flat(elementTree(t.b, cell.dgn[0], cell.dgn[1])), T1 = flat(elementTree(a, 0, a.length));
  const uor = 10000;
  const near = (raw, [x, y]) => Math.abs(i32(a, raw) / uor - x) < 1e-3 && Math.abs(i32(a, raw + 4) / uor - y) < 1e-3;
  for (const [k, n0] of T0.entries()) {
    const n1 = T1[k];
    if (n0.type === 22 || n0.type === 21) { // point string, B-spline poles
      for (let v = 0; v < u16(t.b, n0.o + 36); v++) assert.ok(near(n1.o + 38 + 8 * v, P(i32(t.b, n0.o + 38 + 8 * v) / uor, i32(t.b, n0.o + 42 + 8 * v) / uor)), `type ${n0.type} vertex ${v}`);
    }
    if (n0.type === 7) { assert.ok(near(n1.o + 62, P(i32(t.b, n0.o + 62) / uor, i32(t.b, n0.o + 66) / uor)), 'text node origin'); assert.equal(i32(a, n1.o + 58), (i32(t.b, n0.o + 58) + 90 * 360000) % (360 * 360000), 'text node rotation'); }
    if (n0.type === 17) assert.equal(i32(a, n1.o + 46), (i32(t.b, n0.o + 46) + 90 * 360000) % (360 * 360000), 'text rotation');
    // non-coordinate bytes: level / type / words, graphic group, attribute index, properties, symbology
    for (const j of [0, 1, 2, 3, 28, 29, 30, 31, 32, 33, 34, 35]) assert.equal(a[n1.o + j], t.b[n0.o + j], `type ${n0.type} byte ${j}`);
  }
  const back = parseDgn(w.bytes);
  const c2 = back.entities.find((e) => e.name === 'TBLOCK');
  assert.ok(Math.abs(c2.rotation - Math.PI / 2) < 1e-6, 'cell transform rotated');
  const o2 = P(50, 2);
  assert.ok(Math.abs(c2.origin[0] - o2[0]) < 1e-3 && Math.abs(c2.origin[1] - o2[1]) < 1e-3, 'cell origin moved');
  sameScene(t.model, back);
  if (!ogrSkip) {
    const f = ogr('move-cell.dgn', w.bytes);
    const poles = f.filter((x) => x.Type === 21 && x.Level === 4)[0];
    const p0 = P(76, 4);
    assert.ok(Math.abs(poles.points[0][0] - p0[0]) < 1e-3 && Math.abs(poles.points[0][1] - p0[1]) < 1e-3, 'GDAL sees the moved B-spline poles');
    assert.ok(f.some((x) => x.Text === 'PUMP STATION 3' && /a:90/.test(x.style)), 'GDAL: title rotated 90 degrees');
  }
});

test('restyle a cell: level, colour, weight and line style patched on every element of its range; an exact level mask follows', () => {
  const t = open(FID);
  const ci = cellOf(t), cell = t.model.entities[ci];
  const pal = t.model.header.palette;
  edit(t, ci, (c) => restyle(c, { layer: 'Level 20', color: { ci: 3, rgb: pal[3] }, weight: 4 }, 'DGN'));
  const w = save(t);
  const a = appended(t, w);
  assert.equal(a.length, cell.dgn[1] - cell.dgn[0]);
  for (const n of flat(elementTree(a, 0, a.length))) {
    assert.equal(a[n.o] & 0x3f, 20, `type ${n.type}: level`);
    assert.equal(a[n.o + 35], 3, `type ${n.type}: colour`);
    assert.equal(a[n.o + 34] >> 3, 4, `type ${n.type}: weight`);
    if (n.o) assert.ok(a[n.o] & 0x80, 'components keep the complex bit');
  }
  assert.deepEqual([...a.subarray(44, 52)], [...t.b.subarray(cell.dgn[0] + 44, cell.dgn[0] + 52)], 'an all-levels mask stays all levels');
  // a cell whose level mask names exactly its levels gets the new levels
  const b2 = t.b.slice();
  b2.fill(0, cell.dgn[0] + 44, cell.dgn[0] + 52); b2[cell.dgn[0] + 44] = 0x08; // level 4 only
  const m2 = parseDgn(b2), o2 = m2.entities.slice();
  m2.entities[ci] = restyle(m2.entities[ci], { layer: 'Level 20' }, 'DGN');
  const w2 = writeDgn(m2, { bytes: b2, orig: o2 });
  const h = w2.bytes.subarray(m2.header.eod, m2.header.eod + 52);
  assert.deepEqual([...h.subarray(44, 52)], [0, 0, 0x08, 0, 0, 0, 0, 0], 'mask: level 20 only');
  sameScene(t.model, parseDgn(w.bytes));
});

test('duplicate a cell and a text of a top-level text node: copies of their original bytes, moved (the text stands alone)', () => {
  const t = open(FID);
  const ids = [cellOf(t), find(t, (e) => e.text === 'NOTE A')];
  const r = duplicate(t.model, ids, [0, 0, 1, 1], 'Level 1');
  const i0 = t.doc.nextIndex();
  t.doc.commit('Duplicate', r.ents.map((e, k) => ({ i: i0 + k, before: null, after: moveEntity(e, 0, 30) })));
  const w = save(t);
  assert.deepEqual(w.notes, []);
  originalsKept(t, w, []);
  const a = appended(t, w);
  const cell = t.model.entities[ids[0]], note = t.model.entities[ids[1]];
  assert.equal(a.length, (cell.dgn[1] - cell.dgn[0]) + (note.dgn[1] - note.dgn[0]));
  assert.equal(a[cell.dgn[1] - cell.dgn[0]] & 0x80, 0, 'the copied text is not a component any more');
  const back = parseDgn(w.bytes);
  assert.equal(back.entities.filter((e) => e.name === 'TBLOCK').length, 2);
  sameScene(t.model, back);
  // the same through the system clipboard (another tab with the same file): the fingerprint matches
  const P = parseClip(clipText(makePayload(t.model, [ids[0]], { ext: [0, 0, 1, 1] })));
  const t2 = open(FID);
  const pr = preparePaste(P, t2.model);
  assert.ok(pr.ents[0].dgn, 'same file: linked');
  t2.doc.commit('Paste', [{ i: t2.doc.nextIndex(), before: null, after: moveEntity(pr.ents[0], 0, 30) }]);
  const w2 = save(t2);
  assert.equal(w2.bytes.length - t2.b.length, cell.dgn[1] - cell.dgn[0], 'pasted cell = its original bytes');
  if (!ogrSkip) assert.equal(ogr('dup.dgn', w.bytes).filter((x) => x.Text === 'NOTE A').length, 2);
});

test('top-level text node: move one line, retype the other: the node is rewritten from its bytes; deleting both removes it', () => {
  const t = open(FID);
  const a0 = find(t, (e) => e.text === 'NOTE A'), b0 = find(t, (e) => e.text === 'NOTE B');
  const ctr = t.model.entities[a0].ctr;
  edit(t, a0, (e) => moveEntity(e, 10, 0));
  edit(t, b0, (e) => setText(e, 'NOTE B (EDITED)'));
  const w = save(t);
  assert.deepEqual(w.notes, []);
  originalsKept(t, w, [ctr]);
  const a = appended(t, w);
  const T = elementTree(a, 0, a.length);
  assert.equal(T.length, 1, 'one text node');
  assert.equal(T[0].type, 7);
  assert.deepEqual(T[0].kids.map((k) => k.type), [17, 17]);
  assert.equal(u16(a, 38), 2);
  const back = parseDgn(w.bytes);
  sameScene(t.model, back);
  if (!ogrSkip) { const f = ogr('node.dgn', w.bytes); assert.ok(f.some((x) => x.Text === 'NOTE B (EDITED)') && f.some((x) => x.Text === 'NOTE A' && Math.abs(x.env[0] - 15) < 1e-6)); }
  // delete both lines: the node goes
  const t2 = open(FID);
  t2.doc.commit('Delete', [a0, b0].map((i) => ({ i, before: t2.model.entities[i], after: null })));
  const w2 = save(t2);
  originalsKept(t2, w2, [ctr]);
  assert.equal(w2.bytes.length, t2.b.length, 'nothing appended');
});

test('a cell holding an element that cannot be moved (tag value) is rebuilt, and the save notes say so', () => {
  const t = open(FID);
  const i = find(t, (e) => e.type === 'cell' && e.name === 'TAGGED');
  edit(t, i, (e) => moveEntity(e, 1, 1));
  const w = save(t);
  assert.ok(w.notes.some((n) => /1 item inside cells could not be moved: TAG_VALUE\. That cell was rebuilt/.test(n)), w.notes.join(' | '));
  sameScene(t.model, parseDgn(w.bytes));
  // a restyle needs no move: still byte level, no note
  const t2 = open(FID);
  edit(t2, i, (e) => restyle(e, { weight: 3 }, 'DGN'));
  assert.deepEqual(save(t2).notes, []);
});

test('a complex chain whose word count claims the next element: editing it never marks that element deleted', () => {
  const t = open(FID);
  const i = find(t, (e) => e.layer === 'Level 10');
  const line = t.model.entities.find((e) => e.layer === 'Level 11');
  edit(t, i, (e) => moveEntity(e, 0, 5));
  const w = save(t);
  assert.equal(w.bytes[line.dgn[0] + 1] & 0x80, 0, 'the line is not deleted');
  originalsKept(t, w, [t.doc.orig[i].dgn]);
  const back = parseDgn(w.bytes);
  assert.ok(back.entities.some((e) => e.layer === 'Level 11' && e.type === 'line'));
  sameScene(t.model, back);
  if (!ogrSkip) assert.ok(ogr('claim.dgn', w.bytes).some((x) => x.Type === 3 && x.Level === 11));
});

test('complex chains: move keeps the arc elements; reshaping rewrites arcs as arcs (clockwise = negative sweep); elliptical arcs are reported', () => {
  const t = open(FID);
  const [ci, ei] = t.model.entities.map((e, k) => (e && e.src === 'COMPLEX_CHAIN' && e.layer === 'Level 3' ? k : -1)).filter((k) => k >= 0);
  edit(t, ci, (e) => moveEntity(e, 1, 1));
  let w = save(t);
  let a = appended(t, w);
  assert.deepEqual(flat(elementTree(a, 0, a.length)).map((n) => n.type), [12, 4, 16, 4, 16, 4], 'same elements');
  // reshape: a point added on the last run
  edit(t, ci, (e) => insertVertex(e, 4, 20, 51));
  edit(t, ei, (e) => insertVertex(e, 0, 33, 46));
  w = save(t);
  assert.ok(w.notes.some((n) => /1 reshaped complex chain with elliptical arcs or curves was rewritten with those parts as line strings/.test(n)), w.notes.join(' | '));
  a = appended(t, w);
  const T = elementTree(a, 0, a.length);
  const arcs = flat([T[0]]).filter((n) => n.type === 16);
  assert.equal(arcs.length, 2, 'two arcs');
  const sweep = (n) => { const v = i32(a, n.o + 40) & 0x7fffffff; return (a[n.o + 41] & 0x80 ? -v : v) / 360000; };
  assert.deepEqual(arcs.map(sweep).map(Math.round), [180, -180], 'counter-clockwise then clockwise');
  const back = parseDgn(w.bytes);
  const c2 = back.entities.find((e) => e.src === 'COMPLEX_CHAIN' && e.layer === 'Level 3' && e.bulges);
  assert.deepEqual(c2.bulges.map((v) => +v.toFixed(6)), [0, 1, 0, -1, 0, 0, 0]);
  sameScene(t.model, back, 0.05);
});

test('fills: kept when moved; written as a fill linkage when pasted into another file (GDAL reads the fill colour); a solid hatch in DXF', () => {
  const t = open(FID);
  const i = find(t, (e) => e.src === 'COMPLEX_SHAPE');
  edit(t, i, (e) => moveEntity(e, 2, 2));
  const w = save(t);
  const a = appended(t, w);
  assert.ok(Buffer.from(a).includes(Buffer.from([0x07, 0x10, 0x41, 0x00, 0x02, 0x08, 0x01, 0x00, 3])), 'fill linkage (colour 3) kept');
  // paste the fills into another DGN (default colour table): fresh elements with a fill linkage
  const src = load(FID).model;
  const ids = src.entities.map((e, k) => (e && e.fill != null ? k : -1)).filter((k) => k >= 0);
  assert.equal(ids.length, 3);
  const P = parseClip(clipText(makePayload(src, ids, { ext: [0, 0, 1, 1] })));
  const t2 = open('dgn-titleblock.dgn');
  const r = preparePaste(P, t2.model);
  const i0 = t2.doc.nextIndex();
  t2.doc.commit('Paste', r.ents.map((e, k) => ({ i: i0 + k, before: null, after: e })));
  const w2 = save(t2);
  const back = parseDgn(w2.bytes);
  const got = back.entities.slice(-3);
  assert.deepEqual(got.map((e) => e.fill != null), [true, true, true], 'fills read back');
  assert.ok(got[0].bulges && got[0].bulges.some((v) => v), 'the terminal keeps its arc');
  sameScene(t2.model, back);
  if (!ogrSkip) {
    const f = ogr('fills.dgn', w2.bytes);
    const fl = f.filter((x) => x.fill);
    assert.ok(fl.length >= 2, 'GDAL reads fill colours');
  }
  // DXF: a solid hatch under each filled outline
  const out = writeDxf(src);
  assert.ok(out.notes.some((n) => /DGN fills were saved as solid hatches/.test(n)));
  const dx = parseDrawing(enc(out.text), 'x.dxf');
  assert.equal(dx.entities.filter((e) => e.type === 'hatch' && e.solid).length, 4);
});

// ------------------------------------------------------------------ never written wrong
test('coordinates outside the 32-bit grid fail the save with a clear message (round trip and new files); nothing is clamped', () => {
  const t = open('site-plan.dgn');
  const i = find(t, (e) => e.type === 'line');
  edit(t, i, (e) => moveEntity(e, 500000, 0)); // the site plan has 10,000 UOR per metre: +-214 km
  assert.throws(() => save(t), (e) => e.code === 'dgn-range' && e.count === 1 && /1 item lies outside the DGN v7 coordinate range/.test(e.message));
  const m = createModel('DXF');
  ensureLayer(m, '0');
  m.entities = [{ type: 'line', layer: '0', a: [0, 0], b: [1, 0] }, { type: 'line', layer: '0', a: [5e12, 0], b: [5e12, 1] }];
  assert.throws(() => writeDgn(m, { extents: [0, 0, 1, 1] }), (e) => e.code === 'dgn-range' && e.count === 1);
});

test('very long outlines: no 16-bit word count is ever wrong (several complex chains); a cell too large is refused', () => {
  const N = 20000;
  const L = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', 'CONTOUR', '90', String(N), '70', '0'];
  for (let i = 0; i < N; i++) L.push('10', String(i * 0.01), '20', String(Math.sin(i / 50)));
  L.push('0', 'ENDSEC', '0', 'EOF', '');
  const model = parseDrawing(enc(L.join('\n')), 'big.dxf');
  const w = writeDgn(model, { extents: [0, -1, N * 0.01, 1] });
  assert.ok(w.notes.some((n) => /split into several complex chains/.test(n)));
  const b = w.bytes;
  let chains = 0, verts = 0;
  for (let o = 0; !(b[o] === 0xff && b[o + 1] === 0xff);) {
    const size = 4 + 2 * u16(b, o + 2), type = b[o + 1] & 0x7f;
    if (type === 12) {
      chains++;
      let end = o + size, n = 0;
      while (b[end] & 0x80 && !(b[end] === 0xff && b[end + 1] === 0xff)) { verts += u16(b, end + 36) - 1; end += 4 + 2 * u16(b, end + 2); n++; }
      assert.equal(o + 38 + 2 * u16(b, o + 36), end, 'word count = what follows');
      assert.equal(u16(b, o + 38), n, 'component count');
    }
    o += size;
  }
  assert.ok(chains >= 2 && verts === N - 1, `${chains} chains, every segment once`);
  const back = parseDgn(b);
  assert.equal(back.entities.reduce((s, e) => s + e.pts.length / 2, 0), N + chains - 1, 'chains meet end to end');
  if (!ogrSkip) assert.equal(ogr('long.dgn', b).filter((x) => x.Type === 12).length, chains);
  // a cell of more than 65,535 words
  const m = createModel('DGN');
  m.header = { dimension: 2 };
  ensureLayer(m, 'Level 1');
  const kids = Array.from({ length: 160 }, (_, k) => ({ type: 'polyline', layer: 'Level 1', rgb: 0xff0000, pts: Array.from({ length: 202 }, (_, j) => (j % 2 ? k : j)), bulges: null, closed: false }));
  m.entities = [{ type: 'cell', name: 'HUGE', layer: 'Level 1', rgb: 0xff0000, children: kids }];
  assert.throws(() => writeDgn(m, { extents: [0, 0, 200, 160] }), (e) => e.code === 'dgn-cell-too-big' && /HUGE/.test(e.message));
});

// ------------------------------------------------------------------ 3D
test('3D: a text GDAL wrote at +30 degrees reads +30 (dgnlib quaternion convention); rotating it in place and new 3D text use the same convention', () => {
  const t = open('dgn-3d-rot.dgn');
  const deg = (e) => (e.rot * 180) / Math.PI;
  const r30 = find(t, (e) => e.text === 'ROT30'), r90 = find(t, (e) => e.text === 'ROT90');
  assert.ok(Math.abs(deg(t.model.entities[r30]) - 30) < 1e-6 && Math.abs(deg(t.model.entities[r90]) - 90) < 1e-6);
  const q = (deg) => [Math.cos((-deg * Math.PI) / 360), 0, 0, Math.sin((-deg * Math.PI) / 360)].map((v) => Math.trunc(v * 2147483647)); // GDAL's DGNRotationToQuaternion
  const quatAt = (b, o) => [0, 1, 2, 3].map((k) => i32(b, o + 46 + 4 * k));
  assert.deepEqual(quatAt(t.b, t.model.entities[r30].dgn[0]), q(30), 'fixture: GDAL wrote (cos 15, 0, 0, -sin 15)');
  edit(t, r30, (e) => rotateEntity(e, Math.PI / 6, ...e.p));
  const w = save(t);
  const a = appended(t, w);
  quatAt(a, 0).forEach((v, k) => assert.ok(Math.abs(v - q(60)[k]) <= 2, `rotated in place: quaternion of 60 degrees (${v} vs ${q(60)[k]})`));
  const back = parseDgn(w.bytes);
  assert.ok(Math.abs(deg(back.entities.find((e) => e.text === 'ROT30')) - 60) < 1e-6);
  // a new 3D text (pasted from a 2D file) gets GDAL's quaternion for its angle
  const P = parseClip(clipText(makePayload(load('site-plan.dgn').model, [load('site-plan.dgn').model.entities.findIndex((e) => e.text === 'ACCESS ROAD')], { ext: [0, 0, 1, 1] })));
  const t2 = open('dgn-3d-rot.dgn');
  const r = preparePaste(P, t2.model);
  t2.doc.commit('Paste', [{ i: t2.doc.nextIndex(), before: null, after: r.ents[0] }]);
  const a2 = appended(t2, save(t2));
  quatAt(a2, 0).forEach((v, k) => assert.ok(Math.abs(v - q(-4)[k]) <= 2, 'GDAL convention for -4 degrees'));
  // a 3D arc rotated 30 degrees (same convention) starts at 30 degrees
  const arc = t.doc.orig.find((e) => e && e.type === 'ellipse');
  assert.ok(Math.abs(Math.atan2(arc.major[1], arc.major[0]) - Math.PI / 6) < 1e-6);
  const m = quatToMatrix(Math.cos(-Math.PI / 12), 0, 0, Math.sin(-Math.PI / 12));
  assert.ok(Math.abs(Math.atan2(m[3], m[0]) - Math.PI / 6) < 1e-9);
});

test('3D: every vertex keeps its own Z when moved (byte level) and when reshaped (re-encoded, new vertex interpolated); GDAL agrees', () => {
  const t = open('dgn-3d-rot.dgn');
  const i = find(t, (e) => e.type === 'polyline');
  assert.deepEqual(t.model.entities[i].zv, [0, 50000, 100000]);
  edit(t, i, (e) => moveEntity(e, 1, 0));
  let w = save(t);
  let back = parseDgn(w.bytes);
  assert.deepEqual(back.entities.find((e) => e.type === 'polyline').zv, [0, 50000, 100000]);
  if (!ogrSkip) assert.deepEqual(ogr('z-move.dgn', w.bytes).find((x) => x.Type === 4).z, [0, 5, 10]);
  edit(t, i, (e) => insertVertex(e, 0, 6, 0));
  w = save(t);
  back = parseDgn(w.bytes);
  assert.deepEqual(back.entities.find((e) => e.type === 'polyline').zv, [0, 25000, 50000, 100000]);
  if (!ogrSkip) assert.deepEqual(ogr('z-reshape.dgn', w.bytes).find((x) => x.Type === 4).z, [0, 2.5, 5, 10]);
});

test('3D: cells, text nodes and arcs pasted into a 3D file, then moved, rotated and retyped in place (3D cell transform, quaternions)', () => {
  const t = open('dgn-3d.dgn');
  for (const name of ['site-plan.dgn', FID]) {
    const src = load(name).model;
    const r = preparePaste(parseClip(clipText(makePayload(src, src.entities.map((_, i) => i), { ext: [0, 0, 1, 1] }))), t.model);
    const i0 = t.doc.nextIndex();
    t.doc.commit('Paste', [...r.changes, ...r.ents.map((e, k) => ({ i: i0 + k, before: null, after: e }))]);
  }
  const b = save(t).bytes;
  const m = parseDgn(b), orig = m.entities.slice();
  m.entities = m.entities.map((e) => rotateEntity(moveEntity(e, 3, -2), 0.7, 10, 10));
  const ti = m.entities.findIndex((e) => e.type === 'cell' && e.name === 'TBLOCK');
  m.entities[ti] = withPart(m.entities[ti], 'c2', setText(partAt(m.entities[ti], 'c2'), 'LINE ONE IN 3D'));
  const w = writeDgn(m, { bytes: b, orig });
  assert.deepEqual(w.notes, [], 'all rebuilt from their bytes');
  const back = parseDgn(w.bytes);
  sameScene(m, back);
  const north = back.entities.find((e) => e.type === 'cell' && e.name === 'NORTH');
  assert.ok(Math.abs(Math.atan2(north.trans3[3], north.trans3[0]) - (Math.PI / 6 + 0.7)) < 1e-4, '3D cell transform rotated');
  assert.ok(flatEntities(back.entities).some((e) => e.text === 'LINE ONE IN 3D'));
  if (!ogrSkip) assert.ok(ogr('3d-cells.dgn', w.bytes).some((x) => x.Text === 'LINE ONE IN 3D'));
});

// ------------------------------------------------------------------ new files
test('DXF -> DGN: a clockwise bulge is written as a clockwise arc from the right vertex (connected chain, GDAL agrees)', () => {
  const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', 'WIRE', '90', '3', '70', '0',
    '10', '0', '20', '0', '42', '-1', '10', '10', '20', '0', '10', '10', '20', '10', '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
  const model = parseDrawing(enc(dxf), 'bulge.dxf');
  const w = writeDgn(model, { extents: [-1, -6, 11, 11] });
  const b = w.bytes;
  let arc = -1;
  for (let o = 0; !(b[o] === 0xff && b[o + 1] === 0xff); o += 4 + 2 * u16(b, o + 2)) if ((b[o + 1] & 0x7f) === 16) arc = o;
  const sw = i32(b, arc + 40) & 0x7fffffff;
  assert.ok(b[arc + 41] & 0x80, 'negative sweep');
  assert.equal(Math.round(sw / 360000), 180);
  const back = parseDgn(b);
  assert.deepEqual(back.entities[0].pts.map((v) => +v.toFixed(6) + 0), [0, 0, 10, 0, 10, 10]);
  assert.deepEqual(back.entities[0].bulges.map((v) => +v.toFixed(6) + 0), [-1, 0, 0]);
  if (!ogrSkip) {
    const f = ogr('cw.dgn', b).find((x) => x.Type === 12);
    const pts = f.parts.flat();
    assert.deepEqual(pts[0].map((v) => +v.toFixed(6)), [0, 0], 'starts at the first vertex');
    const straight = (p, q) => Math.abs(p[0] - 10) < 1e-6 && Math.abs(q[0] - 10) < 1e-6; // the line string from (10,0) to (10,10)
    for (let k = 1; k < pts.length; k++) assert.ok(Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]) < 1.5 || straight(pts[k - 1], pts[k]), 'connected, no jump');
    const arcPts = pts.filter((p) => p[0] < 10 - 1e-6);
    assert.ok(arcPts.every((p) => Math.abs(Math.hypot(p[0] - 5, p[1]) - 5) < 1e-3 && p[1] > -1e-6), 'the arc points lie on the upper half circle');
    assert.ok(pts.some((p) => p[1] > 4.9 && p[0] < 6), 'clockwise from (0,0) to (10,0): over the top');
  }
});

test('text encoding: characters outside cp1252 round trip as GDAL reads them; cp1252 stays 8-bit; older 16-bit text still reads', () => {
  const notes = { truncated: 0, wide: 0 };
  assert.equal(textBytes('Ünïcödé €', notes)[0], 0xdc, '8-bit cp1252');
  const wide = textBytes('R1 10kΩ ±5%', notes);
  assert.deepEqual(wide.slice(0, 2), [0xff, 0xfd]);
  assert.equal(decodeDgnText(Uint8Array.from(wide)), 'R1 10kΩ ±5%');
  const legacy = [0xff, 0xfd]; for (const ch of 'A10kΩ') legacy.push(ch.charCodeAt(0) & 255, ch.charCodeAt(0) >> 8);
  assert.equal(decodeDgnText(Uint8Array.from(legacy)), 'A10kΩ', 'UTF-16 written by older versions');
  assert.equal(decodeDgnText(Uint8Array.from([65, 66, 0, 0])), 'AB', 'stops at the first NUL');
  const t = open('site-plan.dgn');
  const i = find(t, (e) => e.text === 'MAIN HALL');
  edit(t, i, (e) => setText(e, 'R1 10kΩ ±5%'));
  const w = save(t);
  assert.ok(w.notes.some((n) => /16-bit text/.test(n)));
  assert.ok(parseDgn(w.bytes).entities.some((e) => e.text === 'R1 10kΩ ±5%'));
  if (!ogrSkip) assert.ok(ogr('omega.dgn', w.bytes).some((x) => x.Text === 'R1 10kΩ ±5%'), 'GDAL reads the same string');
});

test('items on layer "0" in a DGN go to the current level (with a note), not silently to level 63', () => {
  const t = open('site-plan.dgn');
  t.doc.commit('Line', [{ i: t.doc.nextIndex(), before: null, after: { type: 'line', layer: '0', color: 256, rgb: 0xff0000, a: [0, 0], b: [5, 5] } }]);
  const w = save(t, { level: 'Level 7' });
  assert.ok(w.notes.some((n) => /1 item on layer "0" \(not a DGN level\) was saved on level 7/.test(n)), w.notes.join(' | '));
  assert.equal(parseDgn(w.bytes).entities.at(-1).layer, 'Level 7');
});

test('new DGN from a DXF: saved view 1 shows the drawing (MicroStation opens on it)', () => {
  const { model, scene } = load('house-plan.dxf');
  const ext = [scene.extents[0] + scene.origin[0], scene.extents[1] + scene.origin[1], scene.extents[2] + scene.origin[0], scene.extents[3] + scene.origin[1]];
  const w = writeDgn(model, { extents: ext });
  const b = w.bytes, uor = i32(b, 1112) * i32(b, 1116);
  const m = parseDgn(b);
  const [ox, oy] = m.header.origin;
  const x0 = i32(b, 56) / uor - ox, y0 = i32(b, 60) / uor - oy, dx = i32(b, 68) / uor, dy = i32(b, 72) / uor;
  assert.ok(b[46] & 0x80, 'view 1 is open');
  assert.ok(x0 <= ext[0] && y0 <= ext[1] && x0 + dx >= ext[2] && y0 + dy >= ext[3], 'covers the extents');
  assert.ok(dx < (ext[2] - ext[0]) * 2 && dy < (ext[3] - ext[1]) * 2, 'and not much more');
});

// ------------------------------------------------------------------ the invariant, on random edits
test('round trip without edits is byte-identical for the new fixtures; undoing everything gives the original file back', () => {
  for (const name of [FID, 'dgn-3d-rot.dgn']) {
    const t = open(name);
    let w = save(t);
    assert.ok(Buffer.from(w.bytes).equals(Buffer.from(t.b)), name);
    const ci = find(t, (e) => e.type === 'cell' || e.type === 'text');
    const e = t.model.entities[ci];
    const en = t.doc.commit('x', [{ i: ci, before: e, after: transformEntity(e, translate(1, 2)) }]);
    t.doc.revert(en);
    w = save(t);
    assert.ok(Buffer.from(w.bytes).equals(Buffer.from(t.b)), name + ' after undo');
  }
});
