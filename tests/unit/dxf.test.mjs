import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, bytes, findSegment, conics, texts, polys, near, ROOT } from './helpers.mjs';
import { parseDrawing, detectFormat } from '../../src/formats/detect.js';
import { parseDxf, mtextToPlain, decodeTextCodes } from '../../src/formats/dxf.js';
import { FG } from '../../src/model.js';
import { ACI } from '../../src/palettes.js';
import { KIND } from '../../src/scene.js';

const layer = (model, name) => model.layers.find((l) => l.name === name);

test('ACI palette spot checks', () => {
  assert.equal(ACI[1], 0xff0000);
  assert.equal(ACI[2], 0xffff00);
  assert.equal(ACI[3], 0x00ff00);
  assert.equal(ACI[4], 0x00ffff);
  assert.equal(ACI[5], 0x0000ff);
  assert.equal(ACI[6], 0xff00ff);
  assert.equal(ACI[8], 0x808080 - 0x010101); // 0x7f7f7f
  assert.equal(ACI[250], 0x333333 + 0x212121); // 0x545454
});

test('house plan: header, units, layers and colours', () => {
  const { model, scene } = load('house-plan.dxf');
  assert.equal(model.version, 'AC1027');
  assert.equal(model.units.abbr, 'mm');
  assert.deepEqual(model.header.extents, [-1500, -2500, 13500, 9500]);
  assert.equal(layer(model, 'WALLS').color, FG); // ACI 7 = foreground (white/black)
  assert.equal(layer(model, 'DOORS').color, 0xff0000);
  assert.equal(layer(model, 'WINDOWS').color, 0x00ffff);
  assert.equal(layer(model, 'DIMS').color, 0x00ff00);
  assert.equal(layer(model, 'FURNITURE').color, ACI[8]);
  assert.equal(layer(model, 'DEFPOINTS').visible, false, 'negative ACI = layer off');
  assert.equal(model.stats.byType.LWPOLYLINE, 20);
  assert.equal(model.stats.byType.INSERT, 19);
  assert.equal(model.stats.byType.DIMENSION, 3);
  assert.equal(model.stats.byType.TEXT, 12);
  assert.equal(model.stats.byType.HATCH, 4);
  assert.deepEqual(scene.notShown, {});
  assert.ok(Object.keys(model.blocks).includes('DOOR'));
  // the outer wall corner points are exact
  assert.ok(findSegment(scene, [0, 0], [12000, 0]));
  // computed scene extents cover the walls and dimensions
  const [x0, y0, x1, y1] = scene.extents;
  assert.ok(x0 + scene.origin[0] <= -700 && x1 + scene.origin[0] >= 12700);
  assert.ok(y0 + scene.origin[1] <= -1300 && y1 + scene.origin[1] >= 8000);
});

test('house plan: block inserts with rotation and mirroring', () => {
  const { scene } = load('house-plan.dxf');
  // DOOR block: leaf (0,0)-(0,900), swing arc centre (0,0) r 900 from 0 to 90 degrees.
  // front door at (5300,7800) rot 180, sx -1: S(-1,1) (0,900) -> (0,900); R180 -> (0,-900); +P -> (5300,6900)
  const leaf = findSegment(scene, [5300, 7800], [5300, 6900]);
  assert.ok(leaf, 'mirrored+rotated door leaf');
  assert.equal(leaf.layer, 'DOORS', 'layer-0 entities inherit the insert layer');
  assert.equal(leaf.color, 0xff0000, 'BYLAYER colour resolves through the insert layer');
  // bath door at (8600,4100) rot 90, sy -1: (0,900) -> (0,-900) -> R90 (900,0) -> (9500,4100)
  assert.ok(findSegment(scene, [8600, 4100], [9500, 4100]), 'Y-mirrored + rotated');
  // kitchen door at (8600,1800) rot 270, sx -1: (0,900) -> R270 (900,0) -> (9500,1800)
  assert.ok(findSegment(scene, [8600, 1800], [9500, 1800]));
  // living door at (5000,2600) rot 90: (0,900) -> (-900,0) -> (4100,2600)
  assert.ok(findSegment(scene, [5000, 2600], [4100, 2600]));
  // WINDOW scaled 1.5 in X at (6200,7800): (0,0)-(1200,0) -> (6200,7800)-(8000,7800)
  assert.ok(findSegment(scene, [6200, 7800], [8000, 7800]));
  // swing arcs: exact centre and radius; a mirrored insert keeps a 90-degree sweep and lands on
  // the right points: bath door arc runs from (9500,4100) to (8600,5000)
  const arc = conics(scene).find((c) => near(c.c[0], 8600) && near(c.c[1], 4100));
  assert.ok(arc && near(arc.r, 900));
  assert.ok(near(Math.abs(arc.t1 - arc.t0), Math.PI / 2, 1e-9));
  const ends = [arc.start, arc.end].map((p) => p.map((v) => Math.round(v * 1e6) / 1e6).join(',')).sort();
  assert.deepEqual(ends, ['8600,5000', '9500,4100']);
});

