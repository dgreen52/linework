// Copy / paste between drawings, Duplicate inside one, and line weights. DGN -> DGN is the main
// path (both files' bytes, units, origins, colour tables, levels, cells, 3D); every file written
// is read back with our readers and, when Python + GDAL are installed, with GDAL/OGR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, bytes, liveItems, compareItems, gdalPython, ogrDump } from './helpers.mjs';
import { parseDrawing } from '../../src/formats/detect.js';
import { parseDgn } from '../../src/formats/dgn.js';
import { buildScene, DXF_LW, weightToLw, lwToWeight, weightPx } from '../../src/scene.js';
import { writeDxf } from '../../src/formats/dxf-write.js';
import { writeDgn, dgnPalette } from '../../src/formats/dgn-write.js';
import { flatEntities, createModel, ensureLayer } from '../../src/model.js';
import { EditDoc } from '../../src/edit/doc.js';
import { entityBBox } from '../../src/edit/live-scene.js';
import { moveEntity, restyle, setText, partAt, withPart, weightLabel } from '../../src/edit/ops.js';
import { makePayload, preparePaste, clipText, parseClip, unitScale, duplicate, CLIP_HEADER } from '../../src/edit/clipboard.js';
import { ACI, DGN_DEFAULT } from '../../src/palettes.js';
import { makeStressDxf } from '../../samples/gen/stress.js';

const TMP = mkdtempSync(join(tmpdir(), 'linework-clip-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
const ogrSkip = gdalPython() ? false : 'Python with GDAL (osgeo) not found: GDAL/OGR read-back checks skipped';
const enc = (s) => new TextEncoder().encode(s);

/** World extents of entity slots `ids` (what the app uses as the copy's extents). */
function extOf(scene, ids) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const i of ids) { const q = entityBBox(scene, i); if (!q) continue; b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[2]); b[3] = Math.max(b[3], q[3]); }
  return [b[0] + scene.origin[0], b[1] + scene.origin[1], b[2] + scene.origin[0], b[3] + scene.origin[1]];
}
/** Copy the entities of `name` that `pick` accepts; the payload goes through the clipboard text. */
function copy(name, pick = () => true) {
  const { model, scene } = load(name);
  const ids = model.entities.map((e, i) => (e && pick(e, i) ? i : -1)).filter((i) => i >= 0);
  const P = parseClip(clipText(makePayload(model, ids, { ext: extOf(scene, ids) })));
  return { P, model, scene, ids };
}
/** Open `name` for editing and commit the paste of P (moved by d) as one change; the app's commit path. */
function pasteInto(name, P, opts = {}) {
  const { model, scene } = load(name);
  const b = name.endsWith('.dgn') ? bytes(name) : null;
  const doc = new EditDoc(model, scene, { bytes: b });
  const r = preparePaste(P, model, opts);
  const i0 = doc.nextIndex(), d = opts.d || [0, 0];
  const ents = r.ents.map((e) => moveEntity(e, d[0], d[1]));
  const entry = doc.commit('Paste', [...r.changes, ...ents.map((e, k) => ({ i: i0 + k, before: null, after: e }))]);
  return { model, scene, doc, r, b, i0, entry, n: ents.length };
}
const has = (o, key) => JSON.stringify(o).includes(`"${key}":`);
/** DGN round trip: every original element byte-identical, the paste appended before the end-of-design marker. */
function roundTrip(t) {
  const w = writeDgn(t.model, { bytes: t.b, orig: t.doc.orig });
  assert.equal(w.mode, 'round-trip');
  const eod = t.model.header.eod;
  assert.ok(Buffer.from(w.bytes.subarray(0, eod)).equals(Buffer.from(t.b.subarray(0, eod))), 'original elements untouched, byte for byte');
  assert.ok(w.bytes.length > eod + 2 && w.bytes[w.bytes.length - 2 - (t.b.length - eod - 2)] === 0xff, 'pasted elements appended, then the end-of-design marker');
  return w;
}
/** OGR reads the file and finds every element our reader finds (cell / text-node headers and the colour table aside). */
function ogrAgrees(file, model) {
  const r = ogrDump([file])[file];
  assert.ok(r && !r.error, `${file}: OGR opened it (${r && r.error})`);
  const n = r.features.filter((f) => ![2, 5, 7].includes(f.Type)).length;
  assert.equal(n, flatEntities(model.entities).length, `${file}: OGR sees every element`);
  return r;
}

// ------------------------------------------------------------------ payload
test('clipboard payload: text round trip, header line, foreign text ignored', () => {
  const { model, scene } = load('site-plan.dgn');
  const ids = model.entities.map((_, i) => i);
  const P = makePayload(model, ids, { ext: extOf(scene, ids) });
  const t = clipText(P);
  assert.ok(t.startsWith(CLIP_HEADER + '\n{'), 'header line + JSON');
  assert.deepEqual(parseClip(t), JSON.parse(JSON.stringify(P)), 'serialize -> parse gives the same payload');
  for (const s of ['', 'hello', CLIP_HEADER, CLIP_HEADER + '\n{not json', CLIP_HEADER + '\n{"v":2,"ents":[]}', null, 42]) assert.equal(parseClip(s), null, `ignored: ${String(s).slice(0, 30)}`);
  assert.equal(P.format, 'DGN');
  assert.equal(P.units.abbr, 'm');
  assert.deepEqual(P.ext.map((v) => +v.toFixed(6)), extOf(scene, ids).map((v) => +v.toFixed(6)));
});

