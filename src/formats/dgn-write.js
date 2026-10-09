// DGN v7 (ISFF) writer, from the public ISFF element description (element layouts as decoded by
// ./dgn.js; see NOTICE for the GDAL dgnlib credit).
//
// Two modes:
//  * Round trip (the drawing was opened from a DGN v7 file): the original bytes are kept. Every
//    element whose entity was not edited stays byte-for-byte identical at the same offset. The
//    elements of edited or deleted entities get their DELETED bit set in place, and the new
//    versions are appended as fresh elements before the end-of-design marker. Cells keep their
//    header (name, class, attributes) with a patched origin, transform and range.
//  * New file (any other drawing): starts from GDAL's 2D seed (TCB etc., ./dgn-seed.js), sets the
//    working units and global origin so coordinates fit the 32-bit grid, writes a colour table,
//    maps layers to levels 1-63 and writes every item (blocks flattened).
import { SEED_2D } from './dgn-seed.js';
import { DGN_DEFAULT } from '../palettes.js';
import { createEmitter, sceneTables, KIND, FLAG, CHAR_W } from '../scene.js';
import { FG } from '../model.js';
import { ellipseParams } from './dxf-write.js';
import { TAU } from '../geom.js';

const MAXV = 101; // vertices per line string / shape element
const D360 = 360000 * (180 / Math.PI); // radians -> 1/360000 degree

// ------------------------------------------------------------------ bytes
const clampI32 = (v) => Math.max(-2147483648, Math.min(2147483647, Math.round(v)));
function pushI32(a, v) { const u = clampI32(v) >>> 0; a.push((u >>> 16) & 255, (u >>> 24) & 255, u & 255, (u >>> 8) & 255); }
function pushU16(a, v) { a.push(v & 255, (v >>> 8) & 255); }
function pushRange(a, v) { const u = ((clampI32(v) ^ 0x80000000) >>> 0); a.push((u >>> 16) & 255, (u >>> 24) & 255, u & 255, (u >>> 8) & 255); }
/** IEEE double -> VAX D-float (8 bytes, four little-endian 16-bit words). */
export function pushVax(a, x) {
  if (!x || !Number.isFinite(x)) { for (let i = 0; i < 8; i++) a.push(0); return; }
  const sign = x < 0 ? 1 : 0;
  x = Math.abs(x);
  let e = Math.floor(Math.log2(x)) + 1;
  let m = x / 2 ** e;
  if (m >= 1) { m /= 2; e++; }
  if (m < 0.5) { m *= 2; e--; }
  const vexp = e + 128;
  if (vexp <= 0 || vexp >= 256) { for (let i = 0; i < 8; i++) a.push(0); return; }
  let frac = (m * 2 - 1) * 2 ** 55; // 55 fraction bits after the hidden bit (exact: m has 53 bits)
  if (frac >= 2 ** 55) frac = 2 ** 55 - 8;
  const fhi = Math.floor(frac / 2 ** 32), flo = frac - fhi * 2 ** 32;
  const hi = ((sign << 31) | (vexp << 23) | fhi) >>> 0;
  pushU16(a, hi >>> 16); pushU16(a, hi & 0xffff); pushU16(a, Math.floor(flo / 65536)); pushU16(a, flo & 0xffff);
}
const rd = (b) => ({
  u16: (o) => b[o] | (b[o + 1] << 8),
  i32: (o) => b[o + 2] | (b[o + 3] << 8) | (b[o] << 16) | (b[o + 1] << 24),
  vax: (o) => {
    const u = (k) => b[k] | (b[k + 1] << 8);
    const hi = ((u(o) << 16) | u(o + 2)) >>> 0, lo = ((u(o + 4) << 16) | u(o + 6)) >>> 0;
    const exp = (hi >>> 23) & 0xff;
    if (!exp) return 0;
    return (hi >>> 31 ? -1 : 1) * (1 + ((hi & 0x7fffff) * 4294967296 + lo) / 36028797018963968) * Math.pow(2, exp - 129);
  },
});
function setI32(b, o, v) { const t = []; pushI32(t, v); b.set(t, o); }
function setRange(b, o, v) { const t = []; pushRange(t, v); b.set(t, o); }
function getRange(el) { // [xlo, ylo, zlo, xhi, yhi, zhi] (UOR)
  const r = rd(el), out = [];
  for (let k = 0; k < 6; k++) out.push((r.i32(4 + 4 * k) ^ 0x80000000) | 0);
  return out;
}
const elemSize = (b, o) => 4 + 2 * (b[o + 2] | (b[o + 3] << 8));

