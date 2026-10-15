// Line types at their true size (dash lengths in drawing units: $LTSCALE x the item's own scale x its block's
// scale; in a layout viewport as long on paper as in paper space) and hatch patterns drawn as lines (src/hatch.js).
// On the invented fixture tools/make_fixtures.mjs writes as tests/fixtures/linetypes.dxf.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes } from './helpers.mjs';
import { parseDrawing } from '../../src/formats/detect.js';
import { buildScene, worldDash, plug, KIND, FLAG } from '../../src/scene.js';
import { writeDxf } from '../../src/formats/dxf-write.js';
import { writeDgn } from '../../src/formats/dgn-write.js';
import { transformEntity } from '../../src/edit/ops.js';
import { findSnap } from '../../src/tools/snap.js';
import { printLayout, buildSvg } from '../../src/app/print-svg.js';
import * as HATCH from '../../src/hatch.js';
import * as LAYOUT from '../../src/layout.js';

const { patternDefs, patternLines, HATCH_MAX } = HATCH;
const open = () => parseDrawing(bytes('linetypes.dxf'), 'linetypes.dxf');
/** Build as the parse worker does for a drawing with pattern hatches (hatch: false = without src/hatch.js). */
function build(m, { hatch = true, layout } = {}) {
  plug.hatch = hatch ? HATCH : null;
  try { return buildScene(m, { layout }); } finally { plug.hatch = null; }
}
const r3 = (v) => +v.toFixed(3);
/** Items of a scene: { i, flags, pts (drawing coordinates, to 3 decimals unless exact), lt (its line type entry) }. */
function items(s, exact = false) {
  const r = exact ? (v) => v : r3;
  const [ox, oy] = s.origin, out = [];
  for (let i = 0; i < s.n; i++) {
    if (s.kind[i] !== KIND.POLY) continue;
    const st = s.start[i] * 2, pts = [];
    for (let k = 0; k < s.count[i]; k++) { const x = s.coords[st + 2 * k]; pts.push(x !== x ? NaN : r(x + ox), x !== x ? NaN : r(s.coords[st + 2 * k + 1] + oy)); }
    out.push({ i, flags: s.flags[i], pts, lt: s.ltypes[s.style[i]] });
  }
  return out;
}
/** Segments of a pattern-line item as sorted 'x,y x,y' strings. */
function segs(pts) {
  const out = [];
  for (let k = 0; k + 3 < pts.length; k += 6) out.push(`${pts[k]},${pts[k + 1]} ${pts[k + 2]},${pts[k + 3]}`);
  return out.sort();
}
const lineAt = (s, y) => items(s).find((it) => it.pts.length === 4 && it.pts[1] === y && it.pts[3] === y && !(it.flags & FLAG.HL));

test('worldDash: an LTYPE pattern at a scale as a canvas dash array in drawing units', () => {
  assert.deepEqual(worldDash([0.5, -0.25], 10), { wd: [5, 2.5], per: 7.5 });
  assert.deepEqual(worldDash([0.5, -0.25, 0, -0.25], 1), { wd: [0.5, 0.25, 0, 0.25], per: 1 }, 'a dot is a dash of 0 (round caps draw it)');
  assert.deepEqual(worldDash([-0.25, 0.5], 1), { wd: [0.5, 0.25], per: 0.75 }, 'starting with a gap: the last dash wraps to the front');
  assert.deepEqual(worldDash([0.5, 0.5, -0.25], 2), { wd: [2, 0.5], per: 2.5 }, 'two dashes in a row are one');
  assert.deepEqual(worldDash([0.5, -0.25, 0.25], 1), { wd: [0.75, 0.25], per: 1 }, 'ending on a dash: it joins the first');
  assert.equal(worldDash([1], 1), null, 'no gap: solid');
  assert.equal(worldDash([], 1), null);
  assert.equal(worldDash([0.5, -0.25], NaN), null);
});

