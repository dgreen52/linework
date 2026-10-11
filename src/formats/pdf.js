// PDF reader built on Mozilla pdf.js (Apache-2.0), vendored in vendor/pdfjs/ (provenance:
// vendor/pdfjs/README.md, PDF.md). PDFs are read-only: an opened page is a drawing like any other
// (find, measure, snap, markups, editing), saved as DXF or DGN.
//
// * pdf.js is fetched only when the first PDF is opened (this file is imported lazily by
//   detect.js), then cached by the service worker in a cache of its own. DXF/DGN users never
//   download it. It runs here, in the parse worker, in-thread (globalThis.pdfjsWorker): no worker
//   of its own, no fonts installed, nothing fetched but its WebAssembly image decoders.
// * One page at a time (opts.page, 1-based) becomes the model: its vector paths (the operator
//   list: paths, transforms, colours, line widths, dashes, optional-content layers) as lines,
//   polylines, arcs, circles, splines and fills; its text (text content: strings, positions, sizes,
//   angles) as text items fitted to their width. Units are the paper: millimetres, or inches for
//   inch-sized pages (1 pt = 1/72 in); the page is the drawing's extents (model.page).
// * Pictures (scanned pages, photos, gradients) cannot be vectors: they are drawn by pdf.js into one
//   picture of the page (pictures only) shown under the drawing (model.underlay).

import { FormatError, createModel, ensureLayer, countType, notShown, warn, unitsFromCode, FG } from '../model.js';
import { mul, TAU } from '../geom.js';

const VENDOR = '../../vendor/pdfjs/';
/** Version of the vendored pdf.js: part of its URLs and of the service worker's reader cache name
 *  (sw.js PDF_READER_CACHE). Bump both when vendor/pdfjs changes. */
export const PDF_READER_REV = '6.3.289';
/** Largest PDF we try to open. */
export const MAX_PDF_BYTES = 300 * 1024 * 1024;
/** Most drawing items one page may produce (beyond: "not shown"). */
export const MAX_PAGE_ITEMS = 600000;
/** Time one page may take (pdf.js yields while it reads, so a timer can stop it). */
export const PAGE_TIME_LIMIT_MS = 120000;
/** The picture under the drawing: about 200 dpi, at most this many pixels. */
export const UNDERLAY_DPI = 200, UNDERLAY_MAX_PX = 10e6;

/** pdf.js operator numbers used here (its OPS table). */
export const OPS = {
  setLineWidth: 2, setDash: 6, setGState: 9, save: 10, restore: 11, transform: 12, stroke: 20, closeStroke: 21,
  fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27, endPath: 28,
  beginText: 31, setCharSpacing: 33, setWordSpacing: 34, setHScale: 35, setLeading: 36, setFont: 37,
  setTextRenderingMode: 38, setTextRise: 39, moveText: 40, setLeadingMoveText: 41, setTextMatrix: 42, nextLine: 43,
  showText: 44, setStrokeColorN: 53, setFillColorN: 55, setStrokeRGBColor: 58, setFillRGBColor: 59, shadingFill: 62,
  beginMarkedContent: 69, beginMarkedContentProps: 70, endMarkedContent: 71, paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75, beginGroup: 76, endGroup: 77, beginAnnotation: 80, endAnnotation: 81,
  paintImageMaskXObject: 83, paintImageMaskXObjectGroup: 84, paintImageXObject: 85, paintInlineImageXObject: 86,
  paintInlineImageXObjectGroup: 87, paintImageXObjectRepeat: 88, paintImageMaskXObjectRepeat: 89,
  paintSolidColorImageMask: 90, constructPath: 91, setStrokeTransparent: 92, setFillTransparent: 93, rawFillPath: 94,
};
const IMAGE_OPS = new Set([OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintImageXObject, OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask]);
const STROKES = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const FILLS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const D = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 }; // pdf.js DrawOPS

export const NS_IMAGES = 'Pictures (too small to show, or not drawable here)';
export const NS_LIMIT = 'Items beyond the per-page limit';

/** '%PDF-' in the first kilobyte (a few producers put something before the header). */
export function isPdf(b) {
  const n = Math.min(b.length, 1024);
  for (let i = 0; i + 5 <= n; i++) if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2d) return true;
  return false;
}

// ------------------------------------------------------------------ units, colours
/** Inches when both sides of the page are whole or half inches (Letter, Tabloid, ANSI, ARCH), else mm. */
export function pageUnits(wPt, hPt) {
  const half = (v) => v > 0 && Math.abs(v / 36 - Math.round(v / 36)) < 0.02;
  return half(wPt) && half(hPt) ? { code: 1, perPt: 1 / 72 } : { code: 4, perPt: 25.4 / 72 };
}

