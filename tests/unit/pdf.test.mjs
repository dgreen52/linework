// PDF reader (pdf.js, vendor/pdfjs). Every PDF here is synthetic: written by tools/pdf-writer.mjs
// (tools/make_pdf_fixtures.mjs), or Linework's own vector print of the repo's synthetic samples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ROOT, bytes } from './helpers.mjs';
import { detectFormat, parseDrawing, parseDrawingAsync } from '../../src/formats/detect.js';
import {
  parsePdf, pageToModel, bezierArc, subpaths, pageUnits, colorName, isInk, hexColor, isPdf, OPS, PDF_READER_REV,
  NS_IMAGES, NS_LIMIT,
} from '../../src/formats/pdf.js';
import { buildScene, KIND, TEXT_ID } from '../../src/scene.js';
import { findTexts } from '../../src/edit/find.js';
import { findSnap } from '../../src/tools/snap.js';
import { measure } from '../../src/tools/measure.js';
import { writeDxf } from '../../src/formats/dxf-write.js';
import { parseDxf } from '../../src/formats/dxf.js';
import { writeDgn } from '../../src/formats/dgn-write.js';
import { parseDgn } from '../../src/formats/dgn.js';
import { loadInWorkerScope, modelMeta } from '../../src/worker.js';
import { FIXTURES, PRINTS } from '../../tools/make_pdf_fixtures.mjs';
import { makePdf, Content, MM } from '../../tools/pdf-writer.mjs';
import { PIN, FILES, untar, integrityOf, install, pdfjsCodeSites } from '../../tools/vendor_pdfjs.mjs';

// pdf.js in Node says once that it cannot draw (no canvas package): reading needs no canvas
const quiet = async (fn) => {
  const log = console.log;
  console.log = (...a) => { if (!/^Warning: Cannot (load "@napi-rs\/canvas"|polyfill)/.test(String(a[0]))) log(...a); };
  try { return await fn(); } finally { console.log = log; }
};
const open = (name, opts) => quiet(() => parsePdf(bytes(name), opts));
const T0 = [1, 0, 0, 1, 0, 0];
const near = (a, b, tol = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);
const ents = (m, type) => m.entities.filter((e) => e.type === type);
const texts = (m) => new Map(ents(m, 'text').map((e) => [e.text, e]));
const len = (e) => Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
/** An operator list from [fn, args] pairs. */
const opl = (...ops) => ({ fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1] ?? null) });
/** pdf.js path data: m x y l x y ... h. */
const P = (...cmds) => Float32Array.from(cmds.flat());
const M_ = (x, y) => [0, x, y], L_ = (x, y) => [1, x, y], C_ = (...a) => [2, ...a], Z_ = [4];
const page = (ops, extra = {}) => pageToModel({ ops, items: [], T: T0, W: 1000, H: 1000, units: 4, ...extra });

// ------------------------------------------------------------------ vendored reader
test('vendored pdf.js: the pinned files (SHA-256 in its README), no run-time code generation, licences; cache names follow the version', () => {
  const readme = readFileSync(join(ROOT, 'vendor/pdfjs/README.md'), 'utf8');
  assert.ok(readme.includes(`${PIN.name}@${PIN.version}`) && readme.includes(PIN.integrity), 'README names the pinned package and integrity');
  for (const n of Object.values(FILES)) {
    const b = readFileSync(join(ROOT, 'vendor/pdfjs', n));
    if (n.startsWith('LICENSE')) { assert.ok(b.length > 100, n); continue; }
    const sha = createHash('sha256').update(b).digest('hex');
    assert.ok(readme.includes(`| ${n} | ${b.length} | \`${sha}\` |`), `${n}: size and SHA-256 as recorded`);
  }
  for (const n of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    const js = readFileSync(join(ROOT, 'vendor/pdfjs', n), 'utf8');
    const { sites, allowed } = pdfjsCodeSites(js);
    assert.deepEqual(sites, [], `${n}: no eval / new Function`);
    assert.ok(allowed <= 1, `${n}: at most core-js's global lookup`);
    assert.ok(js.includes(`"${PDF_READER_REV}"`), `${n} is pdf.js ${PDF_READER_REV}`);
  }
  assert.equal(PIN.version, PDF_READER_REV, 'the reader revision is the vendored version');
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  assert.ok(sw.includes(`PDF_READER_CACHE = 'linework-reader-pdfjs-${PDF_READER_REV}'`), 'the service worker cache follows the version');
  const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8');
  for (const s of ['pdf.js', 'Apache', 'core-js', 'OpenJPEG', 'PDFium']) assert.ok(notice.includes(s), `NOTICE mentions ${s}`);
});

