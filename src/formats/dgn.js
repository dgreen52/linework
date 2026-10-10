// DGN v7 (ISFF) reader. Element layouts follow the public ISFF description and the logic of
// GDAL's dgnlib by Frank Warmerdam (MIT/X licence; see NOTICE), re-implemented in JavaScript.
// Produces the common model (see ../model.js). Bad/unknown elements are skipped and counted.

import { createModel, ensureLayer, countType, notShown, warn, FormatError, unitsFromLabel } from '../model.js';
import { DGN_DEFAULT } from '../palettes.js';
import { tessCatmullRom } from '../geom.js';

const D2R = Math.PI / 180;

export const TYPE_NAMES = {
  1: 'CELL_LIBRARY', 2: 'CELL', 3: 'LINE', 4: 'LINE_STRING', 5: 'GROUP_DATA', 6: 'SHAPE', 7: 'TEXT_NODE',
  8: 'DIGITIZER_SETUP', 9: 'TCB', 10: 'LEVEL_SYMBOLOGY', 11: 'CURVE', 12: 'COMPLEX_CHAIN', 14: 'COMPLEX_SHAPE',
  15: 'ELLIPSE', 16: 'ARC', 17: 'TEXT', 18: 'SURFACE', 19: 'SOLID', 21: 'BSPLINE_POLE', 22: 'POINT_STRING',
  23: 'CONE', 24: 'BSPLINE_SURFACE', 25: 'BSPLINE_BOUNDARY', 26: 'BSPLINE_KNOT', 27: 'BSPLINE_CURVE',
  28: 'BSPLINE_WEIGHTS', 33: 'DIMENSION', 34: 'SHARED_CELL_DEFN', 35: 'SHARED_CELL', 37: 'TAG_VALUE',
  66: 'APPLICATION', 87: 'RASTER_HEADER', 88: 'RASTER_COMPONENT', 90: 'RASTER_REFERENCE',
};
// non-graphic / bookkeeping elements: nothing to show (settings, tables, B-spline knots and weights)
const SILENT = new Set([1, 8, 9, 10, 26, 28, 34, 66]);

// ---- how complex elements group the elements that follow them (shared with dgn-write.js)
// Cells (2) and shared cell definitions (34): a word count at byte 36 (words after byte 38, the header's
// own included), components carry the complex bit. Text nodes (7), complex chains / shapes (12 / 14) and
// surfaces / solids (18 / 19) also have the number of components at byte 38; that count decides (as in
// dgnlib: some writers store a different word count). B-spline curve (27) / surface (24) headers are
// followed by their poles, knots, weights and boundaries.
const COUNTED = new Set([7, 12, 14, 18, 19]);
const BSPLINE_PARTS = { 27: new Set([21, 26, 28]), 24: new Set([21, 25, 26, 28]) };
export const isContainer = (type) => type === 2 || type === 34 || COUNTED.has(type) || !!BSPLINE_PARTS[type];
/** Grouping of the complex header at o: { end (claimed, exclusive), left (components to come; -1 = no count), kinds }. */
export function groupOf(b, o, type) {
  const words = b[o + 36] | (b[o + 37] << 8);
  if (BSPLINE_PARTS[type]) return { end: Infinity, left: -1, kinds: BSPLINE_PARTS[type] };
  if (COUNTED.has(type)) return { end: Infinity, left: b[o + 38] | (b[o + 39] << 8), kinds: null };
  return { end: o + 38 + 2 * words, left: -1, kinds: null };
}
/** Does the open group g end before the element at o (type, complex bit)? g: { end, left, seen, kinds } */
export const groupEnds = (g, o, type, comp) => !comp || o >= g.end || (g.left >= 0 && g.seen >= g.left) || (g.kinds && !g.kinds.has(type));

// Screen-pixel dash patterns for the 8 standard DGN line styles.
export const DGN_STYLES = [
  null, [1, 3], [8, 4], [16, 5], [10, 3, 1, 3], [4, 3], [10, 3, 1, 3, 1, 3], [16, 3, 5, 3],
];

/** Detect a DGN v7 design file (first element is the 1536-byte TCB, type 9). */
export function isDgnV7(b) {
  return b.length >= 4 && (b[0] & 0x3f) === 8 && (b[1] & 0x7f) === 9 && b[2] === 0xfe && b[3] === 0x02;
}
/** OLE compound document = DGN v8 (or another Office-style container). */
export function isOleCompound(b) {
  return b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1;
}