// cp1252 encoder for 8-bit text (the reader decodes windows-1252)
let CP1252 = null;
function cp1252() {
  if (CP1252) return CP1252;
  CP1252 = new Map();
  try {
    const s = new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 128 }, (_, i) => 128 + i));
    for (let i = 0; i < s.length; i++) CP1252.set(s.charCodeAt(i), 128 + i);
  } catch { for (let i = 160; i < 256; i++) CP1252.set(i, i); }
  return CP1252;
}
/** DGN text bytes: 8-bit (cp1252) when possible, else 16-bit (0xFF 0xFD + UTF-16LE). */
export function textBytes(s, notes) {
  const map = cp1252();
  const out8 = [];
  let ok = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) out8.push(c); else if (map.has(c)) out8.push(map.get(c)); else { ok = false; break; }
  }
  if (ok) { if (out8.length > 255) { notes.truncated++; out8.length = 255; } return out8; }
  const out = [0xff, 0xfd];
  for (let i = 0; i < s.length && out.length + 2 <= 255; i++) { const c = s.charCodeAt(i); out.push(c & 255, c >> 8); }
  if (2 + 2 * s.length > 255) notes.truncated++;
  return out;
}

// ------------------------------------------------------------------ element encoder
class Encoder {
  /** g: { dim, uor, ox, oy, oz } (origin in master units, as the reader uses it) */
  constructor(g, notes) { this.g = g; this.notes = notes; }
  X(x) { return (x + this.g.ox) * this.g.uor; }
  Y(y) { return (y + this.g.oy) * this.g.uor; }

