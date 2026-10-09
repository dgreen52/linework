// Edit engine: entity operations, incremental scene updates, undo/redo, selection maths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, bytes, liveItems, compareItems, rng, near } from './helpers.mjs';
import { buildScene, queryRect, TEXT_ID, KIND } from '../../src/scene.js';
import { createModel, ensureLayer, FG } from '../../src/model.js';
import { EditDoc, selectInRect, segTouchesRect } from '../../src/edit/doc.js';
import { entityItems, entityBBox, liveExtents } from '../../src/edit/live-scene.js';
import {
  moveEntity, rotateEntity, transformEntity, bakeOcs, gripsOf, moveGrip, insertVertex, deleteVertex, segmentsOf,
  setText, restyle, canReshape, nearestOnSegment,
} from '../../src/edit/ops.js';
import { bulgeToArc, translate, scale } from '../../src/geom.js';
import { History } from '../../src/markup/history.js';
import { pickItem, findSnap } from '../../src/tools/snap.js';
import { Canvas2DRenderer } from '../../src/view/renderer2d.js';
import { Viewport } from '../../src/view/viewport.js';

const tolOf = (x) => 1e-9 * Math.max(1, ...x.bbox.map(Math.abs));
const sameAsRebuild = (doc) => compareItems(liveItems(doc.scene), liveItems(buildScene(doc.model)), tolOf);

// ------------------------------------------------------------------ operations
test('move and rotate every entity type (new objects, originals untouched)', () => {
  const L = { layer: '0', color: 256 };
  const ents = [
    { ...L, type: 'line', a: [0, 0], b: [1, 0] },
    { ...L, type: 'polyline', pts: [0, 0, 1, 0, 1, 1], bulges: [0.5, 0, 0], closed: true },
    { ...L, type: 'circle', c: [2, 2], r: 1 },
    { ...L, type: 'arc', c: [0, 0], r: 2, a0: 0, a1: Math.PI / 2 },
    { ...L, type: 'ellipse', c: [0, 0], major: [3, 0], minor: [0, 1], t0: 0, t1: Math.PI },
    { ...L, type: 'text', p: [1, 1], h: 2, rot: 0, text: 'A', halign: 0, valign: 0, wf: 1 },
    { ...L, type: 'mtext', p: [1, 1], h: 2, rot: 0, text: 'A\nB', attach: 1, width: 10 },
    { ...L, type: 'insert', block: 'B', p: [5, 5], sx: 1, sy: 1, rot: 0, attribs: [{ ...L, type: 'text', p: [5, 6], h: 1, rot: 0, text: 'T' }] },
    { ...L, type: 'point', p: [3, 4] },
    { ...L, type: 'solid', pts: [0, 0, 1, 0, 0, 1, 1, 1] },
    { ...L, type: 'hatch', loops: [{ pts: [0, 0, 1, 0, 1, 1], bulges: [0, 0.3, 0] }], solid: true },
    { ...L, type: 'cell', name: 'C', origin: [1, 1], children: [{ ...L, type: 'line', a: [0, 0], b: [2, 2] }] },
    { ...L, type: 'dimension', block: '*D1', p: [0, 0] },
  ];
  const frozen = JSON.stringify(ents);
  const moved = ents.map((e) => moveEntity(e, 10, -5));
  assert.equal(JSON.stringify(ents), frozen, 'inputs never mutated');
  assert.deepEqual(moved[0].a, [10, -5]);
  assert.deepEqual(moved[1].pts, [10, -5, 11, -5, 11, -4]);
  assert.deepEqual(moved[2].c, [12, -3]);
  assert.deepEqual(moved[5].p, [11, -4]);
  assert.deepEqual(moved[7].p, [15, 0]);
  assert.deepEqual(moved[7].attribs[0].p, [15, 1], 'attributes move with their insert');
  assert.deepEqual(moved[11].children[0].b, [12, -3], 'cell components move');
  assert.deepEqual(moved[11].origin, [11, -4], 'cell origin moves');
  assert.deepEqual(moved[12].mv, [1, 0, 0, 1, 10, -5], 'dimension keeps a pending transform');
  const rot = ents.map((e) => rotateEntity(e, Math.PI / 2, 0, 0));
  assert.ok(near(rot[0].b[0], 0) && near(rot[0].b[1], 1));
  assert.ok(near(rot[3].a0, Math.PI / 2) && near(rot[3].a1, Math.PI));
  assert.ok(near(rot[4].major[0], 0) && near(rot[4].major[1], 3));
  assert.ok(near(rot[5].rot, Math.PI / 2));
  assert.ok(near(rot[7].rot, Math.PI / 2));
  assert.ok(near(rot[11].mv[1], 1), 'cell transform rotated');
  // reflection: arc direction stays counter-clockwise, bulges flip
  const mir = transformEntity(ents[3], scale(-1, 1));
  assert.ok(near(Math.cos(mir.a0), 0) && near(Math.sin(mir.a0), 1) && near(Math.cos(mir.a1), -1), 'mirrored arc runs from 90 to 180 degrees');
  assert.deepEqual(transformEntity(ents[1], scale(-1, 1)).bulges, [-0.5, -0, -0]);
});