test('copy strips what belongs to the source file: DGN byte ranges (cells and nested parts), raw Z, cell ids', () => {
  const { P } = copy('dgn-titleblock.dgn');
  const text = JSON.stringify(P);
  for (const k of ['dgn', 'zr', 'group', 'id']) assert.ok(!has(P, k), `no "${k}" anywhere`);
  const title = P.ents.find((e) => e.type === 'cell' && e.name === 'TITLE');
  assert.equal(title.children[5].name, 'STAMP', 'nested cell kept');
  assert.ok(text.length < 20000);
  const { P: P3 } = copy('dgn-3d.dgn');
  assert.ok(!has(P3, 'zr') && P3.ents.every((e) => typeof e.z === 'number'), '3D: raw Z becomes Z in master units');
  assert.ok(P3.ents.some((e) => e.z !== 0), 'the fixture has non-zero Z');
  // the source model is never modified
  const { model } = load('dgn-titleblock.dgn');
  makePayload(model, [0, 1, 2], {});
  assert.ok(model.entities.every((e) => e.dgn), 'source entities keep their ranges');
});

test('copy makes colours and weights explicit (DXF ByLayer / ByBlock), keeps DGN colour-table entries', () => {
  const { P, model } = copy('house-plan.dxf');
  const src = model.entities;
  const wall = P.ents.findIndex((e, k) => src[k].layer === 'WALLS' && src[k].color === 256);
  assert.ok(wall >= 0);
  assert.equal(P.ents[wall].color, 7, 'ByLayer on WALLS (colour 7) -> 7');
  assert.equal(P.ents[wall]._bl, 1, 'marked: was ByLayer');
  const door = P.ents.find((e, k) => src[k].layer === 'DOORS' && src[k].color === 256);
  assert.equal(door.color, 1, 'ByLayer on DOORS -> 1 (red)');
  assert.ok(P.ents.every((e) => e.lw != null), 'line weight explicit too');
  const lay = (n) => P.layers.find((l) => l.name === n);
  assert.deepEqual([lay('GRID').aci, lay('GRID').ltype], [9, 'DASHED'], 'layer definitions travel with the items');
  assert.ok(P.ltypes.DASHED && P.ltypes.DASHED.pattern.length, 'line type definition too');
  // a true-colour layer becomes an rgb colour; ByBlock at the top level is the foreground colour
  const m = createModel('DXF');
  Object.assign(ensureLayer(m, 'TC'), { color: 0x123456, aci: 5 });
  m.entities = [{ type: 'line', layer: 'TC', color: 256, rgb: null, a: [0, 0], b: [1, 0] }, { type: 'line', layer: 'TC', color: 0, rgb: null, a: [0, 1], b: [1, 1] }];
  const Q = makePayload(m, [0, 1], { ext: [0, 0, 1, 1] });
  assert.equal(Q.ents[0].rgb, 0x123456);
  assert.equal(Q.ents[1].color, 7);
  // DGN items keep their colour-table entry (and its colour)
  const { P: D } = copy('site-plan.dgn');
  assert.ok(D.ents.every((e) => e.ci != null && e.rgb != null && e.color === 256));
});

test('unit scaling: mm <-> in <-> m; unknown units are not scaled (and the paste says so)', () => {
  const u = (code) => ({ code, abbr: ['', 'in', 'ft', '', 'mm', '', 'm'][code] });
  assert.equal(unitScale(u(6), u(4)).k, 1000);
  assert.ok(Math.abs(unitScale(u(4), u(1)).k - 1 / 25.4) < 1e-15);
  assert.ok(Math.abs(unitScale(u(1), u(6)).k - 0.0254) < 1e-15);
  assert.equal(unitScale(u(4), u(4)).k, 1);
  assert.equal(unitScale(u(4), u(4)).note, undefined);
  assert.match(unitScale(u(6), u(4)).note, /Scaled from m to mm/);
  const unk = unitScale({ code: 0, name: 'Unitless' }, u(4));
  assert.equal(unk.k, 1);
  assert.match(unk.note, /Not scaled/);
  assert.equal(unitScale({ code: 0, name: 'Unitless' }, { code: 0, name: 'Unitless' }).note, undefined, 'both unitless: nothing to say');
  // a paste: site plan (m) into the house plan (mm) -> x1000, base point = lower-left of the extents
  const { P } = copy('site-plan.dgn', (e) => e.type === 'line');
  const t = pasteInto('house-plan.dxf', P);
  assert.equal(t.r.k, 1000);
  assert.ok(t.r.notes.some((n) => /Scaled from m to mm/.test(n)));
  const src = P.ents[0], got = t.model.entities[t.i0];
  assert.ok(Math.abs(got.a[0] - src.a[0] * 1000) < 1e-6 && Math.abs(got.b[1] - src.b[1] * 1000) < 1e-6, 'coordinates scaled about the origin (paste in place)');
  assert.deepEqual(t.r.base, [P.ext[0] * 1000, P.ext[1] * 1000]);
  // unknown units (schematic) into mm: 1:1 with a note
  const { P: S } = copy('schematic.dxf', (e) => e.type === 'line');
  const s = pasteInto('house-plan.dxf', S);
  assert.equal(s.r.k, 1);
  assert.ok(s.r.notes.some((n) => /Not scaled/.test(n)));
  assert.deepEqual(s.model.entities[s.i0].a, S.ents[0].a);
});