test('house plan: text, mtext and dimension blocks', () => {
  const { scene } = load('house-plan.dxf');
  const t = texts(scene);
  const living = t.find((x) => x.s === 'LIVING / DINING');
  assert.ok(living);
  assert.equal(living.align, 1, 'centre aligned');
  assert.ok(t.find((x) => x.s === '31.4 m²'), 'UTF-8 superscript');
  assert.ok(t.find((x) => x.s === 'GROUND FLOOR PLAN'));
  assert.ok(t.find((x) => x.s.startsWith('Scale 1:100')), 'MTEXT \\P paragraph split');
  assert.ok(t.find((x) => x.s === '12000'), 'dimension text from the *D block');
  assert.ok(t.find((x) => x.s === '8000'));
  const n = t.find((x) => x.s === 'N');
  assert.ok(n, 'text inside a block');
});

test('bracket: bulges, slot arcs, hatch, nested + mirrored blocks, attributes', () => {
  const { model, scene } = load('bracket.dxf');
  assert.equal(model.units.abbr, 'mm');
  assert.deepEqual(model.ltypes.HIDDEN.pattern, [6, -3]);
  assert.deepEqual(model.ltypes.CENTER.pattern, [18, -3, 3, -3]);
  // L-profile inside fillet: bulge -tan(22.5deg) from (20,10) to (10,20) => centre (20,20), r 10
  const fillet = conics(scene).find((c) => near(c.c[0], 20, 1e-6) && near(c.c[1], 20, 1e-6) && near(c.r, 10, 1e-6));
  assert.ok(fillet, 'fillet arc from bulge');
  assert.ok(near(fillet.t1 - fillet.t0, Math.PI / 2, 1e-6));
  // slot: two semicircles r=5 centred at (72.5,130) and (62.5,130)
  const slotArcs = conics(scene).filter((c) => near(c.c[1], 130) && near(c.r, 5) && (near(c.c[0], 72.5) || near(c.c[0], 62.5)));
  assert.equal(slotArcs.length, 2);
  for (const a of slotArcs) assert.ok(near(a.t1 - a.t0, Math.PI, 1e-9));
  // right semicircle bulges right (passes x = 77.5), left one bulges left (x = 57.5)
  const right = slotArcs.find((a) => near(a.c[0], 72.5)), left = slotArcs.find((a) => near(a.c[0], 62.5));
  const mid = (a) => { const t = (a.t0 + a.t1) / 2; return [a.c[0] + a.u[0] * Math.cos(t) + a.v[0] * Math.sin(t), a.c[1] + a.u[1] * Math.cos(t) + a.v[1] * Math.sin(t)]; };
  assert.ok(near(mid(right)[0], 77.5, 1e-9));
  assert.ok(near(mid(left)[0], 57.5, 1e-9));
  // nested block: BOLT (rot 30) contains WASHER circles r=9 and r=5.5 at the hole centre
  const washers = conics(scene).filter((c) => near(c.c[0], 40) && near(c.c[1], 150) && (near(c.r, 9) || near(c.r, 5.5)));
  assert.equal(washers.length, 2);
  // DETAIL A: BOLT at (300,140) sx=-2 sy=2 rot 15 -> washer radius doubles
  const detail = conics(scene).filter((c) => near(c.c[0], 300) && near(c.c[1], 140));
  assert.deepEqual(detail.map((c) => Math.round(c.r * 1000) / 1000).sort((a, b) => a - b), [11, 18]);
  // hexagon vertex (8,0) -> S(-2,2) -> (-16,0) -> R15 -> (-16cos15, -16sin15) + (300,140)
  const a15 = (15 * Math.PI) / 180;
  const hv = [300 - 16 * Math.cos(a15), 140 - 16 * Math.sin(a15)];
  assert.ok(polys(scene).some((p) => p.pts.some((q) => near(q[0], hv[0], 1e-9) && near(q[1], hv[1], 1e-9))), 'mirrored nested hexagon vertex');
  // attributes: visible ones drawn, invisible + non-constant ATTDEF not drawn
  const t = texts(scene).map((x) => x.s);
  for (const s of ['ANGLE BRACKET', 'LW-0001', '1:1', 'B', 'EXAMPLE WORKS (FICTITIOUS)']) assert.ok(t.includes(s), s);
  assert.ok(!t.includes('INVISIBLE'));
  assert.ok(!t.includes('TITLE'), 'ATTDEF default text is not drawn inside an INSERT');
  assert.ok(t.includes('2 x Ø10 THRU'), '%%c -> diameter sign');
  assert.ok(t.some((s) => s.includes('±0.2')), '%%p -> plus/minus in MTEXT');
  // pattern hatch drawn as outline (closed poly) on HATCH layer
  assert.ok(polys(scene).some((p) => p.layer === 'HATCH'));
  // the spline is approximated to a polyline that starts/ends at its end control points
  const spline = polys(scene).find((p) => p.layer === 'OUTLINE' && p.pts.length > 30);
  assert.ok(spline);
  assert.ok(near(spline.pts[0][0], 165) && near(spline.pts[0][1], 90));
  assert.ok(near(spline.pts.at(-1)[0], 235) && near(spline.pts.at(-1)[1], 92));
  // ellipse: major (6,0), ratio .5 -> minor (0,3)
  const el = conics(scene).find((c) => near(c.c[0], 200) && near(c.c[1], 55));
  assert.ok(el && near(el.u[0], 6) && near(el.v[1], 3));
  // half ellipse with a vertical major axis: params 0..pi
  const half = conics(scene).find((c) => near(c.c[0], 200) && near(c.c[1], 30));
  assert.ok(half && near(half.t1 - half.t0, Math.PI, 1e-9));
});

