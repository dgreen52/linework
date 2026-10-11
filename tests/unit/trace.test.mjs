// Wire / net tracing (src/tools/trace.js) on the invented wiring sheet tools/trace_sheet.json, built as DGN
// (tests/fixtures/dgn-trace.dgn, checked against GDAL/OGR's reading) and as DXF (trace-sheet.dxf): shared
// ends, T-junctions, junction dots, crossings without dots, connector cells with pin texts, wire labels,
// a long net, a hop arc, gaps, options, hidden layers, edits, and a 50 000-entity drawing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bytes, fixture, ROOT } from './helpers.mjs';
import { join } from 'node:path';
import { parseDrawing } from '../../src/formats/detect.js';
import { buildScene } from '../../src/scene.js';
import { EditDoc } from '../../src/edit/doc.js';
import { moveEntity } from '../../src/edit/ops.js';
import { DxfWriter } from '../../samples/gen/dxf-writer.js';
import { buildNetGraph, buildNetGraphAsync, traceNet, pickWire, endText, netText, ROLE } from '../../src/tools/trace.js';

const SHEETS = ['dgn-trace.dgn', 'trace-sheet.dxf'];
const J = JSON.parse(readFileSync(join(ROOT, 'tools', 'trace_sheet.json'), 'utf8'));
function open(name) {
  const model = parseDrawing(bytes(name), name);
  const scene = buildScene(model);
  return { model, scene, G: buildNetGraph(scene) };
}
/** The net through the wire at drawing point (x, y). */
function net(t, x, y, opts = {}, G = t.G) {
  const [ox, oy] = t.scene.origin;
  const w = pickWire(G, x - ox, y - oy, 0.5);
  assert.ok(w >= 0, `a wire at ${x}, ${y}`);
  return traceNet(G, w, opts);
}
const ends = (n) => n.ends.map(endText);
const labels = (n) => n.labels.map((l) => `${l.s}${l.texts.length > 1 ? ' x' + l.texts.length : ''}`);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const cellName = (name, dxf) => (dxf ? { J4: 'J4CONN', P1: 'P1CONN' }[name] || name : name === 'J4' || name === 'P1' ? 'CONN' : name);
const wireAt = (t, x, y) => { const [ox, oy] = t.scene.origin; return pickWire(t.G, x - ox, y - oy, 0.5); };

test('trace sheet: the DGN reads like GDAL/OGR (texts, wires on level 5, cells), the DXF twin has the same items', () => {
  const o = JSON.parse(readFileSync(fixture('dgn-trace.ogr.json'), 'utf8'));
  const d = open('dgn-trace.dgn'), x = open('trace-sheet.dxf');
  const ogrTexts = o.features.filter((f) => f.text).map((f) => f.text).sort();
  const textsOf = (s) => s.texts.map((t) => t.s).sort();
  assert.deepEqual(textsOf(d.scene), ogrTexts, 'the same texts as OGR');
  assert.deepEqual(textsOf(x.scene), ogrTexts, 'the DXF has the same texts');
  assert.equal(d.model.entities.filter((e) => e.type === 'cell').length, J.cells.length);
  for (const t of [d, x]) {
    const wires = [...t.G.role].filter((r) => r === ROLE.WIRE).length;
    assert.equal(wires, J.wires.length + 2, 'every wire (the chain with a hop arc is 3 primitives)');
  }
});