test('line types: $LTSCALE, an item\'s own scale (48) and a block\'s scale size the dashes; one entry per name and scale', () => {
  const m = open();
  assert.equal(m.header.ltscale, 10);
  assert.equal(m.header.psltscale, 1);
  const s = build(m);
  assert.deepEqual([0, 10, 20, 30].map((y) => lineAt(s, y).lt.wd), [[5, 2.5], [10, 5], [5, 2.5, 0, 2.5], [15, 7.5]],
    'DASHED at 10; DASHED, its own scale 2; DASHDOT by layer; DASHED in a block inserted at 3x');
  assert.equal(lineAt(s, 0).lt.name, 'DASHED', 'the name stays (the DGN writer and the panels read it)');
  assert.deepEqual(lineAt(s, 0).lt.dash, [16, 8], 'the screen pattern is kept (DGN styles, old hosts)');
  assert.equal(new Set(s.ltypes.map((l) => l.key || l.name)).size, s.ltypes.length, 'no duplicate entries');
});

test('hatch patterns: each definition line a family of lines cut to the boundary (even-odd) and dashed, in drawing units', () => {
  const its = items(build(open())), hl = its.filter((it) => (it.flags & (FLAG.HL | FLAG.PATTERN)) === FLAG.HL);
  assert.equal(hl.length, 4, 'four hatches with lines (the dense one is a tone)');
  assert.deepEqual(segs(hl[0].pts), [42.5, 47.5, 52.5, 57.5, 62.5, 67.5, 72.5, 77.5].map((y) => `0,${y} 40,${y}`).sort(), 'lines 5 apart, from base 2.5');
  const dashes = [];
  for (const y of [42.5, 52.5, 62.5, 72.5]) for (const x of [50, 60, 70, 80]) dashes.push(`${x},${y} ${x + 5},${y}`);
  assert.deepEqual(segs(hl[1].pts), dashes.sort(), '5 on, 5 off from the base point');
  assert.deepEqual(segs(hl[2].pts), ['15,90 15,100', '15,120 15,130', '25,90 25,100', '25,120 25,130', '35,90 35,130', '5,90 5,130'].sort(), 'the hole is left out (lines at 90 degrees run upwards)');
  for (const it of hl) assert.equal(it.lt.dash || null, null, 'pattern lines are solid lines (their dashes are geometry)');
  // ANSI31 in a block inserted at 2x: 45 degrees, 6.35 apart, inside 50..90 x 90..110
  const a = hl[3].pts;
  for (let k = 0; k + 3 < a.length; k += 6) {
    assert.ok(Math.abs((a[k + 3] - a[k + 1]) - (a[k + 2] - a[k])) < 1e-6, '45 degrees');
    for (const [x, y] of [[a[k], a[k + 1]], [a[k + 2], a[k + 3]]]) assert.ok(x >= 50 - 1e-6 && x <= 90 + 1e-6 && y >= 90 - 1e-6 && y <= 110 + 1e-6, `inside: ${x},${y}`);
  }
  const offsets = new Set();
  for (let k = 0; k + 3 < a.length; k += 6) offsets.add(r3((a[k + 1] - 90 - (a[k] - 50)) / (2 * 2.245064 * 2)));
  for (const o of offsets) assert.ok(Math.abs(o - Math.round(o)) < 1e-3, 'every line one of the family');
  // regions: drawn by their lines (HL), the dense one as a tone
  const regions = its.filter((it) => it.flags & FLAG.PATTERN);
  assert.deepEqual(regions.map((it) => !!(it.flags & FLAG.HL)), [true, true, true, true, false]);
});

test('hatch patterns: without src/hatch.js (a library host) hatches are tones as before; saved as DGN, a hatch is its outline either way', () => {
  const its = items(build(open(), { hatch: false }));
  assert.equal(its.filter((it) => it.flags & FLAG.HL).length, 0);
  assert.equal(its.filter((it) => it.flags & FLAG.PATTERN).length, 5);
  const dgn = (hatch) => { plug.hatch = hatch ? HATCH : null; try { return writeDgn(open()).bytes; } finally { plug.hatch = null; } };
  assert.deepEqual(dgn(true), dgn(false), 'the pattern lines are not written as elements');
});