/** '#rrggbb' (pdf.js colours) -> 0xRRGGBB, or null. */
export const hexColor = (s) => (typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s) ? parseInt(s.slice(1), 16) : null);
const channels = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
/** Black and near black (also CMYK black, #231f20) -> the foreground colour (white on dark, black on paper). */
export function isInk(c) { const [r, g, b] = channels(c); return Math.max(r, g, b) < 0x48 && Math.max(r, g, b) - Math.min(r, g, b) < 0x20; }
const isPaper = (c) => { const [r, g, b] = channels(c); return Math.min(r, g, b) > 0xf0; };
const light = (c) => { const [r, g, b] = channels(c); return (r + g + b) / 765 > 0.6; };
/** Colour name for a layer: '' (black), 'grey', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'magenta', 'white'. */
export function colorName(c) {
  if (c == null || isInk(c)) return '';
  const [r, g, b] = channels(c), mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < 0x30) return mn > 0xe0 ? 'white' : 'grey';
  let h;
  if (mx === r) h = ((g - b) / (mx - mn) + 6) % 6; else if (mx === g) h = (b - r) / (mx - mn) + 2; else h = (r - g) / (mx - mn) + 4;
  h *= 60;
  return h < 15 || h >= 335 ? 'red' : h < 45 ? 'orange' : h < 70 ? 'yellow' : h < 165 ? 'green' : h < 195 ? 'cyan' : h < 255 ? 'blue' : 'magenta';
}
/** Model colour props for a colour: black -> ACI 7 (foreground), else true colour. */
const colorProps = (c) => (c == null || isInk(c) ? { color: 7, rgb: null } : { color: 256, rgb: c });
const sceneColor = (c) => (c == null || isInk(c) ? FG : c);

// ------------------------------------------------------------------ geometry helpers
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

/** Number of line segments for a cubic Bézier so that it stays within tol (Wang's formula). */
function cubicSteps(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y, tol) {
  const ax = p0x - 2 * p1x + p2x, ay = p0y - 2 * p1y + p2y, bx = p1x - 2 * p2x + p3x, by = p1y - 2 * p2y + p3y;
  const L = Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
  return Math.max(1, Math.min(96, Math.ceil(Math.sqrt((0.75 * L) / tol))));
}
const bez = (t, a, b, c, d) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
/** Append the points of a cubic (without its start) to out. */
function flatten(out, x0, y0, s, tol) {
  const n = cubicSteps(x0, y0, s[0], s[1], s[2], s[3], s[4], s[5], tol);
  for (let k = 1; k <= n; k++) { const t = k / n; out.push(bez(t, x0, s[0], s[2], s[4]), bez(t, y0, s[1], s[3], s[5])); }
}

/**
 * pdf.js path (DrawOPS in a Float32Array, user space) -> subpaths in drawing coordinates:
 * [{ x, y (start), segs: [[x, y] | [x1, y1, x2, y2, x, y]], closed }].
 */
export function subpaths(path, M) {
  const out = [];
  let cur = null, cx = 0, cy = 0;
  const P = (x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  const start = (ux, uy) => { const [x, y] = P(ux, uy); cur = { x, y, ux, uy, segs: [], closed: false }; out.push(cur); };
  for (let i = 0; i < path.length;) {
    const op = path[i++];
    if (op === D.moveTo) {
      cx = path[i++]; cy = path[i++];
      start(cx, cy);
    } else if (op === D.lineTo) {
      cx = path[i++]; cy = path[i++];
      if (!cur) { start(cx, cy); continue; }
      cur.segs.push(P(cx, cy));
    } else if (op === D.curveTo) {
      const a = P(path[i], path[i + 1]), b = P(path[i + 2], path[i + 3]), c = P(path[i + 4], path[i + 5]);
      cx = path[i + 4]; cy = path[i + 5]; i += 6;
      if (cur) cur.segs.push([...a, ...b, ...c]);
    } else if (op === D.quadraticCurveTo) {
      const [x0, y0] = cur ? P(cx, cy) : [0, 0];
      const q = P(path[i], path[i + 1]), e = P(path[i + 2], path[i + 3]);
      cx = path[i + 2]; cy = path[i + 3]; i += 4;
      if (cur) cur.segs.push([x0 + (2 / 3) * (q[0] - x0), y0 + (2 / 3) * (q[1] - y0), e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1]), e[0], e[1]]);
    } else if (op === D.closePath) {
      if (cur) {
        cur.closed = true;
        // drawing on after h (without m) starts again at the subpath's start
        cx = cur.ux; cy = cur.uy;
        start(cx, cy);
        cur.after = true;
      }
    } else break; // unknown: stop reading this path
  }
  return out.filter((s) => s.segs.length || !s.after);
}

/** Circle through three points: [cx, cy, r] or null. */
function circle3(ax, ay, bx, by, cx, cy) {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return [ux, uy, Math.hypot(ax - ux, ay - uy)];
}

/**
 * A run of cubic segments that is a circular arc (how PDF writers draw circles and arcs):
 * { c, r, a0, a1 (radians, CCW), full } or null.
 */