test('OCS entities are baked into plan coordinates before editing', () => {
  const { model } = load('edge-nested-mirror.dxf');
  const all = [];
  const walk = (l) => { for (const e of l) { if (e.xf) all.push(e); if (e.children) walk(e.children); } };
  walk(model.entities); for (const b of Object.values(model.blocks)) walk(b.entities);
  assert.ok(all.length > 0, 'fixture has OCS (mirrored) entities');
  for (const e of all) {
    const s1 = buildScene({ ...model, entities: [e], blocks: model.blocks });
    const b = bakeOcs(e);
    assert.ok(!b.xf && !b.ext, 'plain plan geometry');
    const s2 = buildScene({ ...model, entities: [b], blocks: model.blocks });
    assert.deepEqual(compareItems(liveItems(s1), liveItems(s2), 1e-9), [], `${e.type} looks identical after baking`);
  }
});

test('grips: drag a vertex, centre, radius and ellipse axis', () => {
  const pl = { type: 'polyline', layer: '0', pts: [0, 0, 10, 0, 10, 10], bulges: null, closed: false };
  const g = gripsOf(pl);
  assert.equal(g.length, 3);
  assert.deepEqual(moveGrip(pl, g[1], 12, 1).pts, [0, 0, 12, 1, 10, 10]);
  const c = { type: 'circle', layer: '0', c: [0, 0], r: 2 };
  const [gc, gr] = gripsOf(c);
  assert.deepEqual(moveGrip(c, gc, 5, 5).c, [5, 5]);
  assert.equal(moveGrip(c, gr, 0, 7).r, 7);
  const arc = { type: 'arc', layer: '0', c: [0, 0], r: 2, a0: 0, a1: Math.PI };
  const [, ar] = gripsOf(arc);
  assert.ok(near(ar.x, 0) && near(ar.y, 2), 'radius handle at the middle of the arc');
  const el = { type: 'ellipse', layer: '0', c: [0, 0], major: [4, 0], minor: [0, 2], t0: 0, t1: 2 * Math.PI };
  const m = moveGrip(el, gripsOf(el)[1], 0, 8);
  assert.ok(near(m.major[0], 0) && near(m.major[1], 8) && near(Math.hypot(...m.minor), 4), 'axis rotates and scales, ratio kept');
  assert.equal(canReshape({ type: 'insert' }), false);
  assert.equal(canReshape({ type: 'spline', pts: [] }), false);
});