  /** Assemble one element. sym: { level, color, style, weight }; rng: [xlo, ylo, xhi, yhi] (UOR). */
  element(type, sym, body, rng, opt = {}) {
    if (body.length % 2) body.push(0);
    const att = opt.att || null;
    const size = 36 + body.length + (att ? att.length : 0);
    const a = [];
    a.push((sym.level & 63) | (opt.component ? 0x80 : 0), type & 0x7f);
    pushU16(a, (size - 4) / 2);
    const z = opt.z || [0, 0];
    for (const v of [rng[0], rng[1], z[0], rng[2], rng[3], z[1]]) pushRange(a, v);
    pushU16(a, opt.gg || 0);
    pushU16(a, (36 + body.length - 32) / 2);
    pushU16(a, opt.props || 0);
    a.push((sym.style & 7) | ((sym.weight & 31) << 3), sym.color & 255);
    for (const v of body) a.push(v);
    if (att) for (const v of att) a.push(v);
    return Uint8Array.from(a);
  }
  rangeOf(raw) { // raw: [x, y, x, y, ...] UOR
    const r = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < raw.length; i += 2) { r[0] = Math.min(r[0], raw[i]); r[1] = Math.min(r[1], raw[i + 1]); r[2] = Math.max(r[2], raw[i]); r[3] = Math.max(r[3], raw[i + 1]); }
    return r.map((v) => Math.round(v));
  }
  quat(a) { // rotation about Z as an ISFF quaternion (w, x, y, z), 1.0 == 2^31
    const t = [];
    for (const v of [Math.cos(a / 2), 0, 0, Math.sin(a / 2)]) pushI32(t, v * 2147483647);
    return t;
  }
  zr(sym) { return sym.zr || 0; }

  line(sym, ax, ay, bx, by, opt) {
    const raw = [this.X(ax), this.Y(ay), this.X(bx), this.Y(by)].map(Math.round);
    const body = [];
    if (this.g.dim === 3) { pushI32(body, raw[0]); pushI32(body, raw[1]); pushI32(body, this.zr(sym)); pushI32(body, raw[2]); pushI32(body, raw[3]); pushI32(body, this.zr(sym)); }
    else for (const v of raw) pushI32(body, v);
    return this.element(3, sym, body, this.rangeOf(raw), { ...opt, z: [this.zr(sym), this.zr(sym)] });
  }
  /** Line string (4), shape (6) or curve (11): pts world [x, y, ...] (<= 101 vertices). */
  multi(type, sym, pts, opt) {
    const raw = [];
    for (let i = 0; i < pts.length; i += 2) raw.push(Math.round(this.X(pts[i])), Math.round(this.Y(pts[i + 1])));
    const body = [];
    pushU16(body, raw.length / 2);
    for (let i = 0; i < raw.length; i += 2) { pushI32(body, raw[i]); pushI32(body, raw[i + 1]); if (this.g.dim === 3) pushI32(body, this.zr(sym)); }
    return this.element(type, sym, body, this.rangeOf(raw), { ...opt, z: [this.zr(sym), this.zr(sym)] });
  }
  /** Conic (scene form: centre, U, V, t0, t1, full) -> ellipse (15) or arc (16). */
  conic(sym, c, opt) {
    const q = ellipseParams({ c: [c[0], c[1]], major: [c[2], c[3]], minor: [c[4], c[5]], t0: c[6], t1: c[7] });
    const full = c.full;
    const r1 = Math.hypot(...q.major), r2 = r1 * q.ratio, rot = Math.atan2(q.major[1], q.major[0]);
    const g = this.g, body = [];
    let sweep = q.t1 - q.t0;
    if (!full) {
      if (sweep <= 0) sweep += TAU;
      pushI32(body, q.t0 * D360);
      pushI32(body, Math.min(sweep, TAU) * D360);
    }
    pushVax(body, r1 * g.uor); pushVax(body, r2 * g.uor);
    if (g.dim === 3) body.push(...this.quat(rot)); else pushI32(body, rot * D360);
    pushVax(body, this.X(q.c[0])); pushVax(body, this.Y(q.c[1]));
    if (g.dim === 3) pushVax(body, this.zr(sym));
    // range: exact bbox of the arc
    const b = conicBox(c);
    const rng = [this.X(b[0]), this.Y(b[1]), this.X(b[2]), this.Y(b[3])].map((v, i) => (i < 2 ? Math.floor(v) : Math.ceil(v)));
    return this.element(full ? 15 : 16, sym, body, rng, { ...opt, z: [this.zr(sym), this.zr(sym)] });
  }
  /** Text (17) from a scene text item (anchor, glyph matrix, alignment). */
  text(sym, t, opt) {
    const [Xx, Xy, Yx, Yy] = t.m;
    const W = t.fit || CHAR_W * t.s.length; // in glyph widths along the baseline
    const u0 = t.align === 0 ? 0 : t.align === 1 ? -W / 2 : -W;
    const ox = t.x + u0 * Xx, oy = t.y + u0 * Xy; // lower-left
    const lm = Math.hypot(Xx, Xy), hm = Math.hypot(Yx, Yy), rot = Math.atan2(Xy, Xx);
    const g = this.g, body = [];
    const chars = textBytes(t.s, this.notes);
    body.push(sym.font | 0, sym.just ?? 2);
    pushI32(body, (lm * g.uor * 1000) / 6); pushI32(body, (hm * g.uor * 1000) / 6);
    if (g.dim === 3) body.push(...this.quat(rot)); else pushI32(body, rot * D360);
    const px = Math.round(this.X(ox)), py = Math.round(this.Y(oy));
    pushI32(body, px); pushI32(body, py);
    if (g.dim === 3) pushI32(body, this.zr(sym));
    body.push(chars.length, 0, ...chars);
    const corners = [];
    for (const [u, v] of [[0, 0], [W, 0], [W, 1], [0, 1]]) corners.push(this.X(ox + u * Xx + v * Yx), this.Y(oy + u * Xy + v * Yy));
    return this.element(17, sym, body, this.rangeOf(corners), { ...opt, z: [this.zr(sym), this.zr(sym)] });
  }
  /** Complex chain (12) / shape (14) header followed by its components. */
  complex(type, sym, comps, opt) {
    let words = 0;
    const r = [Infinity, Infinity, -Infinity, -Infinity];
    for (const el of comps) {
      words += el.length / 2;
      const q = getRange(el);
      r[0] = Math.min(r[0], q[0]); r[1] = Math.min(r[1], q[1]); r[2] = Math.max(r[2], q[3]); r[3] = Math.max(r[3], q[4]);
    }
    const body = [];
    pushU16(body, words + 5);
    pushU16(body, comps.length);
    for (let i = 0; i < 8; i++) body.push(0);
    return [this.element(type, sym, body, r, { ...opt, z: [this.zr(sym), this.zr(sym)] }), ...comps];
  }
  /** Open run of vertices -> line string, or a complex chain when longer than 101 vertices. */
  run(sym, pts, closed, opt) {
    let p = pts;
    if (closed) {
      const n = p.length / 2;
      if (!(p[0] === p[2 * n - 2] && p[1] === p[2 * n - 1])) p = [...p, p[0], p[1]];
    }
    if (p.length / 2 <= MAXV) return [this.multi(closed ? 6 : 4, sym, p, opt)];
    const comps = [];
    for (let s = 0; s < p.length / 2 - 1; s += MAXV - 1) comps.push(this.multi(4, sym, p.slice(2 * s, 2 * Math.min(p.length / 2, s + MAXV)), { component: true }));
    return this.complex(closed ? 14 : 12, sym, comps, opt);
  }
}