export function bezierArc(x0, y0, segs) {
  const n = segs.length;
  if (!n || n > 16) return null;
  const mid = (s, px, py) => [bez(0.5, px, s[0], s[2], s[4]), bez(0.5, py, s[1], s[3], s[5])];
  const ends = [[x0, y0]];
  for (const s of segs) ends.push([s[4], s[5]]);
  const m0 = mid(segs[0], x0, y0);
  const last = ends[n];
  const c = n >= 2 ? circle3(x0, y0, ends[1][0], ends[1][1], ends[2][0], ends[2][1]) || circle3(x0, y0, m0[0], m0[1], ends[1][0], ends[1][1])
    : circle3(x0, y0, m0[0], m0[1], last[0], last[1]);
  if (!c) return null;
  const [cx, cy, r] = c;
  if (!(r > 0) || !Number.isFinite(r)) return null;
  const tol = Math.max(r * 2e-3, 1e-9);
  let sweep = 0;
  for (let k = 0; k < n; k++) {
    const s = segs[k], [px, py] = ends[k], m = mid(s, px, py);
    for (const [x, y] of [[s[4], s[5]], m]) if (Math.abs(Math.hypot(x - cx, y - cy) - r) > tol) return null;
    // the control points of an arc of a circle lie on the tangents, at 4/3 tan(sweep / 4) r
    const a = Math.atan2(py - cy, px - cx), b = Math.atan2(s[5] - cy, s[4] - cx);
    let d = b - a;
    const cross = (px - cx) * (m[1] - cy) - (py - cy) * (m[0] - cx);
    if (cross >= 0) { while (d <= 0) d += TAU; } else { while (d >= 0) d -= TAU; }
    if (Math.abs(d) > Math.PI + 1e-6) return null; // one Bézier never draws more than half a circle
    const k4 = (4 / 3) * Math.tan(Math.abs(d) / 4) * r;
    if (Math.abs(Math.hypot(s[0] - px, s[1] - py) - k4) > 4 * tol + r * 0.01 || Math.abs(Math.hypot(s[2] - s[4], s[3] - s[5]) - k4) > 4 * tol + r * 0.01) return null;
    if (sweep && Math.sign(d) !== Math.sign(sweep)) return null;
    sweep += d;
  }
  if (Math.abs(sweep) > TAU + 1e-6) return null;
  const full = Math.abs(Math.abs(sweep) - TAU) < 1e-3 && Math.hypot(last[0] - x0, last[1] - y0) <= tol;
  let a0 = Math.atan2(y0 - cy, x0 - cx), a1 = a0 + sweep;
  if (sweep < 0) [a0, a1] = [a1, a0];
  return { c: [cx, cy], r, a0, a1, full };
}

// ------------------------------------------------------------------ operator list -> model
/**
 * Convert one page (pure; pdf.js only supplies the data). input:
 * { ops: { fnArray, argsArray }, items (text content items), T (user space -> drawing), W, H (drawing
 *   units), units (model units code), ocName(group) -> layer name | null, ocVisible(group) -> bool,
 *   fontMatrix(fontId) -> [6] | null, tol (curve flatness, drawing units), maxItems, deadline }
 * Returns { model, info: { images, imageCover (0..1 of the page), shadings, paths, texts, invisible } }.
 */
