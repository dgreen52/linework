import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../src/geom.js';
import { buildScene, conicBBox } from '../../src/scene.js';
import { createModel, ensureLayer } from '../../src/model.js';
import { findSnap, pickItem } from '../../src/tools/snap.js';
import { measure, fmtNum, describe, details } from '../../src/tools/measure.js';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('bulge -> arc: semicircles, quarter arcs, direction', () => {
  const a = G.bulgeToArc(0, 0, 10, 0, 1); // CCW semicircle bulging to -Y
  assert.ok(near(a.cx, 5) && near(a.cy, 0) && near(a.r, 5) && near(a.sweep, Math.PI));
  const b = G.bulgeToArc(0, 0, 10, 0, -1);
  assert.ok(near(b.cx, 5) && near(b.cy, 0) && near(b.sweep, -Math.PI));
  const q = G.bulgeToArc(10, 0, 0, 10, Math.tan(Math.PI / 8)); // 90 deg CCW around the origin
  assert.ok(near(q.cx, 0) && near(q.cy, 0) && near(q.r, 10) && near(q.sweep, Math.PI / 2));
  assert.ok(near(q.a0, 0));
  assert.equal(G.bulgeToArc(0, 0, 1, 0, 0), null);
  assert.equal(G.bulgeToArc(1, 1, 1, 1, 1), null, 'zero-length chord');
  // midpoint of a positive-bulge arc lies to the right of the chord
  const t = q.a0 + q.sweep / 2;
  const mx = q.cx + q.r * Math.cos(t), my = q.cy + q.r * Math.sin(t);
  assert.ok(mx > 5 && my > 5);
});

test('bulged polyline length and area (slot: 20 + 10*pi, 100 + 25*pi)', () => {
  const v = [62.5, 125, 72.5, 125, 72.5, 135, 62.5, 135];
  const bl = [0, 1, 0, 1];
  assert.ok(near(G.bulgePolylineLength(v, bl, true), 20 + 10 * Math.PI, 1e-9));
  assert.ok(near(G.bulgePolygonArea(v, bl), 100 + 25 * Math.PI, 1e-9));
  // a full circle from two semicircles
  assert.ok(near(G.bulgePolygonArea([0, 0, 2, 0], [1, 1]), Math.PI, 1e-9));
  // inward (concave) bulge subtracts
  const sq = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.ok(near(G.bulgePolygonArea(sq, [0, -1, 0, 0]), 100 - 12.5 * Math.PI, 1e-9));
});

test('polygon area/length, point in polygon', () => {
  const sq = [0, 0, 4, 0, 4, 3, 0, 3];
  assert.equal(G.polygonArea(sq), 12);
  assert.equal(G.signedArea(sq), 12);
  assert.equal(G.signedArea([0, 0, 0, 3, 4, 3, 4, 0]), -12);
  assert.equal(G.polylineLength(sq, false), 11);
  assert.equal(G.polylineLength(sq, true), 14);
  assert.ok(G.pointInPolygon(1, 1, sq));
  assert.ok(!G.pointInPolygon(5, 1, sq));
});

test('arc + ellipse tessellation stays on the curve', () => {
  const pts = G.tessArc([], 1, 2, 5, 0, Math.PI / 2, 0.01);
  for (let i = 0; i < pts.length; i += 2) assert.ok(near(Math.hypot(pts[i] - 1, pts[i + 1] - 2), 5, 1e-12));
  assert.ok(near(pts[0], 6) && near(pts.at(-1), 7));
  const e = G.tessEllipse([], 0, 0, 4, 0, 0, 2, 0, Math.PI * 2, 0.01);
  for (let i = 0; i < e.length; i += 2) assert.ok(near((e[i] / 4) ** 2 + (e[i + 1] / 2) ** 2, 1, 1e-12));
  assert.ok(G.arcSegments(100, Math.PI * 2, 0.01) > G.arcSegments(1, Math.PI * 2, 0.01));
});

