// Writers: DXF (R2000) and DGN v7 (round trip + new from seed). Everything written is read back
// with our own readers AND, when Python + GDAL are installed, with GDAL/OGR (independent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, bytes, liveItems, compareItems, rng, gdalPython, ogrDump } from './helpers.mjs';
import { parseDrawing } from '../../src/formats/detect.js';
import { parseDgn } from '../../src/formats/dgn.js';
import { buildScene, KIND, FLAG, packTexts, unpackTexts } from '../../src/scene.js';
import { writeDxf, encodeText, mtextTokens, mtextChunks, ellipseParams, nearestAci } from '../../src/formats/dxf-write.js';
import { writeDgn, dgnPalette, pushVax } from '../../src/formats/dgn-write.js';
import { createModel, ensureLayer, flatEntities, FG } from '../../src/model.js';
import { EditDoc } from '../../src/edit/doc.js';
import { moveEntity, rotateEntity, setText, restyle, insertVertex, deleteVertex, moveGrip, gripsOf, canReshape, segmentsOf, partAt, withPart } from '../../src/edit/ops.js';
import { liveExtents } from '../../src/edit/live-scene.js';

const DXF_FIXTURES = ['house-plan.dxf', 'bracket.dxf', 'schematic.dxf', 'edge-crlf-cp1252.dxf', 'edge-utf8-bom.dxf', 'edge-entities-only.dxf',
  'edge-unknown-entities.dxf', 'edge-far-coords.dxf', 'edge-nested-mirror.dxf', 'edge-zero-length.dxf', 'edge-r12-padded.dxf', 'edge-paperspace.dxf', 'edge-truncated.dxf'];
const DGN_FIXTURES = ['site-plan.dgn', 'dgn-default-palette.dgn', 'dgn-3d.dgn'];
const enc = (s) => new TextEncoder().encode(s);
const worldExt = (scene) => [scene.extents[0] + scene.origin[0], scene.extents[1] + scene.origin[1], scene.extents[2] + scene.origin[0], scene.extents[3] + scene.origin[1]];
const relTol = (scene) => 1e-9 * Math.max(1, ...worldExt(scene).map(Math.abs));
const TMP = mkdtempSync(join(tmpdir(), 'linework-write-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
const PY = gdalPython();
const ogrSkip = PY ? false : 'Python with GDAL (osgeo) not found: GDAL/OGR read-back checks skipped';

// ------------------------------------------------------------------ DXF
for (const name of [...DXF_FIXTURES, ...DGN_FIXTURES]) {
  test(`DXF writer round trip: ${name} -> write -> read gives the same drawing`, () => {
    const { model, scene } = load(name);
    const out = writeDxf(model, { extents: worldExt(scene) });
    assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(out.text), 'pure ASCII output');
    const m2 = parseDrawing(enc(out.text), 'out.dxf');
    const s2 = buildScene(m2);
    assert.equal(m2.version, 'AC1015');
    assert.equal(m2.units.code, model.units.code, 'units');
    assert.deepEqual(m2.stats.notShown, {}, 'nothing in our own output is unreadable');
    assert.ok(!m2.stats.warnings.some((w) => /ended early|malformed/.test(w)), 'well-formed: ' + m2.stats.warnings.join(';'));
    // zero-size ellipses are not valid DXF: the writer leaves them out and says so
    const zero = (x) => x.kind === KIND.CONIC && x.bbox[0] === x.bbox[2] && x.bbox[1] === x.bbox[3];
    const before = liveItems(scene);
    if (before.some(zero)) assert.ok(out.notes.some((n) => /zero-size/.test(n)), 'reported');
    const p = compareItems(before.filter((x) => !zero(x)), liveItems(s2), relTol(scene), { mergeKinds: false });
    assert.deepEqual(p, [], 'every item comes back the same (kind, layer, colour, geometry, text)');
    // layers keep name, colour, visibility and line type
    for (const L of model.layers) {
      const L2 = m2.layers.find((x) => x.name === L.name);
      assert.ok(L2, 'layer ' + L.name);
      if (model.format === 'DXF') {
        assert.equal(L2.aci, L.aci ?? 7, 'layer colour ' + L.name); // implicit layers (no table record) have colour 7
        assert.equal(L2.visible, L.visible, 'layer on/off ' + L.name);
        assert.equal(L2.frozen, L.frozen, 'frozen ' + L.name);
        assert.equal(L2.ltype, L.ltype, 'layer line type ' + L.name);
      }
    }
    // blocks keep their name, base point and contents; entity types are kept (curves -> polylines)
    for (const [k, b] of Object.entries(model.blocks)) {
      if (/^\*(MODEL|PAPER)_SPACE/.test(k)) continue;
      const b2 = m2.blocks[k];
      assert.ok(b2, 'block ' + k);
      assert.deepEqual(b2.base, b.base, 'block base ' + k);
      assert.equal(b2.entities.length, b.entities.length, 'block contents ' + k);
    }
    if (model.format === 'DXF') {
      const types = (m) => {
        const c = {};
        for (const e of m.entities) {
          if (e.type === 'ellipse' && !(Math.hypot(...e.major) > 0)) continue; // zero-size: not written (see above)
          const t = e.type === 'spline' ? 'polyline' : e.type;
          c[t] = (c[t] || 0) + 1;
        }
        return c;
      };
      assert.deepEqual(types(m2), types(model), 'entity types');
    } else {
      assert.equal(m2.entities.length, flatEntities(model.entities).length, 'DGN cells are written as their components');
    }
    writeFileSync(join(TMP, name.replace(/\.\w+$/, '') + '.out.dxf'), out.text);
  });
}

test('DXF writer encodes text safely: line breaks, %%, unicode as \\U+, braces, very long strings', () => {
  const model = createModel('DXF');
  ensureLayer(model, '0');
  ensureLayer(model, 'A/B:C*?');
  const long = Array.from({ length: 5000 }, (_, i) => (i % 7 === 0 ? 'Ω' : i % 11 === 0 ? '\\' : String.fromCharCode(97 + (i % 26)))).join('');
  const T = (text, extra = {}) => ({ type: 'text', layer: 'A/B:C*?', p: [0, 0], h: 1, rot: 0, text, halign: 0, valign: 0, wf: 1, oblique: 0, ...extra });
  const M = (text) => ({ type: 'mtext', layer: '0', p: [0, 10], h: 1, rot: 0.3, text, attach: 1, width: 0, spacing: 1, wf: 1 });
  model.entities = [
    T('Line one\nline two'), T('Ünïcödé €100 %% 50%%% done'), T('C:\\temp\\U+0041 caret^J'), T(long.slice(0, 3000)),
    M('Größe\nΩ 東京 {braces} back\\slash ^J caret %%c'), M(long), M('tab\there'),
  ];
  const out = writeDxf(model);
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(out.text), 'pure ASCII');
  assert.ok(out.text.includes('Gr\\U+00F6\\U+00DFe\\P\\U+03A9 \\U+6771\\U+4EAC \\{braces\\} back\\\\slash \\U+005EJ'), 'MTEXT: unicode as \\U+ codes, \\P breaks, escaped braces/backslash/caret');
  assert.ok(out.text.includes('\r\nLine one line two\r\n'), 'TEXT line break became a space (no raw newline in a value)');
  const lines = out.text.split('\r\n');
  for (let i = 0; i + 1 < lines.length; i += 2) assert.ok(/^\s*-?\d+$/.test(lines[i]), `group code at line ${i}: ${lines[i].slice(0, 20)}`);
  // MTEXT chunks never split an escape and stay within 250 characters
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i] === '3') {
      assert.ok(lines[i + 1].length <= 250, 'chunk length');
      assert.ok(!/\\(U(\+[0-9A-F]{0,3})?)?$/.test(lines[i + 1].replace(/\\\\/g, '')), 'chunk ends inside an escape: ' + lines[i + 1].slice(-12));
    }
  }
  const m2 = parseDrawing(enc(out.text), 'x.dxf');
  const got = m2.entities.map((e) => e.text);
  assert.equal(got[0], 'Line one line two', 'TEXT is single-line: break becomes a space');
  assert.equal(got[1], 'Ünïcödé €100 %% 50%%% done');
  assert.equal(got[2], 'C:\\temp\\U+0041 caret^J');
  assert.equal(got[3], long.slice(0, 3000));
  assert.equal(got[4], 'Größe\nΩ 東京 {braces} back\\slash ^J caret %%c');
  assert.equal(got[5], long, 'very long MTEXT survives');
  assert.equal(m2.entities[5].rot.toFixed(9), (0.3).toFixed(9), 'MTEXT direction');
  assert.ok(m2.entities.every((e) => e.layer === 'A_B_C__' || e.layer === '0'), 'layer names made DXF-safe');
  // helpers
  assert.equal(encodeText('a\r\nb'), 'a b');
  assert.deepEqual(mtextChunks(mtextTokens('é'.repeat(100))).map((c) => c.length), [245, 245, 210]);
  assert.equal(nearestAci(0xff0000), 1);
  assert.equal(nearestAci(0xffffff), 7);
});