test('patternLines: definitions, dots, a hatch over HATCH_MAX segments and the build budget', () => {
  const tail = [[75, 1], [76, 1], [52, 0], [41, 1], [77, 0], [78, 1], [53, 0], [43, 0], [44, 0.5], [45, 0], [46, 1], [79, 2], [49, 0], [49, -1], [98, 0]];
  assert.deepEqual(patternDefs(tail), [{ a: 0, b: [0, 0.5], o: [0, 1], d: [0, -1] }]);
  const ring = [0, 0, 4, 0, 4, 2, 0, 2];
  const dots = patternLines({ tail }, [[0, 0, 4.5, 0, 4.5, 2, 0, 2]]);
  assert.deepEqual(segs(dots), ['0,0.5 0,0.5', '1,0.5 1,0.5', '2,0.5 2,0.5', '3,0.5 3,0.5', '4,0.5 4,0.5', '0,1.5 0,1.5', '1,1.5 1,1.5', '2,1.5 2,1.5', '3,1.5 3,1.5', '4,1.5 4,1.5'].sort(), 'dots: segments of length 0');
  assert.equal(patternLines({ solid: true, tail }, [ring]), null, 'a solid hatch has no lines');
  assert.equal(patternLines({ tail: [] }, [ring]), null, 'no definition: no lines');
  const dense = [[53, 0], [43, 0], [44, 0], [45, 0], [46, 2 / (HATCH_MAX + 10)]];
  assert.equal(patternLines({ tail: dense }, [ring]), null, 'more lines than HATCH_MAX: a tone');
  const budget = { left: 7 };
  assert.equal(patternLines({ tail: [[53, 0], [43, 0], [44, 0.5], [45, 0], [46, 1]] }, [ring], budget).length, 2 * 6 - 2);
  assert.equal(budget.left, 5, 'the build budget is spent');
  assert.equal(patternLines({ tail }, [ring], budget), null, 'past the budget: a tone');
  assert.equal(budget.left, 5);
});

test('hatch patterns: pattern lines give no snaps (the hatch is still picked by its area)', () => {
  const s = build(open()), [ox, oy] = s.origin;
  assert.equal(findSnap(s, 20 - ox, 62.5 - oy, 1), null, 'on a pattern line, far from the boundary: no snap');
  const at = findSnap(s, 0.3 - ox, 62.5 - oy, 1);
  assert.ok(at && Math.abs(at.x + ox) < 1e-6, 'the boundary still snaps');
});

test('line types and hatch patterns: saved as DXF and read back the same', () => {
  const m = open(), out = writeDxf(m).text;
  assert.match(out, /\n\$LTSCALE\r?\n *40\r?\n10(\.0+)?\r?\n/);
  assert.match(out, /\n *48\r?\n2(\.0+)?\r?\n/, 'the item\'s own scale');
  const back = parseDrawing(new TextEncoder().encode(out), 'back.dxf');
  const a = build(m), b = build(back);
  assert.deepEqual([0, 10, 20, 30].map((y) => lineAt(b, y).lt.wd), [0, 10, 20, 30].map((y) => lineAt(a, y).lt.wd));
  const hl = (s) => items(s).filter((it) => (it.flags & (FLAG.HL | FLAG.PATTERN)) === FLAG.HL).map((it) => segs(it.pts));
  assert.deepEqual(hl(b), hl(a), 'the pattern definitions are kept');
});

test('line types in a layout viewport: as long on paper as in paper space ($PSLTSCALE 1), or scaled with the view (0)', () => {
  const page = (ps) => {
    const m = LAYOUT.applyLayouts(open(), 2);
    if (ps != null) m.header.psltscale = ps;
    return build(m, { layout: LAYOUT });
  };
  const s = page();
  assert.equal(s.page.label, 'Paper space');
  // the viewport shows model space at 1:10 around 50,40 from 100,100: the line at y 0 is at paper y 96
  assert.deepEqual(lineAt(s, 96).lt.wd, [5, 2.5]);
  assert.deepEqual(lineAt(s, 97).lt.wd, [10, 5]);
  assert.deepEqual(lineAt(page(0), 96).lt.wd, [0.5, 0.25]);
  const hl = items(s).filter((it) => (it.flags & (FLAG.HL | FLAG.PATTERN)) === FLAG.HL);
  assert.ok(hl.length >= 3, 'hatch lines through the viewport too');
  for (const it of hl) for (let k = 0; k < it.pts.length; k += 2) if (it.pts[k] === it.pts[k]) assert.ok(it.pts[k] >= 50 - 1e-6 && it.pts[k] <= 150 + 1e-6 && it.pts[k + 1] >= 60 - 1e-6 && it.pts[k + 1] <= 140 + 1e-6, 'cut at the frame');
});