export function pageToModel(input) {
  const { ops, items = [], T, W, H } = input;
  const model = createModel('PDF');
  model.units = unitsFromCode(input.units ?? 4);
  const tol = input.tol || Math.max(W, H) * 2e-5;
  const maxItems = input.maxItems || MAX_PAGE_ITEMS;
  const ocName = input.ocName || (() => null), ocVisible = input.ocVisible || (() => true);
  const fontMatrix = input.fontMatrix || (() => null);
  const ents = model.entities;
  const info = { images: 0, imageCover: 0, shadings: 0, paths: 0, texts: 0, invisible: 0, annotations: 0, white: 0 };
  let limited = false;
  const push = (e) => {
    if (ents.length >= maxItems) { limited = true; notShown(model, NS_LIMIT); return; }
    ents.push(e);
    countType(model, e.type);
  };
  // layers: optional content name, else by kind (and colour for lines)
  const layerColors = new Map();
  const layer = (name, color, hidden) => {
    const L = ensureLayer(model, name, color);
    if (!layerColors.has(name)) { layerColors.set(name, color); if (hidden) L.visible = false; }
    return name;
  };
  const ltypes = new Map();
  const ltypeFor = (dash, scale) => {
    if (!dash || !dash.length || dash.every((v) => !v)) return undefined;
    const pattern = [];
    dash.forEach((v, i) => pattern.push(i % 2 ? -Math.abs(v * scale) : Math.abs(v * scale)));
    if (pattern.length % 2) pattern.push(...pattern.map((v) => -v)); // odd arrays repeat with dash and gap swapped
    const key = pattern.map((v) => +v.toPrecision(6)).join(',');
    let name = ltypes.get(key);
    if (!name) {
      name = `PDF-DASH-${ltypes.size + 1}`;
      ltypes.set(key, name);
      model.ltypes[name] = { name, desc: `PDF dash ${key}`, pattern: pattern.map((v) => (Math.abs(v) < 1e-9 ? 0 : v)) };
    }
    return name;
  };

  // graphics state
  let g = { ctm: [1, 0, 0, 1, 0, 0], lw: 1, dash: null, stroke: 0, fill: 0, sa: 1, fa: 1, pattern: false };
  let t = { tm: [1, 0, 0, 1, 0, 0], x: 0, y: 0, lx: 0, ly: 0, font: null, size: 0, dir: 1, fm: null, cs: 0, ws: 0, hs: 1, lead: 0, rise: 0, mode: 0 };
  const stack = [], marks = [], annot = [];
  const runs = []; // text shown by the operator list: where, which colour, layer, render mode
  const hiddenOc = new Set(); // optional content that is off by default
  const ocLayer = () => { for (let i = marks.length - 1; i >= 0; i--) if (marks[i]) return marks[i]; return null; };
  const pageArea = Math.max(W * H, 1e-12);
  const clipBox = (x0, y0, x1, y1) => Math.max(0, Math.min(x1, W) - Math.max(x0, 0)) * Math.max(0, Math.min(y1, H) - Math.max(y0, 0));
  let cover = 0;
  const image = (n = 1) => {
    const M = mul(T, g.ctm);
    const xs = [], ys = [];
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const p = apply(M, u, v); xs.push(p[0]); ys.push(p[1]); }
    cover += n * clipBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    info.images += n;
  };

  const { fnArray, argsArray } = ops;
  const N = fnArray.length;
  for (let i = 0; i < N; i++) {
    if ((i & 4095) === 4095 && input.deadline && Date.now() > input.deadline) throw new FormatError('pdf-timeout', TIMEOUT);
    const fn = fnArray[i], a = argsArray[i];
    switch (fn) {
      case OPS.save: stack.push({ g, t }); g = { ...g }; t = { ...t }; break;
      case OPS.restore: if (stack.length) ({ g, t } = stack.pop()); break;
      case OPS.transform: g.ctm = mul(g.ctm, a); break;
      case OPS.paintFormXObjectBegin: stack.push({ g, t }); g = { ...g }; t = { ...t }; if (a && a[0]) g.ctm = mul(g.ctm, a[0]); break;
      case OPS.paintFormXObjectEnd: case OPS.endGroup: if (stack.length) ({ g, t } = stack.pop()); break;
      case OPS.beginGroup: stack.push({ g, t }); g = { ...g }; t = { ...t }; break;
      case OPS.beginAnnotation:
        stack.push({ g, t }); annot.push(true);
        g = { ...g, ctm: mul(a[2] || [1, 0, 0, 1, 0, 0], a[3] || [1, 0, 0, 1, 0, 0]) }; t = { ...t };
        info.annotations++;
        break;
      case OPS.endAnnotation: if (stack.length) ({ g, t } = stack.pop()); annot.pop(); break;
      case OPS.beginMarkedContentProps: {
        const oc = a && a[0] === 'OC' && a[1] ? ocName(a[1]) || 'Optional content' : null;
        if (oc && !ocVisible(a[1])) hiddenOc.add(oc);
        marks.push(oc);
        break;
      }
      case OPS.beginMarkedContent: marks.push(null); break;
      case OPS.endMarkedContent: marks.pop(); break;
      case OPS.setLineWidth: g.lw = a[0]; break;
      case OPS.setDash: g.dash = a[0] && a[0].length ? Array.from(a[0]) : null; break;
      case OPS.setGState:
        for (const [k, v] of a[0] || []) {
          if (k === 'LW') g.lw = v; else if (k === 'D') g.dash = v && v[0] && v[0].length ? Array.from(v[0]) : null;
          else if (k === 'CA') g.sa = v; else if (k === 'ca') g.fa = v;
          else if (k === 'Font' && v) { t.font = v[0]; t.size = Math.abs(v[1]); t.dir = v[1] < 0 ? -1 : 1; }
        }
        break;
      case OPS.setStrokeRGBColor: g.stroke = hexColor(a[0]) ?? 0; g.spat = false; break;
      case OPS.setFillRGBColor: g.fill = hexColor(a[0]) ?? 0; g.pattern = false; break;
      case OPS.setStrokeTransparent: g.stroke = null; break;
      case OPS.setFillTransparent: g.fill = null; break;
      case OPS.setStrokeColorN: g.spat = true; break; // a pattern: drawn in the foreground colour
      case OPS.setFillColorN: g.pattern = true; break;
      case OPS.shadingFill: info.shadings++; break;
      case OPS.constructPath: paint(a[0], a[1] && a[1][0]); break;
      case OPS.rawFillPath: paint(OPS.fill, a[0]); break;
      // text: where each piece of text is shown (to give the text content its colour and layer)
      case OPS.beginText: t.tm = [1, 0, 0, 1, 0, 0]; t.x = t.y = t.lx = t.ly = 0; break;
      case OPS.setTextMatrix: t.tm = Array.from(a[0] || a); t.x = t.y = t.lx = t.ly = 0; break;
      case OPS.moveText: t.x = t.lx += a[0]; t.y = t.ly += a[1]; break;
      case OPS.setLeadingMoveText: t.lead = a[1]; t.x = t.lx += a[0]; t.y = t.ly += a[1]; break;
      case OPS.nextLine: t.x = t.lx += 0; t.y = t.ly += t.lead; break;
      case OPS.setLeading: t.lead = -a[0]; break;
      case OPS.setCharSpacing: t.cs = a[0]; break;
      case OPS.setWordSpacing: t.ws = a[0]; break;
      case OPS.setHScale: t.hs = a[0] / 100; break;
      case OPS.setTextRise: t.rise = a[0]; break;
      case OPS.setTextRenderingMode: t.mode = a[0]; break;
      case OPS.setFont: t.font = a[0]; t.size = Math.abs(a[1]); t.dir = a[1] < 0 ? -1 : 1; t.fm = fontMatrix(a[0]); break;
      case OPS.showText: showText(a[0]); break;
      default:
        if (IMAGE_OPS.has(fn)) {
          let n = 1;
          if (fn === OPS.paintImageXObjectRepeat) n = Math.max(1, ((a && a[3]) || []).length / 2);
          else if (fn === OPS.paintImageMaskXObjectRepeat) n = Math.max(1, ((a && a[5]) || []).length / 2);
          else if (fn === OPS.paintImageMaskXObjectGroup) n = Math.max(1, ((a && a[0]) || []).length);
          image(n);
        }
    }
  }
  function showText(glyphs) {
    if (!glyphs || !t.size) return;
    const fm = t.fm || [0.001, 0, 0, 0.001, 0, 0];
    const hs = t.hs * t.dir;
    let x = 0;
    for (const gl of glyphs) {
      if (typeof gl === 'number') { x -= (gl * t.size) / 1000; continue; }
      if (!gl) continue;
      x += (gl.width || 0) * t.size * fm[0] + t.cs + (gl.isSpace ? t.ws : 0);
    }
    const M = mul(T, mul(g.ctm, t.tm));
    const p0 = apply(M, t.x, t.y + t.rise), p1 = apply(M, t.x + x * hs, t.y + t.rise);
    const up = Math.hypot(M[2], M[3]) * t.size;
    const mode = t.mode & 7;
    const color = mode === 1 || mode === 5 ? g.stroke : g.fill;
    runs.push({ x0: p0[0], y0: p0[1], x1: p1[0], y1: p1[1], up, color, mode, oc: ocLayer(), annot: annot.length > 0 });
    t.x += x * hs;
  }

  function paint(op, path) {
    if (!path || !path.length || op === OPS.endPath) return;
    const doStroke = STROKES.has(op) && g.stroke !== null && g.sa > 0, doFill = FILLS.has(op) && g.fill !== null && g.fa > 0;
    if (!doStroke && !doFill) return;
    const M = mul(T, g.ctm);
    const subs = subpaths(path, M);
    if (!subs.length) return;
    if (op === OPS.closeStroke || op === OPS.closeFillStroke || op === OPS.closeEOFillStroke) subs[subs.length - 1].closed = true;
    info.paths++;
    const oc = ocLayer();
    const sc = scaleOf(M); // drawing units per user unit
    let fillColor = null, fillOk = doFill;
    if (doFill) {
      fillColor = g.pattern ? null : g.fill;
      if (!g.pattern && fillColor != null && isPaper(fillColor)) { fillOk = false; info.white++; } // white = the paper
      else {
        // a fill covering (nearly) the whole page, or a light one covering most of it, is the page's background
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const s of subs) { for (const p of [[s.x, s.y], ...s.segs.map((q) => q.slice(-2))]) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; } }
        const area = clipBox(x0, y0, x1, y1);
        if (area > 0.85 * pageArea || (area > 0.4 * pageArea && (g.pattern || fillColor == null || light(fillColor)))) { fillOk = false; info.white++; }
      }
    }
    const strokeColor = g.spat ? null : g.stroke;
    const lw = Math.round(g.lw * sc * (model.units.code === 1 ? 2540 : 100));
    const base = (kind, c) => {
      const name = oc || (annot.length ? 'Annotations' : kind === 'fill' ? 'Fills' : `Lines${colorName(c) ? ` (${colorName(c)})` : ''}`);
      return { layer: layer(name, kind === 'fill' || oc || annot.length ? FG : sceneColor(c), oc && hiddenOc.has(oc)), ...colorProps(c) };
    };
    const strokeAttrs = () => {
      const e = base('line', strokeColor);
      e.lw = g.lw > 0 ? lw : -3;
      const lt = ltypeFor(g.dash, sc);
      if (lt) e.ltype = lt;
      return e;
    };
    // single closed loops of straight lines, circles: one item with its fill (snaps to corners, centres)
    const one = subs.length === 1 ? subs[0] : null;
    const straight = one && one.segs.every((s) => s.length === 2);
    const arc = one && !straight && one.segs.every((s) => s.length === 6) ? bezierArc(one.x, one.y, one.segs) : null;
    if (fillOk && arc && arc.full) {
      const e = doStroke ? strokeAttrs() : base('fill', fillColor);
      push({ type: 'circle', ...e, c: arc.c, r: arc.r, fill: sceneColor(fillColor) });
      return;
    }
    if (fillOk && straight && (one.closed || !doStroke) && one.segs.length >= 2) {
      const pts = loopPts(one);
      if (pts.length >= 6) {
        const e = doStroke ? strokeAttrs() : base('fill', fillColor);
        push({ type: 'polyline', ...e, pts, bulges: null, closed: true, fill: sceneColor(fillColor) });
        return;
      }
    }
    if (fillOk) {
      const loops = [];
      for (const s of subs) { const pts = loopPts(s); if (pts.length >= 6) loops.push({ pts, bulges: null }); }
      if (loops.length) push({ type: 'hatch', ...base('fill', fillColor), loops, solid: !g.pattern });
    }
    if (doStroke) for (const s of subs) strokeSub(s, strokeAttrs);
  }

  function loopPts(s) {
    const pts = [s.x, s.y];
    let x = s.x, y = s.y;
    for (const q of s.segs) {
      if (q.length === 2) pts.push(q[0], q[1]); else flatten(pts, x, y, q, tol);
      x = q[q.length - 2]; y = q[q.length - 1];
    }
    const n = pts.length;
    if (n >= 4 && Math.abs(pts[0] - pts[n - 2]) < 1e-9 && Math.abs(pts[1] - pts[n - 1]) < 1e-9) pts.length = n - 2;
    return pts;
  }

  function strokeSub(s, attrs) {
    if (!s.segs.length) return;
    const closed = s.closed;
    // straight lines only: a line or a polyline
    if (s.segs.every((q) => q.length === 2)) {
      const pts = [s.x, s.y];
      for (const q of s.segs) pts.push(q[0], q[1]);
      let n = pts.length / 2;
      if (closed && n > 2 && Math.abs(pts[0] - pts[2 * n - 2]) < 1e-9 && Math.abs(pts[1] - pts[2 * n - 1]) < 1e-9) { pts.length -= 2; n--; }
      if (n === 1 || (n === 2 && pts[0] === pts[2] && pts[1] === pts[3])) { push({ type: 'point', ...attrs(), p: [pts[0], pts[1]] }); return; }
      if (n === 2 && !closed) { push({ type: 'line', ...attrs(), a: [pts[0], pts[1]], b: [pts[2], pts[3]] }); return; }
      push({ type: 'polyline', ...attrs(), pts, bulges: null, closed: closed && n > 2 });
      return;
    }
    // curves only: an arc or a circle when they are one
    if (s.segs.every((q) => q.length === 6)) {
      const arc = bezierArc(s.x, s.y, s.segs);
      if (arc) {
        if (arc.full) push({ type: 'circle', ...attrs(), c: arc.c, r: arc.r });
        else push({ type: 'arc', ...attrs(), c: arc.c, r: arc.r, a0: arc.a0, a1: arc.a1 });
        if (closed && !arc.full) {
          const e = s.segs[s.segs.length - 1];
          if (Math.hypot(e[4] - s.x, e[5] - s.y) > 1e-9) push({ type: 'line', ...attrs(), a: [e[4], e[5]], b: [s.x, s.y] });
        }
        return;
      }
    }
    // mixed: straight runs as polylines, curved runs as splines (each snaps at its ends)
    let x = s.x, y = s.y, run = null, kind = '';
    const flush = () => {
      if (!run) return;
      if (kind === 'L') {
        if (run.length === 4) push({ type: 'line', ...attrs(), a: [run[0], run[1]], b: [run[2], run[3]] });
        else push({ type: 'polyline', ...attrs(), pts: run, bulges: null, closed: false });
      } else push({ type: 'spline', ...attrs(), pts: run, closed: false });
      run = null;
    };
    const segs = closed && Math.hypot(x - lastX(s), y - lastY(s)) > 1e-9 ? [...s.segs, [s.x, s.y]] : s.segs;
    for (const q of segs) {
      const k = q.length === 2 ? 'L' : 'C';
      if (k !== kind) { flush(); kind = k; run = [x, y]; }
      if (k === 'L') run.push(q[0], q[1]); else flatten(run, x, y, q, tol);
      x = q[q.length - 2]; y = q[q.length - 1];
    }
    flush();
  }

  // ---------------------------------------------------------------- text
  const findRun = makeRunFinder(runs);
  for (const it of items) {
    if (!it || typeof it.str !== 'string') continue;
    const s = it.str.replace(/\s+$/, '');
    if (!s.trim()) continue;
    const m = it.transform;
    if (!m || !m.every(Number.isFinite)) continue;
    const ux = Math.hypot(m[0], m[1]) || 1;
    const p = apply(T, m[4], m[5]);
    const w = it.width > 0 ? it.width : 0;
    const p2 = apply(T, m[4] + (m[0] / ux) * w, m[5] + (m[1] / ux) * w);
    const up = [T[0] * m[2] + T[2] * m[3], T[1] * m[2] + T[3] * m[3]];
    const size = Math.hypot(up[0], up[1]); // font size in drawing units
    if (!(size > 0)) continue;
    const base = [p2[0] - p[0], p2[1] - p[1]];
    const rot = w > 0 ? Math.atan2(base[1], base[0]) : Math.atan2(T[1] * m[0] + T[3] * m[1], T[0] * m[0] + T[2] * m[1]);
    const mirror = base[0] * up[1] - base[1] * up[0] < 0;
    const r = findRun(p[0], p[1], size);
    const invisible = r && (r.mode === 3 || r.mode === 7);
    const c = r ? r.color : 0;
    let name;
    if (invisible) { name = 'Text (invisible)'; info.invisible++; } else name = (r && r.oc) || (r && r.annot ? 'Annotations' : 'Text');
    const e = { type: 'text', layer: layer(name, FG, invisible || (r && r.oc && hiddenOc.has(r.oc))), ...colorProps(c), p, h: size * 0.7, rot, text: s, halign: 0, valign: 0, wf: 1, oblique: 0 };
    if (w > 0 && s.length > 0) { e.halign = 5; e.p2 = p2; }
    if (mirror) e.mirrorY = true;
    push(e);
    info.texts++;
  }
  if (limited) warn(model, `This page has more than ${maxItems.toLocaleString('en-US')} items; the rest are not shown.`);
  info.imageCover = Math.min(1, cover / pageArea);
  model.stats.entities = ents.length;
  return { model, info };
}
const TIMEOUT = 'This PDF took too long to read. Try another page, or save the drawing from its CAD program as DXF.';
const lastX = (s) => { const q = s.segs[s.segs.length - 1]; return q[q.length - 2]; };
const lastY = (s) => { const q = s.segs[s.segs.length - 1]; return q[q.length - 1]; };