test('vendoring: tarballs are read as npm writes them and must match the pinned integrity', () => {
  const tarFile = (name, body) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const x of h) sum += x;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
  };
  const tgz = gzipSync(Buffer.concat([tarFile('package/package.json', Buffer.from('{"name":"x"}')), tarFile('package/a/b.txt', Buffer.from('hello')), Buffer.alloc(1024)]));
  const files = untar(tgz);
  assert.equal(files.get('package/a/b.txt').toString(), 'hello');
  assert.equal(JSON.parse(files.get('package/package.json')).name, 'x');
  assert.match(integrityOf(tgz), /^sha512-/);
  assert.throws(() => install(tgz, join(ROOT, 'tests', 'e2e', 'out', 'never')), /integrity/, 'a tarball that is not the pinned one is refused');
  assert.equal(pdfjsCodeSites('x=eval("1")').sites.length, 1, 'eval is found');
  assert.equal(pdfjsCodeSites('var check=function(t){return t&&t.Math===Math&&t};t.exports=check("object"==typeof globalThis&&globalThis)||check("object"==typeof self&&self)||function(){return this}()||Function("return this")()').sites.length, 0, "core-js's global lookup is allowed");
});

// ------------------------------------------------------------------ detection, helpers
test('detection: PDF by its content (also after leading bytes); the synchronous reader points to the async one', () => {
  for (const n of Object.keys(FIXTURES)) assert.equal(detectFormat(bytes(n), 'x.bin'), 'pdf', n);
  const junk = Buffer.concat([Buffer.alloc(200, 0x20), bytes('pdf-plan.pdf')]);
  assert.equal(detectFormat(junk, 'a.pdf'), 'pdf');
  assert.ok(isPdf(junk) && !isPdf(Buffer.from('%PD')));
  assert.equal(detectFormat(bytes('house-plan.dxf'), 'house-plan.pdf'), 'dxf', 'the content wins over the extension');
  const dxfMentioningPdf = Buffer.concat([Buffer.from('999\nexported from a %PDF-1.7 file\n'), bytes('house-plan.dxf')]);
  assert.equal(detectFormat(dxfMentioningPdf, 'a.dxf'), 'dxf', 'a DXF whose comment mentions %PDF- is still a DXF');
  assert.throws(() => parseDrawing(bytes('pdf-plan.pdf'), 'a.pdf'), (e) => e.code === 'pdf-async');
});

test('units: inch-sized pages (Letter, Legal, Tabloid, ANSI D, ARCH E) read in inches; A-sizes and others in mm', () => {
  for (const [w, h] of [[612, 792], [612, 1008], [792, 1224], [1584, 2448], [2592, 3456], [792, 612]]) assert.equal(pageUnits(w, h).code, 1, `${w} x ${h}`);
  for (const [w, h] of [[595.28, 841.89], [841.89, 1190.55], [594.96, 841.92], [500, 700]]) assert.equal(pageUnits(w, h).code, 4, `${w} x ${h}`);
});

test('colours: black, near black and CMYK black are the foreground; layer colour names', () => {
  assert.ok(isInk(0x000000) && isInk(0x231f20) && isInk(0x1a1a1a) && !isInk(0x404080) && !isInk(0x7f7f7f));
  assert.equal(hexColor('#ff8000'), 0xff8000);
  assert.equal(hexColor('red'), null);
  const names = { 0x000000: '', 0x808080: 'grey', 0xffffff: 'white', 0xff0000: 'red', 0xff8000: 'orange', 0xffff00: 'yellow', 0x00a000: 'green', 0x00ffff: 'cyan', 0x0000ff: 'blue', 0xff00ff: 'magenta' };
  for (const [c, n] of Object.entries(names)) assert.equal(colorName(+c), n, n);
});

// ------------------------------------------------------------------ geometry
test('Bézier arcs: a circle drawn as four curves is a circle; arcs (either direction) keep their angles; other curves stay curves', () => {
  const k = 0.5522847498 * 10;
  const circle = [[10, k, k, 10, 0, 10], [-k, 10, -10, k, -10, 0], [-10, -k, -k, -10, 0, -10], [k, -10, 10, -k, 10, 0]].map((s) => s.map((v, i) => v + (i % 2 ? 50 : 100)));
  const c = bezierArc(110, 50, circle);
  assert.ok(c && c.full);
  near(c.c[0], 100, 1e-6); near(c.c[1], 50, 1e-6); near(c.r, 10, 1e-6);
  // a quarter arc, CCW from 0 to 90 degrees, and the same drawn backwards (CW)
  const q = [10, k, k, 10, 0, 10];
  const a = bezierArc(10, 0, [q]);
  assert.ok(a && !a.full);
  near(a.a0, 0, 1e-9); near(a.a1, Math.PI / 2, 1e-9); near(a.r, 10, 1e-9);
  const b = bezierArc(0, 10, [[k, 10, 10, k, 10, 0]]);
  near(b.a0, 0, 1e-9, 'CW is stored CCW'); near(b.a1, Math.PI / 2, 1e-9);
  assert.equal(bezierArc(0, 0, [[10, 0, 10, 10, 20, 10]]), null, 'an S-like curve is not an arc');
  assert.equal(bezierArc(0, 0, [[5, 5, 15, 5, 20, 0]]), null, 'a flat curve that is not circular');
});