test('add and delete vertices (straight and bulged segments, lines become polylines)', () => {
  const line = { type: 'line', layer: 'A', a: [0, 0], b: [10, 0] };
  const p = insertVertex(line, 0, 4, 3);
  assert.equal(p.type, 'polyline');
  assert.deepEqual(p.pts, [0, 0, 4, 0, 10, 0], 'new vertex is snapped onto the segment');
  assert.equal(deleteVertex(line, 0), null, 'a line cannot lose a vertex');
  // bulged: the two new arcs together are the original arc
  const pl = { type: 'polyline', layer: 'A', pts: [0, 0, 2, 0], bulges: [1, 0], closed: false }; // half circle
  const arc = bulgeToArc(0, 0, 2, 0, 1);
  const mid = [arc.cx + arc.r * Math.cos(arc.a0 + arc.sweep / 3), arc.cy + arc.r * Math.sin(arc.a0 + arc.sweep / 3)];
  const q = insertVertex(pl, 0, mid[0] + 0.01, mid[1] + 0.01);
  assert.equal(q.pts.length, 6);
  const a1 = bulgeToArc(q.pts[0], q.pts[1], q.pts[2], q.pts[3], q.bulges[0]), a2 = bulgeToArc(q.pts[2], q.pts[3], q.pts[4], q.pts[5], q.bulges[1]);
  assert.ok(near(a1.r, arc.r, 1e-9) && near(a2.r, arc.r, 1e-9) && near(a1.cx, arc.cx, 1e-9) && near(a2.cy, arc.cy, 1e-9), 'same circle');
  assert.ok(near(a1.sweep + a2.sweep, arc.sweep, 1e-9), 'same total sweep');
  const sq = { type: 'polyline', layer: 'A', pts: [0, 0, 1, 0, 1, 1, 0, 1], bulges: null, closed: true };
  assert.deepEqual(deleteVertex(sq, 2).pts, [0, 0, 1, 0, 0, 1]);
  assert.equal(deleteVertex(deleteVertex(sq, 0), 0), null, 'a closed shape keeps at least 3 vertices');
  assert.equal(segmentsOf(sq).length, 4);
  assert.ok(near(nearestOnSegment(segmentsOf(sq)[1], 3, 0.5).d, 2));
});

test('text edit and layer / colour changes (DXF and DGN colour models)', () => {
  const t = { type: 'text', layer: '0', p: [0, 0], h: 1, text: 'old', raw: 'old', rot: 0 };
  const t2 = setText(t, 'new\nline');
  assert.equal(t2.text, 'new line', 'TEXT is single-line');
  assert.equal(t2.raw, undefined, 'stored form dropped');
  assert.equal(setText({ ...t, type: 'mtext' }, 'a\r\nb').text, 'a\nb');
  assert.deepEqual([restyle(t, { color: { aci: 3 } }).color, restyle(t, { color: 'bylayer' }).color], [3, 256]);
  assert.equal(restyle(t, { layer: 'B' }).layer, 'B');
  const d = restyle({ ...t, rgb: 0xffffff, ci: 0 }, { color: { ci: 5, rgb: 0x123456 } }, 'DGN');
  assert.deepEqual([d.rgb, d.ci], [0x123456, 5]);
  const cell = { type: 'cell', layer: 'Level 1', children: [{ type: 'line', layer: 'Level 1', a: [0, 0], b: [1, 1] }] };
  assert.equal(restyle(cell, { layer: 'Level 4' }, 'DGN').children[0].layer, 'Level 4', 'cell components follow');
});