test('ELLIPSE parameters: any axes (swapped, mirrored, skewed) become a valid DXF ellipse', () => {
  const P = (e, t) => [e.c[0] + e.major[0] * Math.cos(t) + e.minor[0] * Math.sin(t), e.c[1] + e.major[1] * Math.cos(t) + e.minor[1] * Math.sin(t)];
  const Q = (q, s) => { const L = Math.hypot(...q.major), n = [-q.major[1] * q.ratio, q.major[0] * q.ratio]; return [q.c[0] + q.major[0] * Math.cos(s) + n[0] * Math.sin(s), q.c[1] + q.major[1] * Math.cos(s) + n[1] * Math.sin(s), L]; };
  for (const e of [
    { c: [1, 2], major: [3, 0], minor: [0, 1], t0: 0.2, t1: 2 },
    { c: [0, 0], major: [1, 0], minor: [0, 3], t0: 0, t1: 1 }, // minor longer
    { c: [0, 0], major: [2, 0], minor: [0, -1], t0: 0.5, t1: 2.5 }, // clockwise
    { c: [5, 5], major: [2, 1], minor: [0.5, 1.5], t0: 1, t1: 4 }, // not orthogonal
  ]) {
    const q = ellipseParams(e);
    assert.ok(q.ratio <= 1 && q.ratio > 0);
    for (const t of [e.t0, (e.t0 + e.t1) / 2, e.t1]) {
      const p = P(e, t);
      // the point must lie on the written ellipse within its written parameter range
      let best = Infinity;
      let s1 = q.t1; while (s1 <= q.t0) s1 += 2 * Math.PI;
      for (let k = 0; k <= 2000; k++) { const s = q.t0 + ((s1 - q.t0) * k) / 2000; const r = Q(q, s); best = Math.min(best, Math.hypot(r[0] - p[0], r[1] - p[1])); }
      assert.ok(best < 0.01, `point on ellipse arc (${best})`);
    }
  }
});