/** Fingerprint of a file's bytes (length + FNV-1a): copies can tell they come from the same file. */
export function fingerprint(b) {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193);
  return b.length.toString(36) + '-' + (h >>> 0).toString(36);
}

/**
 * 3D rotation matrix (rows, 3x3) of an ISFF quaternion (w, x, y, z as int32, 1.0 = 2^31), with the
 * convention of dgnlib's DGNQuaternionToMatrix: the transpose of the usual (Hamilton) matrix, so a
 * rotation of +a about Z is stored as (cos a/2, 0, 0, -sin a/2), as GDAL's writer does.
 */
export function quatToMatrix(w, x, y, z) {
  return [
    w * w + x * x - y * y - z * z, 2 * (z * w + x * y), 2 * (x * z - y * w),
    2 * (x * y - z * w), w * w - x * x + y * y - z * z, 2 * (x * w + y * z),
    2 * (x * z + y * w), 2 * (y * z - x * w), w * w - x * x - y * y + z * z,
  ];
}

/** Colour index of the fill linkage (user data linkage 0x0041) in the attribute data [p, end), or -1. */
export function fillLinkage(b, p, end) {
  while (p + 4 <= end) {
    let size;
    if (b[p] === 0 && (b[p + 1] === 0 || b[p + 1] === 0x80)) size = 8; // DMRS database linkage
    else if (b[p + 1] & 0x10) size = Math.min(512, b[p] * 2 + 2); // user data linkage
    else break;
    if (size <= 4 || p + size > end) break;
    if ((b[p + 2] | (b[p + 3] << 8)) === 0x41 && size >= 9) return b[p + 8];
    p += size;
  }
  return -1;
}

/** cp1252 decoding of text bytes, up to the first NUL (as GDAL / C strings read them). */
let CP = null;
function cp1252(bytes) {
  let n = bytes.indexOf(0);
  if (n < 0) n = bytes.length;
  const s = bytes.subarray ? bytes.subarray(0, n) : Uint8Array.from(bytes.slice(0, n));
  try { CP = CP || new TextDecoder('windows-1252'); return CP.decode(s); } catch { return String.fromCharCode(...s); }
}
/**
 * DGN text bytes -> string. 8-bit text is cp1252. 16-bit text (0xFF 0xFD, then 16-bit words) is turned
 * into bytes the way dgnlib does (a word below 256 is one byte, others two: high, low); those bytes are
 * UTF-8 when they form valid UTF-8 (this app writes characters outside cp1252 that way, and GDAL then
 * reads the same string), else cp1252; words of older 16-bit text that is neither are UTF-16 code units.
 */
export function decodeDgnText(bytes) {
  if (!(bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfd)) return cp1252(bytes);
  const words = [];
  for (let k = 2; k + 1 < bytes.length; k += 2) { const w = bytes[k] | (bytes[k + 1] << 8); if (!w) break; words.push(w); }
  const raw = [];
  for (const w of words) if (w < 256) raw.push(w); else raw.push(w >> 8, w & 255);
  const u8 = Uint8Array.from(raw);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { /* not UTF-8 */ }
  if (words.every((w) => w < 256)) return cp1252(u8);
  return String.fromCharCode(...words);
}