for (const name of SHEETS) {
  const dxf = name.endsWith('.dxf');
  const t = open(name);

  test(`${name}: a long net across many segments (meander + chained lines), its labels and its ends`, () => {
    const n = net(t, 100, 160);
    assert.ok(near(n.length, 282), 'length ' + n.length);
    assert.equal(n.count, 5, 'five wires as drawn');
    assert.equal(n.segments, 26);
    assert.deepEqual(labels(n), ['W9434 x2']);
    assert.deepEqual(ends(n), [`J4 · 1 (${cellName('J4', dxf)})`, `P1 · P1-A (${cellName('P1', dxf)})`]);
    assert.equal(n.junctions, 0);
    // the same net from any of its pieces, and from the far end of the meander
    for (const [x, y] of [[40, 163], [125, 160.05], [239, 160], [34.2, 160]]) assert.equal(net(t, x, y).wires.length, n.wires.length, `${x}, ${y}`);
    // plain crossings (D at x 130, V1 at x 200) are not joined
    assert.ok(!n.wires.includes(wireAt(t, 130, 100)) && !n.wires.includes(wireAt(t, 200, 100)));
  });

  test(`${name}: a T-junction without a dot joins; the branch ends on the coil K1 (a circle, its label inside)`, () => {
    const n = net(t, 60, 150);
    assert.ok(near(n.length, 222 + 90));
    assert.equal(n.count, 2);
    assert.deepEqual(ends(n), [`J4 · 2 (${cellName('J4', dxf)})`, `P1 · P1-B (${cellName('P1', dxf)})`, 'K1 (circle)']);
    assert.deepEqual(labels(n), ['W2001 x2'], 'the rotated label beside the branch too');
    assert.deepEqual(net(t, 100, 100).wires.sort(), n.wires.sort(), 'the same net from the branch');
  });

  test(`${name}: a junction dot T joins (to TB2-3, a pin dot in a terminal strip cell); crossings without dots do not`, () => {
    const n = net(t, 60, 140);
    assert.ok(near(n.length, 222 + 85));
    assert.equal(n.junctions, 1, 'one junction dot (a DGN filled circle is two primitives)');
    const tb = n.ends.find((e) => e.pin === 'TB2-3');
    assert.ok(tb && tb.ref === 'TB2' && tb.kind === 'cell', 'TB2 · TB2-3 with the strip name as reference');
    assert.deepEqual(labels(n), ['W3003']);
    for (const [x, y] of [[100, 100], [130, 100], [200, 100], [60, 150]]) assert.ok(!n.wires.includes(wireAt(t, x, y)), `crossing wire at ${x}, ${y} not in the net`);
    // with "crossings connect" the crossing wires join, and everything they cross
    const all = traceNet(t.G, n.seed, { crossings: true });
    for (const [x, y] of [[100, 100], [130, 100], [200, 100], [60, 150], [100, 160], [60, 110]]) assert.ok(all.wires.includes(wireAt(t, x, y)), `${x}, ${y} joined by a crossing`);
    assert.ok(!all.wires.includes(wireAt(t, 118, 130)), 'a wire that crosses nothing stays out');
    assert.ok(!all.wires.includes(wireAt(t, 290, 160)), 'wires on the far side of a connector stay out');
  });

  test(`${name}: a four-way junction dot; a vertical wire crossing four nets; open ends with off-sheet notes`, () => {
    const e = net(t, 180, 125);
    assert.ok(e.wires.includes(wireAt(t, 200, 100)), 'the vertical through the dot');
    assert.ok(!e.wires.includes(wireAt(t, 220, 100)), 'not the one crossing without a dot');
    assert.equal(e.junctions, 1);
    assert.deepEqual(ends(e), ['TB2 · TB2-2 (TERMS)', 'Open end · TO SH 3', 'Open end', 'Open end']);
    assert.deepEqual(labels(e), ['W5000']);
    const d = net(t, 130, 90);
    assert.equal(d.count, 1, 'D crosses A, B, C and the hop of F without joining them');
    assert.deepEqual(ends(d), ['TB2 · TB2-1 (TERMS)', 'Open end · TO SH 2']);
    assert.deepEqual(labels(d), ['W4100'], 'a label rotated 90°');
  });

  test(`${name}: a chain with a hop arc is one wire (exact arc length); the wire crossing the hop is not joined`, () => {
    const f = net(t, 130, 112);
    assert.equal(f.count, 1);
    assert.equal(f.segments, 3);
    assert.ok(near(f.length, 218 + 2 * Math.PI, 1e-6), 'length ' + f.length);
    assert.deepEqual(ends(f), [`J4 · 6 (${cellName('J4', dxf)})`, `P1 · P1-F (${cellName('P1', dxf)})`]);
    assert.ok(!f.wires.includes(wireAt(t, 130, 90)));
  });

  test(`${name}: gaps within the tolerance join, larger ones do not; a wider tolerance joins them`, () => {
    assert.ok(near(t.G.tol, 0.1, 1e-6), 'tolerance from the text height: ' + t.G.tol);
    const h = net(t, 60, 130);
    assert.ok(near(h.length, 56 + 19.98, 1e-6));
    assert.deepEqual(ends(h), [`J4 · 4 (${cellName('J4', dxf)})`, 'Open end']);
    assert.equal(net(t, 118, 130).count, 1, 'the piece 2 units away is a net of its own');
    const G3 = buildNetGraph(t.scene, { tol: 3 });
    assert.equal(G3.tol, 3);
    assert.ok(near(net(t, 60, 130, {}, G3).length, 56 + 19.98 + 13, 1e-6), 'tolerance 3 bridges the gap');
  });

  test(`${name}: two wires on one pin give one end; "through pins" continues across the connector`, () => {
    const g = net(t, 60, 120);
    assert.equal(g.count, 2);
    assert.deepEqual(ends(g), [`J4 · 5 (${cellName('J4', dxf)})`, 'Open end', 'Open end']);
    const a = net(t, 100, 160, { throughPins: true });
    assert.ok(near(a.length, 282 + 11));
    assert.deepEqual(labels(a), ['W9434 x2', 'W9435']);
    assert.deepEqual(ends(a), [`J4 · 1 (${cellName('J4', dxf)})`, `P1 · P1-A (${cellName('P1', dxf)})`, 'Open end']);
    const b = net(t, 60, 150, { throughPins: true });
    assert.ok(b.wires.includes(wireAt(t, 290, 150)) && !b.wires.includes(wireAt(t, 290, 160)), 'each pin continues to its own wire');
  });

  test(`${name}: hidden layers are not traced through; picking a dot, a pin stub, nothing`, () => {
    const L = t.scene.layers.findIndex((l) => l.name === (dxf ? 'DOTS' : 'Level 14'));
    assert.ok(L >= 0);
    const vis = (li) => li !== L;
    const [ox, oy] = t.scene.origin;
    const w = pickWire(t.G, 180 - ox, 125 - oy, 0.5, vis);
    assert.equal(traceNet(t.G, w, { isVisible: vis }).count, 1, 'without the dot level the four-way junction is broken');
    const d = pickWire(t.G, 200.5 - ox, 125.3 - oy, 0.2);
    assert.equal(t.G.role[d], ROLE.DOT, 'a click on the dot picks it');
    assert.ok(traceNet(t.G, d).wires.includes(wireAt(t, 180, 125)), 'tracing from a dot');
    const s = pickWire(t.G, 32 - ox, 140 - oy, 0.5);
    assert.ok(net(t, 60, 140).wires.includes(s), 'a click on the pin stub of J4-3 traces the wire on that pin');
    assert.equal(pickWire(t.G, 150 - ox, 30 - oy, 0.5), -1, 'nothing there');
    assert.equal(pickWire(t.G, 270 - ox, 13 - oy, 0.5), -1, 'title block text is not a wire');
  });

  test(`${name}: copy text`, () => {
    const s = netText(net(t, 60, 150), { name, origin: t.scene.origin, dec: 2, abbr: 'm' });
    assert.equal(s, [`Net W2001 · ${name}`, 'Length 312.00 m · 2 wires · 2 segments', 'Ends (3):',
      `  1. J4 · 2 (${cellName('J4', dxf)}) at X 34.00 Y 150.00`, `  2. P1 · P1-B (${cellName('P1', dxf)}) at X 256.00 Y 150.00`, '  3. K1 (circle) at X 100.00 Y 60.00'].join('\n'));
  });
}