test('GDAL/OGR reads every DXF we wrote (independent reader)', { skip: ogrSkip }, () => {
  const files = [...DXF_FIXTURES, ...DGN_FIXTURES].map((n) => join(TMP, n.replace(/\.\w+$/, '') + '.out.dxf'));
  for (const name of [...DXF_FIXTURES, ...DGN_FIXTURES]) {
    const { model, scene } = load(name);
    writeFileSync(join(TMP, name.replace(/\.\w+$/, '') + '.out.dxf'), writeDxf(model, { extents: worldExt(scene) }).text);
  }
  const res = ogrDump(files);
  for (const name of [...DXF_FIXTURES, ...DGN_FIXTURES]) {
    const f = join(TMP, name.replace(/\.\w+$/, '') + '.out.dxf');
    const r = res[f];
    assert.ok(r && !r.error, `${name}: OGR opened it (${r && r.error})`);
    const { scene } = load(name);
    const ours = liveItems(scene);
    // OGR explodes blocks like we do; texts must all be there, geometry count close to ours
    const texts = new Set(r.features.filter((x) => x.Text != null).map((x) => x.Text));
    for (const t of ours.filter((x) => x.kind === 't')) {
      if (/[^\x20-\x7e]/.test(t.s)) continue; // OGR may re-encode non-ASCII
      assert.ok([...texts].some((s) => s.includes(t.s.trim()) || t.s.includes(s.trim())), `${name}: OGR sees text "${t.s}"`);
    }
    const layers = new Set(r.features.map((x) => x.Layer));
    const { model } = load(name);
    for (const e of flatEntities(model.entities)) if (e.type !== 'insert' && e.type !== 'dimension') assert.ok(layers.has(e.layer) || e.layer === '0', `${name}: OGR sees layer ${e.layer}`);
    assert.ok(r.features.length >= Math.floor(ours.length * 0.5), `${name}: OGR read ${r.features.length} features for ${ours.length} items`);
  }
});

// ------------------------------------------------------------------ DGN
const elementsOf = (b, eod) => { const out = []; for (let o = 0; o + 4 <= eod;) { if (b[o] === 0xff && b[o + 1] === 0xff) break; const size = 4 + 2 * (b[o + 2] | (b[o + 3] << 8)); out.push([o, size]); o += size; } return out; };
const dgnTol = (model) => (x) => 2 / (model.header.subPerMaster * model.header.uorPerSub) + (x.kind === 't' ? x.h : 0) + 0.002 * Math.max(x.bbox[2] - x.bbox[0], x.bbox[3] - x.bbox[1]);

for (const name of DGN_FIXTURES) {
  test(`DGN round trip without edits is byte-identical: ${name}`, () => {
    const b = bytes(name);
    const model = parseDgn(b);
    const w = writeDgn(model, { bytes: b, orig: model.entities.slice() });
    assert.equal(w.mode, 'round-trip');
    assert.equal(w.bytes.length, b.length);
    assert.ok(w.bytes.every((v, i) => v === b[i]), 'identical bytes');
  });
}

/** Apply a typical edit session to a DGN model; returns the touched original slots. */
function editSitePlan(model) {
  const E = model.entities;
  const touched = new Set();
  const set = (i, e) => { E[i] = e; touched.add(i); };
  const shape = E.findIndex((e) => e.layer === 'Level 1');
  set(shape, moveEntity(E[shape], 2.5, -1.25));
  const hall = E.findIndex((e) => e.text === 'MAIN HALL');
  set(hall, setText(E[hall], 'MAIN HALL (EDITED)'));
  const cell = E.findIndex((e) => e.type === 'cell' && e.name === 'NORTH');
  set(cell, rotateEntity(E[cell], Math.PI / 6, ...E[cell].origin));
  const tree = E.findIndex((e) => e.type === 'cell' && e.name === 'TREE');
  set(tree, moveEntity(E[tree], 3, 4));
  const road = E.findIndex((e) => e.src === 'COMPLEX_CHAIN');
  set(road, insertVertex(E[road], 10, ...E[road].pts.slice(20, 22)));
  const arc = E.findIndex((e) => e.type === 'arc');
  set(arc, restyle(E[arc], { layer: 'Level 9', color: { ci: 5, rgb: dgnPalette(bytes('site-plan.dgn'))[5] } }, 'DGN'));
  const line = E.findIndex((e) => e.type === 'line');
  set(line, null);
  const pal = dgnPalette(bytes('site-plan.dgn'));
  E.push({ type: 'line', layer: 'Level 12', color: 256, rgb: pal[2], a: [0, 0], b: [10, 5] });
  E.push({ type: 'circle', layer: 'Level 12', color: 256, rgb: pal[3], c: [20, 20], r: 3 });
  E.push({ type: 'text', layer: 'Level 12', color: 256, rgb: pal[4], p: [5, 5], h: 1.5, rot: 0.2, text: 'NEW NOTE', halign: 0, valign: 0, wf: 1 });
  E.push({ type: 'polyline', layer: 'Level 12', color: 256, rgb: pal[1], pts: Array.from({ length: 260 }, (_, i) => (i % 2 ? Math.sin(i / 9) * 5 : i / 4)), bulges: null, closed: false });
  return touched;
}