test('print: dashes at their size on paper (solid when a whole pattern is under 0.5 mm)', () => {
  const s = build(open());
  const at = (scale) => buildSvg(s, printLayout({ sheet: 'a3', orientation: 'landscape', scale, rect: s.extents, units: s.units }));
  const one = at('1:1');
  assert.match(one, /stroke-dasharray="5 2.5"/);
  assert.match(one, /stroke-dasharray="15 7.5"/);
  assert.match(one, /stroke-dasharray="5 2.5 0 2.5"/);
  const small = at('1:20'); // 7.5 / 20 = 0.375 mm: solid; 15 mm and up stay dashed
  assert.doesNotMatch(small, /stroke-dasharray="0.25 0.125"/);
  assert.match(small, /stroke-dasharray="0.75 0.375"/);
  const tones = [...one.matchAll(/fill-opacity=".22" fill-rule="evenodd" d="([^"]*)"/g)].map((t) => t[1]);
  assert.equal(tones.length, 1);
  assert.equal(tones[0].split('M').length - 1, 1, 'only the dense hatch is a tone (the others are drawn by their lines)');
});

test('hatch patterns move, turn, scale and mirror with their hatch (and are saved so)', () => {
  /** Each segment of the pattern lines of the top-level hatches, ends in order: [[x0, y0, x1, y1]]. */
  const pattern = (m) => {
    const out = [];
    for (const it of items(build(m), true)) {
      if ((it.flags & (FLAG.HL | FLAG.PATTERN)) !== FLAG.HL) continue;
      const p = it.pts;
      for (let k = 0; k + 3 < p.length; k += 6) out.push(p[k] < p[k + 2] || (p[k] === p[k + 2] && p[k + 1] <= p[k + 3]) ? [p[k], p[k + 1], p[k + 2], p[k + 3]] : [p[k + 2], p[k + 3], p[k], p[k + 1]]);
    }
    return out;
  };
  const xf = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const cases = { move: [1, 0, 0, 1, 10, 5], turn: [c, s, -s, c, 3, -7], scale: [2, 0, 0, 2, -40, 0], mirror: [-1, 0, 0, 1, 100, 0], stretch: [1.5, 0, 0, 0.5, 0, 0] };
  const tops = (m) => m.entities.map((e, i) => (e && e.type === 'hatch' ? i : -1)).filter((i) => i >= 0);
  const before = (() => { const m = open(); m.entities = tops(m).map((i) => m.entities[i]); return pattern(m); })();
  assert.equal(before.length, 8 + 16 + 6);
  for (const [name, M] of Object.entries(cases)) {
    const m = open();
    m.entities = tops(m).map((i) => transformEntity(m.entities[i], M));
    const want = before.map(([x0, y0, x1, y1]) => [...xf(M, x0, y0), ...xf(M, x1, y1)]);
    for (const got of [pattern(m), pattern(parseDrawing(new TextEncoder().encode(writeDxf(m).text), 'back.dxf'))]) {
      assert.equal(got.length, want.length, `${name}: as many segments`);
      for (const w of want) {
        assert.ok(got.some((g) => (Math.hypot(g[0] - w[0], g[1] - w[1]) < 1e-6 && Math.hypot(g[2] - w[2], g[3] - w[3]) < 1e-6) || (Math.hypot(g[0] - w[2], g[1] - w[3]) < 1e-6 && Math.hypot(g[2] - w[0], g[3] - w[1]) < 1e-6)),
          `${name}: the segment ${w.map(r3)} moved with the hatch`);
      }
    }
  }
});
