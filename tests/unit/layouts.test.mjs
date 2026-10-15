// Paper-space layouts (DXF): the model and each layout as a page, a layout's sheet and its viewports (model space at
// the viewport's scale, clipped to its frame, layers frozen in it left out), and the clipping helpers. On the
// invented fixture tools/make_fixtures.mjs writes as tests/fixtures/layouts.dxf.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes } from './helpers.mjs';
import { parseDrawing } from '../../src/formats/detect.js';
import { buildScene as build, KIND } from '../../src/scene.js';
import * as LAYOUT from '../../src/layout.js';

const { clipPolyline, clipRing, applyLayouts } = LAYOUT;
/** As the parse worker does: the layouts as pages, the layout code for the viewports. */
const buildScene = (m) => build(m, { layout: LAYOUT });
import { writeDxf } from '../../src/formats/dxf-write.js';

const open = (page) => applyLayouts(parseDrawing(bytes('layouts.dxf'), 'layouts.dxf'), page);
/** The scene's polylines in drawing coordinates, rounded: ['x,y x,y ...']. */
function polys(scene) {
  const [ox, oy] = scene.origin, out = [];
  for (let i = 0; i < scene.n; i++) {
    if (scene.kind[i] !== KIND.POLY) continue;
    const s = scene.start[i], n = scene.count[i], pts = [];
    for (let k = 0; k < n; k++) pts.push(`${+(scene.coords[2 * (s + k)] + ox).toFixed(3)},${+(scene.coords[2 * (s + k) + 1] + oy).toFixed(3)}`);
    out.push(pts.join(' '));
  }
  return out.sort();
}

test('layouts: Model and every layout as pages, in tab order (not file order), named; Model by default', () => {
  const m = open();
  assert.deepEqual(m.page, { n: 1, count: 4, label: 'Model', labels: ['Model', 'A3 Plan', 'Detail', 'Empty'], layout: false, cad: true });
  assert.equal(m.entities.length, 3, 'model space');
  assert.equal(m.modelSpace, undefined);
  assert.ok(Object.keys(m.stats.notShown).some((k) => /see the layout pages/.test(k)), 'the model page says where the paper-space items are');
  assert.equal(open(9).page.n, 1, 'a page out of range: Model');
  assert.equal(open(0).page.n, 1);
  for (const [n, label, types] of [[2, 'A3 Plan', 'polyline,text,viewport'], [3, 'Detail', 'polyline,text,viewport'], [4, 'Empty', '']]) {
    const p = open(n);
    assert.equal(p.page.label, label);
    assert.equal(p.page.layout, true);
    assert.equal(p.entities.map((e) => e.type).join(','), types, `${label}: its sheet and its viewport (the paper-space viewport, id 1, is not an item)`);
    assert.equal(p.modelSpace.length, 3, 'model space kept for the viewports');
  }
});

test('layouts: a viewport shows model space at its scale around its view centre, clipped to its frame', () => {
  const s = buildScene(open(2));
  // the 12 x 8 m outline at 1:50 (300 x 200 paper units showing a 10 m high view around 6000,4000): 90,80 .. 330,240
  assert.deepEqual(polys(s), [
    '0,0 420,0 420,297 0,297', // the sheet
    '60,60 360,60 360,260 60,260', // the viewport's frame
    '90,80 330,80 330,240 90,240', // model space through it
  ]);
  assert.equal(s.kind.filter((k) => k === KIND.CONIC).length, 1, 'the table (FURN) is drawn in this viewport');
  assert.deepEqual(s.texts.map((t) => t.s).sort(), ['A3 PLAN SHEET', 'MODEL ONLY'], 'model text inside the viewport is shown');
  const label = s.texts.find((t) => t.s === 'MODEL ONLY');
  assert.ok(Math.abs(Math.hypot(label.m[2], label.m[3]) - 5) < 1e-9, 'text height scaled too (250 mm at 1:50 = 5)');
});

test('layouts: a detail viewport crosses the model\'s edges (cut at its frame); a layer frozen in it is left out; text outside it too', () => {
  const s = buildScene(open(3));
  // 1:10 window (120 x 80 at 100,120) on model 500,500: only the left wall (x = 0 -> paper 50) crosses it, from y 80 to 160
  assert.deepEqual(polys(s), ['0,0 420,0 420,297 0,297', '40,80 160,80 160,160 40,160', '50,160 50,80']);
  assert.equal(s.kind.filter((k) => k === KIND.CONIC).length, 0, 'FURN is frozen in this viewport');
  assert.deepEqual(s.texts.map((t) => t.s), ['DETAIL SHEET'], 'the model text is outside the detail');
  const e = buildScene(open(4));
  assert.equal(e.n + e.texts.length, 0, 'an empty layout is empty');
});

test('layouts: without the layout code (a library host that does not call applyLayouts) the reader behaves as before', () => {
  const m = parseDrawing(bytes('layouts.dxf'), 'layouts.dxf');
  assert.equal(m.page, undefined);
  assert.equal(m.entities.length, 3, 'model space');
  assert.ok(m.layoutData && m.layoutData.paper.length === 3, 'what layouts need is kept');
  const p = parseDrawing(bytes('edge-paperspace.dxf'), 'edge-paperspace.dxf');
  assert.equal(applyLayouts(p, 2).page, undefined, 'paper space only, one layout: shown in place of the empty model, no pages');
});

test('layouts: the model page saves as before (viewports and paper-space blocks are not model space)', () => {
  const m = open(1), out = writeDxf(m).text, back = parseDrawing(new TextEncoder().encode(out), 'back.dxf');
  assert.equal(back.entities.length, 3, 'model space round trip');
  assert.ok(!/\nVIEWPORT\r?\n/.test(out), 'no viewport written as a model-space item');
});

test('clipPolyline: pieces inside a rectangle, joined where they touch; closed outlines wrap around', () => {
  const R = [0, 0, 10, 10];
  assert.deepEqual(clipPolyline([-5, 5, 5, 5, 15, 5], false, R), [[0, 5, 5, 5, 10, 5]], 'one piece through');
  assert.deepEqual(clipPolyline([-5, -5, -1, -1], false, R), [], 'outside');
  assert.deepEqual(clipPolyline([2, 2, 12, 2, 12, 8, 2, 8], false, R), [[2, 2, 10, 2], [10, 8, 2, 8]], 'out and back in: two pieces');
  assert.deepEqual(clipPolyline([5, 5, 15, 5, 15, 8, 5, 8], true, R), [[10, 8, 5, 8, 5, 5, 10, 5]], 'closed: the last piece runs on into the first');
  assert.deepEqual(clipPolyline([5, 5], false, R), [], 'one point: nothing');
  assert.deepEqual(clipPolyline([0, 0, 10, 0], false, R), [[0, 0, 10, 0]], 'on the edge counts as inside');
});

test('clipRing: a filled ring cut to the rectangle', () => {
  const R = [0, 0, 10, 10];
  assert.deepEqual(clipRing([-5, -5, 5, -5, 5, 5, -5, 5], R), [0, 0, 5, 0, 5, 5, 0, 5]);
  assert.deepEqual(clipRing([20, 20, 30, 20, 30, 30], R), [], 'outside: empty');
  assert.deepEqual(clipRing([2, 2, 8, 2, 8, 8, 2, 8], R), [2, 2, 8, 2, 8, 8, 2, 8], 'inside: as it was');
});
