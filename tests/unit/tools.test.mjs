// v0.4 editing tools: find / replace text, precision key-ins, mirror / scale / array, select by
// attributes, match attributes, element information, level names. DGN first: the synthetic wiring sheet
// tests/fixtures/dgn-wiring.dgn (tools/make_dgn_fixtures.py), checked against GDAL/OGR when installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytes, fixture, gdalPython, ogrDump, near } from './helpers.mjs';
import { parseDgn } from '../../src/formats/dgn.js';
import { writeDgn } from '../../src/formats/dgn-write.js';
import { buildScene } from '../../src/scene.js';
import { createModel, ensureLayer } from '../../src/model.js';
import { EditDoc } from '../../src/edit/doc.js';
import { rotateEntity, moveEntity } from '../../src/edit/ops.js';
import { entityBBox } from '../../src/edit/live-scene.js';
import { duplicate } from '../../src/edit/clipboard.js';
import { findRegex, findTexts, replaceChanges, replaceIn } from '../../src/edit/find.js';
import { parseKeyin, keyinPoint } from '../../src/edit/keyin.js';
import { mirrorEntity, scaleEntity, arrayCopies, mirrorMatrix } from '../../src/edit/xform.js';
import { attrKey, keysOf, selectByKeys, valuesOf, matchStyle, entityInfo, typeName } from '../../src/edit/attrs.js';
import { parseLevelNames, levelNamesCsv } from '../../src/edit/levels.js';