/** Exact bbox of a conic [cx, cy, ux, uy, vx, vy, t0, t1]. */
function conicBox(c) {
  const P = (t) => [c[0] + c[2] * Math.cos(t) + c[4] * Math.sin(t), c[1] + c[3] * Math.cos(t) + c[5] * Math.sin(t)];
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (p) => { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); };
  add(P(c[6])); add(P(c[7]));
  for (const base of [Math.atan2(c[4], c[2]), Math.atan2(c[5], c[3])]) {
    for (const t of [base, base + Math.PI, base - Math.PI, base + TAU]) {
      let d = (t - c[6]) % TAU; if (d < 0) d += TAU;
      if (d <= c[7] - c[6] + 1e-12) add(P(t));
    }
  }
  return b;
}

// ------------------------------------------------------------------ entity -> elements
/** Emitted items of one entity, in absolute coordinates: { prims: [...], texts: [...] }. */
function emitItems(em, e) {
  const B = em.B;
  for (const k of ['kind', 'flags', 'layer', 'color', 'style', 'weight', 'src', 'blk', 'start', 'count', 'ent', 'coords', 'conics', 'texts']) B[k].length = 0;
  em.emit(e, 0);
  const prims = [];
  for (let j = 0; j < B.kind.length; j++) {
    const p = { kind: B.kind[j], flags: B.flags[j], layer: B.layer[j], color: B.color[j], style: B.style[j], weight: B.weight[j] };
    if (p.kind === KIND.CONIC) { const o = B.start[j] * 8; p.c = B.conics.slice(o, o + 8); p.c.full = !!(p.flags & FLAG.FULL); }
    else { const o = B.start[j] * 2; p.pts = B.coords.slice(o, o + B.count[j] * 2); }
    prims.push(p);
  }
  return { prims, texts: B.texts.slice() };
}

class Writer {
  constructor(model, g, palette, notes, map) {
    this.model = model;
    this.enc = new Encoder(g, notes);
    this.palette = palette;
    this.notes = notes;
    this.tables = sceneTables(model);
    this.em = createEmitter(model, this.tables);
    this.levelOf = map.levelOf;
    this.colorCache = new Map();
  }
  colorIndex(rgb, ci) {
    if (rgb === FG || rgb == null) rgb = 0xffffff;
    if (ci != null && this.palette[ci] === rgb) return ci;
    let k = this.colorCache.get(rgb);
    if (k !== undefined) return k;
    let best = 0, bd = Infinity;
    for (let i = 0; i < 255; i++) {
      const c = this.palette[i];
      const d = ((c >> 16) - (rgb >> 16)) ** 2 + (((c >> 8) & 255) - ((rgb >> 8) & 255)) ** 2 + ((c & 255) - (rgb & 255)) ** 2;
      if (d < bd) { bd = d; best = i; if (!d) break; }
    }
    this.colorCache.set(rgb, best);
    return best;
  }
  styleOf(idx) { const n = this.tables.ltypes[idx] ? this.tables.ltypes[idx].name : ''; const m = /^DGN(\d)$/.exec(n); return m ? +m[1] : idx ? 2 : 0; }
  sym(p, e) {
    return {
      level: this.levelOf(this.tables.layers[p.layer] ? this.tables.layers[p.layer].name : '0'),
      color: this.colorIndex(p.color, e.ci), style: this.styleOf(p.style), weight: Math.min(31, p.weight | 0),
      zr: e.zr, font: e.font, just: e.just,
    };
  }