test('paths: rectangles, h then l (restarts at the subpath start), quadratic curves; drawing coordinates', () => {
  const T = [2, 0, 0, 2, 10, 20];
  const s = subpaths(P(M_(0, 0), L_(10, 0), L_(10, 5), Z_, L_(0, 5)), T);
  assert.equal(s.length, 2);
  assert.deepEqual([s[0].x, s[0].y, s[0].closed], [10, 20, true]);
  assert.deepEqual(s[0].segs, [[30, 20], [30, 30]]);
  assert.deepEqual([s[1].x, s[1].y, s[1].segs], [10, 20, [[10, 30]]], 'after h, l continues from the start');
  const q = subpaths(P(M_(0, 0), [3, 5, 10, 10, 0]), T0)[0].segs[0];
  assert.deepEqual(q.map((v) => +v.toFixed(6)), [3.333333, 6.666667, 6.666667, 6.666667, 10, 0], 'quadratic -> cubic');
});

// ------------------------------------------------------------------ operator list -> model
test('operator list: transforms nest (q/Q, forms), widths, dashes, colours and layers by colour', () => {
  const { model: m } = page(opl(
    [OPS.setLineWidth, [2]],
    [OPS.save], [OPS.transform, [2, 0, 0, 2, 100, 0]],
    [OPS.constructPath, [OPS.stroke, [P(M_(0, 0), L_(10, 0))], null]],
    [OPS.restore],
    [OPS.paintFormXObjectBegin, [[0, 1, -1, 0, 500, 500], [0, 0, 10, 10]]],
    [OPS.setStrokeRGBColor, ['#ff0000']], [OPS.setDash, [[3, 1], 0]],
    [OPS.constructPath, [OPS.stroke, [P(M_(0, 0), L_(10, 0), L_(10, 10))], null]],
    [OPS.paintFormXObjectEnd],
    [OPS.constructPath, [OPS.closeStroke, [P(M_(0, 0), L_(5, 0), L_(5, 5))], null]],
  ));
  const [a, b, c] = m.entities;
  assert.deepEqual([a.type, a.a, a.b, a.lw, a.layer, a.color], ['line', [100, 0], [120, 0], 400, 'Lines', 7], 'scaled by 2 (width too: 4 units = 400 / 100 mm)');
  assert.deepEqual([b.type, b.pts, b.closed, b.layer, b.rgb, b.ltype], ['polyline', [500, 500, 500, 510, 490, 510], false, 'Lines (red)', 0xff0000, 'PDF-DASH-1'], 'form matrix (90 degrees), red, dashed');
  assert.deepEqual(m.ltypes['PDF-DASH-1'].pattern, [3, -1]);
  assert.deepEqual([c.type, c.closed, c.color, c.ltype, c.lw], ['polyline', true, 7, undefined, 200], 'q/Q and the form end restore colour, dash and transform');
  assert.deepEqual(m.layers.map((l) => l.name), ['Lines', 'Lines (red)']);
});

