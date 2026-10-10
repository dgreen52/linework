// Vector print (src/app/print-svg.js): scales, sheet layout, and the SVG itself — lines land at
// the right millimetres, arcs stay arcs, text stays text, weights and monochrome are honoured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
import { createModel, ensureLayer, unitsFromCode, FG } from '../../src/model.js';
import { buildScene } from '../../src/scene.js';
import { createMarkup } from '../../src/markup/model.js';
import { drawMarkup } from '../../src/markup/render.js';
import { parseScale, printLayout, buildSvg, SvgCtx, widthMm, unitMm, ratioLabel, SHEETS, MARGIN, STRIP } from '../../src/app/print-svg.js';

const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

test('scales: Fit, 1:N, N:1, 1/N, 1"=N\', 1/4"=1\'-0"; nonsense refused', () => {
  assert.deepEqual(parseScale('Fit'), { fit: true });
  assert.deepEqual(parseScale(''), { fit: true });
  assert.equal(parseScale('1:50').ratio, 1 / 50);
  assert.equal(parseScale(' 1 : 2.5 ').ratio, 1 / 2.5);
  assert.equal(parseScale('2:1').ratio, 2);
  assert.equal(parseScale('1/100').ratio, 1 / 100);
  assert.ok(near(parseScale('1"=20\'').ratio, 1 / 240, 1e-12), '1 inch = 20 feet = 1:240');
  assert.ok(near(parseScale('1in=10ft').ratio, 1 / 120, 1e-12));
  assert.ok(near(parseScale('1/4"=1\'-0"').ratio, 1 / 48, 1e-12), 'quarter inch = 1 foot = 1:48');
  assert.ok(near(parseScale('1/8”=1’').ratio, 1 / 96, 1e-12), 'typographic quotes');
  assert.equal(parseScale('1"=20\'').label, '1"=20\'');
  for (const bad of ['abc', '1:0', '0:1', '1:', '50', '1"=', '-1:5']) assert.equal(parseScale(bad), null, bad);
  assert.equal(ratioLabel(1 / 37.24), '1:37.2');
  assert.equal(ratioLabel(1 / 1234.4), '1:1234');
  assert.equal(ratioLabel(2), '2:1');
  assert.equal(unitMm({ code: 6 }), 1000);
  assert.equal(unitMm({ code: 2 }), 304.8);
  assert.equal(unitMm({ code: 0 }), null);
});

test('sheet layout: sizes and orientation, Fit, a fixed scale centred on the area, "does not fit" with the size needed', () => {
  for (const [k, s] of Object.entries(SHEETS)) assert.ok(s[1] < s[2], k + ' portrait first');
  const mm = { code: 4 };
  const L = printLayout({ sheet: 'a3', orientation: 'landscape', scale: 'fit', rect: [0, 0, 800, 400], units: mm });
  assert.deepEqual([L.W, L.H], [420, 297]);
  assert.equal(L.fw, 420 - 2 * MARGIN);
  assert.equal(L.fh, 297 - 2 * MARGIN - STRIP - 1);
  assert.ok(near(L.s, L.fw / 800), 'fit: the width decides');
  assert.equal(L.label, `Fit (${ratioLabel(L.s)})`);
  assert.ok(L.fits);
  const P = printLayout({ sheet: 'letter', orientation: 'portrait', scale: '1:2', rect: [100, 100, 300, 200], units: mm });
  assert.deepEqual([P.W, P.H], [215.9, 279.4]);
  assert.equal(P.s, 0.5);
  assert.ok(P.fits && near(P.need[0], 100) && near(P.need[1], 50));
  assert.ok(near((P.win[0] + P.win[2]) / 2, 200) && near((P.win[1] + P.win[3]) / 2, 150), 'centred on the area');
  assert.ok(near((P.win[2] - P.win[0]) * P.s, P.fw), 'the window fills the frame at the scale');
  const M = printLayout({ sheet: 'a4', orientation: 'landscape', scale: '1:1', rect: [0, 0, 5000, 3000], units: { code: 6 } });
  assert.equal(M.s, 1000, 'metres: 1:1 is 1000 mm of paper per unit');
  assert.ok(!M.fits && near(M.need[0], 5e6));
  const U = printLayout({ sheet: 'a4', orientation: 'landscape', scale: '1:10', rect: [0, 0, 10, 10], units: { code: 0 } });
  assert.equal(U.s, 0.1);
  assert.match(U.label, /1 unit = 1 mm/);
  assert.ok(printLayout({ sheet: 'a4', scale: 'oops', rect: [0, 0, 1, 1], units: mm }).bad);
});

