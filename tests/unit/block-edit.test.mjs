// Editing inside blocks: the block editor's model (the block on its own, tables copied), the changes it gives the
// drawing (the definition, the layers and blocks it added; never a block that contains itself), every insert drawn
// again when a definition changes (nested too), undo, and saving: DXF (the definition) and DGN (a cell's parts, the
// rest of the file byte for byte). On the synthetic house plan (seven DOOR inserts) and dgn-fidelity.dgn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes, load, liveItems, compareItems } from './helpers.mjs';
import { parseDrawing } from '../../src/formats/detect.js';
import { parseDgn } from '../../src/formats/dgn.js';
import { buildScene } from '../../src/scene.js';
import { EditDoc, usersOf } from '../../src/edit/doc.js';
import { entityItems } from '../../src/edit/live-scene.js';
import { moveEntity } from '../../src/edit/ops.js';
import { writeDxf } from '../../src/formats/dxf-write.js';
import { writeDgn } from '../../src/formats/dgn-write.js';
import { blockModel, blockChanges, drawsBlock } from '../../src/app/block-edit.js';

const tolOf = (x) => 1e-9 * Math.max(1, ...x.bbox.map(Math.abs));
const sameAsRebuild = (doc) => assert.deepEqual(compareItems(liveItems(doc.scene), liveItems(buildScene(doc.model)), tolOf), [], 'the live scene is what a full rebuild draws');
function openPlan() {
  const { model, scene } = load('house-plan.dxf');
  return { model, scene, doc: new EditDoc(model, scene) };
}
const doors = (m) => m.entities.map((e, i) => (e && e.type === 'insert' && e.block.toUpperCase() === 'DOOR' ? i : -1)).filter((i) => i >= 0);
const livePrims = (s, i) => entityItems(s, i).prims.filter((p) => !s.dead[p]).length;
const KNOB = { type: 'circle', layer: '0', color: 256, ltype: 'BYLAYER', c: [100, 50], r: 30 };
/** As the block editor does: the block on its own, edited (fn: entities -> entities), then the drawing's changes. */
function editBlock(t, i, fn) {
  const e = t.model.entities[i], K = e.block.toUpperCase(), before = t.model.blocks[K];
  const sub = blockModel(t.model, before.entities);
  const s = buildScene(sub), d = new EditDoc(sub, s);
  const next = fn(sub.entities.slice(), sub);
  d.commit('edit', [...next.map((x, k) => ({ i: k, before: sub.entities[k] || null, after: x })), ...sub.entities.slice(next.length).map((x, k) => ({ i: next.length + k, before: x, after: null }))]);
  return { sub, changes: blockChanges(t.model, { i, K, cell: false, before }, sub) };
}

test('usersOf: the top-level items that draw a block, directly or inside other blocks', () => {
  const m = {
    blocks: { A: { entities: [{ type: 'line' }] }, B: { entities: [{ type: 'insert', block: 'a' }] }, C: { entities: [{ type: 'insert', block: 'B' }] }, D: { entities: [] } },
    entities: [{ type: 'insert', block: 'A' }, { type: 'insert', block: 'c' }, { type: 'insert', block: 'D' }, null, { type: 'line' }, { type: 'dimension', block: 'B' }],
  };
  assert.deepEqual(usersOf(m, new Set(['A'])), [0, 1, 5]);
  assert.deepEqual(usersOf(m, new Set(['D'])), [2]);
  assert.deepEqual(usersOf(m, new Set(['X'])), []);
});

test('block editor model: the block\'s items on their own; layers, blocks and line types are copies (the drawing is untouched until Done)', () => {
  const t = openPlan(), K = 'DOOR', blk = t.model.blocks[K];
  const sub = blockModel(t.model, blk.entities);
  assert.equal(sub.entities.length, blk.entities.length);
  assert.notEqual(sub.entities, blk.entities);
  assert.deepEqual(sub.paperEntities, []);
  sub.blocks.NEW = { name: 'NEW', base: [0, 0], entities: [] };
  sub.layers.push({ name: 'EXTRA' });
  sub.layers[0].color = 1;
  assert.ok(!t.model.blocks.NEW && !t.model.layers.some((l) => l.name === 'EXTRA') && t.model.layers[0].color !== 1, 'nothing reaches the drawing');
  const s = buildScene(sub);
  assert.ok(s.n > 0 && s.extents[2] - s.extents[0] < 2000, 'the door alone, in its own coordinates');
});

test('editing a block: one change of its definition; all seven inserts drawn again; undo and redo; the live scene matches a rebuild', () => {
  const t = openPlan(), ids = doors(t.model);
  assert.equal(ids.length, 7);
  const n0 = ids.map((i) => livePrims(t.scene, i));
  const { changes } = editBlock(t, ids[0], (ents) => [...ents, KNOB]);
  assert.equal(changes.length, 1, 'only the definition (no new layers or blocks)');
  assert.equal(changes[0].table, 'blocks');
  const before = t.model.blocks.DOOR;
  const entry = t.doc.commit('Edit block DOOR', changes);
  assert.deepEqual(ids.map((i) => livePrims(t.scene, i)), n0.map((n) => n + 1), 'every door has the knob');
  assert.equal(t.model.blocks.DOOR.entities.length, before.entities.length + 1);
  assert.ok(ids.every((i) => entry.result.touched.includes(i)), 'the inserts were drawn again');
  sameAsRebuild(t.doc);
  t.doc.revert(entry);
  assert.equal(t.model.blocks.DOOR, before, 'undo: the definition as it was (the same object)');
  assert.deepEqual(ids.map((i) => livePrims(t.scene, i)), n0);
  sameAsRebuild(t.doc);
  t.doc.reapply(entry);
  assert.deepEqual(ids.map((i) => livePrims(t.scene, i)), n0.map((n) => n + 1));
  sameAsRebuild(t.doc);
});