  /** Elements for one entity. opt: { component, gg, props, att } (att etc. only when it is one element). */
  encode(e, opt = {}) {
    if (!e) return [];
    if (e.type === 'cell') return this.cell(e, opt);
    const { prims, texts } = emitItems(this.em, e);
    const E = this.enc, out = [];
    const comp = { component: !!opt.component };
    if (e.type === 'polyline' && e.bulges && (prims.length > 1 || prims.some((p) => p.kind === KIND.CONIC))) {
      // bulged polyline: one complex chain/shape whose components are its straight runs and arcs
      const parts = [];
      for (const p of prims) {
        const s = this.sym(p, e);
        if (p.kind === KIND.CONIC) parts.push(E.conic(s, p.c, { component: true }));
        else for (let k = 0; k < p.pts.length / 2 - 1; k += MAXV - 1) parts.push(E.multi(4, s, p.pts.slice(2 * k, 2 * Math.min(p.pts.length / 2, k + MAXV)), { component: true }));
      }
      if (parts.length) out.push(...E.complex(e.closed ? 14 : 12, this.sym(prims[0], e), parts, comp));
    } else {
      for (const p of prims) {
        const s = this.sym(p, e);
        if (p.kind === KIND.POINT) out.push(E.line(s, p.pts[0], p.pts[1], p.pts[0], p.pts[1], comp));
        else if (p.kind === KIND.CONIC) out.push(E.conic(s, p.c, comp));
        else if (p.flags & (FLAG.FILL | FLAG.PATTERN)) {
          this.notes.fills++;
          let ring = [];
          const flush = () => { if (ring.length >= 6) out.push(...E.run(s, ring, true, comp)); ring = []; };
          for (let i = 0; i < p.pts.length; i += 2) { if (p.pts[i] !== p.pts[i]) flush(); else ring.push(p.pts[i], p.pts[i + 1]); }
          flush();
        } else if (e.type === 'line' && p.pts.length === 4 && !(p.flags & FLAG.CLOSED)) out.push(E.line(s, p.pts[0], p.pts[1], p.pts[2], p.pts[3], comp));
        else {
          if (p.flags & FLAG.CURVEPTS) this.notes.curves++;
          if (p.pts.length >= 4) out.push(...E.run(s, p.pts, !!(p.flags & FLAG.CLOSED) && p.pts.length >= 6, comp));
        }
      }
    }
    for (const t of texts) out.push(E.text(this.sym(t, e), t, comp));
    if (out.length === 1 && (opt.gg || opt.props || opt.att)) {
      // one element replacing one element: keep the original graphic group, properties and attribute data
      const el = out[0], q = getRange(el);
      const sym = { level: el[0] & 63, color: el[35], style: el[34] & 7, weight: el[34] >> 3 };
      out[0] = E.element(el[1] & 0x7f, sym, Array.from(el.subarray(36)), [q[0], q[1], q[3], q[4]], { ...comp, gg: opt.gg, props: opt.props, att: opt.att, z: [q[2], q[5]] });
    }
    return out;
  }

