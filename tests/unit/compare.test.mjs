// Revision compare (src/tools/compare.js): DGN items match by element bytes wherever they sit in
// the file, everything else by geometry + attributes; left-overs are paired as moved / changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes, load } from './helpers.mjs';
import { parseDgn } from '../../src/formats/dgn.js';
import { parseDrawing } from '../../src/formats/detect.js';
import { buildScene } from '../../src/scene.js';
import { EditDoc } from '../../src/edit/doc.js';
import { moveEntity, setText, restyle } from '../../src/edit/ops.js';
import { writeDgn } from '../../src/formats/dgn-write.js';
import { writeDxf } from '../../src/formats/dxf-write.js';
import { hashBytes } from '../../src/worker.js';
import { describeScene, diffScenes, quantum, hashStr } from '../../src/tools/compare.js';

const bytesKey = (model, b, orig) => (i) => { const e = model.entities[i]; return e && e.dgn && (!orig || e === orig[i]) ? hashBytes(b.subarray(e.dgn[0], e.dgn[1])) : null; };
function dgn(b) { const model = parseDgn(b); return { b, model, scene: buildScene(model) }; }
function cmp(a, b, opts = {}) {
  const q = quantum(a.scene, b.scene);
  const A = describeScene(a.scene, { q, bytesKey: opts.bytes ? bytesKey(a.model, a.b, a.orig) : null });
  const B = describeScene(b.scene, { q, bytesKey: opts.bytes ? bytesKey(b.model, b.b, null) : null });
  return { A, B, r: diffScenes(A, B) };
}
const kinds = (r) => r.changes.map((c) => c.kind).sort();

test('the same drawing: everything unchanged, for every fixture', () => {
  for (const name of ['house-plan.dxf', 'bracket.dxf', 'schematic.dxf', 'site-plan.dgn', 'dgn-fidelity.dgn', 'dgn-3d.dgn', 'edge-far-coords.dxf', 'edge-nested-mirror.dxf']) {
    const a = load(name), b = load(name);
    const { A, r } = cmp(a, b);
    assert.ok(A.length > 0, name);
    assert.equal(r.same, A.length, name);
    assert.deepEqual([r.onlyA.length, r.onlyB.length, r.changes.length], [0, 0, 0], name);
  }
  assert.equal(hashStr('abc'), hashStr('abc'));
  assert.notEqual(hashStr('abc'), hashStr('abd'));
});

test('DGN revision: moved, retyped, recoloured, deleted and new items; untouched elements match by their bytes although edited ones moved to the end of the file', () => {
  const b0 = bytes('site-plan.dgn');
  const a = dgn(b0);
  // revision B: written by the round-trip writer after edits
  const t = dgn(b0), doc = new EditDoc(t.model, t.scene, { bytes: b0 });
  const ent = (i) => t.model.entities[i];
  doc.commit('move', [{ i: 9, before: ent(9), after: moveEntity(ent(9), 3, 0) }]);
  doc.commit('text', [{ i: 7, before: ent(7), after: setText(ent(7), 'STORE B') }]);
  doc.commit('colour', [{ i: 13, before: ent(13), after: restyle(ent(13), { color: 3 }, 'DGN') }]);
  doc.commit('delete', [{ i: 10, before: ent(10), after: null }]);
  doc.commit('new', [{ i: doc.nextIndex(), before: null, after: { type: 'line', layer: 'Level 5', color: 256, rgb: 0xff0000, ci: 3, weight: 0, a: [200, 200], b: [205, 207] } }]); // away from everything
  const w = writeDgn(t.model, { bytes: b0, orig: doc.orig });
  const b = dgn(w.bytes);
  const { A, r } = cmp(a, b, { bytes: true });
  assert.equal(A.length, 22);
  assert.equal(r.same, 22 - 4, 'everything else unchanged');
  assert.equal(r.sameBytes, 22 - 4, '... by its bytes');
  assert.deepEqual(kinds(r), ['added', 'changed', 'changed', 'moved', 'removed'].sort());
  const moved = r.changes.find((c) => c.kind === 'moved');
  assert.equal(moved.type, 'LINE');
  const text = r.changes.find((c) => c.kind === 'changed' && c.text2);
  assert.deepEqual([text.text, text.text2], ['STORE', 'STORE B']);
  assert.equal(r.onlyA.length, 4);
  assert.equal(r.onlyB.length, 4);
  // order: top to bottom, then left to right
  for (let k = 1; k < r.changes.length; k++) {
    const c = (x) => (x.bbox[1] + x.bbox[3]) / 2;
    assert.ok(c(r.changes[k - 1]) >= c(r.changes[k]) - 1e-9);
  }
});

test('DGN: an element moved within the file but byte-identical (deleted in place, copy appended) is unchanged', () => {
  const b0 = bytes('site-plan.dgn');
  const a = dgn(b0);
  const e = a.model.entities[5], eod = a.model.header.eod;
  const out = new Uint8Array(b0.length + (e.dgn[1] - e.dgn[0]));
  out.set(b0.subarray(0, eod));
  out[e.dgn[0] + 1] |= 0x80; // deleted where it was
  out.set(b0.subarray(e.dgn[0], e.dgn[1]), eod); // the same bytes at the end
  out.set(b0.subarray(eod), eod + (e.dgn[1] - e.dgn[0]));
  const b = dgn(out);
  assert.notDeepEqual(b.model.entities[b.model.entities.length - 1].dgn, e.dgn, 'it sits elsewhere in the file');
  const { r } = cmp(a, b, { bytes: true });
  assert.deepEqual([r.same, r.sameBytes, r.changes.length], [22, 22, 0]);
});

test('DXF revisions: geometry + attributes decide; a layer change, a move, a new item; the live scene of an edited drawing compares too', () => {
  const a = load('house-plan.dxf');
  const t = load('house-plan.dxf'), doc = new EditDoc(t.model, t.scene);
  const ent = (i) => t.model.entities[i];
  const line = t.model.entities.findIndex((e) => e.type === 'line');
  const poly = t.model.entities.findIndex((e) => e.type === 'polyline' && e.layer === 'WALLS');
  doc.commit('move', [{ i: line, before: ent(line), after: moveEntity(ent(line), 1000, 0) }]);
  doc.commit('layer', [{ i: poly, before: ent(poly), after: { ...ent(poly), layer: 'FURNITURE' } }]);
  doc.commit('new', [{ i: doc.nextIndex(), before: null, after: { type: 'circle', layer: '0', color: 1, c: [0, 0], r: 100 } }]);
  const written = parseDrawing(new TextEncoder().encode(writeDxf(t.model, {}).text), 'rev.dxf');
  const b = { model: written, scene: buildScene(written) };
  const { A, r } = cmp(a, b);
  assert.equal(r.same, A.length - 2);
  assert.deepEqual(kinds(r), ['added', 'added', 'moved', 'removed'], 'on another layer it is another item (removed + added)');
  // the edited drawing itself (live scene) against the original
  const live = cmp(t, a);
  assert.equal(live.r.same, A.length - 2);
  assert.equal(live.r.onlyA.length, 3);
  assert.equal(live.r.onlyB.length, 2);
});