test('editing a block: a layer and a block the editor added come along; a block that would contain itself is refused', () => {
  const t = openPlan(), i = doors(t.model)[0];
  const { changes } = editBlock(t, i, (ents, sub) => {
    sub.layers.push({ name: 'HARDWARE', color: 0xff0000, aci: 1, ltype: 'CONTINUOUS' });
    sub.blocks.KNOB = { name: 'KNOB', base: [0, 0], entities: [{ ...KNOB, c: [0, 0] }] };
    return [...ents, { type: 'insert', layer: 'HARDWARE', color: 256, ltype: 'BYLAYER', block: 'KNOB', p: [100, 50], sx: 1, sy: 1, rot: 0 }];
  });
  assert.deepEqual(changes.map((c) => c.layer || `${c.table}:${c.key}`), ['HARDWARE', 'blocks:KNOB', 'blocks:DOOR']);
  t.doc.commit('Edit block DOOR', changes);
  assert.ok(t.model.blocks.KNOB && t.model.layers.some((l) => l.name === 'HARDWARE'));
  sameAsRebuild(t.doc);
  // the door inside the door (directly, or through another block)
  assert.equal(editBlock(t, i, (ents) => [...ents, { type: 'insert', layer: '0', block: 'door', p: [0, 0] }]).changes, null);
  assert.equal(editBlock(t, i, (ents, sub) => { sub.blocks.WRAP = { name: 'WRAP', base: [0, 0], entities: [{ type: 'insert', block: 'DOOR', p: [0, 0] }] }; return [...ents, { type: 'insert', layer: '0', block: 'WRAP', p: [0, 0] }]; }).changes, null);
  assert.equal(drawsBlock({}, [{ type: 'cell', children: [{ type: 'insert', block: 'X' }] }], 'X'), true, 'inside a cell too');
});

test('editing a block: saved as DXF, the definition has the change and every insert draws it', () => {
  const t = openPlan(), ids = doors(t.model);
  t.doc.commit('Edit block DOOR', editBlock(t, ids[0], (ents) => [...ents.slice(1), KNOB]).changes);
  const back = parseDrawing(new TextEncoder().encode(writeDxf(t.model).text), 'back.dxf');
  const d = back.blocks.DOOR;
  assert.equal(d.entities.length, t.model.blocks.DOOR.entities.length);
  assert.ok(d.entities.some((e) => e.type === 'circle' && Math.abs(e.r - 30) < 1e-9 && Math.abs(e.c[0] - 100) < 1e-9));
  assert.equal(doors(back).length, 7);
  assert.deepEqual(compareItems(liveItems(buildScene(t.model)), liveItems(buildScene(back)), (x) => 1e-6 * Math.max(1, ...x.bbox.map(Math.abs)) + (x.kind === 't' ? 1e-3 : 0)), []);
});

test('editing a DGN cell: its parts change, the rest of the file stays byte for byte, and it reads back the same', () => {
  const b = bytes('dgn-fidelity.dgn'), model = parseDgn(b), scene = buildScene(model), doc = new EditDoc(model, scene, { bytes: b });
  const ci = model.entities.findIndex((e) => e && e.type === 'cell' && e.name === 'TBLOCK'), cell = model.entities[ci];
  const sub = blockModel(model, cell.children), s = buildScene(sub), d = new EditDoc(sub, s);
  const k = sub.entities.findIndex((e) => e && e.type !== 'text' && e.type !== 'cell');
  const extra = { type: 'line', layer: cell.layer, a: [cell.origin[0], cell.origin[1]], b: [cell.origin[0] + 50, cell.origin[1]], ci: 3, rgb: 0, weight: 0, ltype: '' };
  d.commit('edit', [{ i: k, before: sub.entities[k], after: moveEntity(sub.entities[k], 5, 0) }, { i: sub.entities.length, before: null, after: extra }]);
  const changes = blockChanges(model, { i: ci, cell: true, before: cell }, sub);
  assert.equal(changes.length, 1);
  doc.commit('Edit cell TBLOCK', changes);
  assert.equal(model.entities[ci].children.length, cell.children.length + 1);
  sameAsRebuild(doc);
  const w = writeDgn(model, { bytes: b, orig: doc.orig });
  for (let o = 0; o < cell.dgn[0]; o++) assert.equal(w.bytes[o], b[o], `before the cell: byte ${o} untouched`);
  const back = parseDgn(w.bytes), bc = back.entities.find((e) => e && e.type === 'cell' && e.name === 'TBLOCK');
  assert.equal(bc.children.length, cell.children.length + 1, 'the new part is in the cell');
  assert.deepEqual(compareItems(liveItems(buildScene(model)), liveItems(buildScene(back)), (x) => 2e-3 + (x.kind === 't' ? 0 : 1e-6 * Math.max(1, ...x.bbox.map(Math.abs)))), []);
});