test('edits: after moving the branch away from the T (and deleting a dot) the rebuilt graph has new nets; undo restores them', () => {
  const name = 'dgn-trace.dgn', model = parseDrawing(bytes(name), name), scene = buildScene(model);
  const doc = new EditDoc(model, scene, { bytes: bytes(name) });
  const t = { scene, G: buildNetGraph(scene) };
  const before = net(t, 60, 150);
  const i = model.entities.findIndex((e) => e && e.type === 'line' && e.a && Math.abs(e.a[0] - 100) < 1e-6 && Math.abs(e.a[1] - 150) < 1e-6);
  assert.ok(i >= 0, 'the branch wire');
  const entry = doc.commit('Move', [{ i, before: model.entities[i], after: moveEntity(model.entities[i], 5, -5) }]);
  t.G = buildNetGraph(scene);
  const after = net(t, 60, 150);
  assert.equal(after.count, 1, 'the branch no longer meets the wire');
  assert.ok(near(after.length, 222));
  assert.ok(!ends(after).includes('K1 (circle)'));
  const branch = net(t, 105, 100);
  assert.ok(ends(branch).includes('Open end'), 'the moved branch: open at the top');
  doc.revert(entry);
  t.G = buildNetGraph(scene);
  assert.deepEqual(ends(net(t, 60, 150)), ends(before), 'undo: the T again');
  const k = model.entities.findIndex((e) => e && e.type === 'circle' && e.fill != null && Math.abs(e.c[0] - 200) < 1e-6 && Math.abs(e.c[1] - 125) < 1e-6);
  assert.ok(k >= 0, 'the four-way junction dot');
  doc.commit('Delete', [{ i: k, before: model.entities[k], after: null }]);
  t.G = buildNetGraph(scene);
  assert.equal(net(t, 180, 125).count, 1, 'without its dot the junction is a crossing');
});