/** Text runs of the operator list -> finder(x, y, size): the run a text item starts on (or null). */
function makeRunFinder(runs) {
  let at = 0;
  const dist = (r, x, y) => {
    const dx = r.x1 - r.x0, dy = r.y1 - r.y0, L2 = dx * dx + dy * dy;
    let u = L2 ? ((x - r.x0) * dx + (y - r.y0) * dy) / L2 : 0;
    u = Math.max(0, Math.min(1, u));
    return Math.hypot(r.x0 + u * dx - x, r.y0 + u * dy - y);
  };
  return (x, y, size) => {
    if (!runs.length) return null;
    const tol = Math.max(size * 0.35, 1e-9);
    let best = null, bd = Infinity;
    const look = (k) => { const d = dist(runs[k], x, y); if (d < bd - 1e-12) { bd = d; best = k; } };
    // text content follows the content stream, as the runs do: look just ahead, then around
    for (let k = at; k < Math.min(runs.length, at + 64); k++) { look(k); if (bd === 0) break; }
    if (bd > tol) for (let k = Math.max(0, at - 3000); k < Math.min(runs.length, at + 3000); k++) look(k);
    if (best === null || bd > tol) return null;
    at = best;
    return runs[best];
  };
}

// ------------------------------------------------------------------ loading pdf.js
let libPromise = null;
/** Load (once) pdf.js and its worker code, to run in this thread. */
export function loadPdfjs() {
  if (!libPromise) {
    libPromise = (async () => {
      const [lib, core] = await Promise.all([
        import(`${VENDOR}pdf.min.mjs?v=${PDF_READER_REV}`),
        import(`${VENDOR}pdf.worker.min.mjs?v=${PDF_READER_REV}`),
      ]);
      globalThis.pdfjsWorker = core; // pdf.js then runs in this thread: no worker of its own
      // the image decoders are fetched when a page needs them: fetch them now (in the background) so
      // the service worker keeps them and scanned pages open offline too
      if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
        for (const f of ['openjpeg.wasm', 'jbig2.wasm']) fetch(new URL(`${VENDOR}${f}?v=${PDF_READER_REV}`, import.meta.url)).then((r) => r.arrayBuffer(), () => {}).catch(() => {});
      }
      return lib;
    })();
    libPromise.catch(() => { libPromise = null; }); // allow a retry (e.g. after going back online)
  }
  return libPromise;
}