function sample() {
  const m = createModel('DXF');
  m.units = unitsFromCode(4);
  ensureLayer(m, 'A', 0xff0000);
  ensureLayer(m, 'OFF', 0x00ff00);
  m.entities.push(
    { type: 'line', layer: 'A', color: 256, a: [0, 0], b: [100, 0], lw: 50 },
    { type: 'circle', layer: 'A', color: 256, c: [50, 50], r: 20 },
    { type: 'arc', layer: 'A', color: 5, c: [150, 50], r: 10, a0: 0, a1: Math.PI / 2 },
    { type: 'text', layer: 'A', color: 256, p: [10, 80], h: 5, rot: 0, text: 'PUMP <1> & "2"', halign: 0, valign: 0, wf: 1 },
    { type: 'line', layer: 'OFF', color: 256, a: [0, 10], b: [100, 10] },
  );
  return buildScene(m);
}
const paths = (svg) => [...svg.matchAll(/<path ([^>]*)d="([^"]*)"/g)].map((x) => ({ attrs: x[1], d: x[2] }));

test('SVG: a 100 mm line prints 100 mm long at 1:1 and 50 mm at 1:2; circles and arcs are arcs; text is text; weights; hidden layers', () => {
  const scene = sample();
  const [ox, oy] = scene.origin;
  const rect = [-10 - ox, -30 - oy, 190 - ox, 100 - oy];
  for (const [scale, k] of [['1:1', 1], ['1:2', 0.5]]) {
    const L = printLayout({ sheet: 'a3', orientation: 'landscape', scale, rect, units: scene.units });
    const svg = buildSvg(scene, L, { layerVisible: Uint8Array.from(scene.layers.map((l) => (l.name === 'OFF' ? 0 : 1))) });
    assert.match(svg, new RegExp(`width="${L.fw}mm" height="${+L.fh.toFixed(3)}mm" viewBox="0 0 ${L.fw} `));
    const line = paths(svg).find((p) => /stroke-width="0.5"/.test(p.attrs));
    assert.ok(line, 'the 0.50 mm lineweight is a 0.5 mm stroke: ' + svg.slice(0, 600));
    const m = /^M([-\d.]+) ([-\d.]+)L([-\d.]+) ([-\d.]+)$/.exec(line.d);
    assert.ok(m, line.d);
    assert.ok(near(+m[3] - +m[1], 100 * k) && near(+m[4], +m[2]), `${scale}: ${100 * k} mm long, horizontal`);
    const arcs = paths(svg).filter((p) => /A/.test(p.d));
    assert.equal(arcs.length, 2, 'circle and arc');
    const circle = arcs.find((p) => /Z$/.test(p.d));
    assert.equal((circle.d.match(/A/g) || []).length, 4, 'a full circle: four 90° arcs');
    assert.match(circle.d, new RegExp(`A${20 * k} ${20 * k} `), 'radius on paper');
    assert.equal(paths(svg).filter((p) => /stroke="#000000"/.test(p.attrs) || true).length, 3, 'the line on the hidden layer is left out');
    assert.match(svg, /<text transform="matrix\([^)]*\)">PUMP &lt;1&gt; &amp; &quot;2&quot;<\/text>/, 'text, escaped');
    const tm = /<text transform="matrix\(([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) /.exec(svg);
    assert.ok(near(+tm[1] * 64 * 0.71, 5 * k, 1e-3) && near(+tm[4] * 64 * 0.71, 5 * k, 1e-3), 'cap height 5 mm × scale');
    assert.ok(!/NaN|Infinity/.test(svg));
  }
  // colours: layer colour (red, darkened for paper as on screen), blue arc; monochrome: everything black
  const L = printLayout({ sheet: 'a4', orientation: 'landscape', scale: 'fit', rect, units: scene.units });
  const col = buildSvg(scene, L, {});
  assert.ok(/stroke="#(?!000000)[0-9a-f]{6}"/.test(col), 'colours');
  const mono = buildSvg(scene, L, { mono: true });
  assert.deepEqual([...new Set([...mono.matchAll(/(?:stroke|fill)="(#[0-9a-f]+)"/g)].map((x) => x[1]))], ['#000'], 'monochrome');
  assert.equal(widthMm(0, 'DXF'), 0.18);
  assert.equal(widthMm(0, 'DGN'), 0.18);
  assert.ok(widthMm(3, 'DGN') > widthMm(1, 'DGN'), 'DGN weights grow');
});