test('affine helpers: insert matrix, invert, OCS', () => {
  const M = G.insertMatrix(10, 20, 2, -1, Math.PI / 2, 1, 0);
  const p = G.apply(M, 2, 0); // (2,0)-(1,0)=(1,0) -> S (2,0) -> R90 (0,2) -> +P (10,22)
  assert.ok(near(p[0], 10) && near(p[1], 22));
  const I = G.invert(M);
  const q = G.apply(I, ...p);
  assert.ok(near(q[0], 2) && near(q[1], 0));
  assert.equal(G.ocsMatrix(0, 0, 1), null);
  const O = G.ocsMatrix(0, 0, -1);
  const w = G.apply(O, 10, 3);
  assert.ok(near(w[0], -10) && near(w[1], 3));
});

test('B-spline and Catmull-Rom interpolate their ends', () => {
  const s = G.tessBSpline([0, 0, 1, 2, 3, 2, 4, 0], 3, null, null, 20);
  assert.ok(near(s[0], 0) && near(s[1], 0) && near(s.at(-2), 4) && near(s.at(-1), 0));
  const c = G.tessCatmullRom([0, 0, 1, 1, 2, 0], 4);
  assert.ok(near(c[8], 1) && near(c[9], 1), 'passes through the middle point');
});

test('segment intersection and nearest point', () => {
  const r = G.segSeg(0, 0, 10, 10, 0, 10, 10, 0);
  assert.ok(near(r[0], 5) && near(r[1], 5));
  assert.equal(G.segSeg(0, 0, 1, 0, 0, 1, 1, 1), null, 'parallel');
  assert.equal(G.segSeg(0, 0, 1, 1, 5, 0, 6, -1), null, 'beyond the segments');
  const n = G.nearestOnSeg(5, 5, 0, 0, 10, 0);
  assert.ok(near(n[0], 5) && near(n[1], 0) && near(n[3], 25));
});

test('stroke smoothing reduces jitter but keeps the ends', () => {
  const raw = [];
  for (let i = 0; i <= 100; i++) raw.push(i, Math.sin(i / 10) * 10 + ((i * 7919) % 3) * 0.05);
  const s = G.smoothStroke(raw, 0.3);
  assert.ok(s.length < raw.length);
  assert.ok(near(s[0], 0) && near(s.at(-2), 100));
});

test('exact conic bounding boxes', () => {
  const out = [Infinity, Infinity, -Infinity, -Infinity];
  conicBBox([0, 0, 5, 0, 0, 5, 0, Math.PI / 2], 0, out); // quarter circle
  assert.deepEqual(out.map((v) => Math.round(v * 1e9) / 1e9), [0, 0, 5, 5]);
  const o2 = [Infinity, Infinity, -Infinity, -Infinity];
  conicBBox([0, 0, 4, 0, 0, 2, 0, Math.PI * 2], 0, o2);
  assert.deepEqual(o2.map((v) => Math.round(v * 1e9) / 1e9), [-4, -2, 4, 2]);
});

// ---------------------------------------------------------------- snaps on a tiny synthetic scene
function tinyScene() {
  const m = createModel('DXF');
  ensureLayer(m, '0');
  ensureLayer(m, 'HIDDEN').visible = false;
  m.entities.push(
    { type: 'line', layer: '0', a: [0, 0], b: [10, 0] },
    { type: 'line', layer: '0', a: [5, -5], b: [5, 5] },
    { type: 'circle', layer: '0', c: [20, 0], r: 2 },
    { type: 'polyline', layer: '0', pts: [30, 0, 40, 0, 40, 10], bulges: null, closed: false },
    { type: 'line', layer: 'HIDDEN', a: [0, 1], b: [10, 1] },
  );
  return buildScene(m);
}
const toLocal = (s, x, y) => [x - s.origin[0], y - s.origin[1]];
const toWorld = (s, r) => [r.x + s.origin[0], r.y + s.origin[1]];