test('operator list: fills (paper white and page backgrounds dropped; one loop keeps its fill; holes are hatches; patterns), invisible paint', () => {
  const sq = (x, y, s) => [M_(x, y), L_(x + s, y), L_(x + s, y + s), L_(x, y + s), Z_];
  const { model: m, info } = page(opl(
    [OPS.setFillRGBColor, ['#ffffff']], [OPS.constructPath, [OPS.fill, [P(...sq(0, 0, 50))], null]],
    [OPS.setFillRGBColor, ['#202020']], [OPS.constructPath, [OPS.fill, [P(...sq(0, 0, 1000))], null]],
    [OPS.setFillRGBColor, ['#e0e0e0']], [OPS.constructPath, [OPS.fill, [P(...sq(0, 0, 800))], null]],
    [OPS.setFillRGBColor, ['#00a000']], [OPS.setStrokeRGBColor, ['#0000ff']], [OPS.constructPath, [OPS.fillStroke, [P(...sq(10, 10, 20))], null]],
    [OPS.setFillRGBColor, ['#000000']], [OPS.constructPath, [OPS.eoFill, [P(...sq(100, 100, 40), ...sq(110, 110, 20))], null]],
    [OPS.setFillColorN, ['TilingPattern']], [OPS.constructPath, [OPS.fill, [P(...sq(200, 200, 30), ...sq(300, 300, 5))], null]],
    [OPS.setFillTransparent], [OPS.constructPath, [OPS.fill, [P(...sq(400, 400, 10))], null]],
    [OPS.setGState, [[['CA', 0]]]], [OPS.constructPath, [OPS.stroke, [P(M_(0, 0), L_(9, 9))], null]],
    [OPS.constructPath, [OPS.endPath, [P(...sq(0, 0, 5))], null]],
  ));
  assert.equal(info.white, 3, 'white, a full-page dark background and a large light one are the page, not items');
  const [box, hole, pat] = m.entities;
  assert.deepEqual([box.type, box.closed, box.fill, box.rgb, box.layer], ['polyline', true, 0x00a000, 0x0000ff, 'Lines (blue)'], 'fill + stroke: one closed item, its outline and its fill');
  assert.deepEqual([hole.type, hole.loops.length, hole.solid, hole.layer, hole.color], ['hatch', 2, true, 'Fills', 7], 'two loops: a hatch (even-odd), black = foreground');
  assert.deepEqual([pat.type, pat.solid], ['hatch', false], 'a pattern fill is a pattern hatch');
  assert.equal(m.entities.length, 3, 'transparent fill, invisible stroke and clip-only paths add nothing');
});

test('operator list: circles and arcs from curves (filled dots keep their fill), mixed paths split, points', () => {
  const k = 0.5522847498 * 5;
  const circ = [M_(15, 10), C_(15, 10 + k, 10 + k, 15, 10, 15), C_(10 - k, 15, 5, 10 + k, 5, 10), C_(5, 10 - k, 10 - k, 5, 10, 5), C_(10 + k, 5, 15, 10 - k, 15, 10), Z_];
  const { model: m } = page(opl(
    [OPS.constructPath, [OPS.fill, [P(...circ)], null]],
    [OPS.constructPath, [OPS.stroke, [P(M_(15, 10), C_(15, 10 + k, 10 + k, 15, 10, 15))], null]],
    [OPS.constructPath, [OPS.stroke, [P(M_(0, 0), L_(10, 0), C_(20, 0, 20, 5, 20, 10), L_(20, 20))], null]],
    [OPS.constructPath, [OPS.stroke, [P(M_(7, 7), L_(7, 7))], null]],
  ));
  const t = m.entities.map((e) => e.type);
  assert.deepEqual(t, ['circle', 'arc', 'line', 'spline', 'line', 'point']);
  near(m.entities[0].r, 5, 1e-6); assert.equal(m.entities[0].fill, 0x1000000, 'a black dot: filled with the foreground');
  near(m.entities[1].a1 - m.entities[1].a0, Math.PI / 2, 1e-6);
  assert.deepEqual(m.entities[3].pts.slice(0, 2), [10, 0]); assert.deepEqual(m.entities[3].pts.slice(-2), [20, 10]);
});

test('operator list: optional content (layers, hidden ones), annotations, pictures counted, item and time limits', () => {
  const grp = { type: 'OCG', id: '5R' };
  const { model: m, info } = pageToModel({
    ops: opl(
      [OPS.beginMarkedContentProps, ['OC', grp]], [OPS.constructPath, [OPS.stroke, [P(M_(0, 0), L_(1, 1))], null]], [OPS.endMarkedContent],
      [OPS.beginAnnotation, ['a1', [0, 0, 10, 10], [1, 0, 0, 1, 50, 50], T0, false]], [OPS.constructPath, [OPS.stroke, [P(M_(0, 0), L_(1, 0))], null]], [OPS.endAnnotation],
      [OPS.save], [OPS.transform, [500, 0, 0, 500, 0, 0]], [OPS.paintImageXObject, ['img1', 10, 10]], [OPS.restore],
    ),
    items: [], T: T0, W: 1000, H: 1000, ocName: (g) => (g.id === '5R' ? 'Hidden wires' : null), ocVisible: () => false,
  });
  assert.deepEqual(m.layers.map((l) => [l.name, l.visible]), [['Hidden wires', false], ['Annotations', true]]);
  assert.deepEqual(m.entities[1].a, [50, 50], 'annotation content in its own transform');
  assert.equal(info.images, 1); near(info.imageCover, 0.25, 1e-9, 'a quarter of the page');
  const many = opl(...Array.from({ length: 50 }, (_, i) => [OPS.constructPath, [OPS.stroke, [P(M_(i, 0), L_(i, 1))], null]]));
  const lim = pageToModel({ ops: many, T: T0, W: 100, H: 100, maxItems: 20 }).model;
  assert.equal(lim.entities.length, 20);
  assert.equal(lim.stats.notShown[NS_LIMIT], 30);
  assert.ok(lim.stats.warnings.some((w) => /items; the rest are not shown/.test(w)));
  const long = opl(...Array.from({ length: 5000 }, () => [OPS.save]));
  assert.throws(() => pageToModel({ ops: long, T: T0, W: 1, H: 1, deadline: Date.now() - 1 }), (e) => e.code === 'pdf-timeout');
});