// ------------------------------------------------------------------ DGN -> DGN (the main path)
test('DGN -> DGN, same units: levels, colour-table entries, weights and cells kept; round trip leaves every original byte', () => {
  const { P } = copy('site-plan.dgn');
  const t = pasteInto('dgn-titleblock.dgn', P, { d: [100, 0] });
  // levels: kept by number; the target gets the ones it did not have
  const lv = (m) => new Set(flatEntities(m.entities).map((e) => e.layer));
  for (const L of lv({ entities: P.ents })) assert.ok(t.model.layers.some((l) => l.name === L), 'level ' + L);
  assert.ok(t.r.changes.some((c) => c.layer === 'Level 10' && c.after), 'missing level created');
  assert.equal(t.r.notes.length, 0, 'nothing to say: same units, same format');
  // colours: the target's own table (titleblock has the default palette, the site plan its own table)
  const pal = dgnPalette(bytes('dgn-titleblock.dgn'));
  for (const e of flatEntities(t.model.entities.slice(t.i0))) {
    assert.equal(e.rgb, pal[e.ci], 'colour is an entry of the target colour table');
    assert.ok(!e.dgn && e.zr == null, 'no source bytes / raw Z');
  }
  const srcPal = dgnPalette(bytes('site-plan.dgn'));
  const bad = flatEntities(P.ents).find((e) => e.ci === 1);
  const goodIdx = DGN_DEFAULT.findIndex((c) => c === srcPal[1]);
  assert.ok(bad && goodIdx !== 1, 'fixture: colour 1 differs between the two tables');
  const ellipse = t.model.entities.slice(t.i0).find((e) => e.type === 'ellipse' && !e.children);
  assert.equal(ellipse.weight, 2, 'weight kept');
  // round trip
  const w = roundTrip(t);
  const back = parseDgn(w.bytes);
  const cells = back.entities.filter((e) => e.type === 'cell');
  assert.deepEqual(cells.map((c) => c.name).sort(), ['NORTH', 'TITLE', 'TREE', 'TREE', 'TREE', 'TREE'], 'pasted cells are cells (new headers), the original TITLE intact');
  const north = cells.find((c) => c.name === 'NORTH');
  assert.ok(Math.abs((north.rotation * 180) / Math.PI - 30) < 0.01 && Math.abs(north.xscale - 1.5) < 1e-4 && Math.abs(north.yscale - 1) < 1e-4, 'cell transform kept in the new header');
  assert.ok(Math.abs(north.origin[0] - 190) < 1e-3 && Math.abs(north.origin[1] - 50) < 1e-3, 'cell origin moved with the paste');
  const tol = (x) => 1e-3 * Math.max(1, ...x.bbox.map(Math.abs));
  assert.deepEqual(compareItems(liveItems(buildScene(t.model)), liveItems(buildScene(back)), tol), [], 'reads back as pasted');
  const f = join(TMP, 'dgn-paste-same-units.dgn');
  writeFileSync(f, w.bytes);
  if (!ogrSkip) ogrAgrees(f, back);
});

test('DGN -> DGN, other working units, global origin and colour table (m -> ft): scaled, colours remapped, GDAL reads it', () => {
  const { P } = copy('site-plan.dgn');
  const t = pasteInto('dgn-default-palette.dgn', P);
  const k = 1 / 0.3048;
  assert.ok(t.r.notes.some((n) => /Scaled from m to ft/.test(n)));
  const srcPal = dgnPalette(bytes('site-plan.dgn'));
  const pasted = t.model.entities.slice(t.i0);
  pasted.forEach((e, j) => {
    const s = P.ents[j];
    assert.equal(e.rgb, DGN_DEFAULT[e.ci], 'an entry of the target (default) colour table');
    if (DGN_DEFAULT[s.ci] === srcPal[s.ci]) assert.equal(e.ci, s.ci, 'same colour in both tables: same entry');
  });
  const w = roundTrip(t);
  const back = parseDgn(w.bytes);
  const tol = (x) => 1e-3 * Math.max(1, ...x.bbox.map(Math.abs));
  assert.deepEqual(compareItems(liveItems(buildScene(t.model)), liveItems(buildScene(back)), tol), []);
  const tree = back.entities.filter((e) => e.type === 'cell' && e.name === 'TREE')[1];
  assert.ok(Math.abs(tree.xscale - 1.5 * k) < 1e-3 && Math.abs((tree.rotation * 180) / Math.PI - 30) < 0.01, 'cell scale includes the unit change');
  const line = back.entities.find((e) => e.type === 'line');
  const src = P.ents.find((e) => e.type === 'line');
  assert.ok(Math.abs(line.a[0] - src.a[0] * k) < 1e-3 && Math.abs(line.b[1] - src.b[1] * k) < 1e-3, 'coordinates in feet');
  const f = join(TMP, 'dgn-paste-m-to-ft.dgn');
  writeFileSync(f, w.bytes);
  if (!ogrSkip) ogrAgrees(f, back);
});

