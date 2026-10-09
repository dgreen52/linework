import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKUP_SCHEMA, MARKUP_VERSION } from '../../src/config.js';
import { createMarkup, cloudPath, cloudArcs, rectCorners, moveMarkup, markupBBox, MARKUP_TYPES } from '../../src/markup/model.js';
import { serializeMarkups, parseMarkups, sidecarName, SidecarError } from '../../src/markup/sidecar.js';
import { History } from '../../src/markup/history.js';
import { pointInPolygon } from '../../src/geom.js';

const sample = () => [
  createMarkup('pen', [0, 0, 1, 1, 2, 0], { author: 'Tester', color: '#e5262b', width: 2 }),
  createMarkup('line', [0, 0, 10, 0], { author: 'Tester' }),
  createMarkup('arrow', [6543210.125, 1987654.25, 6543215.5, 1987660.75], { author: 'Tester' }),
  createMarkup('rect', rectCorners(0, 0, 5, 3), { author: 'Tester', color: '#1f6feb' }),
  createMarkup('ellipse', [0, 0, 5, 3], { author: 'Tester' }),
  createMarkup('cloud', rectCorners(10, 10, 30, 20), { author: 'Tester', arc: 2 }),
  createMarkup('callout', [1, 1, 8, 6], { author: 'Tester', text: 'Check this\nsecond line', size: 0.8 }),
  createMarkup('highlight', [0, 5, 10, 5], { author: 'Tester', width: 14, color: '#ffd400' }),
];

test('every markup type round-trips through the sidecar unchanged', () => {
  const list = sample();
  assert.deepEqual(list.map((m) => m.type), MARKUP_TYPES);
  const json = serializeMarkups({ name: 'house-plan.dxf', size: 1234, format: 'DXF', units: 'mm' }, list);
  const doc = JSON.parse(json);
  assert.equal(doc.schema, MARKUP_SCHEMA);
  assert.equal(doc.version, MARKUP_VERSION);
  assert.equal(doc.drawing.name, 'house-plan.dxf');
  const back = parseMarkups(json);
  assert.deepEqual(back.warnings, []);
  assert.equal(back.markups.length, list.length);
  back.markups.forEach((m, i) => {
    const o = list[i];
    assert.equal(m.id, o.id);
    assert.equal(m.type, o.type);
    assert.deepEqual(m.pts, o.pts, 'world coordinates preserved (incl. far from origin)');
    assert.equal(m.color, o.color);
    assert.equal(m.width, o.width);
    assert.equal(m.author, 'Tester');
    assert.equal(m.created, o.created);
    assert.equal(m.text, o.text);
    assert.equal(m.size, o.size);
    assert.equal(m.arc, o.arc);
  });
  // a second round trip is stable
  const again = parseMarkups(serializeMarkups(back.drawing, back.markups));
  assert.deepEqual(again.markups, back.markups);
});

test('sidecar naming', () => {
  assert.equal(sidecarName('plan.dxf'), 'plan.dxf.markup.json');
});

test('sidecar validation: wrong schema, newer version, bad JSON, bad items', () => {
  assert.throws(() => parseMarkups('{nope'), SidecarError);
  assert.throws(() => parseMarkups(JSON.stringify({ markups: [] })), /not a markup file/);
  assert.throws(() => parseMarkups(JSON.stringify({ schema: MARKUP_SCHEMA, version: MARKUP_VERSION + 1, markups: [] })), /newer version/);
  const r = parseMarkups(JSON.stringify({
    schema: MARKUP_SCHEMA, version: 1, markups: [
      { type: 'line', pts: [0, 0, 1, 1], color: 'red', width: 999, created: 'garbage' },
      { type: 'laser', pts: [0, 0, 1, 1] },
      { type: 'line', pts: [0, 0, 'x', 1] },
      { type: 'line', pts: [0, 0, 1] },
    ],
  }));
  assert.equal(r.markups.length, 1);
  assert.equal(r.warnings.length, 3);
  assert.equal(r.markups[0].color, '#e5262b', 'invalid colour replaced');
  assert.equal(r.markups[0].width, 64, 'width clamped');
  assert.ok(!Number.isNaN(Date.parse(r.markups[0].created)));
});

test('revision cloud: outward scallops that close on themselves', () => {
  for (const poly of [rectCorners(0, 0, 100, 50), [0, 0, 0, 50, 100, 50, 100, 0]]) { // CCW and CW
    const arcs = cloudArcs(poly, 10);
    assert.equal(arcs.length, 30);
    const { verts } = cloudPath(poly, 10);
    assert.equal(verts.length / 2, 30);
    for (const a of arcs) {
      const t = a.a0 + a.sweep / 2;
      const mx = a.cx + a.r * Math.cos(t), my = a.cy + a.r * Math.sin(t);
      assert.ok(!pointInPolygon(mx, my, poly), 'scallop bulges outward');
      assert.ok(Math.abs(Math.abs(a.sweep) - (160 * Math.PI) / 180) < 1e-9);
    }
  }
});

test('markup helpers: bbox and move', () => {
  const m = createMarkup('rect', rectCorners(0, 0, 5, 3));
  assert.deepEqual(markupBBox(m), [0, 0, 5, 3]);
  const mv = moveMarkup(m, 10, -1);
  assert.deepEqual(markupBBox(mv), [10, -1, 15, 2]);
  assert.deepEqual(markupBBox(m), [0, 0, 5, 3], 'original untouched');
});

test('undo / redo history', () => {
  const h = new History();
  let list = [];
  h.record(list); list = [...list, createMarkup('line', [0, 0, 1, 1])];
  h.record(list); list = [...list, createMarkup('line', [0, 0, 2, 2])];
  assert.equal(list.length, 2);
  list = h.undo(list); assert.equal(list.length, 1);
  list = h.undo(list); assert.equal(list.length, 0);
  assert.equal(h.undo(list), null);
  list = h.redo(list); assert.equal(list.length, 1);
  list = h.redo(list); assert.equal(list.length, 2);
  assert.equal(h.redo(list), null);
  h.record(list); list = list.slice(1);
  assert.equal(h.canRedo(), false, 'a new change clears redo');
});