test('text: position, size, angle and width (fitted); colour, layer and invisible text from where the operator list shows it', () => {
  const glyph = (w) => ({ unicode: 'X', width: w, isSpace: false });
  const ops = opl(
    [OPS.setFillRGBColor, ['#ff0000']], [OPS.beginText], [OPS.setFont, ['F1', 10]], [OPS.setTextMatrix, [[1, 0, 0, 1, 100, 200]]], [OPS.showText, [[glyph(500), glyph(500)]]],
    [OPS.setFillRGBColor, ['#000000']], [OPS.setTextRenderingMode, [3]], [OPS.setTextMatrix, [[0, 1, -1, 0, 300, 100]]], [OPS.showText, [[glyph(600)]]],
    [OPS.setTextRenderingMode, [0]], [OPS.beginMarkedContentProps, ['OC', { type: 'OCG', id: '9R' }]], [OPS.moveText, [0, -20]], [OPS.showText, [[glyph(500)]]], [OPS.endMarkedContent],
  );
  const items = [
    { str: 'RED', transform: [10, 0, 0, 10, 100, 200], width: 10 },
    { str: 'OCR', transform: [0, 10, -10, 0, 300, 100], width: 6 },
    { str: 'ON LAYER', transform: [0, 10, -10, 0, 320, 100], width: 5 },
    { str: '   ', transform: [10, 0, 0, 10, 0, 0], width: 3 },
  ];
  const { model: m, info } = pageToModel({ ops, items, T: [0.5, 0, 0, 0.5, 0, 0], W: 500, H: 500, ocName: () => 'Labels' });
  const t = texts(m);
  assert.equal(t.size, 3, 'blank text is skipped');
  const red = t.get('RED');
  assert.deepEqual([red.p, red.p2, red.halign, red.rot, red.rgb, red.layer], [[50, 100], [55, 100], 5, 0, 0xff0000, 'Text'], 'drawing units (x 0.5), fitted to its width, red');
  near(red.h, 5 * 0.7, 1e-12, 'cap height from the font size');
  const ocr = t.get('OCR');
  assert.deepEqual([ocr.layer, ocr.color], ['Text (invisible)', 7]);
  near(ocr.rot, Math.PI / 2, 1e-12, 'turned 90 degrees');
  assert.equal(t.get('ON LAYER').layer, 'Labels', 'text in optional content is on its layer');
  assert.equal(m.layers.find((l) => l.name === 'Text (invisible)').visible, false, 'invisible text is on a hidden layer');
  assert.equal(info.invisible, 1);
});

// ------------------------------------------------------------------ fixtures through pdf.js
test('PDF fixtures are reproducible from tools/make_pdf_fixtures.mjs (and the printed ones exist)', () => {
  for (const [name, make] of Object.entries(FIXTURES)) assert.ok(Buffer.from(make()).equals(Buffer.from(bytes(name))), name);
  for (const p of PRINTS) assert.ok(existsSync(join(ROOT, 'tests/fixtures', p[4])), p[4]);
});

