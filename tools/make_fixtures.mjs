#!/usr/bin/env node
// Generates every SYNTHETIC DXF sample and test fixture. No real drawings are read or copied.
//   node tools/make_fixtures.mjs           -> samples/*.dxf, tests/fixtures/*.dxf (+ stress-50k.dxf)
// DGN fixtures come from tools/make_dgn_fixtures.py (needs Python + GDAL).
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
// 14) entity and table variants for the DWG reader (converted to DWG by make_dwg_fixtures.mjs):
//     hidden layers, line types, OCS, 3D polylines, meshes, text alignments, MINSERT, constant
//     attributes, hatch edges and patterns, weighted and fit-point splines, more dimension types,
//     leaders, 3DFACE/TRACE, invisible items, paper space
{
  const w = new DxfWriter({ version: 'AC1015', insunits: 4 });
  w.ltype('DASHED', 'Dashed __ __', [10, -5]);
  w.style('NARROW', { width: 0.8, oblique: 10 });
  w.layer('VIS', 1).layer('OFF', 3, 'CONTINUOUS', { off: true }).layer('FROZEN', 4, 'CONTINUOUS', { frozen: true }).layer('DASH', 5, 'DASHED').layer('TXT', 2).layer('MESH', 6).layer('HATCH', 8).layer('DIM', 3);
  const L = (layer, extra = {}) => ({ layer, ...extra });
  w.line([0, 0], [50, 0], L('VIS', { color: 2 }));
  w.line([0, 5], [50, 5], L('VIS', { ltype: 'DASHED' }));
  w.line([0, 10], [50, 10], L('DASH'));
  w.line([0, 15], [50, 15], L('DASH', { ltype: 'CONTINUOUS' }));
  w.line([0, 20], [50, 20], L('OFF'));
  w.line([0, 25], [50, 25], L('FROZEN'));
  w.line([0, 30], [50, 30], L('VIS', { invisible: true }));
  w.line([0, 35], [50, 35], L('NOT_IN_TABLE'));
  w.point([60, 0], L('VIS'));
  w.circle([70, 10], 4, L('VIS', { extrusion: [0, 0, -1] }));
  w.arc([80, 10], 5, 20, 160, L('VIS', { extrusion: [0, 0, -1] }));
  w.ellipse([100, 10], [8, 3], 0.5, 0.5, 2.5, L('VIS'));
  w.lwpolyline([[110, 0, 0.5], [130, 0, 0], [130, 15, -0.3], [110, 15]], true, L('VIS', { elevation: 2 }));
  w.polyline([[140, 0, 0], [150, 0, 0.4], [150, 10, 0], [140, 10, 0]], true, L('VIS'));
  // 3D polyline
  w.raw('POLYLINE', [[8, 'MESH'], [66, 1], [10, 0], [20, 0], [30, 0], [70, 8 | 1]], 'AcDb3dPolyline');
  for (const [x, y, z] of [[0, 50, 0], [10, 55, 3], [20, 50, 6], [15, 40, 2]]) w.raw('VERTEX', [[8, 'MESH'], [10, x], [20, y], [30, z], [70, 32]], 'AcDb3dPolylineVertex');
  w.raw('SEQEND', [[8, 'MESH']]);
  // polyface mesh: 4 vertices, 2 faces (the second with a hidden edge)
  w.raw('POLYLINE', [[8, 'MESH'], [66, 1], [10, 0], [20, 0], [30, 0], [70, 64], [71, 4], [72, 2]], 'AcDbPolyFaceMesh');
  for (const [x, y] of [[30, 40], [45, 40], [45, 55], [30, 55]]) w.raw('VERTEX', [[8, 'MESH'], [10, x], [20, y], [30, 0], [70, 192]], 'AcDbPolyFaceMeshVertex');
  w.raw('VERTEX', [[8, 'MESH'], [10, 0], [20, 0], [30, 0], [70, 128], [71, 1], [72, 2], [73, 3]], 'AcDbFaceRecord');
  w.raw('VERTEX', [[8, 'MESH'], [10, 0], [20, 0], [30, 0], [70, 128], [71, 1], [72, -3], [73, 4]], 'AcDbFaceRecord');
  w.raw('SEQEND', [[8, 'MESH']]);
  // 2 x 3 polygon mesh
  w.raw('POLYLINE', [[8, 'MESH'], [66, 1], [10, 0], [20, 0], [30, 0], [70, 16], [71, 2], [72, 3]], 'AcDbPolygonMesh');
  for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) w.raw('VERTEX', [[8, 'MESH'], [10, 60 + j * 8], [20, 40 + i * 10], [30, i + j], [70, 64]], 'AcDbPolygonMeshVertex');
  w.raw('SEQEND', [[8, 'MESH']]);
  w.raw('3DFACE', [[8, 'MESH'], [10, 90], [20, 40], [30, 0], [11, 100], [21, 40], [31, 0], [12, 100], [22, 50], [32, 0], [13, 90], [23, 50], [33, 0], [70, 2]], 'AcDbFace');
  w.raw('TRACE', [[8, 'MESH'], [10, 110], [20, 40], [30, 0], [11, 120], [21, 40], [31, 0], [12, 110], [22, 44], [32, 0], [13, 120], [23, 44], [33, 0]], 'AcDbTrace');
  w.solid([[125, 40], [135, 40], [130, 48]], L('MESH'));
  // splines: weighted (rational) control points, and fit points only
  {
    const ctrl = [[0, 70], [10, 80], [20, 70], [30, 80]], wts = [1, 2, 0.5, 1], deg = 3, n = 4;
    const g = [[8, 'VIS'], [70, 8 | 4], [71, deg], [72, n + deg + 1], [73, n], [74, 0]];
    for (const k of [0, 0, 0, 0, 1, 1, 1, 1]) g.push([40, k]);
    ctrl.forEach((c, i) => g.push([10, c[0]], [20, c[1]], [30, 0], [41, wts[i]]));
    w.raw('SPLINE', g, 'AcDbSpline');
    const f = [[8, 'VIS'], [70, 8], [71, 3], [72, 0], [73, 0], [74, 5], [44, 1e-10]];
    for (const [x, y] of [[40, 70], [45, 78], [52, 72], [58, 80], [65, 74]]) f.push([11, x], [21, y], [31, 0]);
    w.raw('SPLINE', f, 'AcDbSpline');
  }
  // text: alignments, rotation, width, oblique, style, mirrored; MTEXT rotated with a width
  w.text('CENTER', [0, 100], { h: 3, halign: 1 }, L('TXT'));
  w.text('RIGHT', [40, 100], { h: 3, halign: 2 }, L('TXT'));
  w.text('MIDDLE', [80, 100], { h: 3, halign: 4 }, L('TXT'));
  w.text('ALIGNED', [0, 110], { h: 3, halign: 3, at2: [30, 115] }, L('TXT'));
  w.text('FIT', [40, 110], { h: 3, halign: 5, at2: [70, 110] }, L('TXT'));
  w.text('TOP LEFT', [80, 110], { h: 3, halign: 0, valign: 3 }, L('TXT'));
  w.text('BASE CENTER', [0, 120], { h: 3, halign: 1, valign: 1 }, L('TXT'));
  w.text('ROTATED NARROW', [40, 120], { h: 3, rot: 30, width: 0.8, oblique: 15, style: 'NARROW' }, L('TXT'));
  w.text('MIRRORED', [80, 120], { h: 3, mirror: 2 }, L('TXT'));
  w.mtext('Rotated multi-line\\Ptext with a width', [0, 140], { h: 2.5, width: 40, attach: 5, rot: 15 }, L('TXT'));
  // blocks: variable + constant attributes, non-uniform scale + rotation, MINSERT, BYBLOCK line type
  w.block('TAG', [0, 0], (b) => {
    b.circle([0, 0], 3, { layer: '0', ltype: 'BYBLOCK' });
    b.attdef('ID', 'Identifier', '?', [-2, -1], { h: 2 }, { layer: '0' });
    b.attdef('KIND', 'Kind', 'VALVE', [-2, -5], { h: 1.5, constant: true }, { layer: '0' });
  });
  w.insert('TAG', [100, 70], { attribs: [{ tag: 'ID', value: 'V-101', at: [98, 69], h: 2 }, { tag: 'NOTE', value: 'hidden', at: [98, 66], h: 1, invisible: true }] }, L('VIS', { ltype: 'DASHED' }));
  w.insert('TAG', [120, 70], { sx: 2, sy: 0.5, rot: 30 }, L('VIS'));
  w.insert('TAG', [140, 60], { cols: 3, rows: 2, dc: 8, dr: 9 }, L('VIS'));
  // hatches: edges with an elliptic arc, a pattern with two dashed lines and a seed point
  w.hatchEdges([{ type: 'line', a: [0, 160], b: [20, 160] }, { type: 'arc', c: [20, 165], r: 5, a0: -90, a1: 90 }, { type: 'line', a: [20, 170], b: [0, 170] }, { type: 'line', a: [0, 170], b: [0, 160] }], { solid: true }, L('HATCH'));
  w.raw('HATCH', [[8, 'HATCH'], [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1], [2, 'NET'], [70, 0], [71, 0], [91, 1],
    [92, 1], [93, 2], [72, 1], [10, 40], [20, 160], [11, 60], [21, 160], [72, 3], [10, 50], [20, 160], [11, 10], [21, 0], [40, 0.6], [50, 0], [51, 180], [73, 1], [97, 0],
    [75, 1], [76, 1], [52, 0], [41, 1], [77, 0], [78, 2],
    [53, 0], [43, 0], [44, 0], [45, 0], [46, 3], [79, 2], [49, 2], [49, -1],
    [53, 90], [43, 0], [44, 0], [45, -3], [46, 0], [79, 0],
    [98, 1], [10, 50], [20, 162]], 'AcDbHatch');
  // dimensions without blocks (drawn from their definition points) and one with a block
  w.raw('DIMENSION', [[8, 'DIM'], [2, ''], [10, 10], [20, 190], [30, 0], [11, 5], [21, 192], [31, 0], [70, 1], [1, ''], [13, 0], [23, 185], [33, 0], [14, 10], [24, 185], [34, 0], [42, 10]], 'AcDbDimension');
  w.raw('DIMENSION', [[8, 'DIM'], [2, ''], [10, 30], [20, 190], [30, 0], [11, 34], [21, 194], [31, 0], [70, 4], [1, 'R5'], [15, 35], [25, 190], [35, 0], [40, 2]], 'AcDbDimension');
  w.raw('DIMENSION', [[8, 'DIM'], [2, ''], [10, 50], [20, 190], [30, 0], [11, 55], [21, 194], [31, 0], [70, 3], [1, '%%c10'], [15, 60], [25, 190], [35, 0], [40, 0]], 'AcDbDimension');
  w.raw('DIMENSION', [[8, 'DIM'], [2, ''], [10, 80], [20, 190], [30, 0], [11, 85], [21, 195], [31, 0], [70, 5], [1, ''], [13, 90], [23, 190], [33, 0], [14, 85], [24, 198], [34, 0], [15, 80], [25, 190], [35, 0]], 'AcDbDimension');
  w.raw('DIMENSION', [[8, 'DIM'], [2, ''], [10, 0], [20, 0], [30, 0], [11, 105], [21, 195], [31, 0], [70, 6 | 64], [1, ''], [13, 100], [23, 190], [33, 0], [14, 105], [24, 195], [34, 0]], 'AcDbDimension');
  w.linearDim([120, 185], [150, 185], [135, 195], 0, {}, L('DIM'));
  w.leader([[160, 190], [170, 198], [180, 198]], L('DIM'));
  w.raw('LEADER', [[8, 'DIM'], [3, 'STANDARD'], [71, 0], [72, 0], [73, 3], [76, 2], [10, 160], [20, 180], [30, 0], [10, 175], [20, 182], [30, 0]], 'AcDbLeader');
  // paper space (model space is not empty, so these are reported, not drawn)
  w.line([0, 0], [100, 0], { layer: 'VIS', paper: true });
  w.text('SHEET NOTE', [0, 5], { h: 3 }, { layer: 'TXT', paper: true });
  out(FIX, 'edge-dwg-coverage.dxf', w.toString());
}