test('snaps: endpoint, midpoint, centre, intersection, nearest, hidden layers', () => {
  const s = tinyScene();
  const vis = (li) => s.layers[li].visible;
  let r = findSnap(s, ...toLocal(s, 0.2, 0.1), 0.5, { isVisible: vis });
  assert.equal(r.kind, 'endpoint');
  assert.deepEqual(toWorld(s, r).map((v) => Math.round(v * 1e9) / 1e9), [0, 0]);
  r = findSnap(s, ...toLocal(s, 34.8, 0.2), 0.5, { isVisible: vis });
  assert.equal(r.kind, 'midpoint');
  assert.ok(near(toWorld(s, r)[0], 35));
  r = findSnap(s, ...toLocal(s, 5.2, 0.2), 0.5, { isVisible: vis });
  assert.equal(r.kind, 'intersection');
  assert.ok(near(toWorld(s, r)[0], 5, 1e-9) && near(toWorld(s, r)[1], 0, 1e-9));
  r = findSnap(s, ...toLocal(s, 20.1, 0.1), 0.5, { isVisible: vis });
  assert.equal(r.kind, 'center');
  r = findSnap(s, ...toLocal(s, 22.05, 0), 0.5, { isVisible: vis }); // on a small circle's edge
  assert.equal(r.kind, 'center');
  r = findSnap(s, ...toLocal(s, 22.05, 0), 0.5, { isVisible: vis, enabled: { center: false } });
  assert.equal(r.kind, 'nearest', 'with centre snap off, the circle edge gives a nearest point');
  assert.ok(near(Math.hypot(toWorld(s, r)[0] - 20, toWorld(s, r)[1]), 2, 1e-3));
});

test('snaps: nearest, disabled kinds, hidden layers and empty space', () => {
  const s = tinyScene();
  const vis = (li) => s.layers[li].visible;
  let r = findSnap(s, ...toLocal(s, 7.3, 0.3), 0.5, { isVisible: vis });
  assert.equal(r.kind, 'nearest');
  assert.ok(near(toWorld(s, r)[0], 7.3, 1e-9) && near(toWorld(s, r)[1], 0, 1e-9));
  r = findSnap(s, ...toLocal(s, 7.3, 1.1), 0.3, { isVisible: vis });
  assert.equal(r, null, 'hidden layer is not snappable');
  r = findSnap(s, ...toLocal(s, 0.2, 0.1), 0.5, { isVisible: vis, enabled: { endpoint: false } });
  assert.equal(r.kind, 'nearest');
  assert.equal(findSnap(s, ...toLocal(s, 100, 100), 0.5), null);
  const pick = pickItem(s, ...toLocal(s, 20, 2.1), 0.3, vis);
  assert.ok(pick && !pick.isText);
});

test('measure: distance, length, area + formatting', () => {
  const d = measure('distance', [0, 0, 3, 4]);
  assert.equal(d.value, 5);
  assert.ok(near(d.angle, 53.13010235415598));
  assert.equal(measure('length', [0, 0, 3, 4, 3, 10]).value, 11);
  const a = measure('area', [0, 0, 4, 0, 4, 3, 0, 3]);
  assert.equal(a.value, 12);
  assert.equal(a.perimeter, 14);
  assert.equal(measure('area', [0, 0, 1, 1]), null);
  assert.equal(fmtNum(12000, 2), '12,000.00');
  assert.equal(fmtNum(-0.0001, 2), '0.00');
  assert.equal(fmtNum(1234567.891, 1), '1,234,567.9');
  assert.equal(describe(d, 3, 'mm'), '5.000 mm');
  assert.equal(describe(a, 1, 'm'), '12.0 m²');
  assert.match(details(d, 1, 'mm'), /ΔX 3.0 mm · ΔY 4.0 mm/);
});

test('scene text packing for the worker hand-off round-trips exactly', async () => {
  const { load } = await import('./helpers.mjs');
  const { packTexts, unpackTexts, sceneTransferables } = await import('../../src/scene.js');
  const { scene } = load('bracket.dxf');
  const before = JSON.stringify(scene.texts.map((t) => [t.s, t.x, t.y, t.m, t.fit || 0, t.bbox, t.layer, t.color, t.blk, t.align]));
  packTexts(scene);
  assert.equal(scene.texts, undefined);
  assert.ok(sceneTransferables(scene).length === 18);
  const clone = structuredClone(scene);
  unpackTexts(clone);
  const after = JSON.stringify(clone.texts.map((t) => [t.s, t.x, t.y, t.m, t.fit || 0, t.bbox, t.layer, t.color, t.blk, t.align]));
  assert.equal(after, before);
});
