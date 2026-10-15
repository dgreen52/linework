// Markup resize handles (src/markup/handles.js): which handles a markup has, finding one, and resizing from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarkup, rectCorners } from '../../src/markup/model.js';
import { markupHandles, handleAt, resizeMarkup, pointsBBox } from '../../src/markup/handles.js';

const NOW = '2026-10-15T00:00:00.000Z';
const ids = (m) => markupHandles(m).map((h) => h.id).join(' ');

test('handles: ends for lines, arrows and callouts; eight outline handles for the rest; a flat stroke only its ends', () => {
  assert.equal(ids(createMarkup('line', [0, 0, 10, 5])), 'p0 p1');
  assert.equal(ids(createMarkup('arrow', [0, 0, 10, 5])), 'p0 p1');
  assert.equal(ids(createMarkup('callout', [0, 0, 10, 5], { text: 'X', size: 1 })), 'p0 p1');
  for (const t of ['rect', 'cloud']) assert.equal(ids(createMarkup(t, rectCorners(0, 0, 10, 4))), 'nw n ne e se s sw w', t);
  assert.equal(ids(createMarkup('ellipse', [0, 0, 10, 4])), 'nw n ne e se s sw w');
  assert.equal(ids(createMarkup('pen', [0, 0, 3, 1, 7, 4, 10, 2])), 'nw n ne e se s sw w');
  assert.equal(ids(createMarkup('highlight', [0, 2, 10, 2])), 'nw ne e se sw w', 'a straight highlight: no top / bottom handles');
  assert.deepEqual(markupHandles({ type: 'rect', pts: [1, 2] }), [], 'too few points: none');
  const h = Object.fromEntries(markupHandles(createMarkup('rect', rectCorners(0, 0, 10, 4))).map((x) => [x.id, [x.x, x.y]]));
  assert.deepEqual([h.nw, h.n, h.se, h.w], [[0, 4], [5, 4], [10, 0], [0, 2]], 'y up: north is the top');
});

test('handleAt: the nearest handle within the tolerance', () => {
  const m = createMarkup('rect', rectCorners(0, 0, 10, 4));
  assert.equal(handleAt(m, 10.3, 0.2, 0.5).id, 'se');
  assert.equal(handleAt(m, 5, 2, 0.5), null, 'the middle is not a handle');
  assert.equal(handleAt(createMarkup('arrow', [0, 0, 1, 0]), 0.6, 0, 1).id, 'p1', 'nearest wins');
});

test('resize: a corner scales every point from the opposite corner; an edge only its axis; the original is untouched', () => {
  const m = createMarkup('pen', [0, 0, 5, 2, 10, 4], { modified: '2000-01-01T00:00:00.000Z' });
  const r = resizeMarkup(m, 'ne', 20, 8, { now: NOW });
  assert.deepEqual(r.pts, [0, 0, 10, 4, 20, 8]);
  assert.equal(r.modified, NOW);
  assert.deepEqual(m.pts, [0, 0, 5, 2, 10, 4], 'orig unchanged');
  assert.equal(m.modified, '2000-01-01T00:00:00.000Z');
  assert.deepEqual(resizeMarkup(m, 'w', -10, 99, { now: NOW }).pts, [-10, 0, 0, 2, 10, 4], 'west edge: x only, from the east side');
  assert.deepEqual(resizeMarkup(m, 's', 99, -4, { now: NOW }).pts, [0, -4, 5, 0, 10, 4], 'south edge: y only, from the top');
  assert.deepEqual(resizeMarkup(m, 'sw', -10, -4, { now: NOW }).pts, [-10, -4, 0, 0, 10, 4]);
});

test('resize: never inside out (stops min short of the opposite side); Shift keeps the proportions at a corner', () => {
  const m = createMarkup('rect', rectCorners(0, 0, 10, 4));
  const r = resizeMarkup(m, 'e', -50, 0, { min: 0.5, now: NOW });
  assert.deepEqual(pointsBBox(r.pts), [0, 0, 0.5, 4], 'dragged past the west side: half a unit wide');
  const k = resizeMarkup(m, 'ne', 20, 5, { keepRatio: true, now: NOW });
  assert.deepEqual(pointsBBox(k.pts), [0, 0, 20, 8], 'twice the width: twice the height too (2.5:1 kept)');
  const k2 = resizeMarkup(m, 'sw', -1, -36, { keepRatio: true, now: NOW });
  assert.deepEqual(pointsBBox(k2.pts), [-90, -36, 10, 4], 'the larger stretch wins, the opposite corner stays');
  assert.deepEqual(resizeMarkup(m, 'e', 30, 0, { keepRatio: true, now: NOW }).pts, rectCorners(0, 0, 30, 4), 'an edge ignores Shift');
});

test('resize: line ends and callout points move alone; text, size, colour, cloud scallops are kept', () => {
  const a = createMarkup('arrow', [0, 0, 10, 0], { color: '#1f6feb' });
  assert.deepEqual(resizeMarkup(a, 'p1', 3, 7, { now: NOW }).pts, [0, 0, 3, 7]);
  assert.deepEqual(resizeMarkup(a, 'p0', -2, 1, { now: NOW }).pts, [-2, 1, 10, 0]);
  assert.equal(resizeMarkup(a, 'p0', 0, 0, { now: NOW }).color, '#1f6feb');
  const c = createMarkup('callout', [0, 0, 10, 5], { text: 'CHECK', size: 2 });
  const rc = resizeMarkup(c, 'p1', 20, 9, { now: NOW });
  assert.deepEqual([rc.pts, rc.text, rc.size], [[0, 0, 20, 9], 'CHECK', 2], 'the note moves, the leader tip stays');
  const cl = createMarkup('cloud', rectCorners(0, 0, 10, 10), { arc: 1.5 });
  assert.equal(resizeMarkup(cl, 'se', 20, -10, { now: NOW }).arc, 1.5, 'scallop size kept');
  assert.equal(resizeMarkup(cl, 'bogus', 1, 1), cl, 'an unknown handle changes nothing');
  const flat = createMarkup('highlight', [0, 2, 10, 2]);
  assert.deepEqual(resizeMarkup(flat, 'e', 20, 9, { now: NOW }).pts, [0, 2, 20, 2], 'a flat stroke keeps its y');
});
