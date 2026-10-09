// DGN v7 (ISFF) reader. Element layouts follow the public ISFF description and the logic of
// GDAL's dgnlib by Frank Warmerdam (MIT/X licence; see NOTICE), re-implemented in JavaScript.
// Produces the common model (see ../model.js). Bad/unknown elements are skipped and counted.

import { createModel, ensureLayer, countType, notShown, warn, FormatError, unitsFromLabel } from '../model.js';
import { DGN_DEFAULT } from '../palettes.js';
import { tessCatmullRom } from '../geom.js';

const D2R = Math.PI / 180;

const TYPE_NAMES = {
  1: 'CELL_LIBRARY', 2: 'CELL', 3: 'LINE', 4: 'LINE_STRING', 5: 'GROUP_DATA', 6: 'SHAPE', 7: 'TEXT_NODE',
  8: 'DIGITIZER_SETUP', 9: 'TCB', 10: 'LEVEL_SYMBOLOGY', 11: 'CURVE', 12: 'COMPLEX_CHAIN', 14: 'COMPLEX_SHAPE',
  15: 'ELLIPSE', 16: 'ARC', 17: 'TEXT', 18: 'SURFACE', 19: 'SOLID', 21: 'BSPLINE_POLE', 22: 'POINT_STRING',
  23: 'CONE', 24: 'BSPLINE_SURFACE', 25: 'BSPLINE_BOUNDARY', 26: 'BSPLINE_KNOT', 27: 'BSPLINE_CURVE',
  28: 'BSPLINE_WEIGHTS', 33: 'DIMENSION', 34: 'SHARED_CELL_DEFN', 35: 'SHARED_CELL', 37: 'TAG_VALUE',
  66: 'APPLICATION', 87: 'RASTER_HEADER', 88: 'RASTER_COMPONENT', 90: 'RASTER_REFERENCE',
};
// non-graphic / bookkeeping elements: ignored silently
const SILENT = new Set([1, 5, 8, 9, 10, 26, 28, 34, 37, 66]);

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