test('pdf-plan.pdf: an A4 page in mm; a 100 mm line is exactly 100 mm; circle, arc, colours, dashes, spot colour, fills, a turned form, an annotation, text', async () => {
  const m = await open('pdf-plan.pdf');
  assert.equal(m.format, 'PDF');
  assert.equal(m.version, '1.7');
  assert.equal(m.units.abbr, 'mm');
  near(m.page.box[2], 210, 0.01); near(m.page.box[3], 297, 0.01);
  assert.deepEqual([m.page.n, m.page.count], [1, 1]);
  const lines = ents(m, 'line');
  near(len(lines[0]), 100, 1e-9, '100 mm line');
  assert.deepEqual(lines[0].a.map((v) => +v.toFixed(9)), [20, 20]);
  const [circle] = ents(m, 'circle').filter((c) => c.fill == null);
  near(circle.r, 10, 1e-6); near(circle.c[0], 150, 1e-6); near(circle.c[1], 60, 1e-6);
  const [arc] = ents(m, 'arc');
  near(arc.r, 20, 1e-4, 'arc from float32 path points'); near(arc.a0, Math.PI / 6, 1e-6); near(arc.a1, (5 * Math.PI) / 6, 1e-6);
  const red = lines.filter((l) => l.rgb === 0xff0000);
  assert.equal(red.length, 2, 'red line and the spot colour (its PostScript tint transform gives red)');
  const blue = lines.find((l) => l.rgb === 0x0000ff);
  assert.deepEqual(m.ltypes[blue.ltype].pattern.map((v) => +v.toFixed(9)), [4, -2], 'dash 4 mm / 2 mm');
  assert.equal(lines[0].lw, 35, '0.35 mm');
  const fills = m.entities.filter((e) => e.fill != null);
  assert.deepEqual(fills.map((e) => [e.type, e.layer]), [['polyline', 'Fills'], ['circle', 'Fills']], 'green box and the black dot; the white page background is not an item');
  const form = m.entities.find((e) => e.type === 'polyline' && e.closed && Math.abs(e.pts[0] - 60) < 1e-6);
  near(form.pts[2], 60 + 20 * Math.cos(Math.PI / 6), 1e-4, 'form turned 30 degrees (cm written to 5 decimals)');
  near(form.pts[3], 200 + 20 * Math.sin(Math.PI / 6), 1e-4);
  assert.equal(m.entities.filter((e) => e.layer === 'Annotations').length, 1, 'the annotation (a PDF viewer markup)');
  const t = texts(m);
  assert.deepEqual([...t.keys()].sort(), ['ELEV +2.50', 'FORM 30', 'KEEP CLEAR', 'PLAN VIEW A', 'PUMP-7 INLET', 'Ø25 ±0.1 50°C'].sort());
  const pv = t.get('PLAN VIEW A');
  assert.deepEqual(pv.p.map((v) => +v.toFixed(9)), [20, 260]);
  near(pv.h, 3.5, 1e-9, '5 mm font -> 3.5 mm cap height');
  near(t.get('ELEV +2.50').rot, Math.PI / 2, 1e-9);
  near(t.get('FORM 30').rot, Math.PI / 6, 1e-5);
  assert.equal(t.get('KEEP CLEAR').rgb, 0xff0000);
  assert.ok(pv.p2[0] - pv.p[0] > 25 && pv.p2[0] - pv.p[0] < 40, 'width from the font metrics');
});

test('pdf-schematic.pdf: a Tabloid page in inches, text-heavy; optional content layers (one off), wire numbers on theirs, red caution, junction dots', async () => {
  const m = await open('pdf-schematic.pdf');
  assert.equal(m.units.abbr, 'in');
  assert.deepEqual(m.page.box, [0, 0, 17, 11]);
  assert.deepEqual(m.layers.map((l) => [l.name, l.visible]).filter(([n]) => ['Wires', 'Wire numbers', 'Notes'].includes(n)), [['Wires', true], ['Wire numbers', true], ['Notes', false]]);
  const t = ents(m, 'text');
  assert.ok(t.length >= 130, 'text items: ' + t.length);
  const wn = t.filter((e) => /^W1\d\d$/.test(e.text));
  assert.equal(wn.length, 45);
  assert.ok(wn.every((e) => e.layer === 'Wire numbers' && e.rgb === 0x0000cc), 'wire numbers: their layer and colour');
  assert.ok(t.filter((e) => /^NOTE/.test(e.text)).every((e) => e.layer === 'Notes'));
  assert.equal(t.find((e) => /^CAUTION/.test(e.text)).rgb, 0xff0000);
  assert.ok(t.some((e) => /^Ø10 STUD\s+±0\.5\s+85°C MAX$/.test(e.text)), 'WinAnsi characters');
  assert.equal(ents(m, 'polyline').filter((e) => e.layer === 'Wires').length, 45, 'wires');
  assert.equal(ents(m, 'circle').filter((e) => e.fill != null).length, 8, 'junction dots: filled circles (centre snap)');
  near(ents(m, 'circle')[0].r, 3 / 72, 1e-9);
});