export function parseDgn(input, { onProgress } = {}) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (isOleCompound(b)) {
    throw new FormatError('dgn-v8', 'This looks like a DGN v8 file. Only DGN v7 is supported in this version — export it as DGN v7 or DXF.');
  }
  if (!isDgnV7(b)) throw new FormatError('not-dgn', 'This is not a DGN v7 design file (the header was not recognised).');
  const len = b.length;
  const u16 = (o) => b[o] | (b[o + 1] << 8);
  const i32 = (o) => b[o + 2] | (b[o + 3] << 8) | (b[o] << 16) | (b[o + 1] << 24);
  const vaxD = (o) => {
    const hi = ((u16(o) << 16) | u16(o + 2)) >>> 0, lo = ((u16(o + 4) << 16) | u16(o + 6)) >>> 0;
    const exp = (hi >>> 23) & 0xff;
    if (!exp) return 0;
    const frac = (hi & 0x7fffff) * 4294967296 + lo;
    return (hi >>> 31 ? -1 : 1) * (1 + frac / 36028797018963968) * Math.pow(2, exp - 129);
  };
  const ascii = (o, n) => { let s = ''; for (let k = 0; k < n; k++) { const c = b[o + k]; if (c) s += String.fromCharCode(c); } return s; };

  const model = createModel('DGN');
  model.version = 'V7';

  // ---- TCB (first element)
  const dim = b[1214] & 0x40 ? 3 : 2;
  let subPerMaster = i32(1112), uorPerSub = i32(1116);
  if (!(subPerMaster > 0)) subPerMaster = 1;
  if (!(uorPerSub > 0)) uorPerSub = 1;
  const uorPerMaster = subPerMaster * uorPerSub;
  const scale = 1 / uorPerMaster;
  const masterName = ascii(1120, 2).trim(), subName = ascii(1122, 2).trim();
  const ox = vaxD(1240) / uorPerMaster, oy = vaxD(1248) / uorPerMaster;
  model.units = unitsFromLabel(masterName);
  model.header = { dimension: dim, masterUnit: masterName, subUnit: subName, subPerMaster, uorPerSub, origin: [ox, oy], oz: vaxD(1256) / uorPerMaster, fid: fingerprint(b) };
  if (dim === 3) warn(model, '3D design file: shown in top (plan) view.');
  // Saved views (TCB bytes 46 + 118 * view): flags word (0x80 = view open), then a 64-bit level mask
  // (bit n-1 = level n). The first open view (else view 1) decides which levels start visible, the way
  // MicroStation opens the file.
  let savedView = 0;
  for (let v = 0; v < 8 && !savedView; v++) if (b[46 + v * 118] & 0x80) savedView = v + 1;
  if (!savedView) savedView = 1;
  const vmask = b.subarray(46 + (savedView - 1) * 118 + 2, 46 + (savedView - 1) * 118 + 10);
  const levelOnInView = (lv) => vmask.length === 8 && !!(vmask[(lv - 1) >> 3] & (1 << ((lv - 1) & 7)));
  const X = (raw) => raw * scale - ox;
  const Y = (raw) => raw * scale - oy;
  const P = dim === 3 ? 12 : 8; // bytes per vertex
  const joinTol = Math.max(2 * scale, 1e-9); // complex chain parts meet within 2 UOR

  // ---- pre-scan for a colour table (type 5, level 1); with several, the last one wins (as in GDAL)
  let palette = DGN_DEFAULT;
  for (let o = 0; o + 4 <= len;) {
    if (b[o] === 0xff && b[o + 1] === 0xff) break;
    const size = 4 + 2 * u16(o + 2);
    if ((b[o + 1] & 0x7f) === 5 && (b[o] & 0x3f) === 1 && size >= 806 && o + size <= len && !(b[o + 1] & 0x80)) {
      palette = new Uint32Array(256);
      for (let i = 0; i < 255; i++) palette[i] = (b[o + 41 + 3 * i] << 16) | (b[o + 42 + 3 * i] << 8) | b[o + 43 + 3 * i];
      palette[255] = (b[o + 38] << 16) | (b[o + 39] << 8) | b[o + 40];
      model.header.colorTable = true;
    }
    o += size;
  }

  model.header.palette = Array.from(palette); // colour table (index -> 0xRRGGBB), for editing
  const usedLevels = new Set();
  const cells = [];
  model.cells = cells;
  const stack = []; // open complex groups: { type, start, end, left, seen, parts, ... }

  const quatMatrix = (o) => quatToMatrix(i32(o) / 2147483648, i32(o + 4) / 2147483648, i32(o + 8) / 2147483648, i32(o + 12) / 2147483648);
  const fillOf = (o, size) => {
    const att = o + 32 + 2 * u16(o + 30);
    if (att < o + 36 || att >= o + size) return -1;
    return fillLinkage(b, att, o + size);
  };

  // Every entity keeps `dgn: [start, end)` = the byte range of its element(s) in the file, plus
  // its colour index, so the round-trip writer (dgn-write.js) can keep untouched bytes as they are.
  const base = (o, type, size) => {
    const level = b[o] & 0x3f;
    const top = stack[stack.length - 1];
    if (!(top && (top.type === 12 || top.type === 14))) usedLevels.add(level); // chain parts use the header's level
    const e = {
      layer: 'Level ' + level,
      color: 256,
      rgb: palette[b[o + 35]],
      ci: b[o + 35],
      weight: (b[o + 34] & 0xf8) >> 3,
      ltype: (b[o + 34] & 7) ? 'DGN' + (b[o + 34] & 7) : 'CONTINUOUS',
      src: TYPE_NAMES[type] || 'TYPE_' + type,
      dgn: [o, o + size],
    };
    const cell = enclosingCell();
    if (cell) e.group = cell.id;
    else if (top && top.rng) e.ctr = top.rng; // a part of a top-level text node / surface: saved with it
    if (type === 6 || type === 14 || type === 15) {
      const f = fillOf(o, size);
      if (f >= 0) { e.fill = palette[f]; e.fci = f; }
    }
    return e;
  };
  const enclosingCell = () => { for (let k = stack.length - 1; k >= 0; k--) if (stack[k].type === 2) return stack[k].cell; return null; };
  /** Entities inside a cell become its children; everything else is top level. */
  const place = (e) => { const cell = enclosingCell(); (cell ? cell.children : model.entities).push(e); };

  const readVerts = (o, count, size) => {
    const out = [];
    const n = Math.min(count, ((size - 38) / P) | 0);
    for (let i = 0; i < n; i++) {
      const p = o + 38 + i * P;
      out.push(X(i32(p)), Y(i32(p + 4)));
    }
    return out;
  };
  const readZs = (o, n) => { const out = []; for (let i = 0; i < n; i++) out.push(i32(o + 38 + i * P + 8)); return out; };

  const emit = (e) => {
    const top = stack[stack.length - 1];
    if (top && (top.type === 14 || top.type === 12)) { top.parts.push(e); return; } // complex chain/shape: joined later
    place(e);
  };

  const finishGroup = (g, end) => {
    g.end = end;
    if (g.rng) g.rng[1] = end;
    if (g.cell) g.cell.dgn[1] = end;
    if (g.type === 14 || g.type === 12) joinChain(g, end);
  };
  /**
   * Complex chain / shape -> one polyline. Circular arcs become bulges (exact, and written back as
   * arcs); other curved parts are approximated by points (`tess`). Parts run head to tail; one stored
   * the other way round is turned.
   */
  const joinChain = (g, end) => {
    const pts = [], into = [], zs = [], z3 = dim === 3; // into[k]: bulge of the segment that ends at vertex k
    let lastExact = true; // the last vertex is a stored one (not computed from an arc)
    let curved = false, tess = false;
    const near = (x, y) => Math.abs(pts[pts.length - 2] - x) <= joinTol && Math.abs(pts[pts.length - 1] - y) <= joinTol;
    for (const part of g.parts) {
      const s = partRun(part);
      if (!s || s.pts.length < 2) continue;
      if (s.tess) tess = true;
      const n = s.pts.length / 2;
      if (pts.length && !near(s.pts[0], s.pts[1]) && near(s.pts[2 * n - 2], s.pts[2 * n - 1])) reverseRun(s);
      const k0 = pts.length && near(s.pts[0], s.pts[1]) ? 1 : 0; // shared vertex: keep the one already there
      if (k0 && !lastExact && !s.arc) { pts[pts.length - 2] = s.pts[0]; pts[pts.length - 1] = s.pts[1]; } // ... unless a stored one is at hand
      lastExact = !s.arc;
      for (let k = k0; k < n; k++) {
        const bk = k ? s.bul[k - 1] || 0 : 0; // a gap between parts is a straight segment
        if (bk) curved = true;
        into.push(bk);
        pts.push(s.pts[2 * k], s.pts[2 * k + 1]);
        if (z3) zs.push(s.z[k] ?? s.z[0] ?? 0);
      }
    }
    const closed = g.type === 14;
    let closing = 0;
    if (closed && pts.length >= 6 && Math.abs(pts[0] - pts[pts.length - 2]) <= joinTol && Math.abs(pts[1] - pts[pts.length - 1]) <= joinTol) {
      if (lastExact && g.parts.length && partRun(g.parts[0]).arc) { pts[0] = pts[pts.length - 2]; pts[1] = pts[pts.length - 1]; }
      pts.length -= 2;
      closing = into.pop();
      if (z3) zs.length -= 1;
    }
    if (pts.length < 4) return;
    const bulges = into.slice(1);
    bulges.push(closed ? closing : 0);
    const e = { ...g.props, type: 'polyline', pts, bulges: curved ? bulges : null, closed, dgn: [g.start, end] };
    if (z3) { e.zv = zs; e.zr = zs[0]; }
    if (tess) e.tess = 1;
    place(e);
  };
  const reverseRun = (s) => {
    const n = s.pts.length / 2, p = [], bl = [];
    for (let k = n - 1; k >= 0; k--) p.push(s.pts[2 * k], s.pts[2 * k + 1]);
    for (let k = n - 2; k >= 0; k--) bl.push(-(s.bul[k] || 0));
    s.pts = p; s.bul = bl; s.z = s.z.slice().reverse();
  };
  /** One part of a complex chain as a run: { pts, bul (per segment), z (raw, per vertex), tess }. */
  const partRun = (e) => {
    const z = e.zv ? e.zv.slice() : [e.zr ?? 0];
    if (e.type === 'line') return { pts: [...e.a, ...e.b], bul: [0], z };
    if (e.type === 'polyline') {
      const p = e.closed ? [...e.pts, e.pts[0], e.pts[1]] : e.pts;
      if (e.closed && e.zv) z.push(e.zv[0]);
      return { pts: p, bul: [], z };
    }
    if (e.type === 'spline') return { pts: e.pts, bul: [], z, tess: true };
    let C = null; // circular arc in plan: centre, radius, start angle, signed sweep
    if (e.type === 'arc') C = { c: e.c, r: e.r, a: e.reversed ? e.a1 : e.a0, sw: (e.a1 - e.a0) * (e.reversed ? -1 : 1) };
    else if (e.type === 'ellipse') {
      const [ux, uy] = e.major, [vx, vy] = e.minor, r = Math.hypot(ux, uy), cr = ux * vy - uy * vx;
      if (r > 0 && Math.abs(Math.hypot(vx, vy) - r) <= 1e-9 * r && Math.abs(ux * vx + uy * vy) <= 1e-9 * r * r) {
        const dir = cr > 0 ? 1 : -1, a = Math.atan2(uy, ux);
        const t0 = e.reversed ? e.t1 : e.t0, sw = (e.t1 - e.t0) * (e.reversed ? -1 : 1);
        C = { c: e.c, r, a: a + dir * t0, sw: dir * sw };
      }
    }
    if (C && Math.abs(C.sw) > 1e-12) {
      const k = Math.abs(C.sw) > Math.PI + 1e-9 ? 2 : 1; // bulges stay finite: split sweeps over 180 degrees
      const pts = [], bul = [];
      for (let i = 0; i <= k; i++) { const t = C.a + (C.sw * i) / k; pts.push(C.c[0] + C.r * Math.cos(t), C.c[1] + C.r * Math.sin(t)); }
      for (let i = 0; i < k; i++) bul.push(Math.tan(C.sw / k / 4));
      return { pts, bul, z, arc: true };
    }
    if (e.type === 'arc' || e.type === 'ellipse') return { pts: arcPoints(e), bul: [], z, tess: true, arc: true };
    return null;
  };
  const arcPoints = (e) => {
    const out = [];
    const mx = e.type === 'arc' ? e.r : e.major[0], my = e.type === 'arc' ? 0 : e.major[1];
    const nx = e.type === 'arc' ? 0 : e.minor[0], ny = e.type === 'arc' ? e.r : e.minor[1];
    const t0 = e.type === 'arc' ? e.a0 : e.t0, t1 = e.type === 'arc' ? e.a1 : e.t1;
    let sw = t1 - t0; if (sw <= 0) sw += Math.PI * 2;
    const n = Math.max(8, Math.ceil(sw / (Math.PI / 36)));
    const fwd = !e.reversed;
    for (let i = 0; i <= n; i++) {
      const t = fwd ? t0 + (sw * i) / n : t1 - (sw * i) / n;
      out.push(e.c[0] + mx * Math.cos(t) + nx * Math.sin(t), e.c[1] + my * Math.cos(t) + ny * Math.sin(t));
    }
    return out;
  };

  // ellipse / arc helper: centre, axes (master units), rotation (rad) or 3D matrix, parametric start/sweep (rad)
  const conic = (props, cx, cy, r1, r2, rot, m3, start, sweep) => {
    let mx, my, nx, ny;
    if (m3) { mx = m3[0] * r1; my = m3[3] * r1; nx = m3[1] * r2; ny = m3[4] * r2; }
    else { const c = Math.cos(rot), s = Math.sin(rot); mx = c * r1; my = s * r1; nx = -s * r2; ny = c * r2; }
    const full = Math.abs(sweep) >= Math.PI * 2 - 1e-9;
    const circular = Math.abs(r1 - r2) <= 1e-9 * Math.max(r1, r2) && !m3;
    let t0 = start, t1 = start + sweep, reversed = false;
    if (sweep < 0) { t0 = start + sweep; t1 = start; reversed = true; }
    if (circular) {
      if (full) return { ...props, type: 'circle', c: [cx, cy], r: r1 };
      return { ...props, type: 'arc', c: [cx, cy], r: r1, a0: t0 + rot, a1: t1 + rot, reversed };
    }
    return { ...props, type: 'ellipse', c: [cx, cy], major: [mx, my], minor: [nx, ny], t0: full ? 0 : t0, t1: full ? Math.PI * 2 : t1, reversed };
  };

  const total = len;
  let nextReport = 0;
  let o = 0;
  let elementCount = 0;
  model.header.eod = len;
  while (o + 4 <= len) {
    if (b[o] === 0xff && b[o + 1] === 0xff) { model.header.eod = o; break; }
    if (!(b[o] | b[o + 1] | b[o + 2] | b[o + 3])) { model.header.eod = o; break; } // zero padding and no end marker: the design ends here
    const size = 4 + 2 * u16(o + 2);
    if (o + size > len) { model.header.eod = o; model.header.truncated = true; warn(model, 'The file ended in the middle of an element; showing what was read.'); break; }
    if (onProgress && o >= nextReport) { onProgress(o / total); nextReport = o + total / 50; }
    const type = b[o + 1] & 0x7f;
    const deleted = !!(b[o + 1] & 0x80);
    const isComponent = !!(b[o] & 0x80);
    // groups end at the first element that is not one of their components (the range a group covers is
    // where reading it actually stopped, never just what its word count claims)
    while (stack.length && groupEnds(stack[stack.length - 1], o, type, isComponent)) finishGroup(stack.pop(), o);
    if (stack.length) stack[stack.length - 1].seen++;
    elementCount++;
    if (deleted) { o += size; continue; }
    try {
      handle(o, type, size);
    } catch {
      notShown(model, (TYPE_NAMES[type] || 'TYPE_' + type) + ' (unreadable)');
    }
    o += size;
  }
  if (model.header.eod === len && o + 2 <= len && b[o] === 0xff && b[o + 1] === 0xff) model.header.eod = o; // marker in the last bytes
  while (stack.length) finishGroup(stack.pop(), Math.min(o, len));

  function open(o, type, extra) {
    const g = { type, start: o, seen: 0, parts: [], ...groupOf(b, o, type), ...extra };
    stack.push(g);
    return g;
  }

  function handle(o, type, size) {
    const name = TYPE_NAMES[type] || 'TYPE_' + type;
    if (type === 9 && o === 0) return;
    if (stack.some((g) => g.skip)) { if (isContainer(type)) open(o, type, { skip: true }); return; } // inside a shared cell definition / B-spline
    if (type === 5) { // group data: colour tables, named views (silent); reference file attachments (reported)
      if ((b[o] & 0x3f) === 9) {
        const ref = refName(o, size);
        (model.header.refs || (model.header.refs = [])).push(ref);
        notShown(model, 'Reference file attachment' + (ref ? ` (${ref})` : ''));
      }
      return;
    }
    if (SILENT.has(type)) { if (type === 34) open(o, type, { skip: true }); return; }
    if (size < 36) { notShown(model, name + ' (invalid)'); return; }
    countType(model, name);
    switch (type) {
      case 3: { // line
        const e = base(o, type, size);
        e.type = 'line';
        e.a = [X(i32(o + 36)), Y(i32(o + 40))];
        e.b = dim === 3 ? [X(i32(o + 48)), Y(i32(o + 52))] : [X(i32(o + 44)), Y(i32(o + 48))];
        if (dim === 3) { e.zr = i32(o + 44); e.zv = [e.zr, i32(o + 56)]; } // raw Z (UOR), kept for saving
        emit(e);
        return;
      }
      case 4: case 6: case 11: { // line string, shape, curve
        const e = base(o, type, size);
        const pts = readVerts(o, u16(o + 36), size);
        if (pts.length < 4) { notShown(model, name + ' (degenerate)'); return; }
        if (dim === 3) { e.zv = readZs(o, pts.length / 2); e.zr = e.zv[0]; }
        if (type === 11) {
          e.type = 'spline';
          e.closed = false;
          e.pts = curvePoints(pts);
          delete e.zv; // the drawn points are not the stored vertices
        } else {
          e.type = 'polyline';
          e.pts = pts;
          e.bulges = null;
          e.closed = type === 6;
          if (e.closed && pts.length >= 6 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) {
            e.pts = pts.slice(0, -2);
            if (e.zv) e.zv = e.zv.slice(0, -1);
          }
        }
        emit(e);
        return;
      }
      case 12: case 14: { // complex chain / shape header
        open(o, type, { props: base(o, type, size) });
        return;
      }
      case 7: case 18: case 19: { // text node header (components carry the text); surface / solid
        const top = !enclosingCell();
        open(o, type, top ? { rng: [o, o + size] } : {});
        if (type !== 7) notShown(model, name + ' (shown as its boundary elements)');
        return;
      }
      case 24: case 27: { // B-spline surface / curve: header + poles, knots, weights (one item)
        notShown(model, name);
        open(o, type, { skip: true });
        return;
      }
      case 2: { // cell header
        const id = cells.length;
        const r50 = (v) => { const a = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ$.?0123456789'; return a[Math.floor(v / 1600) % 40] + a[Math.floor(v / 40) % 40] + a[v % 40]; };
        const cell = { ...base(o, type, size), type: 'cell', id, name: (r50(u16(o + 38)) + r50(u16(o + 40))).trim(), level: b[o] & 0x3f, children: [] };
        delete cell.ctr;
        place(cell);
        const g = open(o, type, { id, cell });
        cell.dgn = [o, g.end];
        if (dim === 2) {
          const t = [i32(o + 68) / 214748, i32(o + 72) / 214748, i32(o + 76) / 214748, i32(o + 80) / 214748];
          cell.trans = t;
          cell.origin = [X(i32(o + 84)), Y(i32(o + 88))];
          cell.xscale = Math.hypot(t[0], t[2]);
          cell.yscale = Math.hypot(t[1], t[3]);
          cell.rotation = Math.atan2(t[2], t[0]);
          if (t[0] * t[3] - t[1] * t[2] < 0) cell.mirrored = true;
        } else {
          cell.trans3 = Array.from({ length: 9 }, (_, k) => i32(o + 76 + 4 * k) / 214748);
          cell.origin = [X(i32(o + 112)), Y(i32(o + 116))];
          cell.zr = i32(o + 120);
        }
        cells.push(cell);
        return;
      }
      case 15: case 16: { // ellipse, arc
        const e = base(o, type, size);
        let r1, r2, rot = 0, m3 = null, cx, cy, start = 0, sweep = Math.PI * 2;
        if (type === 16) {
          start = (i32(o + 36) / 360000) * D2R;
          let sw = i32(o + 40) & 0x7fffffff;
          if (b[o + 41] & 0x80) sw = -sw;
          sweep = sw === 0 ? Math.PI * 2 : (sw / 360000) * D2R;
          r1 = vaxD(o + 44) * scale; r2 = vaxD(o + 52) * scale;
          if (dim === 2) { rot = (i32(o + 60) / 360000) * D2R; cx = X(vaxD(o + 64)); cy = Y(vaxD(o + 72)); }
          else { m3 = quatMatrix(o + 60); cx = X(vaxD(o + 76)); cy = Y(vaxD(o + 84)); e.zr = vaxD(o + 92); }
        } else {
          r1 = vaxD(o + 36) * scale; r2 = vaxD(o + 44) * scale;
          if (dim === 2) { rot = (i32(o + 52) / 360000) * D2R; cx = X(vaxD(o + 56)); cy = Y(vaxD(o + 64)); }
          else { m3 = quatMatrix(o + 52); cx = X(vaxD(o + 68)); cy = Y(vaxD(o + 76)); e.zr = vaxD(o + 84); }
        }
        if (!(r1 >= 0) || !(r2 >= 0) || !Number.isFinite(cx) || !Number.isFinite(cy)) { notShown(model, name + ' (invalid)'); return; }
        emit(conic(e, cx, cy, Math.abs(r1), Math.abs(r2), rot, m3, start, sweep));
        return;
      }
      case 17: { // text
        const e = base(o, type, size);
        e.type = 'text';
        const lm = i32(o + 38) * scale * 6 / 1000, hm = i32(o + 42) * scale * 6 / 1000;
        let n, to;
        if (dim === 2) {
          e.rot = (i32(o + 46) / 360000) * D2R;
          e.p = [X(i32(o + 50)), Y(i32(o + 54))];
          n = b[o + 58]; to = o + 60;
        } else {
          const m = quatMatrix(o + 46);
          e.rot = Math.atan2(m[3], m[0]);
          e.p = [X(i32(o + 62)), Y(i32(o + 66))];
          e.zr = i32(o + 70);
          n = b[o + 74]; to = o + 76;
        }
        e.h = Math.abs(hm) || 1;
        e.wf = hm ? Math.abs(lm / hm) || 1 : 1;
        e.text = decodeDgnText(b.subarray(to, Math.min(len, to + Math.min(n, size - (to - o)))));
        e.halign = 0; e.valign = 0; e.oblique = 0;
        e.font = b[o + 36];
        e.just = b[o + 37];
        if (!e.text.trim()) return;
        emit(e);
        return;
      }
      default:
        notShown(model, name);
    }
  }

  /** File name of a reference file attachment (type 5, level 9): a length byte + characters at 38 when they look like a name. */
  function refName(o, size) {
    const good = (p, n) => n > 0 && p + n <= o + size && [...b.subarray(p, p + n)].every((c) => c >= 32 && c < 127);
    if (good(o + 39, b[o + 38])) return ascii(o + 39, b[o + 38]).trim();
    for (let p = o + 36; p + 1 < o + size; p++) { // otherwise: the first length-prefixed name with a dot
      const n = b[p];
      if (n >= 3 && good(p + 1, n)) { const s = ascii(p + 1, n); if (/\w\.\w/.test(s)) return s.trim(); }
    }
    return '';
  }

  // levels -> layers (numeric order)
  const levels = [...usedLevels].sort((a, c) => a - c);
  levels.forEach((lv) => ensureLayer(model, 'Level ' + lv, 0xffffff));
  // Levels switched off in the saved view start hidden (Layers > Show all brings them back). If the mask
  // would hide every level in use it is not trusted, and everything is shown.
  const off = levels.filter((lv) => !levelOnInView(lv));
  if (off.length && off.length < levels.length) {
    for (const lv of off) ensureLayer(model, 'Level ' + lv).visible = false;
    model.header.savedView = { view: savedView, levelsOff: off };
    warn(model, `${off.length} level${off.length === 1 ? ' is' : 's are'} off in this drawing's saved view ${savedView}, so ${off.length === 1 ? 'it starts' : 'they start'} hidden, as in MicroStation. Layers > Show all brings ${off.length === 1 ? 'it' : 'them'} back.`);
  }
  for (let i = 1; i <= 7; i++) model.ltypes['DGN' + i] = { name: 'DGN' + i, desc: 'DGN line style ' + i, px: DGN_STYLES[i] };
  model.stats.entities = model.entities.length;
  model.stats.elements = elementCount;
  if (onProgress) onProgress(1);
  return model;
}

/** DGN curve (type 11): the first and last two vertices only steer the end tangents. */
function curvePoints(pts) {
  const n = pts.length / 2;
  if (n < 6) return pts;
  const SEG = 10;
  const full = tessCatmullRom(pts, SEG, false);
  // vertex k sits at output point k*SEG; keep vertex 2 .. vertex n-3
  return full.slice(2 * (2 * SEG), 2 * ((n - 3) * SEG) + 2);
}