  /** Cell: the original header (patched) followed by its components; no header -> components only. */
  cell(e, opt) {
    const kids = [];
    for (const c of e.children || []) kids.push(...this.encode(c, { component: true }));
    const src = this.bytes && e.dgn ? this.bytes : null;
    if (!src) { this.notes.cellsFlattened++; return (e.children || []).flatMap((c) => this.encode(c, { component: !!opt.component })); }
    const o = e.dgn[0];
    const hdr = src.slice(o, o + elemSize(src, o));
    const r = rd(hdr), g = this.enc.g;
    hdr[0] = (hdr[0] & 0x3f) | (opt.component ? 0x80 : 0);
    hdr[1] &= 0x7f;
    let words = 0;
    const R = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const el of kids) {
      words += el.length / 2;
      const q = getRange(el);
      for (let k = 0; k < 3; k++) { R[k] = Math.min(R[k], q[k]); R[k + 3] = Math.max(R[k + 3], q[k + 3]); }
    }
    if (!kids.length) return [];
    hdr[36] = 0; hdr[37] = 0;
    const tot = (hdr.length - 38) / 2 + words;
    hdr[36] = tot & 255; hdr[37] = (tot >> 8) & 255;
    for (let k = 0; k < 6; k++) setRange(hdr, 4 + 4 * k, R[k]);
    const M = e.mv;
    if (g.dim === 2) {
      setI32(hdr, 52, R[0]); setI32(hdr, 56, R[1]); setI32(hdr, 60, R[3]); setI32(hdr, 64, R[4]);
      if (M) {
        const t = [0, 1, 2, 3].map((k) => r.i32(68 + 4 * k) / 214748);
        const n = [M[0] * t[0] + M[2] * t[2], M[0] * t[1] + M[2] * t[3], M[1] * t[0] + M[3] * t[2], M[1] * t[1] + M[3] * t[3]];
        n.forEach((v, k) => setI32(hdr, 68 + 4 * k, v * 214748));
      }
      if (e.origin) { setI32(hdr, 84, this.enc.X(e.origin[0])); setI32(hdr, 88, this.enc.Y(e.origin[1])); }
    } else {
      for (let k = 0; k < 6; k++) setI32(hdr, 52 + 4 * k, R[k]);
      if (M) {
        const t = [];
        for (let k = 0; k < 9; k++) t.push(r.i32(76 + 4 * k) / 214748);
        const L = [[M[0], M[2], 0], [M[1], M[3], 0], [0, 0, 1]];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) setI32(hdr, 76 + 4 * (3 * i + j), (L[i][0] * t[j] + L[i][1] * t[3 + j] + L[i][2] * t[6 + j]) * 214748);
        if (e.origin) { setI32(hdr, 112, this.enc.X(e.origin[0])); setI32(hdr, 116, this.enc.Y(e.origin[1])); }
      }
    }
    const lv = this.levelOf(e.layer);
    hdr[0] = (hdr[0] & 0xc0) | (lv & 63);
    return [hdr, ...kids];
  }
}

// ------------------------------------------------------------------ public API
function newNotes() { return { truncated: 0, fills: 0, curves: 0, cellsFlattened: 0, merged: 0, levels: [] }; }
function noteList(n) {
  const out = [];
  if (n.levels.length) out.push(`Layers became DGN levels (DGN v7 has no layer names): ${n.levels.join(', ')}.`);
  if (n.merged) out.push(`${n.merged} layer${n.merged === 1 ? '' : 's'} beyond 63 were merged into level 63.`);
  if (n.cellsFlattened) out.push(`${n.cellsFlattened} cell${n.cellsFlattened === 1 ? '' : 's'} written as separate elements.`);
  if (n.curves) out.push(`${n.curves} curve${n.curves === 1 ? ' was' : 's were'} written as line strings.`);
  if (n.fills) out.push(`${n.fills} filled area${n.fills === 1 ? ' was' : 's were'} written as outlines.`);
  if (n.truncated) out.push(`${n.truncated} text${n.truncated === 1 ? ' was' : 's were'} longer than DGN v7 allows and ${n.truncated === 1 ? 'was' : 'were'} shortened.`);
  return out;
}

/** Palette of a DGN file: its colour table (type 5, level 1) or the default DGN palette. */
export function dgnPalette(b) {
  const r = rd(b);
  for (let o = 0; o + 4 <= b.length;) {
    if (b[o] === 0xff && b[o + 1] === 0xff) break;
    const size = elemSize(b, o);
    if ((b[o + 1] & 0x7f) === 5 && (b[o] & 0x3f) === 1 && size >= 806 && o + size <= b.length && !(b[o + 1] & 0x80)) {
      const p = new Uint32Array(256);
      for (let i = 0; i < 255; i++) p[i] = (b[o + 41 + 3 * i] << 16) | (b[o + 42 + 3 * i] << 8) | b[o + 43 + 3 * i];
      p[255] = (b[o + 38] << 16) | (b[o + 39] << 8) | b[o + 40];
      return p;
    }
    o += size;
    void r;
  }
  return DGN_DEFAULT;
}