/** pdf.js canvases: OffscreenCanvas (there is no document in a worker). */
class Canvases {
  create(w, h) {
    if (!(w > 0 && h > 0)) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  reset(cc, w, h) { cc.canvas.width = w; cc.canvas.height = h; }
  destroy(cc) { if (cc.canvas) cc.canvas.width = cc.canvas.height = 0; cc.canvas = null; cc.context = null; }
}
/** No SVG filters in a worker (transfer functions and high-contrast modes are not used). */
class NoFilters {
  addFilter() { return 'none'; }
  addHCMFilter() { return 'none'; }
  addAlphaFilter() { return 'none'; }
  addLuminosityFilter() { return 'none'; }
  addKnockoutFilter() { return 'none'; }
  addHighlightHCMFilter() { return 'none'; }
  addSelectionHCMFilter() { return 'none'; }
  addSelectionFilter() { return 'none'; }
  createSelectionStyle() { return null; }
  destroy() {}
}
/** Binary data pdf.js asks for: only the WebAssembly image decoders, from vendor/pdfjs/. */
class Fetcher {
  constructor({ wasmUrl }) { this.wasmUrl = wasmUrl; }
  async fetch({ kind, filename }) {
    if (kind !== 'wasmUrl' || !this.wasmUrl) throw new Error(`${kind} is not available`);
    const r = await fetch(this.wasmUrl + filename);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
}

// ------------------------------------------------------------------ main entry
const UNREADABLE = 'This PDF could not be read (the file may be damaged or incomplete).';
/**
 * Read one page of a PDF into the common model (format 'PDF'). opts: { page (1-based), onPhase(label,
 * f), onProgress(f), timeLimitMs, maxBytes, underlay: false (no picture) }.
 */
export async function parsePdf(bytes, opts = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length > (opts.maxBytes || MAX_PDF_BYTES)) throw new FormatError('pdf-too-large', 'This PDF is too large to open in the browser (over 300 MB).');
  if (!isPdf(b)) throw new FormatError('pdf-unreadable', UNREADABLE);
  const phase = opts.onPhase || (() => {});
  const progress = opts.onProgress || (() => {});
  let lib;
  try {
    phase('Loading the PDF reader for', 0);
    lib = await loadPdfjs();
  } catch (e) {
    throw new FormatError('pdf-reader', `The PDF reader could not be loaded (${e && e.message ? e.message : e}). Check the connection and try again.`);
  }
  const deadline = Date.now() + (opts.timeLimitMs || PAGE_TIME_LIMIT_MS);
  const task = lib.getDocument({
    data: b.slice(), // pdf.js takes this copy (the caller keeps its bytes)
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: typeof OffscreenCanvas !== 'undefined',
    useWorkerFetch: false,
    wasmUrl: new URL(VENDOR, import.meta.url).href,
    CanvasFactory: Canvases,
    FilterFactory: NoFilters,
    BinaryDataFactory: Fetcher,
    enableXfa: false,
  });
  let timer = 0;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new FormatError('pdf-timeout', TIMEOUT)), Math.max(0, deadline - Date.now())); });
  timeout.catch(() => {});
  const within = (p) => Promise.race([p, timeout]);
  try {
    phase('Reading', 0.05);
    let doc;
    try {
      doc = await within(task.promise);
    } catch (e) {
      if (e instanceof FormatError) throw e;
      if (e && e.name === 'PasswordException') throw new FormatError('pdf-password', 'This PDF is protected by a password. Linework cannot open password-protected PDFs yet: save a copy without the password and open that.');
      const err = new FormatError('pdf-unreadable', UNREADABLE);
      err.cause = e;
      throw err;
    }
    const count = doc.numPages;
    if (!count) throw new FormatError('pdf-unreadable', 'This PDF has no pages.');
    const n = Math.max(1, Math.min(count, Math.round(opts.page || 1)));
    const page = await within(doc.getPage(n));
    const vp = page.getViewport({ scale: 1 }); // with the page's rotation
    const u = pageUnits(vp.width, vp.height);
    const k = u.perPt, W = vp.width * k, H = vp.height * k;
    // user space -> device (y down, points) -> drawing units (y up, origin at the page's lower left)
    const T = mul([k, 0, 0, -k, 0, H], vp.transform);
    progress(0.15);
    const [ops, text, occ, labels, meta] = await within(Promise.all([
      page.getOperatorList(),
      page.getTextContent().catch(() => ({ items: [] })),
      doc.getOptionalContentConfig().catch(() => null),
      doc.getPageLabels().catch(() => null),
      doc.getMetadata().catch(() => null),
    ]));
    progress(0.6);
    const groupName = (grp) => {
      if (!occ || !grp) return null;
      const id = grp.type === 'OCG' ? grp.id : grp.ids && grp.ids[0];
      const G = id && occ.getGroup ? occ.getGroup(id) : null;
      return G && G.name ? String(G.name).trim() || null : null;
    };
    const { model, info } = pageToModel({
      ops, items: text.items, T, W, H, units: u.code, deadline,
      ocName: groupName,
      ocVisible: (grp) => { try { return !occ || occ.isVisible(grp); } catch { return true; } },
      fontMatrix: (id) => { try { if (page.commonObjs.has(id)) { const f = page.commonObjs.get(id); return f && f.fontMatrix ? Array.from(f.fontMatrix) : null; } } catch { /* default */ } return null; },
      tol: u.code === 1 ? 0.0004 : 0.01,
    });
    progress(0.85);
    model.version = (meta && meta.info && meta.info.PDFFormatVersion) || '';
    const label = labels && labels[n - 1] ? String(labels[n - 1]) : '';
    model.page = { n, count, label, labels: labels && labels.length === count && labels.some((l, i) => l !== String(i + 1)) ? labels.map(String) : null, box: [0, 0, W, H], rotate: page.rotate || 0, size: [vp.width, vp.height] };
    model.header.pdf = { page: n, pages: count, title: (meta && meta.info && meta.info.Title) || '' };
    // pictures: one image of the page's pictures (and gradients) under the drawing
    const scanned = info.imageCover >= 0.5 && info.paths < 40;
    model.page.raster = scanned;
    const wantsPicture = info.imageCover >= 0.002 || info.shadings > 0;
    if (wantsPicture && opts.underlay !== false && typeof OffscreenCanvas !== 'undefined') {
      try {
        model.underlay = await within(renderPictures(page, ops, vp, W, H));
      } catch (e) {
        if (e instanceof FormatError) throw e;
        warn(model, 'The pictures on this page could not be shown.');
      }
    }
    if (!model.underlay && info.images) notShown(model, NS_IMAGES, info.images);
    if (scanned) {
      warn(model, `${count > 1 ? `Page ${label || n}` : 'This page'} is a scanned image: it is shown as a picture. Measure and markups work; its lines cannot be snapped to and there is no text recognition in this version.${info.invisible ? ' Its hidden text (from the scanner) is on the layer “Text (invisible)”: show that layer to search it.' : ''}`);
    } else if (model.underlay && info.imageCover >= 0.5) {
      warn(model, 'Most of this page is a picture: it is shown under the drawing’s lines and text.');
    }
    if (info.annotations) model.header.pdf.annotations = info.annotations;
    progress(1);
    return model;
  } finally {
    clearTimeout(timer);
    task.destroy().catch(() => {});
  }
}