test('DGN -> DGN: text inside a pasted cell can still be retyped, and saves', () => {
  const { P } = copy('dgn-titleblock.dgn', (e) => e.type === 'cell');
  const t = pasteInto('site-plan.dgn', P, { d: [0, -100] });
  const ci = t.i0, cell = t.model.entities[ci];
  assert.equal(partAt(cell, 'c3').text, 'SHEET 1 OF 2');
  const s = buildScene(t.model);
  assert.ok(s.texts.some((x) => x.ent === ci && x.sub === 'c5.c1' && x.s === 'OK'), 'scene knows the path of the nested text');
  t.doc.commit('Edit text', [{ i: ci, before: cell, after: withPart(cell, 'c3', setText(partAt(cell, 'c3'), 'SHEET 9 OF 9')) }]);
  const w = roundTrip(t);
  const back = parseDgn(w.bytes);
  const title = back.entities.find((e) => e.type === 'cell' && e.name === 'TITLE');
  assert.deepEqual(title.children.map((c) => c.type), P.ents[0].children.map((c) => c.type), 'same structure');
  assert.equal(title.children[3].text, 'SHEET 9 OF 9');
  assert.equal(title.children[5].name, 'STAMP', 'nested cell has its own new header');
  assert.ok(Math.abs(title.origin[1] - (2 - 100)) < 1e-6);
  const f = join(TMP, 'dgn-paste-titleblock.dgn');
  writeFileSync(f, w.bytes);
  if (!ogrSkip) {
    const r = ogrAgrees(f, back);
    assert.ok(r.features.some((x) => x.Text === 'SHEET 9 OF 9'));
  }
});

test('DGN 3D: Z kept between 3D files, flattened (with a note) into a 2D file, Z = 0 from a 2D file; 3D cell headers', () => {
  const { P } = copy('dgn-3d.dgn');
  const src = load('dgn-3d.dgn').model.entities;
  // 3D -> same 3D file (duplicate): raw Z identical
  const d = pasteInto('dgn-3d.dgn', P, { d: [20, 0] });
  d.model.entities.slice(d.i0).forEach((e, j) => assert.equal(e.zr, src[j].zr, 'Z kept'));
  const w = roundTrip(d);
  const back = parseDgn(w.bytes);
  assert.deepEqual(back.entities.slice(-3).map((e) => e.zr), src.map((e) => e.zr), 'Z written and read back');
  // 3D -> 2D: flattened, with a note
  const f2 = pasteInto('site-plan.dgn', P);
  assert.ok(f2.r.notes.some((n) => /flattened to Z = 0/.test(n)));
  assert.ok(f2.model.entities.slice(f2.i0).every((e) => e.zr == null));
  // 2D -> 3D (cells too): Z = 0, 3D layouts, new 3D cell headers
  const { P: S } = copy('site-plan.dgn');
  const t = pasteInto('dgn-3d.dgn', S);
  const w3 = roundTrip(t);
  const b3 = parseDgn(w3.bytes);
  assert.equal(b3.header.dimension, 3);
  const cells = b3.entities.filter((e) => e.type === 'cell');
  assert.equal(cells.length, 5);
  assert.ok(cells.every((c) => c.trans3 && Math.abs(c.trans3[8] - 1) < 1e-4), '3D transform');
  const north = cells.find((c) => c.name === 'NORTH');
  assert.ok(Math.abs(Math.atan2(north.trans3[3], north.trans3[0]) - Math.PI / 6) < 1e-4, 'rotation in the 3D matrix');
  const z = flatEntities(b3.entities.slice(3));
  assert.ok(z.every((e) => !e.zr) && z.filter((e) => e.zr === 0).length > 20, 'Z = 0 (this file has no Z origin)');
  const tol = (x) => 2e-3 * Math.max(1, ...x.bbox.map(Math.abs));
  assert.deepEqual(compareItems(liveItems(buildScene(t.model)), liveItems(buildScene(b3)), tol), []);
  if (!ogrSkip) {
    const f = join(TMP, 'dgn-paste-into-3d.dgn'), g = join(TMP, 'dgn-3d-dup.dgn');
    writeFileSync(f, w3.bytes); writeFileSync(g, w.bytes);
    ogrAgrees(f, b3); ogrAgrees(g, back);
  }
});