const levelFromName = (name) => { const m = /^Level (\d+)$/i.exec(String(name)); return m ? Math.max(1, Math.min(63, +m[1])) : null; };

/**
 * Write a DGN v7 file. opts: { bytes, orig, extents }. With `bytes` (the original DGN file) and
 * `orig` (the original entity objects by slot) it is a byte-preserving round trip.
 * Returns { bytes: Uint8Array, notes: [..], mode: 'round-trip' | 'new' }.
 */
export function writeDgn(model, opts = {}) {
  if (model.format === 'DGN' && opts.bytes && opts.orig) return roundTrip(model, opts);
  return fromSeed(model, opts);
}

function roundTrip(model, { bytes, orig }) {
  const b = bytes;
  const r = rd(b);
  const dim = b[1214] & 0x40 ? 3 : 2;
  let sub = r.i32(1112), upsub = r.i32(1116);
  if (!(sub > 0)) sub = 1;
  if (!(upsub > 0)) upsub = 1;
  const uor = sub * upsub;
  const g = { dim, uor, ox: r.vax(1240) / uor, oy: r.vax(1248) / uor, oz: r.vax(1256) / uor };
  const notes = newNotes();
  const palette = dgnPalette(b);
  const w = new Writer(model, g, palette, notes, { levelOf: (name) => levelFromName(name) ?? 63 });
  w.bytes = b;
  let eod = model.header && model.header.eod != null ? model.header.eod : b.length;
  if (eod > b.length) eod = b.length;
  const head = b.slice(0, eod);
  const appended = [];
  const markDeleted = (from, to) => { for (let o = from; o + 4 <= to;) { head[o + 1] |= 0x80; o += elemSize(head, o); } };
  const n = Math.max(orig.length, model.entities.length);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const cur = model.entities[i] || null, was = orig[i] || null;
    if (cur === was) continue;
    changed++;
    const keep = {};
    if (was && was.dgn) {
      markDeleted(was.dgn[0], was.dgn[1]);
      const o = was.dgn[0], size = elemSize(b, o);
      if (was.dgn[1] - o === size && cur && cur.type !== 'cell') { // single element: keep its graphic group, properties, attributes
        keep.gg = r.u16(o + 28); keep.props = r.u16(o + 32);
        const att = o + 32 + 2 * r.u16(o + 30);
        if (att >= o + 36 && att < o + size) keep.att = Array.from(b.subarray(att, o + size));
      }
    }
    if (cur) appended.push(...w.encode(cur, keep));
  }
  let total = head.length + 2;
  for (const el of appended) total += el.length;
  const tail = b[eod] === 0xff && b[eod + 1] === 0xff ? b.subarray(eod + 2) : new Uint8Array(0);
  const out = new Uint8Array(total + tail.length);
  out.set(head, 0);
  let o = head.length;
  for (const el of appended) { out.set(el, o); o += el.length; }
  out[o] = 0xff; out[o + 1] = 0xff;
  out.set(tail, o + 2);
  return { bytes: out, notes: noteList(notes), mode: 'round-trip', changed, appended: appended.length };
}

function decodeSeed() {
  if (typeof atob === 'function') return Uint8Array.from(atob(SEED_2D), (c) => c.charCodeAt(0));
  return new Uint8Array(Buffer.from(SEED_2D, 'base64')); // Node without atob (old versions)
}