// ------------------------------------------------------------------ incremental scene + undo
test('editing one entity updates the scene in place (old items gone, new ones found) and undo restores it', () => {
  const { model, scene } = load('house-plan.dxf');
  const doc = new EditDoc(model, scene);
  const n0 = scene.n;
  const i = model.entities.findIndex((e) => e.type === 'line');
  const before = model.entities[i];
  const items0 = entityItems(scene, i);
  const entry = doc.commit('Move', [{ i, before, after: moveEntity(before, 50000, 0) }]);
  assert.ok(doc.dirty);
  assert.ok(items0.prims.every((p) => scene.dead[p]), 'old primitives retired');
  assert.equal(scene.n, n0 + 1, 'one primitive appended, nothing rebuilt');
  const [ox, oy] = scene.origin;
  const hit = []; queryRect(scene, before.a[0] + 50000 - ox - 1, before.a[1] - oy - 1, before.a[0] + 50000 - ox + 1, before.a[1] - oy + 1, (id) => { hit.push(id); });
  assert.ok(hit.some((id) => id < TEXT_ID && scene.ent[id] === i), 'spatial index finds the moved line');
  const old = []; queryRect(scene, before.a[0] - ox - 1, before.a[1] - oy - 1, before.a[0] - ox + 1, before.a[1] - oy + 1, (id) => { old.push(id); });
  assert.ok(!old.some((id) => id < TEXT_ID && scene.ent[id] === i), 'nothing left at the old place');
  assert.deepEqual(entry.result.killed, items0.prims);
  assert.deepEqual(sameAsRebuild(doc), []);
  doc.revert(entry);
  assert.equal(model.entities[i], before, 'undo restores the very same object');
  assert.ok(!doc.dirty);
  assert.deepEqual(sameAsRebuild(doc), []);
  doc.reapply(entry);
  assert.ok(doc.dirty);
  assert.deepEqual(sameAsRebuild(doc), []);
});

test('undo/redo invariants over long random sessions (shared history with markups)', () => {
  for (const name of ['house-plan.dxf', 'site-plan.dgn', 'bracket.dxf']) {
    const R = rng(name.length * 7);
    const { model, scene } = load(name);
    const doc = new EditDoc(model, scene, { bytes: name.endsWith('dgn') ? bytes(name) : null });
    const h = new History();
    const original = model.entities.slice();
    let markups = [];
    const snapshots = [];
    for (let s = 0; s < 120; s++) {
      const r = R();
      if (r < 0.2) { const e = h.undo(markups); if (e && e.kind === 'edit') doc.revert(e); else if (e) markups = e; continue; }
      if (r < 0.3) { const e = h.redo(markups); if (e && e.kind === 'edit') doc.reapply(e); else if (e) markups = e; continue; }
      if (r < 0.4) { h.record(markups); markups = [...markups, { id: 'm' + s, type: 'line', pts: [0, 0, s, s] }]; continue; }
      const live = model.entities.map((e, i) => (e ? i : -1)).filter((i) => i >= 0);
      const i = live[Math.floor(R() * live.length)];
      const e = model.entities[i];
      const after = r < 0.7 ? moveEntity(e, R() * 100, R() * 100) : r < 0.8 ? null : r < 0.9 ? rotateEntity(e, R(), 0, 0) : restyle(e, { layer: model.layers[0].name }, model.format);
      const changes = [{ i, before: e, after }];
      if (R() < 0.3) changes.push({ i: doc.nextIndex(), before: null, after: { type: 'circle', layer: model.layers[0].name, color: 256, rgb: model.format === 'DGN' ? 0xffffff : null, c: [s, s], r: 1 + s } });
      h.push(doc.commit('step', changes));
      snapshots.push(model.entities.slice());
    }
    assert.deepEqual(sameAsRebuild(doc), [], name + ': scene == full rebuild after the session');
    let e;
    while ((e = h.undo(markups))) { if (e.kind === 'edit') doc.revert(e); else markups = e; }
    assert.ok(!doc.dirty, 'undoing everything = not dirty');
    assert.equal(markups.length, 0, 'markups back to empty');
    assert.ok(original.every((o, i) => model.entities[i] === o), name + ': every original object is back');
    assert.ok(model.entities.slice(original.length).every((x) => x == null), 'added items gone');
    assert.deepEqual(sameAsRebuild(doc), [], name + ': scene == full rebuild after undoing everything');
    while ((e = h.redo(markups))) { if (e.kind === 'edit') doc.reapply(e); else markups = e; }
    assert.deepEqual(model.entities.filter(Boolean).length, snapshots[snapshots.length - 1].filter(Boolean).length, 'redo all brings the last state back');
    assert.deepEqual(sameAsRebuild(doc), []);
  }
});