test('pdf-multipage.pdf: pages, labels, an offset media box, a page turned by /Rotate; a page out of range is clamped', async () => {
  const p1 = await open('pdf-multipage.pdf');
  assert.deepEqual([p1.page.n, p1.page.count, p1.page.label, p1.page.labels], [1, 3, 'i', ['i', '1', '2']]);
  assert.equal(p1.units.abbr, 'in');
  near(len(ents(p1, 'line')[0]), 2, 1e-9, '2 in');
  const p2 = await open('pdf-multipage.pdf', { page: 2 });
  assert.equal(p2.units.abbr, 'mm');
  near(p2.page.box[2], 297, 0.1); near(p2.page.box[3], 210, 0.1);
  const l2 = ents(p2, 'line')[0];
  near(len(l2), 50, 1e-4, '50 mm');
  near(l2.a[0], 50 * 25.4 / 72, 1e-6, 'measured from the media box corner, not from 0,0');
  assert.equal(texts(p2).get('PAGE TWO').text, 'PAGE TWO');
  const p3 = await open('pdf-multipage.pdf', { page: 3 });
  assert.deepEqual([p3.page.rotate, p3.page.box], [90, [0, 0, 11, 8.5]], 'landscape as displayed');
  const L = ents(p3, 'polyline')[0].pts;
  // turned clockwise: the long leg (up the page) runs right to left, the short leg (to the right) runs down
  near(L[0] - L[2], 200 / 72, 1e-9); near(L[1] - L[3], 0, 1e-9);
  near(L[3] - L[5], 100 / 72, 1e-9); near(L[2] - L[4], 0, 1e-9);
  near(texts(p3).get('PAGE THREE').rot, -Math.PI / 2, 1e-9, 'text reads downwards');
  assert.equal((await open('pdf-multipage.pdf', { page: 99 })).page.n, 3);
});

test('pdf-scan.pdf: a scanned page (raster): flagged, warned, pictures not drawable in Node; its invisible text on a hidden layer', async () => {
  const m = await open('pdf-scan.pdf');
  assert.equal(m.page.raster, true);
  assert.equal(m.underlay, undefined, 'no OffscreenCanvas here: the browser draws the picture (e2e)');
  assert.equal(m.stats.notShown[NS_IMAGES], 1);
  assert.ok(/scanned image: it is shown as a picture.*no text recognition/.test(m.stats.warnings[0]), m.stats.warnings[0]);
  const ocr = ents(m, 'text')[0];
  assert.deepEqual([ocr.text, ocr.layer], ['PUMP-7 INLET', 'Text (invisible)']);
  assert.equal(m.layers[0].visible, false);
});

test('protected and damaged PDFs: friendly messages; owner-password-only files open; limits', async () => {
  await assert.rejects(open('pdf-password.pdf'), (e) => e.code === 'pdf-password' && /protected by a password/.test(e.message));
  const o = await open('pdf-owner.pdf');
  assert.equal(ents(o, 'text')[0].text, 'OWNER ONLY');
  await assert.rejects(open('pdf-broken.pdf'), (e) => e.code === 'pdf-unreadable' && /could not be read/.test(e.message));
  await assert.rejects(quiet(() => parsePdf(Buffer.from('not a pdf at all'))), (e) => e.code === 'pdf-unreadable');
  await assert.rejects(open('pdf-plan.pdf', { maxBytes: 100 }), (e) => e.code === 'pdf-too-large');
  await assert.rejects(open('pdf-schematic.pdf', { timeLimitMs: 1 }), (e) => e.code === 'pdf-timeout' && /too long/.test(e.message));
  assert.equal((await open('pdf-plan.pdf')).format, 'PDF', 'the next PDF opens normally');
});

test("Linework's own vector print, read back: the house plan at 1:100 on A3 (a 12 m wall is 120 mm on paper), its text and colours", async () => {
  const m = await open('pdf-print-house-plan.pdf');
  assert.equal(m.units.abbr, 'mm');
  near(m.page.box[2], 420, 0.5); near(m.page.box[3], 297, 0.5);
  const walls = ents(m, 'polyline').filter((e) => e.closed && e.pts.length === 8 && Math.abs(e.pts[2] - e.pts[0] - 120) < 0.01);
  assert.ok(walls.length >= 1, 'the outer wall: 120 mm');
  const w = walls[0].pts;
  near(w[5] - w[3], 80, 0.01, '80 mm');
  assert.ok(ents(m, 'text').some((e) => /GROUND FLOOR PLAN/.test(e.text)), 'its title is text');
  assert.ok(m.layers.some((l) => l.name === 'Lines (red)'), 'coloured layers (doors)');
  assert.equal(m.stats.notShown[NS_IMAGES], undefined, 'a vector PDF: no pictures');
});