// ------------------------------------------------------------------ across formats
test('DXF -> DGN: on the current level, blocks exploded (note), colours through the DGN table, weights mapped; GDAL reads it', () => {
  const { P } = copy('house-plan.dxf');
  const t = pasteInto('site-plan.dgn', P, { layer: 'Level 6' });
  assert.ok(t.r.notes.some((n) => /exploded/.test(n)) && t.r.notes.some((n) => /Level 6/.test(n)) && t.r.notes.some((n) => /mm to m/.test(n)));
  const pasted = t.model.entities.slice(t.i0);
  assert.ok(pasted.every((e) => e.layer === 'Level 6'), 'all on the current level');
  assert.ok(!pasted.some((e) => e.type === 'insert' || e.type === 'dimension'), 'no blocks in a DGN');
  const pal = dgnPalette(bytes('site-plan.dgn'));
  assert.ok(pasted.every((e) => e.rgb === pal[e.ci] && e.color === 256 && e.lw == null));
  assert.ok(pasted.some((e) => e.ltype === 'DGN2'), 'dashed GRID line type -> DGN line style 2');
  // the exploded doors look the same as the inserts did (scaled mm -> m)
  const before = liveItems(buildScene(load('house-plan.dxf').model)).filter((x) => x.kind !== 't');
  const after = liveItems(buildScene(t.model)).filter((x) => x.kind !== 't' && x.layer === 'Level 6');
  assert.ok(after.length >= before.length * 0.95, `exploded items drawn: ${after.length} vs ${before.length}`);
  const w = roundTrip(t);
  const back = parseDgn(w.bytes);
  assert.ok(flatEntities(back.entities).filter((e) => e.layer === 'Level 6').length > 100);
  const f = join(TMP, 'dxf-into-dgn.dgn');
  writeFileSync(f, w.bytes);
  if (!ogrSkip) ogrAgrees(f, back);
});

test('DGN -> DXF: levels become layers "Level N", colours ACI or true colour, weights -> lineweights; writeDxf + GDAL read it', () => {
  const { P } = copy('site-plan.dgn');
  const t = pasteInto('house-plan.dxf', P);
  const pasted = t.model.entities.slice(t.i0);
  const newLayers = t.r.changes.filter((c) => c.layer).map((c) => c.layer);
  assert.ok(newLayers.includes('Level 1') && newLayers.includes('Level 10'));
  assert.ok(t.r.changes.filter((c) => c.layer).every((c) => c.after.aci === 7));
  const pal = dgnPalette(bytes('site-plan.dgn'));
  pasted.forEach((e, j) => {
    const s = P.ents[j];
    if (s.rgb === 0xffffff) assert.equal(e.color, 7, 'white -> colour 7');
    else if (e.rgb == null) assert.equal(ACI[e.color], s.rgb, 'exact ACI');
    else assert.equal(e.rgb, pal[s.ci], 'true colour');
    assert.ok(e.ci == null && e.weight == null);
  });
  assert.equal(pasted.find((e) => e.type === 'ellipse').lw, weightToLw(2), 'weight 2 -> 0.18 mm');
  const out = writeDxf(t.model);
  const m2 = parseDrawing(enc(out.text), 'x.dxf');
  const tol = (x) => 1e-6 * Math.max(1, ...x.bbox.map(Math.abs));
  assert.deepEqual(compareItems(liveItems(buildScene(t.model)), liveItems(buildScene(m2)), tol, { mergeKinds: true }), []);
  assert.ok(out.notes.some((n) => /cells? saved as separate items/.test(n)));
  const f = join(TMP, 'dgn-into-dxf.dxf');
  writeFileSync(f, out.text);
  if (!ogrSkip) { const r = ogrDump([f])[f]; assert.ok(r && !r.error && r.features.filter((x) => /^Level /.test(x.Layer)).length >= flatEntities(P.ents).length); }
  // and that DXF drawing saved as a new DGN: the pasted cells are written as cells (new headers)
  const g = parseDgn(writeDgn(t.model, { extents: [-1000, -3000, 14000, 10000] }).bytes);
  assert.deepEqual(g.entities.filter((e) => e.type === 'cell').map((e) => e.name).sort(), ['NORTH', 'TREE', 'TREE', 'TREE', 'TREE']);
  if (!ogrSkip) { const h = join(TMP, 'dgn-into-dxf-as.dgn'); writeFileSync(h, writeDgn(t.model, { extents: [-1000, -3000, 14000, 10000] }).bytes); ogrAgrees(h, g); }
});