test('new layer + drawing on it, undo removes it again', () => {
  const { model, scene } = load('schematic.dxf');
  const doc = new EditDoc(model, scene);
  const nl = scene.layers.length;
  const e1 = doc.commit('New layer', [{ layer: 'NEW STUFF', before: null, after: { name: 'NEW STUFF', color: 0xff0000, aci: 1 } }]);
  const e2 = doc.commit('Line', [{ i: doc.nextIndex(), before: null, after: { type: 'line', layer: 'NEW STUFF', color: 256, a: [0, 0], b: [5, 5] } }]);
  assert.equal(scene.layers.length, nl + 1);
  const li = scene.layers.findIndex((l) => l.name === 'NEW STUFF');
  const p = entityItems(scene, model.entities.length - 1).prims[0];
  assert.equal(scene.layer[p], li);
  assert.equal(scene.color[p], 0xff0000, 'by-layer colour of the new layer');
  doc.revert(e2); doc.revert(e1);
  assert.ok(scene.layers[li].removed, 'layer hidden after undo');
  assert.ok(!model.layers.some((l) => l.name === 'NEW STUFF'));
  assert.ok(!doc.layerNames().includes('NEW STUFF'));
});

test('stress drawing: moving ~500 entities touches only their items (no rebuild)', { skip: !load.length }, () => {
  const { model, scene } = load('house-plan.dxf'); // small stand-in; the 53k timing is measured in the e2e suite
  const doc = new EditDoc(model, scene);
  const ids = model.entities.map((e, i) => i);
  const t0 = performance.now();
  doc.commit('Move all', ids.map((i) => ({ i, before: model.entities[i], after: moveEntity(model.entities[i], 1, 1) })));
  assert.ok(performance.now() - t0 < 500);
  assert.deepEqual(sameAsRebuild(doc), []);
  const ext = liveExtents(scene);
  const full = buildScene(model);
  assert.ok(near(ext[0], full.extents[0] + full.origin[0], 1e-6) && near(ext[3], full.extents[3] + full.origin[1], 1e-6), 'live extents');
});

// ------------------------------------------------------------------ selection
test('box selection: window (left to right) needs the whole item inside, crossing (right to left) any touch', () => {
  const m = createModel('DXF');
  ensureLayer(m, '0');
  m.blocks.B = { name: 'B', base: [0, 0], entities: [{ type: 'line', layer: '0', a: [0, 0], b: [10, 0] }, { type: 'circle', layer: '0', c: [10, 0], r: 1 }] };
  m.entities = [
    { type: 'line', layer: '0', a: [1, 1], b: [3, 3] }, // fully inside
    { type: 'line', layer: '0', a: [-5, 2], b: [20, 2] }, // crosses the box, ends outside
    { type: 'line', layer: '0', a: [8, 8], b: [9, 9] }, // outside entirely, bbox overlaps corner region? no
    { type: 'insert', block: 'B', layer: '0', p: [2, 4], sx: 1, sy: 1, rot: 0 }, // partly inside
    { type: 'circle', layer: '0', c: [2.5, 2.5], r: 10 }, // box is inside the circle: circle does not touch the box
    { type: 'text', layer: '0', p: [1, 4], h: 0.5, rot: 0, text: 'IN', halign: 0, valign: 0, wf: 1 },
  ];
  const s = buildScene(m);
  const [ox, oy] = s.origin;
  const box = [0 - ox, 0 - oy, 5 - ox, 5 - oy];
  const win = selectInRect(s, box, 'window');
  const cross = selectInRect(s, box, 'crossing');
  assert.deepEqual([...win].sort(), [0, 5]);
  assert.deepEqual([...cross].sort(), [0, 1, 3, 5]);
  assert.ok(segTouchesRect(-1, 0.5, 2, 0.5, 0, 0, 1, 1));
  assert.ok(!segTouchesRect(-1, 2, 2, 2, 0, 0, 1, 1));
  assert.ok(segTouchesRect(-1, -1, 2, 2, 0, 0, 1, 1), 'diagonal through');
  // hidden layers are ignored
  assert.equal(selectInRect(s, box, 'crossing', () => false).size, 0);
});