const W = 'dgn-wiring.dgn';
const TMP = mkdtempSync(join(tmpdir(), 'linework-tools-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
const ogrSkip = gdalPython() ? false : 'Python with GDAL (osgeo) not found: GDAL/OGR read-back checks skipped';

function open(name = W) {
  const b = bytes(name);
  const model = parseDgn(b);
  const scene = buildScene(model);
  return { b, model, scene, doc: new EditDoc(model, scene, { bytes: b }) };
}
const save = (t) => writeDgn(t.model, { bytes: t.b, orig: t.doc.orig });
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
/** Original elements outside `ranges` are byte-identical; inside, only the deleted bit differs. */
function originalsKept(t, out, ranges) {
  const b = t.b;
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
const textsOf = (model) => {
  const out = [];
  const walk = (l) => { for (const e of l) { if (!e) continue; if (e.type === 'text') out.push(e.text); if (e.children) walk(e.children); } };
  walk(model.entities);
  return out.sort();
};
const idx = (t, pred) => t.model.entities.findIndex((e) => e && pred(e));
const textIdx = (t, s) => idx(t, (e) => e.type === 'text' && e.text === s);

// ------------------------------------------------------------------ fixture
test('wiring fixture: read like GDAL/OGR (texts, levels), cells hold their labels', () => {
  const t = open();
  const o = JSON.parse(readFileSync(fixture('dgn-wiring.ogr.json'), 'utf8'));
  const ogrTexts = o.features.filter((f) => f.text).map((f) => f.text).sort();
  assert.deepEqual(textsOf(t.model), ogrTexts, 'the same texts as OGR');
  assert.deepEqual(t.scene.layers.filter((l) => l.count).map((l) => l.name), o.levels.map((l) => 'Level ' + l));
  assert.equal(t.model.entities.filter((e) => e.type === 'cell').length, 5);
});

// ------------------------------------------------------------------ find
test('find: substring, whole word, match case, visible levels only, text inside cells, reading order', () => {
  const { scene } = open();
  const s = (q, o) => findTexts(scene, q, o).map((h) => h.s);
  assert.deepEqual(s('W101').sort(), ['NOTE: W101 FEEDS RELAY K1', 'W101', 'W101', 'W1010'].sort(), 'substring, any case');
  assert.equal(findTexts(scene, 'W101', { wholeWord: true }).length, 3, 'whole word: not W1010');
  assert.equal(findTexts(scene, 'w104').length, 1);
  assert.equal(findTexts(scene, 'W104', { matchCase: true }).length, 0, 'match case');
  assert.equal(findTexts(scene, 'tb1-', {}).length, 3, 'punctuation is literal');
  assert.equal(findTexts(scene, 'TB1-2', { wholeWord: true }).length, 1, 'whole word around a hyphenated label');
  assert.equal(findTexts(scene, '.*').length, 0, 'regex characters are literal');
  assert.equal(findTexts(scene, '').length, 0);
  const hidden = scene.layers.findIndex((l) => l.name === 'Level 20');
  assert.equal(findTexts(scene, 'W101', { isVisible: (li) => li !== hidden }).length, 3, 'visible levels only');
  const inCell = findTexts(scene, 'W101', { wholeWord: true }).find((h) => h.sub);
  assert.equal(inCell.sub, 'c1', 'a hit inside a cell carries its path');
  // reading order: top row first, left to right
  const hits = findTexts(scene, 'W10');
  assert.deepEqual(hits.map((h) => h.s), ['W101', 'W101', 'W102', 'W103', 'W1010', 'w104', 'NOTE: W101 FEEDS RELAY K1'], 'top to bottom, left to right');
  assert.equal(hits[0].sub, 'c1', 'the marker cell sits higher than the W101 label');
  assert.ok(findRegex('a(b', { wholeWord: true }).test('x a(b y'));
});

test('replace: one text, every text (one undo step), cells rebuilt from their bytes, DGN saved byte-preserving', () => {
  const t = open();
  // replace the current hit (the label inside the MARKER cell)
  const cellHit = findTexts(t.scene, 'W101', { wholeWord: true }).find((h) => h.sub);
  const one = replaceChanges(t.model.entities, [cellHit], 'W101', 'W201', { wholeWord: true });
  assert.equal(one.changes.length, 1);
  assert.equal(one.changes[0].after.children[1].text, 'W201');
  assert.equal(one.changes[0].after.children[0], one.changes[0].before.children[0], 'the rest of the cell is shared, untouched');
  // replace all: the cell, the label and the note; W1010 untouched
  const hits = findTexts(t.scene, 'W101', { wholeWord: true });
  const r = replaceChanges(t.model.entities, hits, 'W101', 'W201', { wholeWord: true });
  assert.equal(r.texts, 3);
  assert.equal(r.changes.length, 3);
  const before = t.model.entities.slice();
  const entry = t.doc.commit('Replace 3 texts', r.changes);
  assert.equal(entry.changes.length, 3, 'one history entry');
  assert.deepEqual(findTexts(t.scene, 'W201').map((h) => h.s).sort(), ['NOTE: W201 FEEDS RELAY K1', 'W201', 'W201'], 'the scene shows the new texts');
  assert.equal(findTexts(t.scene, 'W1010').length, 1);
  // save: every untouched element byte for byte; the edited ones flagged deleted and appended
  const w = save(t);
  const ranges = r.changes.map((c) => before[c.i].dgn);
  originalsKept(t, w.bytes, ranges);
  assert.ok(!w.notes.some((n) => /rewritten|rebuilt/.test(n)), 'no item rewritten from the model: ' + w.notes.join(' | '));
  const back = parseDgn(w.bytes);
  assert.deepEqual(textsOf(back).filter((s) => /W[12]01/.test(s)), ['NOTE: W201 FEEDS RELAY K1', 'W1010', 'W201', 'W201']);
  const cell = back.entities.find((e) => e.type === 'cell' && e.name === 'MARKER');
  assert.equal(cell.children.length, 2, 'the cell keeps its frame');
  // the appended MARKER cell equals the original bytes except the text characters and the deleted bits
  const o0 = before[idx(t, (e) => e.type === 'cell' && e.name === 'MARKER')].dgn;
  const orig = t.b.subarray(o0[0], o0[1]), nb = w.bytes.subarray(cell.dgn[0], cell.dgn[1]);
  assert.equal(nb.length, orig.length, 'same size (same text length)');
  const diff = []; for (let k = 0; k < nb.length; k++) if (nb[k] !== orig[k]) diff.push(k);
  assert.ok(diff.length <= 2 && diff.every((k) => orig[k] === '1'.charCodeAt(0) || orig[k] === '0'.charCodeAt(0)), 'only the changed digit differs: ' + diff);
  // undo restores the original objects
  t.doc.revert(entry);
  for (let i = 0; i < before.length; i++) assert.equal(t.model.entities[i], before[i]);
});

test('replace: block-definition text is shared (skipped), a text is never left empty, attributes and case', () => {
  const m = createModel('DXF');
  ensureLayer(m, '0');
  m.blocks.TAG = { name: 'TAG', base: [0, 0], entities: [{ type: 'text', layer: '0', p: [0, 0], h: 1, rot: 0, text: 'PUMP', halign: 0, valign: 0, wf: 1 }] };
  m.entities.push({ type: 'insert', layer: '0', block: 'TAG', p: [10, 0], sx: 1, sy: 1, rot: 0, attribs: [{ type: 'text', layer: '0', p: [10, 2], h: 1, rot: 0, text: 'P-1 pump', tag: 'ID' }] });
  m.entities.push({ type: 'text', layer: '0', p: [0, 5], h: 1, rot: 0, text: 'pump', halign: 0, valign: 0, wf: 1 });
  m.entities.push({ type: 'mtext', layer: '0', p: [0, 9], h: 1, rot: 0, text: 'Pump one\nPump two', attach: 1, width: 0 });
  const scene = buildScene(m);
  const hits = findTexts(scene, 'pump');
  assert.equal(hits.length, 5, 'block text, attribute, text, two MTEXT lines');
  assert.ok(hits.some((h) => h.sub[0] === '#'), 'block-definition text is marked shared');
  const r = replaceChanges(m.entities, hits, 'pump', 'Fan', {});
  assert.equal(r.shared, 1);
  assert.equal(r.changes.length, 3, 'insert (attribute), text, MTEXT (both lines in one change)');
  const by = Object.fromEntries(r.changes.map((c) => [c.i, c.after]));
  assert.equal(by[0].attribs[0].text, 'P-1 Fan');
  assert.equal(by[1].text, 'Fan');
  assert.equal(by[2].text, 'Fan one\nFan two');
  assert.equal(replaceIn(m.entities[1], '', findRegex('pump', {}, true), '').skip, 'blank', 'a text would become empty');
  assert.equal(replaceChanges(m.entities, hits, 'pump', 'X', { matchCase: true }).changes.length, 2, 'match case: the attribute and the text, not the MTEXT');
  assert.equal(replaceIn(m.entities[1], '', findRegex('pump', {}, true), '$&$&').after.text, '$&$&', 'the replacement is literal');
});

// ------------------------------------------------------------------ key-ins
test('key-ins: XY= DL= DI= AA=, plain numbers, @ forms, errors', () => {
  assert.deepEqual(parseKeyin('XY=10,20'), { kind: 'xy', v: [10, 20] });
  assert.deepEqual(parseKeyin(' xy = -1.5 , 2e3 '), { kind: 'xy', v: [-1.5, 2000] });
  assert.deepEqual(parseKeyin('dl=5'), { kind: 'dl', v: [5, 0] }, 'a missing value is 0');
  assert.deepEqual(parseKeyin('DL=3 4'), { kind: 'dl', v: [3, 4] }, 'spaces separate too');
  assert.deepEqual(parseKeyin('DI=10,90'), { kind: 'di', v: [10, 90] });
  assert.deepEqual(parseKeyin('AA=45°'), { kind: 'aa', v: [45] });
  assert.deepEqual(parseKeyin('XY=1,2,3'), { kind: 'xy', v: [1, 2] }, 'Z is ignored (plan)');
  assert.deepEqual(parseKeyin('1500'), { kind: 'len', v: [1500] });
  assert.deepEqual(parseKeyin('.5'), { kind: 'len', v: [0.5] });
  assert.deepEqual(parseKeyin('@3,4'), { kind: 'dl', v: [3, 4] });
  assert.deepEqual(parseKeyin('@10<30'), { kind: 'di', v: [10, 30] });
  for (const bad of ['', 'XY=', 'XY=a,b', 'AA=1,2', 'ZZ=1', 'hello', 'DL=1,,']) assert.ok(parseKeyin(bad).error, 'error for ' + JSON.stringify(bad));
  assert.deepEqual(keyinPoint(parseKeyin('XY=10,20'), null), [10, 20]);
  assert.deepEqual(keyinPoint(parseKeyin('DL=5,-5'), [10, 20]), [15, 15]);
  const p = keyinPoint(parseKeyin('DI=10,90'), [1, 1]);
  assert.ok(near(p[0], 1) && near(p[1], 11), 'DI: angle counter-clockwise from +X');
  const q = keyinPoint(parseKeyin('DI=2,-45'), [0, 0]);
  assert.ok(near(q[0], Math.SQRT2) && near(q[1], -Math.SQRT2));
  assert.equal(keyinPoint(parseKeyin('DL=1,1'), null), null, 'relative without a last point');
  assert.equal(keyinPoint(parseKeyin('AA=10'), [0, 0]), null);
});

// ------------------------------------------------------------------ transforms
test('mirror, scale, array: geometry; text stays readable (moved, not reversed); originals untouched', () => {
  const L = { layer: '0', color: 256 };
  const line = { ...L, type: 'line', a: [1, 0], b: [3, 2] };
  const ml = mirrorEntity(line, 'h', 0, 0);
  assert.deepEqual(ml.a, [-1, 0]); assert.deepEqual(ml.b, [-3, 2]);
  const mv = mirrorEntity(line, 'v', 0, 1);
  assert.deepEqual(mv.a, [1, 2]); assert.deepEqual(mv.b, [3, 0]);
  const text = { ...L, type: 'text', p: [10, 0], h: 2, rot: 0.3, text: 'K1', halign: 0, valign: 0, wf: 1 };
  const mt = mirrorEntity(text, 'h', 0, 0, { centre: [12, 1] });
  assert.ok(near(mt.p[0], -14) && near(mt.p[1], 0), 'its box centre lands on the mirrored centre: ' + mt.p);
  assert.ok(near(mt.rot, 0.3, 1e-12), 'angle kept'); assert.ok(!mt.mirrorY, 'not reversed');
  assert.ok(mirrorEntity(text, 'h', 0, 0, { readable: false }).mirrorY, 'a true mirror when asked');
  const arc = { ...L, type: 'arc', c: [5, 0], r: 1, a0: 0, a1: Math.PI / 2 };
  const ma = mirrorEntity(arc, 'h', 0, 0);
  assert.ok(near(ma.c[0], -5) && near(Math.cos(ma.a0), 0) && near(Math.cos(ma.a1), -1), 'a mirrored arc still runs counter-clockwise');
  const sc = scaleEntity({ ...L, type: 'circle', c: [2, 2], r: 1 }, 3, 1, 1);
  assert.deepEqual(sc.c, [4, 4]); assert.equal(sc.r, 3);
  const st = scaleEntity(text, 0.5, 0, 0);
  assert.equal(st.h, 1); assert.deepEqual(st.p, [5, 0]);
  const arr = arrayCopies([line, text], 3, 10, 5);
  assert.equal(arr.length, 6);
  assert.deepEqual(arr[4].a, [31, 15], 'copy 3 of the line');
  assert.deepEqual(arr[5].p, [40, 15]);
  assert.deepEqual(line.a, [1, 0], 'inputs never mutated');
  assert.deepEqual(mirrorMatrix('h', 2, 0), [-1, 0, 0, 1, 4, 0]);
  // text inside a mirrored cell and a block's attributes stay readable; the rest is mirrored
  const cell = { ...L, type: 'cell', name: 'C', origin: [0, 0], children: [{ ...L, type: 'line', a: [0, 0], b: [4, 0] }, { ...text, p: [0, 1], rot: 0 }] };
  const mc = mirrorEntity(cell, 'h', 10, 0);
  assert.deepEqual(mc.children[0].b, [16, 0], 'the line is mirrored');
  assert.ok(!mc.children[1].mirrorY && near(mc.children[1].rot, 0), 'the text is not reversed');
  assert.ok(near(mc.children[1].p[0], 20 - 0.62 * 2 * 2), 'its box is mirrored: ' + mc.children[1].p);
  assert.ok(mc.mv[0] < 0, 'the cell header gets the mirror');
  const ins = mirrorEntity({ ...L, type: 'insert', block: 'B', p: [0, 0], sx: 1, sy: 1, rot: 0, attribs: [{ ...text, p: [1, 0], rot: 0 }] }, 'v', 0, 5);
  assert.ok(ins.sy < 0 && !ins.attribs[0].mirrorY && near(ins.attribs[0].p[1], 10 - 0.8 - 0.8), 'attribute readable: ' + ins.attribs[0].p);
});

test('DGN: scale / rotate / move a cell and a text keep their bytes (in-place transforms); a mirrored line is written from the model with a note; arrays copy original bytes', () => {
  const t = open();
  const tb = idx(t, (e) => e.type === 'cell' && e.name === 'TBLOCK');
  const lbl = textIdx(t, 'K1');
  const wire = idx(t, (e) => e.type === 'line' && e.layer === 'Level 5');
  const before = t.model.entities.slice();
  t.doc.commit('Scale', [{ i: tb, before: before[tb], after: scaleEntity(before[tb], 0.5, 140, 2) }]);
  t.doc.commit('Rotate', [{ i: lbl, before: before[lbl], after: rotateEntity(before[lbl], Math.PI / 6, 150, 95) }]);
  let w = save(t);
  assert.deepEqual(w.notes.filter((n) => /mirror|rewritten|rebuilt/.test(n)), [], 'in place: ' + w.notes.join(' | '));
  originalsKept(t, w.bytes, [before[tb].dgn, before[lbl].dgn]);
  let back = parseDgn(w.bytes);
  const cell = back.entities.find((e) => e.type === 'cell' && e.name === 'TBLOCK');
  assert.ok(near(cell.xscale, 0.5, 1e-4), 'cell scaled: ' + cell.xscale);
  assert.ok(near(back.entities.find((e) => e.text === 'K1').rot, Math.PI / 6, 1e-6), 'text rotated');
  assert.equal(back.entities.find((e) => e.text === 'REV B' || (e.children || []).some((k) => k.text === 'REV B')) ? 1 : 0, 1);
  // mirror a line: written from what Linework shows, with a note
  t.doc.commit('Mirror', [{ i: wire, before: before[wire], after: mirrorEntity(before[wire], 'v', 0, 100) }]);
  w = save(t);
  assert.ok(w.notes.some((n) => /mirrored/.test(n)), 'the save notes say so: ' + w.notes.join(' | '));
  back = parseDgn(w.bytes);
  assert.ok(back.entities.some((e) => e.type === 'line' && near(e.a[1], 105) && near(e.b[1], 105)), 'the mirrored wire is at y = 105');
  // array: 3 copies of a wire label, one change list; the copies are its original bytes, moved
  const t2 = open();
  const w101 = textIdx(t2, 'W101');
  const r = duplicate(t2.model, [w101], [0, 0, 0, 0], 'Level 10');
  const ents = arrayCopies(r.ents, 3, 0, -2);
  const i0 = t2.doc.nextIndex();
  t2.doc.commit('Array', ents.map((e, k) => ({ i: i0 + k, before: null, after: e })));
  const w2 = save(t2);
  originalsKept(t2, w2.bytes, []);
  const back2 = parseDgn(w2.bytes);
  const ys = back2.entities.filter((e) => e.text === 'W101').map((e) => +e.p[1].toFixed(6)).sort((a, b) => a - b);
  assert.deepEqual(ys, [90, 92, 94, 96], 'the original and three copies');
  const src = t2.b.subarray(...t2.model.entities[w101].dgn);
  const copy = back2.entities.filter((e) => e.text === 'W101').find((e) => near(e.p[1], 90));
  const cb = w2.bytes.subarray(...copy.dgn);
  const diff = []; for (let k = 0; k < src.length; k++) if (cb[k] !== src[k]) diff.push(k);
  assert.ok(diff.every((k) => (k >= 4 && k < 28) || (k >= 54 && k < 58)), 'only the range and the origin Y differ: ' + diff);
});

test('GDAL/OGR reads a DGN after replace all, scale and mirror', { skip: ogrSkip }, () => {
  const t = open();
  const r = replaceChanges(t.model.entities, findTexts(t.scene, 'GND'), 'GND', '0V', {});
  t.doc.commit('Replace', r.changes);
  const tb = idx(t, (e) => e.type === 'cell' && e.name === 'TBLOCK');
  t.doc.commit('Scale', [{ i: tb, before: t.model.entities[tb], after: scaleEntity(t.model.entities[tb], 2, 140, 2) }]);
  const w = save(t);
  writeFileSync(join(TMP, 'wiring-edited.dgn'), w.bytes);
  const f = ogrDump([join(TMP, 'wiring-edited.dgn')])[join(TMP, 'wiring-edited.dgn')];
  assert.ok(f && !f.error, 'OGR opened it');
  const texts = f.features.filter((x) => x.Text).map((x) => x.Text);
  assert.ok(texts.includes('0V') && texts.includes('0V BUS') && !texts.includes('GND'), texts.join(','));
  const title = f.features.find((x) => x.Text === 'CONTROL PANEL WIRING');
  const size = title && Number((/s:([\d.]+)g/.exec(title.style) || [])[1]);
  assert.ok(near(size, 5, 0.01), 'title text twice as high: ' + (title && title.style));
});

// ------------------------------------------------------------------ attributes
test('select same level / colour / weight / type; dropdown values; match attributes (DGN and DXF)', () => {
  const t = open();
  const E = t.model.entities, f = 'DGN';
  const all = E.map((_, i) => i);
  const wire = idx(t, (e) => e.type === 'line' && e.ci === 1);
  const green = idx(t, (e) => e.type === 'line' && e.ci === 2);
  assert.equal(selectByKeys(E, all, keysOf(E, [green], ['layer'], f), f).size, 5, 'level 5: five wires');
  assert.equal(selectByKeys(E, all, keysOf(E, [green], ['layer', 'color', 'weight'], f), f).size, 4, 'green, weight 2');
  assert.equal(selectByKeys(E, all, { type: new Set(['TEXT']) }, f).size, 9, 'top-level texts');
  assert.equal(selectByKeys(E, all, { type: new Set(['CELL']) }, f).size, 5);
  assert.equal(selectByKeys(E, all, {}, f).size, 0, 'no attribute: nothing');
  assert.equal(selectByKeys(E, all.filter((i) => E[i].layer !== 'Level 5'), keysOf(E, [green], ['layer'], f), f).size, 0, 'only candidates (visible items)');
  const vals = valuesOf(E, all, 'layer', f);
  assert.equal(vals.get('Level 10').n, 7);
  assert.equal(attrKey(E[idx(t, (e) => e.name === 'TERM')], 'color', f), 'ci1', 'a cell: its own colour');
  // match: the blue weight-1 wire takes the green wire's symbology
  const m = matchStyle(E[wire], E[green], f);
  assert.equal(m.ci, 2); assert.equal(m.weight, 2); assert.equal(m.rgb, E[green].rgb); assert.equal(m.layer, 'Level 5');
  const cell = matchStyle(E[idx(t, (e) => e.name === 'MARKER')], E[idx(t, (e) => e.text === 'K1')], f);
  assert.ok(cell.children.every((k) => k.layer === 'Level 30' && k.ci === 4), 'a cell: its components too');
  t.doc.commit('Match', [{ i: wire, before: E[wire], after: m }]);
  const w = save(t);
  assert.ok(!w.notes.some((n) => /rewritten|rebuilt/.test(n)), 'symbology patched in place');
  const back = parseDgn(w.bytes);
  assert.equal(back.entities.filter((e) => e.type === 'line' && e.ci === 2 && e.weight === 2).length, 5);
  // DXF: true colour, lineweight, line type
  const src = { type: 'line', layer: 'POWER', color: 1, rgb: 0x123456, lw: 50, ltype: 'DASHED', a: [0, 0], b: [1, 0] };
  const dst = matchStyle({ type: 'line', layer: '0', color: 256, a: [0, 0], b: [2, 0] }, src, 'DXF');
  assert.deepEqual([dst.layer, dst.color, dst.rgb, dst.lw, dst.ltype], ['POWER', 1, 0x123456, 50, 'DASHED']);
  const bylayer = matchStyle(src, { type: 'line', layer: '0', a: [0, 0], b: [1, 0] }, 'DXF');
  assert.deepEqual([bylayer.color, bylayer.rgb, bylayer.lw, bylayer.ltype], [256, null, undefined, undefined], 'ByLayer source: ByLayer colour, weight, line type');
});

test('element info: DGN element type number, file offset, size, symbology, text font and justification, cell components', () => {
  const t = open();
  const E = t.model.entities;
  const wire = idx(t, (e) => e.type === 'line' && e.ci === 1);
  const rows = (i, extra = {}) => Object.fromEntries(entityInfo(E[i], { format: 'DGN', bytes: t.b, orig: t.doc.orig[i], abbr: 'm', dec: 2, ...extra }).rows.map((r) => [r[0], r[1]]));
  const r = rows(wire);
  assert.equal(r.Type, 'Line (type 3)');
  assert.equal(r.Level, 'Level 5');
  assert.equal(r.Colour, '1');
  assert.equal(r.Weight, '1');
  assert.equal(r.Length, '90.00 m');
  assert.equal(r.Element, 'type 3 · 52 bytes');
  assert.equal(r['File offset'], `${E[wire].dgn[0].toLocaleString('en-US')} (0x${E[wire].dgn[0].toString(16).toUpperCase()})`);
  assert.equal(r['Saved as'], 'in the file, unchanged');
  const lbl = textIdx(t, 'W102');
  const tr = rows(lbl, { layerLabel: (n) => (n === 'Level 10' ? 'Level 10 · Labels' : n) });
  assert.equal(tr.Font, '1'); assert.equal(tr.Justification, 'Left bottom (2)'); assert.equal(tr.Height, '2.00 m');
  assert.equal(tr.Level, 'Level 10 · Labels', 'level names shown');
  const moved = moveEntity(E[lbl], 1, 0);
  assert.equal(Object.fromEntries(entityInfo(moved, { format: 'DGN', bytes: t.b, orig: E[lbl] }).rows)['Saved as'], 'rebuilt from those bytes (edited)');
  assert.equal(Object.fromEntries(entityInfo({ type: 'line', layer: 'Level 1', a: [0, 0], b: [1, 0], src: 'LINE' }, { format: 'DGN', bytes: t.b }).rows)['Saved as'], 'a new element, added at the end');
  const tb = idx(t, (e) => e.name === 'TBLOCK');
  const info = entityInfo(E[tb], { format: 'DGN', bytes: t.b, orig: E[tb] });
  assert.equal(Object.fromEntries(info.rows).Cell, 'TBLOCK');
  assert.equal(info.parts.length, 4);
  assert.ok(info.parts.some((p) => /Text \(type 17\) “REV B”/.test(p.text)), info.parts.map((p) => p.text).join(' / '));
  assert.equal(typeName({ type: 'polyline', closed: true, src: 'LWPOLYLINE' }, 'DXF'), 'Closed polyline (LWPOLYLINE)');
  const c = Object.fromEntries(entityInfo({ type: 'circle', layer: 'A', color: 1, c: [0, 0], r: 2 }, { format: 'DXF', abbr: 'mm', dec: 1 }).rows.map((x) => [x[0], x.slice(1)]));
  assert.deepEqual(c.Colour, ['1', 0xff0000]);
  assert.equal(c.Radius[0], '2.0 mm');
});

// ------------------------------------------------------------------ level names
test('level names: CSV / TXT import (separators, quotes, header, comments, bad lines) and CSV export', () => {
  const txt = '﻿level,name\r\n5,Wires\n6;Ground bus\n10\tLabels\n12 Terminal blocks\n"20","Notes, general"\n# a comment\n\n70,Too high\n0,Zero\nabc\n30,\n4,  Title block  ,\n';
  const r = parseLevelNames(txt);
  assert.deepEqual([...r.names], [[5, 'Wires'], [6, 'Ground bus'], [10, 'Labels'], [12, 'Terminal blocks'], [20, 'Notes, general'], [4, 'Title block']]);
  assert.deepEqual(r.skipped, [9, 10, 11, 12], 'out of range, level 0, not a line, no name');
  const csv = levelNamesCsv(r.names);
  assert.equal(csv.split('\r\n')[0], 'level,name');
  assert.ok(csv.includes('20,"Notes, general"'));
  assert.deepEqual([...parseLevelNames(csv).names].sort((a, b) => a[0] - b[0]), [...r.names].sort((a, b) => a[0] - b[0]), 'export -> import round trip');
  assert.equal(parseLevelNames('').names.size, 0);
  assert.equal(parseLevelNames('7,' + 'x'.repeat(100)).names.get(7).length, 64, 'names are kept short');
});

// ------------------------------------------------------------------ hits follow edits
test('find after edits: retyped and moved texts are found where they are now; deleted ones are gone', () => {
  const t = open();
  const i = textIdx(t, 'W102');
  t.doc.commit('Move', [{ i, before: t.model.entities[i], after: moveEntity(t.model.entities[i], 0, 30) }]);
  const h = findTexts(t.scene, 'W102')[0];
  const b = entityBBox(t.scene, i);
  assert.deepEqual(h.bbox, t.scene.texts[h.t].bbox);
  assert.ok(near(h.bbox[1], b[1]), 'the moved text');
  t.doc.commit('Delete', [{ i, before: t.model.entities[i], after: null }]);
  assert.equal(findTexts(t.scene, 'W102').length, 0);
});