test('DXF -> DXF: layers, line types, styles and blocks copied in; a block name with other content is renamed (NAME_2, *D5)', () => {
  // the schematic's terminal (insert + attributes) into the house plan: new blocks and layers come along
  const { P } = copy('schematic.dxf', (e) => e.type === 'insert' && e.block === 'TERM');
  assert.ok(P.blocks.TERM && P.layers.some((l) => l.name === 'TERMINALS'));
  const t = pasteInto('house-plan.dxf', P);
  assert.ok(t.model.blocks.TERM, 'block added');
  assert.ok(t.model.layers.some((l) => l.name === 'TERMINALS' && l.aci === 1), 'layer created with its colour');
  assert.ok(t.model.entities.slice(t.i0).every((e) => e.attribs && e.attribs.length), 'attributes kept');
  // nested blocks: the whole chain comes along; a clash renames, and so does every block that uses it
  const { P: N } = copy('edge-nested-mirror.dxf', (e) => e.type === 'insert' && e.block === 'TRIPLE');
  assert.deepEqual(Object.keys(N.blocks).sort(), ['FLAG', 'PAIR', 'TRIPLE']);
  const n = load('edge-nested-mirror.dxf');
  n.model.blocks.FLAG = { ...n.model.blocks.FLAG, entities: n.model.blocks.FLAG.entities.slice(0, 1) }; // a different FLAG
  const r = preparePaste(N, n.model);
  const added = Object.fromEntries(r.changes.filter((c) => c.table === 'blocks').map((c) => [c.after.name, c.after]));
  assert.deepEqual(Object.keys(added).sort(), ['FLAG_2', 'PAIR_2', 'TRIPLE_2'], 'renamed: ' + Object.keys(added));
  assert.ok(added.PAIR_2.entities.every((c) => c.block === 'FLAG_2') && added.TRIPLE_2.entities.some((c) => c.block === 'PAIR_2'));
  assert.equal(r.ents[0].block, 'TRIPLE_2');
  assert.ok(r.notes.some((x) => /FLAG → FLAG_2/.test(x)));
  // the same drawing (identical blocks): nothing added, nothing renamed
  const same = preparePaste(N, load('edge-nested-mirror.dxf').model);
  assert.equal(same.changes.length, 0);
  // dimensions: anonymous blocks get the next free number
  const { P: D } = copy('house-plan.dxf', (e) => e.type === 'dimension');
  const b = pasteInto('bracket.dxf', D);
  const names = b.model.entities.slice(b.i0).map((e) => e.block);
  assert.deepEqual(names, ['*D5', '*D6', '*D7']);
  const out = writeDxf(b.model);
  const m2 = parseDrawing(enc(out.text), 'x.dxf');
  const tol = (x) => 1e-6 * Math.max(1, ...x.bbox.map(Math.abs));
  assert.deepEqual(compareItems(liveItems(buildScene(b.model)), liveItems(buildScene(m2)), tol), []);
  if (!ogrSkip) { const f = join(TMP, 'dims-into-bracket.dxf'); writeFileSync(f, out.text); const g = ogrDump([f])[f]; assert.ok(g && !g.error && g.features.length > 30); }
});

test('DXF -> DXF colours: ByLayer comes back when the target layer looks the same, else stays explicit; undo removes everything in one step', () => {
  const { P } = copy('house-plan.dxf', (e) => e.layer === 'DOORS' || e.layer === 'WALLS');
  const t = pasteInto('house-plan.dxf', P);
  const pasted = t.model.entities.slice(t.i0);
  assert.ok(pasted.filter((e) => e.layer === 'WALLS').every((e) => e.color === 256 && e.lw == null), 'same layer colour: ByLayer again');
  // a target where DOORS is green: the pasted doors stay red
  const g = load('house-plan.dxf');
  g.model.layers.find((l) => l.name === 'DOORS').color = ACI[3];
  const r = preparePaste(P, g.model);
  assert.ok(r.ents.filter((e) => e.layer === 'DOORS').every((e) => e.color === 1), 'look kept: explicit red');
  // undo: one step removes entities, layers and blocks
  const { P: S } = copy('schematic.dxf', (e) => e.type === 'insert');
  const u = pasteInto('house-plan.dxf', S);
  const nBlocks = Object.keys(u.model.blocks).length, nLayers = u.model.layers.length;
  u.doc.revert(u.entry);
  assert.ok(Object.keys(u.model.blocks).length < nBlocks && u.model.layers.length < nLayers);
  assert.ok(u.model.entities.slice(u.i0).every((e) => !e), 'items gone');
  assert.deepEqual(Object.keys(u.model.blocks).sort(), Object.keys(load('house-plan.dxf').model.blocks).sort());
  assert.equal(u.doc.dirty, false);
  u.doc.reapply(u.entry);
  assert.equal(u.model.entities.slice(u.i0).filter(Boolean).length, S.ents.length, 'redo');
});

// ------------------------------------------------------------------ duplicate
test('duplicate (DGN): line, line string, text, cell -> new elements appended; originals untouched; cells get new headers', () => {
  const { model, scene } = load('site-plan.dgn');
  const b = bytes('site-plan.dgn');
  const doc = new EditDoc(model, scene, { bytes: b });
  const pick = ['line', 'polyline', 'text', 'cell'].map((ty) => model.entities.findIndex((e) => e.type === ty));
  const r = duplicate(model, pick, extOf(scene, pick), 'Level 1');
  assert.equal(r.changes.length, 0, 'same drawing: nothing to add');
  assert.equal(r.notes.length, 0);
  r.ents.forEach((e, j) => {
    const o = model.entities[pick[j]];
    assert.ok(e !== o && !e.dgn && e.layer === o.layer && e.ci === o.ci && e.rgb === o.rgb && (e.weight | 0) === (o.weight | 0), 'same look, no source bytes');
  });
  const i0 = doc.nextIndex();
  doc.commit('Duplicate', r.ents.map((e, k) => ({ i: i0 + k, before: null, after: moveEntity(e, 5, 5) })));
  const w = roundTrip({ model, doc, b });
  const back = parseDgn(w.bytes);
  assert.equal(back.entities.length, model.entities.length);
  assert.equal(back.entities.filter((e) => e.type === 'cell' && e.name === 'TREE').length, 5, 'four trees + the duplicate');
  const tol = (x) => 1e-3 * Math.max(1, ...x.bbox.map(Math.abs));
  assert.deepEqual(compareItems(liveItems(buildScene(model)), liveItems(buildScene(back)), tol), []);
  if (!ogrSkip) { const f = join(TMP, 'dgn-dup.dgn'); writeFileSync(f, w.bytes); ogrAgrees(f, back); }
});