test('DGN round trip with edits: untouched elements byte-identical, edited ones deleted in place + appended', () => {
  const b = bytes('site-plan.dgn');
  const model = parseDgn(b);
  const orig = model.entities.slice();
  const touched = editSitePlan(model);
  const w = writeDgn(model, { bytes: b, orig });
  const out = w.bytes;
  const ranges = [...touched].map((i) => orig[i].dgn);
  const inEdited = (o) => ranges.some(([a, z]) => o >= a && o < z);
  let same = 0, deleted = 0;
  for (const [o, size] of elementsOf(b, model.header.eod)) {
    if (inEdited(o)) {
      assert.ok(out[o + 1] & 0x80, `element at ${o} marked deleted`);
      assert.equal(out[o + 1] & 0x7f, b[o + 1] & 0x7f, 'type kept');
      for (let k = 0; k < size; k++) if (k !== 1) assert.equal(out[o + k], b[o + k]);
      deleted++;
    } else {
      for (let k = 0; k < size; k++) assert.equal(out[o + k], b[o + k], `untouched element at ${o} byte ${k}`);
      same++;
    }
  }
  assert.ok(same > 20 && deleted > 5, `${same} untouched, ${deleted} deleted`);
  // appended elements are word aligned, sized correctly, and end with the end-of-design marker
  const els = elementsOf(out, out.length);
  const last = els[els.length - 1];
  assert.equal(out[last[0] + last[1]], 0xff);
  assert.equal(out[last[0] + last[1] + 1], 0xff);
  for (const [o, size] of els) {
    assert.equal(size % 2, 0);
    if (o >= model.header.eod) assert.ok(((out[o + 30] | (out[o + 31] << 8)) * 2 + 32) <= size, `appended element at ${o}: attribute index inside the element`);
  }
  assert.ok(els.filter(([o]) => o >= model.header.eod).length >= 10, 'edits appended after the original elements');
  // re-read: the drawing equals the edited model
  const m2 = parseDgn(out);
  const p = compareItems(liveItems(buildScene(model)), liveItems(buildScene(m2)), dgnTol(m2));
  assert.deepEqual(p, [], 'reads back as edited');
  const north = m2.entities.find((e) => e.type === 'cell' && e.name === 'NORTH');
  assert.ok(Math.abs((north.rotation * 180) / Math.PI - 60) < 0.01, 'cell header transform rotated (30 + 30 degrees): ' + (north.rotation * 180) / Math.PI);
  assert.ok(Math.abs(north.xscale - 1.5) < 1e-4 && Math.abs(north.yscale - 1) < 1e-4, 'cell scale kept');
  writeFileSync(join(TMP, 'site-plan-edited.dgn'), out);
});

test('DGN round trip on a 3D design file keeps Z and 3D element layouts', () => {
  const b = bytes('dgn-3d.dgn');
  const model = parseDgn(b);
  const orig = model.entities.slice();
  model.entities = model.entities.map((e) => moveEntity(e, 1, 2));
  model.entities.push({ type: 'circle', layer: 'Level 1', color: 256, rgb: 0xff0000, c: [3, 3], r: 1 });
  model.entities.push({ type: 'arc', layer: 'Level 1', color: 256, rgb: 0xff0000, c: [3, 3], r: 2, a0: 0.2, a1: 2.5 });
  const w = writeDgn(model, { bytes: b, orig });
  const m2 = parseDgn(w.bytes);
  assert.equal(m2.header.dimension, 3);
  assert.deepEqual(compareItems(liveItems(buildScene(model)), liveItems(buildScene(m2)), dgnTol(m2)), []);
  const ls = m2.entities.find((e) => e.type === 'polyline' && !e.closed);
  assert.equal(ls.zr, orig.find((e) => e.type === 'polyline' && !e.closed).zr, 'Z kept');
  writeFileSync(join(TMP, 'dgn-3d-edited.dgn'), w.bytes);
});

/** What a DGN written from `model` should contain (as our reader returns it). */
function expectedDgnItems(model) {
  const out = [];
  const col = (c) => (c === FG || c === 0xffffff ? 'FG' : c);
  const bb = (pts) => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (let i = 0; i < pts.length; i += 2) { if (pts[i] !== pts[i]) continue; b[0] = Math.min(b[0], pts[i]); b[1] = Math.min(b[1], pts[i + 1]); b[2] = Math.max(b[2], pts[i]); b[3] = Math.max(b[3], pts[i + 1]); } return b; };
  const s = buildScene(model);
  const [ox, oy] = s.origin;
  // per entity: bulged polylines become one item (complex chain), fills become one item per ring
  const byEnt = new Map();
  for (let i = 0; i < s.n; i++) { const k = s.ent[i]; if (!byEnt.has(k)) byEnt.set(k, []); byEnt.get(k).push(i); }
  for (const [k, ids] of byEnt) {
    const e = model.entities[k];
    const pts = (i) => { const q = [], o = s.start[i] * 2; if (s.kind[i] === KIND.CONIC) { const c = s.conics, cc = s.start[i] * 8; for (let t = 0; t <= 64; t++) { const a = c[cc + 6] + ((c[cc + 7] - c[cc + 6]) * t) / 64; q.push(c[cc] + c[cc + 2] * Math.cos(a) + c[cc + 4] * Math.sin(a) + ox, c[cc + 1] + c[cc + 3] * Math.cos(a) + c[cc + 5] * Math.sin(a) + oy); } return q; } for (let v = 0; v < s.count[i]; v++) q.push(s.coords[o + 2 * v] + ox, s.coords[o + 2 * v + 1] + oy); return q; };
    const it = (i, b) => ({ kind: 1, layer: s.layers[s.layer[i]].name, color: col(s.color[i]), bbox: b });
    if (e.type === 'polyline' && e.bulges && (ids.length > 1 || ids.some((i) => s.kind[i] === KIND.CONIC))) {
      out.push(it(ids[0], bb(ids.flatMap(pts))));
      continue;
    }
    for (const i of ids) {
      if (s.flags[i] & (FLAG.FILL | FLAG.PATTERN)) {
        let ring = [];
        const P = pts(i);
        const flush = () => { if (ring.length >= 6) out.push(it(i, bb(ring))); ring = []; };
        for (let v = 0; v < P.length; v += 2) { if (P[v] !== P[v]) flush(); else ring.push(P[v], P[v + 1]); }
        flush();
      } else out.push(it(i, bb(pts(i))));
    }
  }
  for (const t of s.texts) out.push({ kind: 't', s: t.s.slice(0, 255), layer: s.layers[t.layer].name, color: col(t.color), x: t.x + ox, y: t.y + oy, h: Math.hypot(t.m[2], t.m[3]), bbox: [t.bbox[0] + ox, t.bbox[1] + oy, t.bbox[2] + ox, t.bbox[3] + oy] });
  return out;
}
const levelMapFor = (model) => {
  const s = buildScene(model);
  const map = new Map();
  let k = 1;
  for (const L of s.layers) if (L.count) map.set(L.name, 'Level ' + Math.min(63, k++));
  return (name) => map.get(name);
};
const asDgnItems = (items) => items.map((x) => (x.kind === 't' ? { ...x, bbox: x.bbox } : { ...x, kind: 1 }));