test('schematic (R12): POLYLINE/VERTEX, padded group codes, text rotation and alignment', () => {
  const { model, scene } = load('schematic.dxf');
  assert.equal(model.version, 'AC1009');
  assert.equal(model.units.code, 0);
  assert.ok(model.stats.byType.POLYLINE >= 2);
  assert.equal(model.stats.byType.VERTEX, undefined, 'VERTEX records are folded into POLYLINE');
  const t = texts(scene);
  const r1 = t.find((x) => x.s === 'R1 4k7');
  assert.ok(r1);
  // rotation 90: baseline vector points +Y
  assert.ok(Math.abs(r1.m[0]) < 1e-9 && r1.m[1] > 0);
  const up = t.find((x) => x.s === 'UPSIDE');
  assert.ok(up.m[0] < 0, 'rotation 180 keeps the text upside down as drawn');
  // alignment key: 12 combinations, all present
  const keys = t.filter((x) => /^[LCR]-(BASE|BOT|MID|TOP)$/.test(x.s));
  assert.equal(keys.length, 12);
  assert.equal(keys.find((x) => x.s === 'R-TOP').align, 2);
  assert.equal(keys.find((x) => x.s === 'C-MID').align, 1);
  // attribute in TERM block instance
  assert.ok(t.find((x) => x.s === 'X2'));
  // resistor zig-zag polyline inside a rotated block: 10 vertices
  assert.ok(polys(scene).some((p) => p.pts.length === 10 && p.layer === 'SYMBOLS'));
});

test('edge: CRLF + cp1252 + %% codes', () => {
  const { model, scene } = load('edge-crlf-cp1252.dxf');
  assert.equal(model.header.encoding, 'windows-1252');
  const t = texts(scene).map((x) => x.s);
  assert.ok(t.includes('Café Ø25 ±0.1 50°C'));
  assert.ok(t.includes('Ø12 ±0.05 90° 100%'));
  assert.ok(t.includes('Line one') && t.includes('Líne twö'));
  assert.ok(findSegment(scene, [0, -30], [100, -30]));
});

test('edge: UTF-8 with BOM and \\U+ escapes', () => {
  const { model, scene } = load('edge-utf8-bom.dxf');
  assert.equal(model.units.abbr, 'm');
  assert.ok(texts(scene).some((x) => x.s === 'Größe 東京 ⌀ Ω'));
});