test('duplicate (DXF): insert with attributes, polyline, text -> same blocks / layers / colours; DXF round trip', () => {
  const { model, scene } = load('schematic.dxf');
  const doc = new EditDoc(model, scene);
  const pick = [model.entities.findIndex((e) => e.type === 'insert' && e.attribs && e.attribs.length), model.entities.findIndex((e) => e.type === 'polyline'), model.entities.findIndex((e) => e.type === 'text')];
  const before = JSON.stringify(pick.map((i) => model.entities[i]));
  const r = duplicate(model, pick, extOf(scene, pick));
  assert.equal(r.changes.length, 0);
  r.ents.forEach((e, j) => {
    const o = model.entities[pick[j]];
    for (const k of ['type', 'layer', 'color', 'rgb', 'block', 'text']) assert.deepEqual(e[k], o[k], k);
    if (o.attribs) assert.deepEqual(e.attribs.map((a) => a.text), o.attribs.map((a) => a.text));
  });
  const i0 = doc.nextIndex();
  doc.commit('Duplicate', r.ents.map((e, k) => ({ i: i0 + k, before: null, after: moveEntity(e, 0, 3) })));
  assert.equal(JSON.stringify(pick.map((i) => model.entities[i])), before, 'originals untouched');
  const m2 = parseDrawing(enc(writeDxf(model).text), 'x.dxf');
  const tol = (x) => 1e-6 * Math.max(1, ...x.bbox.map(Math.abs));
  assert.deepEqual(compareItems(liveItems(buildScene(model)), liveItems(buildScene(m2)), tol), []);
});

test('copy ~500 items of the 53k stress drawing and paste them: fast', () => {
  const model = parseDrawing(enc(makeStressDxf().text), 'stress.dxf');
  const scene = buildScene(model);
  const ids = Array.from({ length: 500 }, (_, k) => k * 97);
  const t0 = performance.now();
  const text = clipText(makePayload(model, ids, { ext: extOf(scene, ids) }));
  const r = preparePaste(parseClip(text), model);
  const ms = performance.now() - t0;
  assert.equal(r.ents.length, 500);
  assert.ok(ms < 400, `copy + paste of 500 items took ${ms.toFixed(1)} ms`);
});

// ------------------------------------------------------------------ line weights
test('line weights: DXF 370 on entities and layers (ByLayer, ByBlock, default) -> scene widths; labels', () => {
  const { model, scene } = load('edge-lineweights.dxf');
  assert.deepEqual(model.layers.filter((l) => l.lw != null).map((l) => [l.name, l.lw]), [['THIN', 13], ['HEAVY', 100], ['PLAIN', -3]]);
  assert.deepEqual(model.entities.map((e) => e.lw), [200, 35, undefined, -1, -3, 50, 70]);
  const w = (i) => [...scene.weight.subarray(scene.entPrim[i], scene.entPrim[i + 1])];
  const cls = (lw) => 1 + DXF_LW.indexOf(lw);
  assert.deepEqual([w(0), w(1), w(2), w(3), w(4), w(5)], [[cls(200)], [cls(35)], [cls(100)], [cls(13)], [0], [cls(50)]], 'explicit, ByLayer, default');
  assert.deepEqual(w(6), [cls(70), cls(13)], 'in a block: ByBlock takes the insert weight, ByLayer its layer');
  assert.equal(weightPx(cls(25), 'DXF'), 1);
  assert.equal(weightPx(cls(200), 'DXF'), 8);
  assert.equal(weightPx(0, 'DXF'), 1);
  assert.equal(weightPx(4, 'DGN'), 4);
  assert.equal(weightLabel(model.entities[1], 'DXF'), 'Weight 0.35 mm');
  assert.equal(weightLabel(model.entities[2], 'DXF'), 'Weight ByLayer');
  assert.equal(weightLabel({ weight: 7 }, 'DGN'), 'Weight 7');
  // DGN weight <-> lineweight mapping (documented in the README)
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 31].map(weightToLw), [-1, 13, 18, 25, 35, 50, 70, 100, 140, 200, 211, 211]);
  assert.deepEqual([-3, 0, 9, 13, 15, 25, 30, 53, 100, 158, 200, 211].map(lwToWeight), [0, 0, 0, 1, 1, 3, 3, 5, 7, 8, 9, 10]);
  for (let w2 = 1; w2 <= 10; w2++) assert.equal(lwToWeight(weightToLw(w2)), w2, 'DGN -> DXF -> DGN keeps weights 1-10');
});