// 15) line weights (group 370): explicit, ByLayer (layer weights), ByBlock inside a block, default
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
// 15) hostile, tiny files that expand to 10^8 items: a 10000 x 10000 array insert, and blocks
//     nested eight deep with ten copies at each level (the scene caps block expansion)
{
  const w = new DxfWriter({ version: 'AC1015', insunits: 4 });
  w.layer('GRID', 7);
  w.block('DOT', [0, 0], (b) => { b.line([0, 0], [1, 1], { layer: '0' }); });
  w.line([-10, -10], [-5, -5], { layer: 'GRID' });
  w.insert('DOT', [0, 0], { cols: 10000, rows: 10000, dc: 2, dr: 2 }, { layer: 'GRID' });
  out(FIX, 'edge-huge-array.dxf', w.toString());
}
{
  const w = new DxfWriter({ version: 'AC1015', insunits: 4 });
  w.layer('NEST', 7);
  w.block('N8', [0, 0], (b) => { b.line([0, 0], [1, 1], { layer: '0' }); });
  for (let k = 7; k >= 1; k--) w.block('N' + k, [0, 0], (b) => { for (let i = 0; i < 10; i++) b.insert('N' + (k + 1), [i * 2, 0], {}, { layer: '0' }); });
  w.line([-10, -10], [-5, -5], { layer: 'NEST' });
  for (let i = 0; i < 10; i++) w.insert('N1', [0, i * 2], {}, { layer: 'NEST' });
  out(FIX, 'edge-nested-huge.dxf', w.toString());
}
// 16) the first layer with items is switched off: new items must not go on it by default
{
  const w = new DxfWriter({ version: 'AC1015', insunits: 4 });
  w.layer('A-HIDDEN', 1, 'CONTINUOUS', { off: true }).layer('B-SHOWN', 3);
  w.line([0, 0], [100, 0], { layer: 'A-HIDDEN' });
  w.circle([50, 50], 20, { layer: 'A-HIDDEN' });
  w.line([0, 100], [100, 100], { layer: 'B-SHOWN' });
  w.text('SHOWN', [0, 110], { h: 5 }, { layer: 'B-SHOWN' });
  out(FIX, 'edge-first-layer-off.dxf', w.toString());
}
// 17) two revisions of one drawing: same size, one coordinate differs (markups are kept per revision)
for (const [rev, x] of [[1, 41], [2, 42]]) {
  const w = new DxfWriter({ version: 'AC1015', insunits: 4 });
  w.layer('PART', 7);
  w.line([0, 0], [100, 0], { layer: 'PART' });
  w.line([100, 0], [100, x], { layer: 'PART' });
  out(FIX, `edge-rev-${rev}.dxf`, w.toString());
}
// 18) the invented wiring sheet of the Trace tests (tools/trace_sheet.json; the DGN twin comes from
// make_dgn_fixtures.py): connectors and a terminal strip as blocks, junction dots as solid hatches, the
// hop arc as a polyline bulge
{
  const J = JSON.parse(readFileSync(join(ROOT, 'tools', 'trace_sheet.json'), 'utf8'));
  const w = new DxfWriter({ version: 'AC1015', insunits: 6 });
  w.layer('BORDER', 8).layer('WIRES', 3).layer('DOTS', 3).layer('LABELS', 2).layer('CELLS', 7).layer('COILS', 4).layer('NOTES', 6);
  const dot = (b, d, p) => b.hatch([[[d.c[0] - d.r, d.c[1], 1], [d.c[0] + d.r, d.c[1], 1]]], { solid: true }, p);
  const text = (b, t, p) => b.text(t.s, t.p, { h: t.h, rot: t.rot || 0 }, p);
  w.lwpolyline(J.border, false, { layer: 'BORDER' });
  const names = ['J4CONN', 'P1CONN', 'TERMS', 'TBLOCK'];
  J.cells.forEach((c, k) => {
    w.block(names[k], [0, 0], (b) => {
      b.lwpolyline(c.frame.slice(0, -1), true, { layer: '0' });
      for (const l of c.lines || []) b.line(l[0], l[1], { layer: '0' });
      for (const d of c.dots || []) dot(b, d, { layer: '0' });
      for (const t of c.texts) text(b, t, { layer: '0' });
    });
    w.insert(names[k], [0, 0], {}, { layer: 'CELLS' });
  });
  for (const x of J.wires) {
    if (x.chain) { // line, hop arc, line: one polyline with a bulge (tan of a quarter of the sweep; negative = clockwise)
      const [a, arc, b] = x.chain;
      w.lwpolyline([[...a.pts[0]], [...a.pts[1], Math.tan((arc.arc.sweep * Math.PI) / 720)], ...b.pts.map((p) => [...p])], false, { layer: 'WIRES' });
    } else if (x.pts.length === 2) w.line(x.pts[0], x.pts[1], { layer: 'WIRES' });
    else w.lwpolyline(x.pts, false, { layer: 'WIRES' });
  }
  for (const d of J.dots) dot(w, d, { layer: 'DOTS' });
  for (const c of J.circles) w.circle(c.c, c.r, { layer: 'COILS' });
  for (const t of J.texts) text(w, t, { layer: t.level === 30 ? 'COILS' : t.level === 20 ? 'NOTES' : 'LABELS' });
  out(FIX, 'trace-sheet.dxf', w.toString());
}
console.log('done');
