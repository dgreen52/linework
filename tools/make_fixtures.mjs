#!/usr/bin/env node
// Generates every SYNTHETIC DXF sample and test fixture. No real drawings are read or copied.
//   node tools/make_fixtures.mjs           -> samples/*.dxf, tests/fixtures/*.dxf (+ stress-50k.dxf)
// DGN fixtures come from tools/make_dgn_fixtures.py (needs Python + GDAL).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DxfWriter } from '../samples/gen/dxf-writer.js';
import { housePlan, bracket, schematic } from '../samples/gen/samples.js';
import { makeStressDxf } from '../samples/gen/stress.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = join(ROOT, 'samples');
const FIX = join(ROOT, 'tests', 'fixtures');
mkdirSync(SAMPLES, { recursive: true });
mkdirSync(FIX, { recursive: true });

const out = (dir, name, data) => {
  writeFileSync(join(dir, name), data);
  console.log('wrote', join(dir, name).replace(ROOT, '.'), `${(Buffer.byteLength(data) / 1024).toFixed(1)} KB`);
};

// ---------------------------------------------------------------- samples (also used as fixtures)
out(SAMPLES, 'house-plan.dxf', housePlan());
out(SAMPLES, 'bracket.dxf', bracket());
out(SAMPLES, 'schematic.dxf', schematic());

// ---------------------------------------------------------------- stress (not committed)
if (!process.argv.includes('--no-stress')) {
  const s = makeStressDxf();
  out(FIX, 'stress-50k.dxf', s.text);
}