test('line weights: DXF round trip exact (entities + layers); DGN -> DXF -> DGN mapping; GDAL reads them', () => {
  const { model } = load('edge-lineweights.dxf');
  const out = writeDxf(model);
  const m2 = parseDrawing(enc(out.text), 'x.dxf');
  assert.deepEqual(m2.entities.map((e) => e.lw ?? -1), model.entities.map((e) => e.lw ?? -1), 'entity lineweights');
  for (const L of model.layers) assert.equal(m2.layers.find((l) => l.name === L.name).lw, L.lw ?? -3, 'layer ' + L.name);
  assert.deepEqual(m2.blocks.TAG.entities.map((e) => e.lw ?? -1), [-2, -1], 'ByBlock / ByLayer inside blocks');
  // DGN -> DXF -> DGN
  const { model: g } = load('site-plan.dgn');
  const heavy = g.entities.findIndex((e) => e.type === 'line');
  g.entities[heavy] = restyle(g.entities[heavy], { weight: 6 }, 'DGN');
  const dx = parseDrawing(enc(writeDxf(g).text), 'g.dxf');
  assert.equal(dx.entities.filter((e) => e.type === 'line')[0].lw, 70, 'weight 6 -> 0.70 mm');
  assert.equal(dx.entities.find((e) => e.type === 'ellipse').lw, 18, 'weight 2 -> 0.18 mm');
  const dg = parseDgn(writeDgn(dx, { extents: [-10, -20, 110, 60] }).bytes);
  const ws = new Map(flatEntities(dg.entities).map((e) => [e.type + ':' + (e.a || e.c || e.p || e.pts.slice(0, 2)).map((v) => v.toFixed(2)), e.weight]));
  assert.ok([...ws.values()].includes(6) && [...ws.values()].includes(2), 'DXF lineweights -> DGN weights');
  assert.equal(flatEntities(dg.entities).filter((e) => e.weight === 6).length, 1);
  if (!ogrSkip) {
    const f = join(TMP, 'weights.dxf'), h = join(TMP, 'weights.dgn');
    writeFileSync(f, out.text);
    writeFileSync(h, writeDgn(model, { extents: [0, -10, 100, 100] }).bytes);
    const r = ogrDump([f, h]);
    assert.deepEqual(r[f].features.slice(0, 4).map((x) => x.w), ['2g', '0.35g', '1g', '0.13g'], 'OGR: DXF lineweights (ByLayer resolved)');
    assert.deepEqual(r[h].features.filter((x) => x.Type !== 5).slice(0, 4).map((x) => x.Weight), [9, 4, 7, 1], 'OGR: DGN weights from DXF lineweights');
  }
});

test('line weights: restyle a DGN cell (components + header), a DXF insert (+ attributes); round trip keeps them', () => {
  const b = bytes('dgn-titleblock.dgn');
  const m = parseDgn(b), orig = m.entities.slice();
  const ci = m.entities.findIndex((e) => e.type === 'cell');
  const cell = restyle(m.entities[ci], { weight: 5 }, 'DGN');
  assert.ok(flatEntities([cell]).every((e) => e.weight === 5) && cell.weight === 5 && cell.children[5].weight === 5, 'every component, nested too');
  assert.equal(m.entities[ci].children[0].weight, 0, 'input not modified');
  m.entities[ci] = cell;
  const out = writeDgn(m, { bytes: b, orig }).bytes;
  const back = parseDgn(out);
  const c2 = back.entities.find((e) => e.type === 'cell' && e.name === 'TITLE');
  assert.ok(flatEntities([c2]).every((e) => e.weight === 5) && c2.weight === 5, 'written: components and the patched header');
  const { model } = load('schematic.dxf');
  const ins = model.entities.find((e) => e.type === 'insert' && e.attribs && e.attribs.length);
  const r = restyle(ins, { weight: 50 }, 'DXF');
  assert.ok(r.lw === 50 && r.attribs.every((a) => a.lw === 50));
  assert.equal(restyle(r, { weight: -1 }, 'DXF').lw, undefined, 'back to ByLayer');
  if (!ogrSkip) { const f = join(TMP, 'weights-cell.dgn'); writeFileSync(f, out); const q = ogrDump([f])[f]; assert.equal(q.features.filter((x) => x.Weight === 5).length, 7, "OGR: every component has weight 5"); }
});

test('copy / paste carries line weights across formats', () => {
  const { P } = copy('edge-lineweights.dxf');
  const t = pasteInto('site-plan.dgn', P, { layer: 'Level 3' });
  const pasted = t.model.entities.slice(t.i0);
  assert.deepEqual(pasted.slice(0, 6).map((e) => e.weight), [9, 4, 7, 1, 0, 5], '2.00 / 0.35 / ByLayer 1.00 / ByLayer 0.13 / default / 0.50 mm');
  assert.ok(pasted.slice(6).some((e) => e.weight === 6), 'ByBlock inside the exploded block -> the insert weight 0.70');
  const { P: D } = copy('site-plan.dgn', (e) => e.type === 'ellipse');
  const x = pasteInto('edge-lineweights.dxf', D);
  assert.equal(x.model.entities[x.i0].lw, 18, 'DGN weight 2 -> 0.18 mm');
  const same = pasteInto('edge-lineweights.dxf', P);
  assert.deepEqual(same.model.entities.slice(same.i0).map((e) => e.lw), [200, 35, undefined, undefined, -3, 50, 70], 'DXF -> same DXF: ByLayer stays ByLayer');
});