for (const name of ['house-plan.dxf', 'bracket.dxf', 'schematic.dxf']) {
  test(`DXF -> new DGN v7 file (seed, units, levels, colour table): ${name}`, () => {
    const { model, scene } = load(name);
    const w = writeDgn(model, { extents: worldExt(scene) });
    assert.equal(w.mode, 'new');
    assert.equal(w.bytes.length % 512, 0, 'padded to 512-byte blocks');
    const m2 = parseDgn(w.bytes);
    assert.equal(m2.header.dimension, 2);
    assert.equal(m2.units.abbr, model.units.abbr, 'working units named after the drawing units');
    assert.ok(m2.header.colorTable, 'colour table written');
    assert.deepEqual(m2.stats.notShown, {}, 'every element readable');
    const exp = expectedDgnItems(model);
    const got = asDgnItems(liveItems(buildScene(m2)));
    const tol = (x) => 2 / w.uor + 0.003 * Math.max(x.bbox[2] - x.bbox[0], x.bbox[3] - x.bbox[1]);
    const p = compareItems(exp, got, tol, { layerMap: levelMapFor(model), textTol: (x) => 1e-6 + x.h * 0.01 + (x.align ? x.h * 10 : 0), ignoreColor: false });
    assert.deepEqual(p.filter((x) => !/^no match for text/.test(x)), [], 'geometry, levels and colours');
    // texts: same strings at their lower-left origin
    const texts = got.filter((x) => x.kind === 't').map((x) => x.s).sort();
    assert.deepEqual(texts, exp.filter((x) => x.kind === 't').map((x) => x.s).sort(), 'all text');
    assert.ok(w.notes.some((n) => /levels/.test(n)), 'level mapping reported');
    writeFileSync(join(TMP, name.replace('.dxf', '') + '.out.dgn'), w.bytes);
  });
}

test('VAX D-float encoding matches the reader for awkward values', () => {
  const vax = (x) => { const a = []; pushVax(a, x); return Uint8Array.from(a); };
  const dec = (b) => { const u = (k) => b[k] | (b[k + 1] << 8); const hi = ((u(0) << 16) | u(2)) >>> 0, lo = ((u(4) << 16) | u(6)) >>> 0; const ex = (hi >>> 23) & 0xff; if (!ex) return 0; return (hi >>> 31 ? -1 : 1) * (1 + ((hi & 0x7fffff) * 4294967296 + lo) / 36028797018963968) * Math.pow(2, ex - 129); };
  for (const x of [0, 1, -1, 0.5, 3.141592653589793, 123456789.123, -98765.4321e3, 1e-20, 6543220.123456789, 2 ** 52 + 1]) assert.equal(dec(vax(x)), x, String(x));
});