// ---------------------------------------------------------------- edge cases
// 1) CRLF line endings + cp1252 bytes + %% control codes
{
  const w = new DxfWriter({ version: 'AC1015', insunits: 4, codepage: 'ANSI_1252', eol: '\r\n' });
  w.layer('NOTES', 5);
  w.text('Café Ø25 ±0.1 50°C', [0, 0], { h: 5 }, { layer: 'NOTES' });
  w.text('%%c12 %%p0.05 90%%d 100%%%', [0, -10], { h: 5 }, { layer: 'NOTES' });
  w.mtext('Line one\\PLíne twö', [0, -20], { h: 5 }, { layer: 'NOTES' });
  w.line([0, -30], [100, -30], { layer: 'NOTES' });
  const text = w.toString();
  // encode as Windows-1252 (all chars used here are in Latin-1, which matches cp1252 for them)
  out(FIX, 'edge-crlf-cp1252.dxf', Buffer.from(text, 'latin1'));
}
// 2) UTF-8 R2018 with \U+ escapes and a BOM
{
  const w = new DxfWriter({ version: 'AC1032', insunits: 6 });
  w.layer('UNICODE', 3);
  w.text('Größe 東京 \\U+2300 Ω', [0, 0], { h: 1 }, { layer: 'UNICODE' });
  w.line([0, -2], [10, -2], { layer: 'UNICODE' });
  out(FIX, 'edge-utf8-bom.dxf', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(w.toString(), 'utf8')]));
}
// 3) ENTITIES section only: no HEADER, no TABLES, no BLOCKS
{
  const lines = ['0', 'SECTION', '2', 'ENTITIES'];
  const ent = (...g) => { for (const [c, v] of g) lines.push(String(c), String(v)); };
  ent([0, 'LINE'], [8, 'UNDEFINED_LAYER'], [10, 0], [20, 0], [30, 0], [11, 50], [21, 0], [31, 0]);
  ent([0, 'LINE'], [8, 'UNDEFINED_LAYER'], [62, 1], [10, 50], [20, 0], [30, 0], [11, 50], [21, 30], [31, 0]);
  ent([0, 'CIRCLE'], [8, 'Another Layer'], [10, 25], [20, 15], [30, 0], [40, 10]);
  ent([0, 'TEXT'], [8, '0'], [10, 0], [20, 40], [30, 0], [40, 3], [1, 'NO HEADER']);
  lines.push('0', 'ENDSEC', '0', 'EOF');
  out(FIX, 'edge-entities-only.dxf', lines.join('\n') + '\n');
}
// 4) unknown / unsupported entities mixed with valid ones
{
  const w = new DxfWriter({ version: 'AC1018', insunits: 4 });
  w.layer('A', 1);
  w.line([0, 0], [10, 0], { layer: 'A' });
  w.raw('3DSOLID', [[8, 'A'], [70, 1], [1, 'opaque modeler data']], 'AcDbModelerGeometry');
  w.raw('REGION', [[8, 'A'], [70, 1], [1, 'opaque']], 'AcDbModelerGeometry');
  w.raw('ACME_WIDGET', [[8, 'A'], [10, 1], [20, 2], [1, 'custom object']], 'AcDbAcmeWidget');
  w.raw('ACME_WIDGET', [[8, 'A'], [10, 3], [20, 4]], 'AcDbAcmeWidget');
  w.raw('IMAGE', [[8, 'A'], [10, 0], [20, 0], [11, 1], [21, 0], [12, 0], [22, 1]], 'AcDbRasterImage');
  w.raw('WIPEOUT', [[8, 'A'], [10, 0], [20, 0]], 'AcDbWipeout');
  w.circle([5, 5], 2, { layer: 'A' });
  out(FIX, 'edge-unknown-entities.dxf', w.toString());
}
// 5) huge coordinates far from the origin (state-plane style) with sub-millimetre detail
{
  const w = new DxfWriter({ version: 'AC1024', insunits: 6 });
  const X = 6543210.125, Y = 1987654.25;
  w.layer('SURVEY', 2).layer('DETAIL', 1);
  w.lwpolyline([[X, Y], [X + 40, Y], [X + 40, Y + 25], [X, Y + 25]], true, { layer: 'SURVEY' });
  w.line([X + 10, Y + 10], [X + 10.25, Y + 10], { layer: 'DETAIL' }); // 0.25 m
  w.line([X + 10, Y + 10.002], [X + 10.25, Y + 10.002], { layer: 'DETAIL' }); // 2 mm apart
  w.circle([X + 20, Y + 12.5], 0.005, { layer: 'DETAIL' });
  w.text('FAR FROM ORIGIN', [X + 1, Y + 1], { h: 1 }, { layer: 'SURVEY' });
  out(FIX, 'edge-far-coords.dxf', w.toString());
}
// 6) zero-length / degenerate entities
{
  const w = new DxfWriter({ version: 'AC1015', insunits: 4 });
  w.layer('Z', 7);
  w.line([5, 5], [5, 5], { layer: 'Z' });
  w.circle([1, 1], 0, { layer: 'Z' });
  w.arc([2, 2], 1, 30, 30, { layer: 'Z' });
  w.lwpolyline([[3, 3]], false, { layer: 'Z' });
  w.lwpolyline([[0, 0], [0, 0], [0, 0]], true, { layer: 'Z' });
  w.lwpolyline([[0, 0, 1], [0, 0, 0]], false, { layer: 'Z' }); // bulge between identical points
  w.ellipse([0, 0], [0, 0], 1, 0, Math.PI * 2, { layer: 'Z' });
  w.text('', [0, 0], { h: 1 }, { layer: 'Z' });
  w.text('ZERO HEIGHT', [0, 0], { h: 0 }, { layer: 'Z' });
  w.insert('NO_SUCH_BLOCK', [0, 0], {}, { layer: 'Z' });
  w.insert('EMPTY', [0, 0], { sx: 0 }, { layer: 'Z' });
  w.block('EMPTY', [0, 0], () => {});
  w.line([0, 0], [10, 10], { layer: 'Z' }); // the one real line
  out(FIX, 'edge-zero-length.dxf', w.toString());
}
// 7) nested blocks with mirroring, non-uniform scale, rotation, MINSERT arrays and OCS extrusion
{
  const w = new DxfWriter({ version: 'AC1015', insunits: 4 });
  w.layer('NEST', 7).layer('INNER', 1).layer('ARRAY', 4).layer('OCS', 6);
  // FLAG: a right-pointing flag, base at its pole foot
  w.block('FLAG', [0, 0], (b) => {
    b.line([0, 0], [0, 10], { layer: '0' });
    b.lwpolyline([[0, 10], [6, 8], [0, 6]], true, { layer: 'INNER' });
    b.text('F', [1, 7], { h: 1.5 }, { layer: '0' });
  });
  // PAIR: two flags, the second mirrored in X
  w.block('PAIR', [0, 0], (b) => {
    b.insert('FLAG', [0, 0], {}, { layer: '0' });
    b.insert('FLAG', [20, 0], { sx: -1 }, { layer: '0' });
  });
  // TRIPLE: nests PAIR scaled & rotated -> three levels deep
  w.block('TRIPLE', [10, 0], (b) => {
    b.insert('PAIR', [10, 0], { sx: 0.5, sy: 0.5, rot: 90 }, { layer: '0' });
    b.circle([10, 0], 1, { layer: '0', color: 0 }); // BYBLOCK colour
  });
  w.insert('PAIR', [0, 0], {}, { layer: 'NEST' });
  w.insert('PAIR', [0, -30], { sy: -1 }, { layer: 'NEST' });            // mirrored in Y
  w.insert('TRIPLE', [60, 0], { sx: 2, sy: 2, rot: 45 }, { layer: 'NEST', color: 3 });
  w.insert('FLAG', [100, 0], { cols: 3, rows: 2, dc: 12, dr: 15 }, { layer: 'ARRAY' });
  w.insert('FLAG', [100, -40], { sx: -1, sy: -1 }, { layer: 'NEST' });  // rotated 180 via double mirror
  // arc in a mirrored OCS (extrusion 0,0,-1): OCS centre (10,0) -> WCS (-10,0)
  w.arc([10, 0], 5, 0, 90, { layer: 'OCS', extrusion: [0, 0, -1] });
  w.circle([10, 0], 2, { layer: 'OCS', extrusion: [0, 0, -1] });
  out(FIX, 'edge-nested-mirror.dxf', w.toString());
}
// 8) truncated file (cut mid-entity) -> partial load with a warning
{
  const full = bracket();
  out(FIX, 'edge-truncated.dxf', full.slice(0, Math.floor(full.length * 0.8)));
}
// 9) binary DXF signature (only the header bytes matter for detection)
{
  const sig = Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00', 'latin1');
  out(FIX, 'edge-binary.dxf', Buffer.concat([sig, Buffer.alloc(64, 0)]));
}
// 10) a "DWG" stub: just the version magic, to exercise the friendly message
out(FIX, 'edge-fake.dwg', Buffer.concat([Buffer.from('AC1032', 'latin1'), Buffer.alloc(122, 0)]));
// 11) garbage / not a drawing
out(FIX, 'edge-garbage.dxf', 'this is not a drawing\njust some text\n\u0000\u0001\u0002');
// 12) old R12 file with group codes padded with spaces, LF only, POLYLINE with bulges
{
  const w = new DxfWriter({ version: 'AC1009', insunits: null, padCodes: true, handles: false });
  w.layer('R12', 2);
  w.polyline([[0, 0, 0], [10, 0, 1], [10, 10, 0], [0, 10, 0]], true, { layer: 'R12' }); // semicircle bulge on the right
  out(FIX, 'edge-r12-padded.dxf', w.toString());
}
// 13) paper-space-only drawing (empty model space)
{
  const w = new DxfWriter({ version: 'AC1015', insunits: 4 });
  w.layer('SHEET', 7);
  w.line([0, 0], [297, 0], { layer: 'SHEET', paper: true });
  w.line([297, 0], [297, 210], { layer: 'SHEET', paper: true });
  out(FIX, 'edge-paperspace.dxf', w.toString());
}
// 14) line weights (group 370): explicit, ByLayer (layer weights), ByBlock inside a block, default
{
  const w = new DxfWriter({ version: 'AC1015', insunits: 4 });
  w.layer('THIN', 7, 'CONTINUOUS', { lw: 13 }).layer('HEAVY', 1, 'CONTINUOUS', { lw: 100 }).layer('PLAIN', 3);
  w.block('TAG', [0, 0], (b) => {
    b.line([0, 0], [10, 0], { layer: '0', lw: -2 }); // ByBlock: takes the insert's weight
    b.line([0, 2], [10, 2], { layer: 'THIN' }); // ByLayer inside the block
  });
  w.line([0, 0], [100, 0], { layer: 'PLAIN', lw: 200 }); // 2.00 mm
  w.line([0, 10], [100, 10], { layer: 'PLAIN', lw: 35 });
  w.line([0, 20], [100, 20], { layer: 'HEAVY' }); // ByLayer -> 1.00 mm
  w.line([0, 30], [100, 30], { layer: 'THIN', lw: -1 }); // explicit ByLayer -> 0.13 mm
  w.line([0, 40], [100, 40], { layer: 'PLAIN', lw: -3 }); // default
  w.circle([50, 70], 15, { layer: 'PLAIN', lw: 50 });
  w.insert('TAG', [0, 90], {}, { layer: 'PLAIN', lw: 70 });
  out(FIX, 'edge-lineweights.dxf', w.toString());
}
console.log('done');