/**
 * Draw the page's pictures (images, image masks, gradients; not its lines and text, which become
 * drawing items) into an ImageBitmap: { image, dark (inverted, for the dark theme; greyscale pictures
 * only), box, w, h }.
 */
async function renderPictures(page, ops, vp, W, H) {
  const pt = vp.width * vp.height;
  let scale = UNDERLAY_DPI / 72;
  scale = Math.min(scale, Math.sqrt(UNDERLAY_MAX_PX / pt), 8192 / Math.max(vp.width, vp.height));
  const view = page.getViewport({ scale });
  const w = Math.max(1, Math.floor(view.width)), h = Math.max(1, Math.floor(view.height));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // keep everything but painted paths and text (clipping paths, state, pictures and gradients stay);
  // the render reads its own operator list (the same as `ops`, which is the fallback)
  let task = null;
  const skip = (i) => {
    const L = (task && task._internalRenderTask && task._internalRenderTask.operatorList) || ops;
    const fn = L.fnArray[i];
    return fn === OPS.constructPath ? L.argsArray[i][0] !== OPS.endPath : fn === OPS.showText || fn === OPS.rawFillPath;
  };
  task = page.render({ canvasContext: ctx, viewport: view, background: 'rgba(0,0,0,0)', operationsFilter: (i) => !skip(i) });
  await task.promise;
  // greyscale pictures (scans) are shown inverted on the dark background, like the drawing
  const sw = Math.min(w, 256), sh = Math.min(h, 256), sample = new OffscreenCanvas(sw, sh), sc = sample.getContext('2d', { willReadFrequently: true });
  sc.drawImage(canvas, 0, 0, sw, sh);
  const px = sc.getImageData(0, 0, sw, sh).data;
  let seen = 0, grey = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 32) continue;
    seen++;
    if (Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) < 24) grey++;
  }
  let dark = null;
  if (seen && grey / seen > 0.97) {
    const inv = new OffscreenCanvas(w, h), c2 = inv.getContext('2d');
    c2.drawImage(canvas, 0, 0);
    c2.globalCompositeOperation = 'difference';
    c2.fillStyle = '#fff';
    c2.fillRect(0, 0, w, h);
    c2.globalCompositeOperation = 'destination-in';
    c2.drawImage(canvas, 0, 0);
    dark = inv.transferToImageBitmap();
  }
  return { image: canvas.transferToImageBitmap(), dark, box: [0, 0, W, H], w, h };
}