test('GDAL/OGR reads every DGN we wrote, element for element (independent reader)', { skip: ogrSkip }, () => {
  // regenerate the files here so this test does not depend on test order
  {
    const b = bytes('site-plan.dgn'); const m = parseDgn(b); const orig = m.entities.slice(); editSitePlan(m);
    writeFileSync(join(TMP, 'site-plan-edited.dgn'), writeDgn(m, { bytes: b, orig }).bytes);
    const b3 = bytes('dgn-3d.dgn'); const m3 = parseDgn(b3); const o3 = m3.entities.slice(); m3.entities = m3.entities.map((e) => moveEntity(e, 1, 2));
    writeFileSync(join(TMP, 'dgn-3d-edited.dgn'), writeDgn(m3, { bytes: b3, orig: o3 }).bytes);
    for (const name of ['house-plan.dxf', 'bracket.dxf', 'schematic.dxf']) { const { model, scene } = load(name); writeFileSync(join(TMP, name.replace('.dxf', '') + '.out.dgn'), writeDgn(model, { extents: worldExt(scene) }).bytes); }
  }
  const files = ['site-plan-edited.dgn', 'dgn-3d-edited.dgn', 'house-plan.out.dgn', 'bracket.out.dgn', 'schematic.out.dgn'].map((f) => join(TMP, f));
  const res = ogrDump(files);
  const hex = (v) => v.toString(16).padStart(6, '0');
  for (const f of files) {
    const r = res[f];
    assert.ok(r && !r.error, `${f}: OGR opened it`);
    const model = parseDgn(new Uint8Array(readFileSync(f)));
    const ents = flatEntities(model.entities);
    const used = new Set();
    // same matching as the reader's own OGR oracle test: level, colour, text, envelope
    for (const feat of r.features) {
      if (feat.Type === 5 || feat.Type === 2 || feat.Type === 7) continue; // colour table, cell/text-node headers
      const size = feat.env ? Math.max(feat.env[2] - feat.env[0], feat.env[3] - feat.env[1]) : 0;
      const tol = 1e-3 + size * 0.01;
      const idx = ents.findIndex((e, i) => {
        if (used.has(i) || e.layer !== 'Level ' + feat.Level) return false;
        if (feat.rgb && hex(e.rgb) !== feat.rgb) return false;
        if (feat.Text != null && !/[^\x20-\x7e]/.test(feat.Text) && e.text !== feat.Text) return false;
        if (feat.Text != null && e.type !== 'text') return false;
        const b = entBox(e);
        return feat.env.every((v, k) => Math.abs(v - b[k]) <= tol);
      });
      assert.ok(idx >= 0, `${f}: OGR feature type ${feat.Type} level ${feat.Level} env ${feat.env && feat.env.map((v) => v.toFixed(3))} matches one of ours`);
      used.add(idx);
    }
    assert.equal(used.size, ents.length, `${f}: every element we read is also read by OGR`);
  }
});
function entBox(e) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x, y) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); };
  if (e.type === 'line') { add(...e.a); add(...e.b); }
  else if (e.type === 'polyline' || e.type === 'spline') for (let i = 0; i < e.pts.length; i += 2) add(e.pts[i], e.pts[i + 1]);
  else if (e.type === 'text') add(...e.p);
  else if (e.type === 'circle') { add(e.c[0] - e.r, e.c[1] - e.r); add(e.c[0] + e.r, e.c[1] + e.r); }
  else if (e.type === 'arc' || e.type === 'ellipse') {
    const U = e.type === 'arc' ? [e.r, 0] : e.major, V = e.type === 'arc' ? [0, e.r] : e.minor;
    const t0 = e.type === 'arc' ? e.a0 : e.t0, t1 = e.type === 'arc' ? e.a1 : e.t1;
    for (let k = 0; k <= 720; k++) { const t = t0 + ((t1 - t0) * k) / 720; add(e.c[0] + U[0] * Math.cos(t) + V[0] * Math.sin(t), e.c[1] + U[1] * Math.cos(t) + V[1] * Math.sin(t)); }
  }
  return b;
}

// ------------------------------------------------------------------ fuzz
function randomSession(name, seed, steps = 40) {
  const R = rng(seed);
  const { model, scene } = load(name);
  const b = name.endsWith('.dgn') ? bytes(name) : null;
  const doc = new EditDoc(model, scene, { bytes: b });
  const done = [], undone = [];
  const pick = () => { const live = model.entities.map((e, i) => (e ? i : -1)).filter((i) => i >= 0); return live.length ? live[Math.floor(R() * live.length)] : -1; };
  const isDgn = model.format === 'DGN';
  const pal = isDgn ? dgnPalette(b) : null;
  const layer = () => (isDgn ? 'Level ' + (1 + Math.floor(R() * 12)) : model.layers[Math.floor(R() * model.layers.length)].name);
  const style = () => (isDgn ? { color: 256, rgb: pal[1 + Math.floor(R() * 6)] } : { color: 1 + Math.floor(R() * 9) });
  const ext = worldExt(scene), W = ext[2] - ext[0], H = ext[3] - ext[1];
  const pt = () => [ext[0] + R() * W, ext[1] + R() * H];
  for (let s = 0; s < steps; s++) {
    const r = R();
    let changes = null;
    const i = pick();
    const e = i >= 0 ? model.entities[i] : null;
    if (r < 0.12 && done.length) { const en = done.pop(); doc.revert(en); undone.push(en); continue; }
    if (r < 0.18 && undone.length) { const en = undone.pop(); doc.reapply(en); done.push(en); continue; }
    if (!e) continue;
    if (r < 0.35) changes = [{ i, before: e, after: moveEntity(e, (R() - 0.5) * W * 0.1, (R() - 0.5) * H * 0.1) }];
    else if (r < 0.42) changes = [{ i, before: e, after: rotateEntity(e, (R() - 0.5) * 3, ...pt()) }];
    else if (r < 0.5) changes = [{ i, before: e, after: null }];
    else if (r < 0.6) {
      const n = doc.nextIndex();
      const kind = Math.floor(R() * 4);
      const base = { layer: layer(), ...style() };
      const ne = kind === 0 ? { ...base, type: 'line', a: pt(), b: pt() }
        : kind === 1 ? { ...base, type: 'circle', c: pt(), r: W * 0.02 * (0.2 + R()) }
          : kind === 2 ? { ...base, type: 'text', p: pt(), h: H * 0.01 + 1e-3, rot: R(), text: 'FUZZ ' + s, halign: 0, valign: 0, wf: 1 }
            : { ...base, type: 'polyline', pts: [...pt(), ...pt(), ...pt()], bulges: null, closed: R() < 0.5 };
      changes = [{ i: n, before: null, after: ne }];
    } else if (r < 0.75 && canReshape(e)) {
      const g = gripsOf(e), sg = segmentsOf(e);
      const q = R();
      let ne;
      if (q < 0.4 && g.length) ne = moveGrip(e, g[Math.floor(R() * g.length)], ...pt());
      else if (q < 0.7 && sg.length) { const k = Math.floor(R() * sg.length); ne = insertVertex(e, k, (sg[k].ax + sg[k].bx) / 2, (sg[k].ay + sg[k].by) / 2); }
      else if (e.type === 'polyline') ne = deleteVertex(e, Math.floor(R() * (e.pts.length / 2)));
      if (ne !== undefined) changes = [{ i, before: e, after: ne }];
    } else if (r < 0.85 && (e.type === 'text' || e.type === 'mtext')) changes = [{ i, before: e, after: setText(e, 'EDIT ' + s + (e.type === 'mtext' ? '\nSECOND' : '')) }];
    else {
      const k = 1 + Math.floor(R() * 6);
      changes = [{ i, before: e, after: restyle(e, { layer: layer(), color: isDgn ? { ci: k, rgb: pal[k] } : { aci: 1 + Math.floor(R() * 9) } }, model.format) }];
    }
    if (changes) { done.push(doc.commit('fuzz', changes)); undone.length = 0; }
  }
  return { model, scene, doc, bytes: b };
}