// ------------------------------------------------------------------ the rest of the app on a PDF page
test('scene: the page is the drawing extents (also when empty); page and picture boxes move to scene coordinates; find and snaps work', async () => {
  const m = await open('pdf-plan.pdf');
  const s = buildScene(m, { fileName: 'pdf-plan.pdf' });
  assert.equal(s.format, 'PDF');
  const ext = [s.extents[0] + s.origin[0], s.extents[1] + s.origin[1], s.extents[2] + s.origin[0], s.extents[3] + s.origin[1]];
  near(ext[0], 0, 1e-9); near(ext[1], 0, 1e-9); near(ext[2], 210.0016, 1e-3); near(ext[3], 297, 1e-3);
  assert.deepEqual(s.page.box, s.extents, 'the page box, scene-local');
  assert.deepEqual(findTexts(s, 'pump-7').map((h) => h.s), ['PUMP-7 INLET']);
  const [ox, oy] = s.origin;
  const snap = findSnap(s, 120 - ox + 0.2, 20 - oy + 0.1, 1);
  assert.deepEqual([snap.kind, +(snap.x + ox).toFixed(9), +(snap.y + oy).toFixed(9)], ['endpoint', 120, 20]);
  const c = findSnap(s, 150 - ox + 0.3, 60 - oy, 1);
  assert.equal(c.kind, 'center');
  assert.equal(measure('distance', [20, 20, snap.x + ox, snap.y + oy]).value, 100);
  // an empty page, and a picture-only page: still a page to measure and mark up
  const e = pageToModel({ ops: opl(), T: T0, W: 300, H: 200 }).model;
  e.page = { n: 1, count: 1, box: [0, 0, 300, 200] };
  e.underlay = { image: {}, box: [0, 0, 300, 200], w: 30, h: 20 };
  const se = buildScene(e);
  assert.equal(se.empty, false);
  assert.deepEqual(se.extents, [-150, -100, 150, 100]);
  assert.deepEqual(se.underlay.box, [-150, -100, 150, 100]);
});

test('save: a PDF page as DXF (lines, arcs, circles, fills, line types, text, mm) and as DGN v7; both read back', async () => {
  const m = await open('pdf-plan.pdf');
  const { text } = writeDxf(m, {});
  const d = parseDxf(new TextEncoder().encode(text));
  assert.equal(d.units.abbr, 'mm');
  for (const [k, K] of [['line', 'LINE'], ['arc', 'ARC'], ['text', 'TEXT'], ['circle', 'CIRCLE'], ['polyline', 'LWPOLYLINE']]) assert.equal(d.stats.byType[K] || 0, m.stats.byType[k] || 0, k);
  assert.equal(d.stats.byType.HATCH, 2, 'the two fills: solid hatches under their outlines');
  assert.ok(writeDxf(m, {}).notes.some((n) => /^2 filled shapes were saved as solid hatches/.test(n)), 'the note says so (not "DGN fills")');
  const sd = buildScene(d);
  assert.deepEqual(findTexts(sd, 'PLAN VIEW A').length, 1);
  assert.ok(Object.values(d.ltypes).some((l) => /PDF-DASH/.test(l.name)), 'the dash pattern is a line type');
  const g = writeDgn(m, {});
  const dg = parseDgn(g.bytes);
  assert.equal(dg.entities.length, m.entities.length, 'DGN has the items');
  assert.equal(dg.stats.byType.TEXT, 6);
});

test('worker: a PDF page is read from the bytes with its page number; its hash is per page; the picture stays out of the model message', async () => {
  const buf = () => { const b = bytes('pdf-multipage.pdf'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const r1 = await quiet(() => loadInWorkerScope({ id: 1, name: 'm.pdf', buffer: buf() }, () => {}));
  const r2 = await quiet(() => loadInWorkerScope({ id: 2, name: 'm.pdf', buffer: buf(), page: 2 }, () => {}));
  assert.equal(r1.scene.page.n, 1);
  assert.equal(r2.scene.page.n, 2);
  assert.equal(r2.scene.hash, r1.scene.hash + '-p2', 'markups and unsaved edits are kept per page');
  assert.equal(r1.bytes, null, 'no original bytes for editing (a PDF is never written)');
  const meta = modelMeta({ ...r1.model, underlay: { image: {} } });
  assert.ok(!('underlay' in meta) && meta.page.count === 3, 'the picture travels with the scene only');
  const viaDetect = await quiet(() => parseDrawingAsync(bytes('pdf-plan.pdf'), 'pdf-plan.pdf'));
  assert.equal(viaDetect.format, 'PDF');
});

test('a PDF writer sanity check: the fixture writer makes files other readers accept (xref offsets, lengths)', () => {
  const b = makePdf({ pages: [{ size: [100, 100], content: String(new Content().line(0, 0, MM, MM)) }] });
  const s = b.toString('latin1');
  const xref = +/startxref\n(\d+)/.exec(s)[1];
  assert.equal(s.slice(xref, xref + 4), 'xref');
  const offs = [...s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((x) => +x[1]);
  offs.forEach((o, i) => assert.equal(s.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1}`));
});