test('SVG of every fixture: valid numbers, culled to the window, markups and measurements recorded as vector', () => {
  for (const name of ['house-plan.dxf', 'bracket.dxf', 'schematic.dxf', 'site-plan.dgn', 'edge-far-coords.dxf', 'edge-lineweights.dxf']) {
    const { scene } = load(name);
    const all = printLayout({ sheet: 'tabloid', orientation: 'landscape', scale: 'fit', rect: scene.extents, units: scene.units });
    const svg = buildSvg(scene, all, {});
    assert.ok(!/NaN|Infinity|undefined/.test(svg), name);
    assert.ok(paths(svg).length > 0, name);
    const e = scene.extents, corner = [e[0], e[1], e[0] + (e[2] - e[0]) / 50, e[1] + (e[3] - e[1]) / 50];
    const part = buildSvg(scene, printLayout({ sheet: 'a4', scale: 'fit', rect: corner, units: scene.units }), {});
    assert.ok(part.length < svg.length, name + ': items outside the window are left out');
  }
  const ctx = new SvgCtx(() => 40);
  const toS = (x, y) => [x * 2, 300 - y * 2];
  for (const [type, pts, extra] of [['pen', [0, 0, 5, 5, 10, 0]], ['line', [0, 0, 10, 10]], ['arrow', [0, 0, 10, 10]], ['rect', [0, 0, 10, 0, 10, 10, 0, 10]],
    ['ellipse', [0, 0, 10, 5]], ['cloud', [0, 0, 40, 0, 40, 20, 0, 20], { arc: 4 }], ['callout', [0, 0, 20, 20], { text: 'CHECK\nTHIS', size: 4 }], ['highlight', [0, 0, 30, 0]]]) {
    drawMarkup(ctx, createMarkup(type, pts, { color: '#e5262b', width: 2, ...extra }), toS, 2, {});
  }
  const out = ctx.out.join('');
  assert.ok(ctx.out.length >= 10, 'one or more elements per markup');
  assert.match(out, /<text [^>]*>CHECK<\/text>/);
  assert.match(out, /A\d/, 'cloud and ellipse arcs');
  assert.match(out, /opacity="0.35"/, 'highlighter transparency');
  assert.ok(!/NaN|undefined/.test(out), out.slice(0, 300));
  const r = new SvgCtx(() => 1);
  r.beginPath(); r.roundRect(0, 0, 40, 10, 5); r.fill();
  assert.match(r.out[0], /^<path d="M5 0H35A5 5 0 0 1 40 5V5A5 5/);
  assert.ok(FG > 0xffffff);
});