test('the graph a slice at a time gives the same nets, and gives up when the drawing changes', async () => {
  const t = open('trace-sheet.dxf');
  const G = await buildNetGraphAsync(t.scene, {}, 0.01);
  assert.deepEqual([...G.role], [...t.G.role]);
  assert.deepEqual(net(t, 60, 140, {}, G).wires, net(t, 60, 140).wires);
  assert.equal(await buildNetGraphAsync(t.scene, {}, 0, () => true), null);
});

test('the existing samples: the DXF schematic rails, its junction dots (circle + solid), terminal blocks with attributes', () => {
  const t = open('schematic.dxf');
  const rail = net(t, 5, 9.5);
  assert.ok(ends(rail).includes('X1 (TERM)') && ends(rail).includes('X3 (TERM)'), 'TERM blocks with their attribute as the pin');
  assert.deepEqual(labels(rail).slice(0, 1), ['+24V']);
  const zero = net(t, 5, 2);
  assert.ok(zero.junctions >= 3, 'the dots on the 0 V rail');
  assert.ok(zero.count >= 4, 'the three branches join the rail at their dots');
  const w = open('dgn-wiring.dgn');
  const n = net(w, 60, 95);
  assert.deepEqual(ends(n), ['TB1-1 (TERM)', 'Open end']);
  assert.deepEqual(labels(n), ['W101']);
});

test('performance: 50 000 entities (the trace sheet tiled 35 x 35 as blocks, lines and labels): build < 300 ms, a trace < 50 ms', () => {
  const w = new DxfWriter({ version: 'AC1015', insunits: 6 });
  w.layer('WIRES', 3).layer('LABELS', 2).layer('DOTS', 3).layer('CELLS', 7);
  J.cells.forEach((c, k) => w.block('C' + k, [0, 0], (b) => {
    b.lwpolyline(c.frame.slice(0, -1), true, { layer: '0' });
    for (const l of c.lines || []) b.line(l[0], l[1], { layer: '0' });
    for (const t of c.texts) b.text(t.s, t.p, { h: t.h }, { layer: '0' });
  }));
  let count = 0;
  for (let ty = 0; ty < 35; ty++) {
    for (let tx = 0; tx < 35; tx++) {
      const dx = tx * 310, dy = ty * 210, P = (p) => [p[0] + dx, p[1] + dy];
      J.cells.forEach((c, k) => { w.insert('C' + k, [dx, dy], {}, { layer: 'CELLS' }); count++; });
      for (const x of J.wires) {
        const pts = x.chain ? [x.chain[0].pts[0], x.chain[2].pts[1]] : x.pts;
        if (pts.length === 2) w.line(P(pts[0]), P(pts[1]), { layer: 'WIRES' }); else w.lwpolyline(pts.map(P), false, { layer: 'WIRES' });
        count++;
      }
      for (const d of J.dots) { w.hatch([[[d.c[0] - d.r + dx, d.c[1] + dy, 1], [d.c[0] + d.r + dx, d.c[1] + dy, 1]]], { solid: true }, { layer: 'DOTS' }); count++; }
      for (const t of J.texts) { w.text(t.s, P(t.p), { h: t.h, rot: t.rot || 0 }, { layer: 'LABELS' }); count++; }
    }
  }
  assert.ok(count >= 50000, 'entities: ' + count);
  const scene = buildScene(parseDrawing(new TextEncoder().encode(w.toString()), 'tiled.dxf'));
  const ms = [];
  let G;
  for (let k = 0; k < 3; k++) { G = buildNetGraph(scene); ms.push(G.ms); }
  const build = Math.min(...ms);
  const [ox, oy] = scene.origin, x = 17 * 310 + 60 - ox, y = 17 * 210 + 140 - oy;
  const tr = [];
  let n;
  for (let k = 0; k < 5; k++) { n = traceNet(G, pickWire(G, x, y, 0.5), {}); tr.push(n.ms); }
  const all = traceNet(G, pickWire(G, x, y, 0.5), { crossings: true, throughPins: true });
  console.log(`  # 50k trace: build ${ms.map((v) => v.toFixed(0)).join(' / ')} ms, trace ${Math.min(...tr).toFixed(2)} ms, with crossings + pins ${all.ms.toFixed(1)} ms (${all.wires.length} wires)`);
  assert.equal(n.count, 2, 'net C of the middle tile');
  assert.ok(build < 300, `build ${build.toFixed(0)} ms`);
  assert.ok(Math.min(...tr) < 50, 'trace ms');
});