test('edge: ENTITIES-only file creates layers on the fly', () => {
  const { model, scene } = load('edge-entities-only.dxf');
  assert.ok(layer(model, 'UNDEFINED_LAYER'));
  assert.ok(layer(model, 'Another Layer'));
  assert.equal(scene.n, 3);
  assert.equal(scene.texts.length, 1);
});

test('edge: unknown entities are skipped and reported', () => {
  const { scene } = load('edge-unknown-entities.dxf');
  assert.deepEqual(scene.notShown, { '3DSOLID': 1, REGION: 1, ACME_WIDGET: 2, IMAGE: 1, WIPEOUT: 1 });
  assert.equal(scene.n, 2);
});

test('edge: huge coordinates keep sub-millimetre precision via the local origin', () => {
  const { scene } = load('edge-far-coords.dxf');
  assert.ok(Math.abs(scene.origin[0] - 6543230.125) < 1e-6);
  // local coordinates are small
  for (let k = 0; k < scene.coords.length; k++) assert.ok(Math.abs(scene.coords[k]) < 100);
  // a 0.25 m line and a parallel line 2 mm away stay distinct and exact (also in float32)
  const ls = polys(scene).filter((p) => p.layer === 'DETAIL');
  assert.equal(ls.length, 2);
  const local = ls.map((p) => scene.coords.subarray(scene.start[p.i] * 2, scene.start[p.i] * 2 + 4));
  for (const c of local) assert.ok(Math.abs(Math.fround(c[2]) - Math.fround(c[0]) - 0.25) < 1e-5);
  assert.ok(Math.abs(Math.fround(local[1][1]) - Math.fround(local[0][1]) - 0.002) < 1e-5);
});

test('edge: zero-length and degenerate entities never crash', () => {
  const { model, scene } = load('edge-zero-length.dxf');
  assert.ok(findSegment(scene, [0, 0], [10, 10]));
  assert.ok(scene.notShown['Missing block "NO_SUCH_BLOCK"'] === 1);
  assert.ok(model.stats.warnings.some((w) => /zero X scale/.test(w)));
  for (let k = 0; k < scene.coords.length; k++) assert.ok(Number.isFinite(scene.coords[k]) || Number.isNaN(scene.coords[k]));
});

test('edge: nested blocks with mirroring, BYBLOCK colour, MINSERT arrays and OCS', () => {
  const { scene } = load('edge-nested-mirror.dxf');
  // TRIPLE (base 10,0) at (60,0) s=2 rot 45 > PAIR at (10,0) s=.5 rot 90 > FLAG at (20,0) sx=-1
  // pole (0,0)-(0,10) -> world (45.858,14.142)-(38.787,7.071)  (derived by hand)
  const r2 = Math.SQRT1_2;
  assert.ok(findSegment(scene, [60 - 20 * r2, 20 * r2], [60 - 30 * r2, 10 * r2], 1e-9), 'three-level nested mirrored pole');
  // BYBLOCK circle inside TRIPLE takes the INSERT colour (ACI 3)
  const byblock = conics(scene).find((c) => near(c.c[0], 60) && near(c.c[1], 0) && near(c.r, 2));
  assert.ok(byblock);
  assert.equal(byblock.color, 0x00ff00);
  // PAIR mirrored in Y at (0,-30): flag pole (0,0)-(0,10) -> (0,-30)-(0,-40)
  assert.ok(findSegment(scene, [0, -30], [0, -40]));
  // MINSERT 3 x 2 with spacing 12 / 15
  for (const x of [100, 112, 124]) for (const y of [0, 15]) assert.ok(findSegment(scene, [x, y], [x, y + 10]), `array ${x},${y}`);
  // double mirror == 180 degree rotation: pole (100,-40)-(100,-50)
  assert.ok(findSegment(scene, [100, -40], [100, -50]));
  // OCS extrusion (0,0,-1): centre (10,0) -> (-10,0); arc 0..90 runs (-15,0) -> (-10,5)
  const ocs = conics(scene).find((c) => near(c.c[0], -10) && near(c.c[1], 0) && near(c.r, 5));
  assert.ok(ocs);
  assert.ok(near(ocs.start[0], -15) && near(ocs.start[1], 0));
  assert.ok(near(ocs.end[0], -10) && near(ocs.end[1], 5));
  // mirrored text inside the mirrored flag: baseline vector points -X
  const fs = texts(scene).filter((t) => t.s === 'F');
  assert.ok(fs.some((t) => t.m[0] < 0) && fs.some((t) => t.m[0] > 0));
});