test('picking returns the entity; ties go to the topmost item; snaps can skip what is being moved', () => {
  const m = createModel('DXF');
  ensureLayer(m, '0');
  m.entities = [{ type: 'line', layer: '0', a: [0, 0], b: [10, 0] }, { type: 'line', layer: '0', a: [0, 0], b: [10, 0] }, { type: 'solid', layer: '0', pts: [20, 0, 30, 0, 20, 10, 30, 10] }];
  const s = buildScene(m);
  const [ox, oy] = s.origin;
  assert.equal(pickItem(s, 5 - ox, 0 - oy, 0.5).ent, 1, 'topmost of two identical lines');
  assert.equal(pickItem(s, 25 - ox, 5 - oy, 0.5).ent, 2, 'inside a filled area');
  const sn = findSnap(s, 10.1 - ox, 0 - oy, 0.5, { skip: (id) => s.ent[id] === 0 });
  assert.equal(s.ent[sn.prim], 1, 'skipped entity gives no snap');
});

test('renderer: edits rebuild only the touched batches; removed items are not drawn', () => {
  class P { constructor() { this.ops = []; } moveTo(...a) { this.ops.push(['M', ...a]); } lineTo(...a) { this.ops.push(['L', ...a]); } closePath() {} ellipse(...a) { this.ops.push(['E', ...a]); } }
  globalThis.Path2D = P;
  const { model, scene } = load('house-plan.dxf');
  const ctx = new Proxy({ canvas: { width: 800, height: 600 } }, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  const r = new Canvas2DRenderer({ getContext: () => ctx, width: 800, height: 600 });
  r.setScene(scene);
  const v = new Viewport(); v.setSize(800, 600); v.fit(scene.fitBox);
  r.drawTo(ctx, v, { theme: 'dark' }, 1, 800, 600);
  const built = r.chunks.flatMap((c) => c.batches).filter((g) => g.path);
  assert.ok(built.length > 3);
  const doc = new EditDoc(model, scene);
  const i = model.entities.findIndex((e) => e.type === 'line');
  const res = doc.commit('Move', [{ i, before: model.entities[i], after: moveEntity(model.entities[i], 1, 1) }]).result;
  r.applyEdit(res);
  const stale = r.chunks.flatMap((c) => c.batches).filter((g) => !g.path);
  assert.ok(stale.length >= 1 && stale.length <= 2, `only the old and new batch are rebuilt (${stale.length})`);
  r.drawTo(ctx, v, { theme: 'dark' }, 1, 800, 600);
  const all = r.chunks.flatMap((c) => c.batches);
  const killed = res.killed[0], added = res.added[0];
  const holder = all.find((g) => Array.from(g.ids).includes(killed));
  const k = scene.coords[scene.start[killed] * 2];
  assert.ok(!holder.path.ops.some((op) => op[0] === 'M' && op[1] === k && op[2] === scene.coords[scene.start[killed] * 2 + 1]), 'retired line not in its batch path');
  assert.ok(all.some((g) => g.more && g.more.includes(added)), 'new line joined a batch');
});

test('entity bbox and items helpers', () => {
  const { model, scene } = load('bracket.dxf');
  const i = model.entities.findIndex((e) => e.type === 'insert');
  const it = entityItems(scene, i);
  assert.ok(it.prims.length + it.texts.length > 1, 'an insert owns all its expanded items');
  const b = entityBBox(scene, i);
  assert.ok(b && b[0] <= b[2]);
  assert.ok(it.prims.every((p) => scene.ent[p] === i));
  assert.equal(scene.kind[it.prims[0]] > 0, true);
  void KIND; void FG; void translate;
});