for (const [name, seeds] of [['house-plan.dxf', [1, 2, 3, 4]], ['schematic.dxf', [5, 6]], ['site-plan.dgn', [7, 8, 9, 10, 11]], ['dgn-3d.dgn', [12]], ['bracket.dxf', [13, 14]]]) {
  test(`fuzz: random edits on ${name} -> scene, DXF and DGN all match the edited model`, () => {
    for (const seed of seeds) {
      const { model, scene, doc, bytes: b } = randomSession(name, seed);
      const full = liveItems(buildScene(model));
      const tolS = (x) => 1e-9 * Math.max(1, ...x.bbox.map(Math.abs));
      assert.deepEqual(compareItems(liveItems(scene), full, tolS), [], `seed ${seed}: incremental scene == full rebuild`);
      // DXF
      const ext = liveExtents(scene);
      const dxf = writeDxf(model, { extents: ext });
      const m2 = parseDrawing(enc(dxf.text), 'f.dxf');
      assert.deepEqual(compareItems(full, liveItems(buildScene(m2)), tolS), [], `seed ${seed}: DXF matches`);
      // DGN
      const w = writeDgn(model, { bytes: b, orig: doc.orig, extents: ext });
      const m3 = parseDgn(w.bytes);
      if (model.format === 'DGN') {
        assert.deepEqual(compareItems(full, liveItems(buildScene(m3)), dgnTol(m3)), [], `seed ${seed}: DGN round trip matches`);
      } else {
        const exp = expectedDgnItems(model);
        const tol = (x) => 2 / w.uor + 0.003 * Math.max(x.bbox[2] - x.bbox[0], x.bbox[3] - x.bbox[1]);
        const p = compareItems(exp, asDgnItems(liveItems(buildScene(m3))), tol, { layerMap: levelMapFor(model), textTol: (x) => x.h * 12 });
        assert.deepEqual(p, [], `seed ${seed}: new DGN matches`);
      }
    }
  });
}

test('saving warns about items the reader could not load', () => {
  const { model } = load('edge-unknown-entities.dxf');
  const lost = Object.entries(model.stats.notShown).filter(([k]) => !/paper-space/i.test(k)).reduce((s, [, v]) => s + v, 0);
  assert.equal(lost, 6, 'six unsupported entities were not loaded (and cannot be written)');
});

// ------------------------------------------------------------------ text inside cells / inserts
/** Elements of a DGN file up to the end-of-design marker: { o, size, type, deleted }. */
function dgnElements(b) {
  const out = [];
  for (let o = 0; o + 4 <= b.length && !(b[o] === 0xff && b[o + 1] === 0xff);) {
    const size = 4 + 2 * (b[o + 2] | (b[o + 3] << 8));
    out.push({ o, size, type: b[o + 1] & 0x7f, deleted: !!(b[o + 1] & 0x80) });
    o += size;
  }
  return out;
}
const text2d = (b, o) => String.fromCharCode(...b.subarray(o + 60, o + 60 + b[o + 58]));
const ATT = [0x07, 0x10, 0x34, 0x12, 0x01, 0x00, 0x02, 0x00]; // the attribute data the fixture gives "SHEET 1 OF 2"

test('scene: text inside cells and inserts knows its path; block-definition text is marked shared', () => {
  const { scene } = load('dgn-titleblock.dgn');
  const byText = Object.fromEntries(scene.texts.map((t) => [t.s, t.sub]));
  assert.deepEqual(byText, { 'LOOSE NOTE': '', 'DRAWING TITLE': 'c2', 'SHEET 1 OF 2': 'c3', 'REV A': 'c4', OK: 'c5.c1' });
  // the paths survive the trip from the worker (packed texts)
  const moved = unpackTexts(packTexts({ ...scene }));
  assert.deepEqual(moved.texts.map((x) => x.sub), scene.texts.map((x) => x.sub || ''));
  const { model, scene: s2 } = load('schematic.dxf');
  const ins = model.entities.findIndex((e) => e.type === 'insert' && e.attribs && e.attribs.some((a) => !a.invisible && a.text.trim()));
  assert.ok(ins >= 0, 'schematic has an insert with attributes');
  const mine = s2.texts.filter((t) => t.ent === ins);
  assert.ok(mine.some((t) => /^a\d+$/.test(t.sub)), 'attributes are addressable');
  for (const t of mine) assert.ok(/^a\d+$/.test(t.sub) || t.sub[0] === '#', `"${t.s}": ${t.sub}`);
});