export function parseDgn(input, { onProgress } = {}) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (isOleCompound(b)) {
    throw new FormatError('dgn-v8', 'This looks like a DGN v8 file. Only DGN v7 is supported in this version — export it as DGN v7 or DXF.');
  }
  if (!isDgnV7(b)) throw new FormatError('not-dgn', 'This is not a DGN v7 design file (the header was not recognised).');
  const len = b.length;
  const u16 = (o) => b[o] | (b[o + 1] << 8);
  const i16 = (o) => (u16(o) << 16) >> 16;
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
  model.header = { dimension: dim, masterUnit: masterName, subUnit: subName, subPerMaster, uorPerSub, origin: [ox, oy] };
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

  // ---- pre-scan for a colour table (type 5, level 1) anywhere in the file
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
  const stack = []; // open complex groups: {type, end, ...}

  const quatMatrix = (o) => { // 4 x int32 quaternion -> 3x3 rotation (rows)
    const w = i32(o) / 2147483648, x = i32(o + 4) / 2147483648, y = i32(o + 8) / 2147483648, z = i32(o + 12) / 2147483648;
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ];
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

  const emit = (e) => {
    const top = stack[stack.length - 1];
    if (top && (top.type === 14 || top.type === 12)) { top.parts.push(e); return; } // complex chain/shape: joined later
    place(e);
  };

  const closeGroups = (o) => {
    while (stack.length && stack[stack.length - 1].end <= o) finishGroup(stack.pop());
  };
  const finishGroup = (g) => {
    if (g.type !== 14 && g.type !== 12) return;
    const pts = [];
    for (const part of g.parts) {
      const seg = partPoints(part);
      for (let k = pts.length && seg.length >= 2 && near(pts, seg) ? 2 : 0; k < seg.length; k++) pts.push(seg[k]);
    }
    const closed = g.type === 14;
    if (closed && pts.length >= 4 && near(pts, pts.slice(0, 2))) pts.length -= 2;
    if (pts.length >= 4) place({ ...g.props, type: 'polyline', pts, bulges: null, closed, dgn: [g.start, g.end] });
  };
  const near = (pts, seg) => Math.abs(pts[pts.length - 2] - seg[0]) < 1e-9 && Math.abs(pts[pts.length - 1] - seg[1]) < 1e-9;
  const partPoints = (e) => {
    if (e.type === 'line') return [...e.a, ...e.b];
    if (e.type === 'polyline' || e.type === 'spline') return e.pts;
    if (e.type === 'arc' || e.type === 'ellipse') {
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
    }
    return [];
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

  const decodeText = (o, n) => {
    if (n >= 2 && b[o] === 0xff && b[o + 1] === 0xfd) { // 16-bit text
      let s = '';
      for (let k = 2; k + 1 < n; k += 2) s += String.fromCharCode(b[o + k] | (b[o + k + 1] << 8));
      return s;
    }
    let s = '';
    for (let k = 0; k < n && o + k < len; k++) s += String.fromCharCode(b[o + k]);
    try { return new TextDecoder('windows-1252').decode(b.subarray(o, Math.min(len, o + n))); } catch { return s; }
  };

  const total = len;
  let nextReport = 0;
  let o = 0;
  let elementCount = 0;
  model.header.eod = len;
  while (o + 4 <= len) {
    if (b[o] === 0xff && b[o + 1] === 0xff) { model.header.eod = o; break; }
    const size = 4 + 2 * u16(o + 2);
    if (o + size > len) { model.header.eod = o; model.header.truncated = true; warn(model, 'The file ended in the middle of an element; showing what was read.'); break; }
    if (onProgress && o >= nextReport) { onProgress(o / total); nextReport = o + total / 50; }
    closeGroups(o);
    const type = b[o + 1] & 0x7f;
    const deleted = !!(b[o + 1] & 0x80);
    const isComponent = !!(b[o] & 0x80);
    if (stack.length && !isComponent) while (stack.length) finishGroup(stack.pop());
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
  while (stack.length) finishGroup(stack.pop());

  function handle(o, type, size) {
    const name = TYPE_NAMES[type] || 'TYPE_' + type;
    if (type === 9 && o === 0) return;
    if (!isGraphic(type)) return;
    if (size < 36) return;
    countType(model, name);
    switch (type) {
      case 3: { // line
        const e = base(o, type, size);
        e.type = 'line';
        e.a = [X(i32(o + 36)), Y(i32(o + 40))];
        e.b = dim === 3 ? [X(i32(o + 48)), Y(i32(o + 52))] : [X(i32(o + 44)), Y(i32(o + 48))];
        if (dim === 3) e.zr = i32(o + 44); // raw Z (UOR), kept for saving
        emit(e);
        return;
      }
      case 4: case 6: case 11: { // line string, shape, curve
        const e = base(o, type, size);
        const pts = readVerts(o, u16(o + 36), size);
        if (pts.length < 4) { notShown(model, name + ' (degenerate)'); return; }
        if (dim === 3) e.zr = i32(o + 46);
        if (type === 11) {
          e.type = 'spline';
          e.closed = false;
          e.pts = curvePoints(pts);
        } else {
          e.type = 'polyline';
          e.pts = pts;
          e.bulges = null;
          e.closed = type === 6;
          if (e.closed && pts.length >= 4 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) e.pts = pts.slice(0, -2);
        }
        emit(e);
        return;
      }
      case 12: case 14: { // complex chain / shape header
        const tot = u16(o + 36);
        const g = { type, start: o, end: o + 38 + tot * 2, parts: [], props: base(o, type, size) };
        stack.push(g);
        return;
      }
      case 7: { // text node header: components carry the text
        const tot = u16(o + 36);
        stack.push({ type, end: o + 38 + tot * 2, parts: [] });
        return;
      }
      case 2: { // cell header
        const tot = u16(o + 36);
        const id = cells.length;
        const r50 = (v) => { const a = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ$.?0123456789'; return a[Math.floor(v / 1600) % 40] + a[Math.floor(v / 40) % 40] + a[v % 40]; };
        const end = o + 38 + tot * 2;
        const cell = { ...base(o, type, size), type: 'cell', id, name: (r50(u16(o + 38)) + r50(u16(o + 40))).trim(), level: b[o] & 0x3f, children: [] };
        cell.dgn = [o, end];
        if (dim === 2) {
          const t = [i32(o + 68) / 214748, i32(o + 72) / 214748, i32(o + 76) / 214748, i32(o + 80) / 214748];
          cell.trans = t;
          cell.origin = [X(i32(o + 84)), Y(i32(o + 88))];
          cell.xscale = Math.hypot(t[0], t[2]);
          cell.yscale = Math.hypot(t[1], t[3]);
          cell.rotation = Math.atan2(t[2], t[0]);
          if (t[0] * t[3] - t[1] * t[2] < 0) cell.mirrored = true;
        } else {
          cell.origin = [X(i32(o + 112)), Y(i32(o + 116))];
        }
        cells.push(cell);
        place(cell);
        stack.push({ type, end, parts: [], id, cell });
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
        e.text = decodeText(to, Math.min(n, size - (to - o)));
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

  function isGraphic(type) {
    if (SILENT.has(type)) return false;
    return true;
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