test('edge: truncated file keeps what was read and warns', () => {
  const { model, scene } = load('edge-truncated.dxf');
  assert.ok(scene.n > 10);
  assert.ok(model.stats.warnings.some((w) => /ended early/.test(w)));
});

test('edge: binary DXF, DWG, garbage and empty input give friendly errors', () => {
  assert.equal(detectFormat(bytes('edge-binary.dxf'), 'edge-binary.dxf'), 'dxf-binary');
  assert.throws(() => parseDrawing(bytes('edge-binary.dxf'), 'x.dxf'), (e) => e.code === 'binary-dxf' && /ASCII DXF/.test(e.message));
  assert.equal(detectFormat(bytes('edge-fake.dwg'), 'edge-fake.dwg'), 'dwg');
  assert.throws(() => parseDrawing(bytes('edge-fake.dwg'), 'x.dwg'), (e) => e.code === 'dwg' && /export the drawing to DXF/.test(e.message));
  assert.throws(() => parseDrawing(bytes('edge-garbage.dxf'), 'edge-garbage.dxf'), (e) => !!e.code);
  assert.throws(() => parseDrawing(new Uint8Array(0), 'empty.dxf'), (e) => e.code === 'empty');
});

test('edge: R12 padded codes + POLYLINE bulge', () => {
  const { scene } = load('edge-r12-padded.dxf');
  const arcs = conics(scene);
  assert.equal(arcs.length, 1);
  assert.ok(near(arcs[0].c[0], 10) && near(arcs[0].c[1], 5) && near(arcs[0].r, 5));
});

test('edge: paper-space-only drawing falls back to the layout', () => {
  const { model, scene } = load('edge-paperspace.dxf');
  assert.equal(scene.n, 2);
  assert.ok(model.stats.warnings.some((w) => /paper-space/.test(w)));
});

test('text helpers', () => {
  assert.equal(decodeTextCodes('%%c5 %%d %%p %%%'), 'Ø5 ° ± %');
  assert.equal(mtextToPlain('{\\fArial|b1;Bold}\\Pnext\\~line \\S1/2; \\U+00B2'), 'Bold\nnext\u00a0line 1/2 ²');
  assert.equal(mtextToPlain('a\\\\b \\{c\\}'), 'a\\b {c}');
});

test('string input and unknown sections are tolerated', () => {
  const s = '0\nSECTION\n2\nOBJECTS\n0\nDICTIONARY\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n';
  const m = parseDxf(s);
  assert.equal(m.entities.length, 1);
});

test('stress fixture: 50k+ entities parse and index quickly', { skip: !existsSync(join(ROOT, 'tests/fixtures/stress-50k.dxf')) }, () => {
  const t0 = performance.now();
  const { model, scene } = load('stress-50k.dxf');
  const ms = performance.now() - t0;
  assert.equal(model.entities.length, 53100);
  assert.ok(scene.n >= 53100);
  assert.equal(scene.texts.length, 9000);
  assert.ok(ms < 8000, `parse+scene took ${ms.toFixed(0)} ms`);
  console.log(`# stress-50k: ${model.entities.length} entities -> ${scene.n} primitives + ${scene.texts.length} texts in ${ms.toFixed(0)} ms (Node)`);
  // grid index covers every item exactly once
  assert.equal(scene.grid.items.length, scene.n + scene.texts.length);
  assert.equal(scene.kind.filter((k) => k === KIND.CONIC).length > 0, true);
});

test('an empty section (e.g. CLASSES) does not swallow the next one', () => {
  const txt = ['0', 'SECTION', '2', 'CLASSES', '0', 'ENDSEC', '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '1',
    '0', 'LAYER', '2', 'RED', '70', '0', '62', '1', '6', 'CONTINUOUS', '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', 'RED', '10', '0', '20', '0', '11', '1', '21', '1', '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const model = parseDxf(txt);
  const L = model.layers.find((l) => l.name === 'RED');
  assert.equal(L.aci, 1, 'layer table read after an empty section');
  assert.equal(model.entities.length, 1);
});