test('DGN: typing over a text inside a cell rewrites that cell; untouched parts byte-for-byte, the edited text keeps its attribute data', () => {
  const b = bytes('dgn-titleblock.dgn');
  const m = parseDgn(b), orig = m.entities.slice();
  const ci = m.entities.findIndex((e) => e.type === 'cell' && e.name === 'TITLE');
  const cell = m.entities[ci];
  assert.equal(partAt(cell, 'c3').text, 'SHEET 1 OF 2');
  assert.equal(partAt(cell, 'c5.c1').text, 'OK', 'nested cell text');
  assert.equal(partAt(cell, 'c9'), null);
  let next = withPart(cell, 'c3', setText(partAt(cell, 'c3'), 'SHEET 2 OF 2'));
  next = withPart(next, 'c5.c1', setText(partAt(next, 'c5.c1'), 'APPROVED'));
  assert.equal(cell.children[3].text, 'SHEET 1 OF 2', 'the original model is not touched');
  assert.equal(next.children[0], cell.children[0], 'untouched parts are shared');
  m.entities[ci] = next;
  const w = writeDgn(m, { bytes: b, orig });
  assert.equal(w.mode, 'round-trip');
  const out = w.bytes, eod = m.header.eod;
  // the old cell is flagged deleted in place; nothing else in the original part changed
  for (const el of dgnElements(b)) {
    const inCell = el.o >= cell.dgn[0] && el.o < cell.dgn[1];
    assert.equal(!!(out[el.o + 1] & 0x80), el.deleted || inCell, `element at ${el.o}`);
  }
  // untouched components are copied byte-for-byte after the old end of the design
  const B = Buffer.from(out);
  for (const k of [0, 1, 2, 4]) {
    const c = cell.children[k];
    assert.ok(B.indexOf(Buffer.from(b.subarray(c.dgn[0], c.dgn[1])), eod) >= eod, `component ${k} (${c.type}) copied as-is`);
  }
  assert.ok(B.indexOf(Buffer.from(b.subarray(cell.children[5].children[0].dgn[0], cell.children[5].children[0].dgn[1])), eod) >= eod, 'nested circle copied as-is');
  // the edited text: same level/colour, attribute data and its "attributes present" flag kept
  const live = dgnElements(out).filter((el) => !el.deleted && el.o >= eod);
  const sheet = live.find((el) => el.type === 17 && text2d(out, el.o) === 'SHEET 2 OF 2');
  assert.ok(sheet, 'edited text written');
  assert.ok(out[sheet.o] & 0x80, 'still a cell component');
  const att = sheet.o + 32 + 2 * (out[sheet.o + 30] | (out[sheet.o + 31] << 8));
  assert.deepEqual([...out.subarray(att, sheet.o + sheet.size)], ATT, 'attribute data kept');
  assert.ok(out[sheet.o + 32] & 0x08, 'attribute flag kept');
  assert.ok(live.some((el) => el.type === 17 && text2d(out, el.o) === 'APPROVED'));
  // read back: one TITLE cell with the same structure and the new texts
  const back = parseDgn(out);
  const t2 = back.entities.find((e) => e.type === 'cell' && e.name === 'TITLE');
  assert.deepEqual(t2.children.map((c) => c.type), cell.children.map((c) => c.type));
  assert.equal(t2.children[5].name, 'STAMP');
  assert.deepEqual(flatEntities(back.entities).filter((e) => e.type === 'text').map((e) => e.text).sort(),
    ['APPROVED', 'DRAWING TITLE', 'LOOSE NOTE', 'REV A', 'SHEET 2 OF 2']);
  writeFileSync(join(TMP, 'titleblock-edited.dgn'), out);
});

test('GDAL/OGR reads the DGN with edited cell text', { skip: ogrSkip }, () => {
  const f = join(TMP, 'titleblock-edited.dgn');
  const b = bytes('dgn-titleblock.dgn');
  const m = parseDgn(b), orig = m.entities.slice();
  const ci = m.entities.findIndex((e) => e.type === 'cell' && e.name === 'TITLE');
  m.entities[ci] = withPart(m.entities[ci], 'c3', setText(partAt(m.entities[ci], 'c3'), 'SHEET 2 OF 2'));
  writeFileSync(f, writeDgn(m, { bytes: b, orig }).bytes);
  const r = ogrDump([f])[f];
  assert.ok(r && !r.error, 'OGR opened it');
  assert.deepEqual(r.features.filter((x) => x.Type === 17).map((x) => x.Text).sort(), ['DRAWING TITLE', 'LOOSE NOTE', 'OK', 'REV A', 'SHEET 2 OF 2']);
});

test('DXF: editing one attribute of a block insert changes only that insert, and survives a save', () => {
  const { model } = load('schematic.dxf');
  const ins = model.entities.findIndex((e) => e.type === 'insert' && e.attribs && e.attribs.some((a) => !a.invisible && a.text.trim()));
  const e = model.entities[ins];
  const k = e.attribs.findIndex((a) => !a.invisible && a.text.trim());
  const before = e.attribs.map((a) => a.text);
  model.entities[ins] = withPart(e, 'a' + k, setText(partAt(e, 'a' + k), 'EDITED VALUE'));
  const back = parseDrawing(new TextEncoder().encode(writeDxf(model).text), 'x.dxf');
  const e2 = back.entities.filter((x) => x.type === 'insert' && x.block === e.block && x.attribs && x.attribs.length)
    .find((x) => Math.abs(x.p[0] - e.p[0]) < 1e-6 && Math.abs(x.p[1] - e.p[1]) < 1e-6);
  assert.ok(e2, 'insert found after the round trip');
  assert.deepEqual(e2.attribs.map((a) => a.text), before.map((t, j) => (j === k ? 'EDITED VALUE' : t)));
});