function fromSeed(model, { extents }) {
  const notes = newNotes();
  const seed = decodeSeed();
  // ---- working units and global origin: coordinates must fit the 32-bit UOR grid
  let ext = extents && extents[0] <= extents[2] ? extents : [0, 0, 1, 1];
  const cx = (ext[0] + ext[2]) / 2, cy = (ext[1] + ext[3]) / 2;
  const half = Math.max(ext[2] - ext[0], ext[3] - ext[1], 1e-9) * 0.6;
  let k = Math.floor(Math.log10(2 ** 30 / half));
  k = Math.max(0, Math.min(6, k));
  const uor = 10 ** k;
  if (half * uor > 2 ** 31) notes.overflow = true;
  const g = { dim: 2, uor, ox: -cx, oy: -cy, oz: 0 };
  const tcb = seed.slice(0, 1536);
  setI32(tcb, 1112, 1); setI32(tcb, 1116, uor);
  const unit = (model.units && model.units.abbr ? model.units.abbr : '').replace('µ', 'u').replace(/[^\x20-\x7e]/g, '').slice(0, 2).padEnd(2, ' ');
  for (const o of [1120, 1122]) { tcb[o] = unit.charCodeAt(0); tcb[o + 1] = unit.charCodeAt(1); }
  tcb[1214] &= ~0x40;
  const ov = [];
  pushVax(ov, g.ox * uor); pushVax(ov, g.oy * uor); pushVax(ov, 0);
  tcb.set(ov, 1240);
  // ---- layers -> levels (in table order, only layers with items), colours -> palette
  const tables = sceneTables(model);
  const em = createEmitter(model, tables);
  const counts = new Map(), colors = new Map();
  for (const e of model.entities) {
    if (!e) continue;
    const { prims, texts } = emitItems(em, e);
    for (const p of [...prims, ...texts]) {
      const name = tables.layers[p.layer].name;
      counts.set(name, (counts.get(name) || 0) + 1);
      const c = p.color === FG ? 0xffffff : p.color;
      colors.set(c, (colors.get(c) || 0) + 1);
    }
  }
  const levelMap = new Map();
  let next = 1;
  for (const L of tables.layers) {
    if (!counts.has(L.name)) continue;
    let lv = next++;
    if (lv > 63) { lv = 63; notes.merged++; }
    levelMap.set(L.name.toUpperCase(), lv);
    notes.levels.push(`${L.name} → ${lv}`);
  }
  if (notes.levels.length > 12) notes.levels = [...notes.levels.slice(0, 12), `… (${notes.levels.length - 12} more)`];
  const palette = DGN_DEFAULT.slice();
  palette[0] = 0xffffff;
  const used = [...colors.entries()].filter(([c]) => c !== 0xffffff).sort((a, b2) => b2[1] - a[1]).map(([c]) => c).slice(0, 254);
  used.forEach((c, i) => { palette[i + 1] = c; });
  palette[255] = 0x000000;
  const w = new Writer(model, g, palette, notes, { levelOf: (name) => levelMap.get(String(name).toUpperCase()) || 1 });
  // ---- colour table element (type 5, level 1)
  const ct = [];
  pushU16(ct, 0);
  ct.push(0, 0, 0); // background (index 255)
  for (let i = 0; i < 255; i++) ct.push(palette[i] >> 16, (palette[i] >> 8) & 255, palette[i] & 255);
  const ctEl = w.enc.element(5, { level: 1, color: 0, style: 0, weight: 0 }, ct, [0, 0, 0, 0]);
  const els = [];
  for (const e of model.entities) if (e) els.push(...w.encode(e));
  if (model.paperEntities && model.paperEntities.length) notes.paper = model.paperEntities.length;
  let total = tcb.length + (seed.length - 1536) + ctEl.length + 2;
  for (const el of els) total += el.length;
  const padded = Math.ceil(total / 512) * 512;
  const out = new Uint8Array(padded);
  out.set(tcb, 0);
  out.set(seed.subarray(1536), 1536);
  let o = seed.length;
  out.set(ctEl, o); o += ctEl.length;
  for (const el of els) { out.set(el, o); o += el.length; }
  out[o] = 0xff; out[o + 1] = 0xff;
  const list = noteList(notes);
  if (notes.overflow) list.unshift('The drawing is too large for the DGN v7 coordinate range; far-away items may be clipped.');
  if (notes.paper) list.push(`${notes.paper} paper-space (layout) item${notes.paper === 1 ? ' is' : 's are'} not written (DGN has no layouts).`);
  return { bytes: out, notes: list, mode: 'new', uor };
}
