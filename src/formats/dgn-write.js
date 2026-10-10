// DGN v7 (ISFF) writer, from the public ISFF element description (element layouts as decoded by
// ./dgn.js; see NOTICE for the GDAL dgnlib credit).
//
// Two modes:
//  * Round trip (the drawing was opened from a DGN v7 file): the original bytes are kept. Every
//    element whose entity was not edited stays byte-for-byte identical at the same offset. An edited
//    item is rebuilt FROM ITS ORIGINAL BYTES (see Patcher): a move / rotate transforms the coordinates
//    of every element in its byte range, a restyle patches the symbology bytes, a retyped text is
//    spliced in as a new text element with the old header, enter-data fields and attribute data, and
//    the word counts and ranges of the enclosing text node / cell / complex headers are fixed. So
//    everything the reader does not model (text node headers, point strings, blank texts, B-splines,
//    linkages, graphic groups...) survives. The old elements get their DELETED bit set in place and
//    the new versions are appended before the end-of-design marker. Duplicates / pastes of items
//    from the same file are copies of their original bytes, transformed. Only an item that cannot be
//    rebuilt that way (reshaped geometry, an element type that cannot be moved) is encoded afresh
//    from the model, and the save notes say what that loses.
//  * New file (any other drawing): starts from GDAL's 2D seed (TCB etc., ./dgn-seed.js), sets the
//    working units and global origin so coordinates fit the 32-bit grid, writes a colour table,
//    maps layers to levels 1-63 and writes every item (blocks flattened).
// Coordinates outside the 32-bit grid are never clamped: the save fails with a message instead.
import { SEED_2D } from './dgn-seed.js';
import { groupOf, groupEnds, isContainer, decodeDgnText, quatToMatrix, TYPE_NAMES } from './dgn.js';
import { DGN_DEFAULT } from '../palettes.js';
import { createEmitter, sceneTables, KIND, FLAG, CHAR_W, DXF_LW, lwToWeight } from '../scene.js';
import { FG } from '../model.js';
import { ellipseParams } from './dxf-write.js';
import { TAU, bulgeToArc } from '../geom.js';
import { transformEntity, bakeOcs } from '../edit/ops.js';

const MAXV = 101; // vertices per line string / shape element
const D360 = 360000 * (180 / Math.PI); // radians -> 1/360000 degree
const FULL_TURN = 360 * 360000;
const MAX_WORDS = 65535; // u16 word counts

// ------------------------------------------------------------------ bytes
/** Coordinates that do not fit the 32-bit grid are counted here (per item) and fail the save. */
let OVF = null;
function toI32(v) {
  const r = Math.round(v);
  if (r >= -2147483648 && r <= 2147483647) return r;
  if (OVF) OVF.hit = true;
  return 0;
}
function pushI32(a, v) { const u = toI32(v) >>> 0; a.push((u >>> 16) & 255, (u >>> 24) & 255, u & 255, (u >>> 8) & 255); }
function pushU16(a, v) { a.push(v & 255, (v >>> 8) & 255); }
function pushRange(a, v) { const u = ((toI32(v) ^ 0x80000000) >>> 0); a.push((u >>> 16) & 255, (u >>> 24) & 255, u & 255, (u >>> 8) & 255); }
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
const u16At = (b, o) => b[o] | (b[o + 1] << 8);
const i32At = (b, o) => b[o + 2] | (b[o + 3] << 8) | (b[o] << 16) | (b[o + 1] << 24);
function setU16(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; }
function setI32(b, o, v) { const t = []; pushI32(t, v); b.set(t, o); }
function setRange(b, o, v) { const t = []; pushRange(t, v); b.set(t, o); }
function setVax(b, o, v) { const t = []; pushVax(t, v); b.set(t, o); }
function getRange(el) { // [xlo, ylo, zlo, xhi, yhi, zhi] (UOR)
  const out = [];
  for (let k = 0; k < 6; k++) out.push((i32At(el, 4 + 4 * k) ^ 0x80000000) | 0);
  return out;
}
const elemSize = (b, o) => 4 + 2 * (b[o + 2] | (b[o + 3] << 8));
const attStart = (el) => { const a = 32 + 2 * u16At(el, 30); return a >= 36 && a < el.length ? a : el.length; };
const NONGRAPHIC = new Set([1, 5, 8, 9, 10, 66]);

/** Element with attribute data appended (properties: attributes present; a complex header's word count grows too). */
function addAtt(el, att) {
  const out = new Uint8Array(el.length + att.length);
  out.set(el); out.set(att, el.length);
  if (attStart(el) >= el.length) setU16(out, 30, (el.length - 32) / 2);
  setU16(out, 2, (out.length - 4) / 2);
  out[33] |= 0x08;
  const t = el[1] & 0x7f;
  if (t === 2 || t === 7 || t === 12 || t === 14) setU16(out, 36, u16At(el, 36) + att.length / 2);
  return out;
}
/** Fill linkage (user data linkage 0x0041, as GDAL writes it) for fill colour index ci. */
const fillAtt = (ci) => [0x07, 0x10, 0x41, 0x00, 0x02, 0x08, 0x01, 0x00, ci & 255, 0, 0, 0, 0, 0, 0, 0];

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
/**
 * DGN text bytes: 8-bit cp1252 when possible. Text with other characters (Ω, CJK...) is written as
 * 16-bit text (0xFF 0xFD + 16-bit words) holding its UTF-8 bytes the way dgnlib unpacks words (a word
 * below 256 is one byte, others two: high, low), so GDAL and this app read back the same string.
 */
export function textBytes(s, notes) {
  s = String(s).replace(/\0/g, '');
  const map = cp1252();
  const out8 = [];
  let ok = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) out8.push(c); else if (map.has(c)) out8.push(map.get(c)); else { ok = false; break; }
  }
  if (ok) { if (out8.length > 255) { notes.truncated++; out8.length = 255; } return out8; }
  notes.wide++;
  const out = [0xff, 0xfd], enc = new TextEncoder();
  for (const ch of s) {
    const u = enc.encode(ch), bytes = [];
    for (let k = 0; k < u.length;) {
      const w = u[k] >= 0x80 && k + 1 < u.length ? (u[k] << 8) | u[k + 1] : u[k]; // >= 256: two bytes, high first
      k += w >= 256 ? 2 : 1;
      bytes.push(w & 255, w >> 8); // each word little-endian
    }
    if (out.length + bytes.length > 254) { notes.truncated++; break; }
    out.push(...bytes);
  }
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
  /** Rotation about Z as an ISFF quaternion (w, x, y, z), 1.0 == 2^31; dgnlib's convention: +a is (cos a/2, 0, 0, -sin a/2). */
  quat(a) {
    const t = [];
    for (const v of [Math.cos(a / 2), 0, 0, -Math.sin(a / 2)]) pushI32(t, v * 2147483647);
    return t;
  }
  zr(sym) { return sym.zr || 0; }
  zAt(sym, k) { return sym.zv && sym.zv[k] != null ? sym.zv[k] : this.zr(sym); }
  zRange(sym, n) { if (!sym.zv) return [this.zr(sym), this.zr(sym)]; let lo = Infinity, hi = -Infinity; for (let k = 0; k < n; k++) { const z = this.zAt(sym, k); lo = Math.min(lo, z); hi = Math.max(hi, z); } return [lo, hi]; }

  line(sym, ax, ay, bx, by, opt) {
    const raw = [this.X(ax), this.Y(ay), this.X(bx), this.Y(by)].map(Math.round);
    const body = [];
    if (this.g.dim === 3) { pushI32(body, raw[0]); pushI32(body, raw[1]); pushI32(body, this.zAt(sym, 0)); pushI32(body, raw[2]); pushI32(body, raw[3]); pushI32(body, this.zAt(sym, 1)); }
    else for (const v of raw) pushI32(body, v);
    return this.element(3, sym, body, this.rangeOf(raw), { ...opt, z: this.g.dim === 3 ? this.zRange(sym, 2) : [0, 0] });
  }
  /** Line string (4), shape (6) or curve (11): pts world [x, y, ...] (<= 101 vertices); sym.zv: raw Z per vertex. */
  multi(type, sym, pts, opt) {
    const raw = [];
    for (let i = 0; i < pts.length; i += 2) raw.push(Math.round(this.X(pts[i])), Math.round(this.Y(pts[i + 1])));
    const body = [];
    pushU16(body, raw.length / 2);
    for (let i = 0; i < raw.length; i += 2) { pushI32(body, raw[i]); pushI32(body, raw[i + 1]); if (this.g.dim === 3) pushI32(body, this.zAt(sym, i / 2)); }
    return this.element(type, sym, body, this.rangeOf(raw), { ...opt, z: this.g.dim === 3 ? this.zRange(sym, raw.length / 2) : [0, 0] });
  }
  /** Conic (scene form: centre, U, V, t0, t1, full) -> ellipse (15) or arc (16). */
  conic(sym, c, opt) {
    const q = ellipseParams({ c: [c[0], c[1]], major: [c[2], c[3]], minor: [c[4], c[5]], t0: c[6], t1: c[7] });
    const full = c.full;
    const r1 = Math.hypot(...q.major), r2 = r1 * q.ratio, rot = Math.atan2(q.major[1], q.major[0]);
    let sweep = q.t1 - q.t0;
    if (!full) { if (sweep <= 0) sweep += TAU; sweep = Math.min(sweep, TAU); }
    return this.arcEl(sym, q.c[0], q.c[1], r1, r2, rot, full ? null : q.t0, sweep, conicBox(c), opt);
  }
  /** Circular arc (16) with a signed sweep (negative = clockwise), e.g. a polyline bulge. */
  arc(sym, cx, cy, r, a0, sweep, opt) {
    const P = (t) => [cx + r * Math.cos(t), cy + r * Math.sin(t)];
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (p) => { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); };
    const lo = Math.min(a0, a0 + sweep), hi = Math.max(a0, a0 + sweep);
    add(P(lo)); add(P(hi));
    for (let k = Math.ceil(lo / (Math.PI / 2)); k * (Math.PI / 2) <= hi; k++) add(P(k * (Math.PI / 2)));
    return this.arcEl(sym, cx, cy, r, r, 0, a0, sweep, b, opt);
  }
  /** Ellipse (start == null) or arc element: radii r1/r2 along rot, parametric start, signed sweep; box = world bbox. */
  arcEl(sym, cx, cy, r1, r2, rot, start, sweep, box, opt) {
    const g = this.g, body = [];
    if (start != null) {
      let s = Math.round(start * D360) % FULL_TURN; if (s < 0) s += FULL_TURN;
      const mag = Math.min(FULL_TURN, Math.round(Math.abs(sweep) * D360));
      pushI32(body, s);
      pushI32(body, sweep < 0 ? (mag | 0x80000000) | 0 : mag); // sign and magnitude
    }
    pushVax(body, r1 * g.uor); pushVax(body, r2 * g.uor);
    if (g.dim === 3) body.push(...this.quat(rot)); else { let r = Math.round(rot * D360) % FULL_TURN; if (r < 0) r += FULL_TURN; pushI32(body, r); }
    toI32(this.X(cx)); toI32(this.Y(cy)); // the centre must lie on the grid too
    pushVax(body, this.X(cx)); pushVax(body, this.Y(cy));
    if (g.dim === 3) pushVax(body, this.zr(sym));
    const rng = [this.X(box[0]), this.Y(box[1]), this.X(box[2]), this.Y(box[3])].map((v, i) => (i < 2 ? Math.floor(v) : Math.ceil(v)));
    return this.element(start == null ? 15 : 16, sym, body, rng, { ...opt, z: [this.zr(sym), this.zr(sym)] });
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
    if (g.dim === 3) body.push(...this.quat(rot)); else { let r = Math.round(rot * D360) % FULL_TURN; if (r < 0) r += FULL_TURN; pushI32(body, r); }
    const px = Math.round(this.X(ox)), py = Math.round(this.Y(oy));
    pushI32(body, px); pushI32(body, py);
    if (g.dim === 3) pushI32(body, this.zr(sym));
    body.push(chars.length, 0, ...chars);
    const corners = [];
    for (const [u, v] of [[0, 0], [W, 0], [W, 1], [0, 1]]) corners.push(this.X(ox + u * Xx + v * Yx), this.Y(oy + u * Xy + v * Yy));
    return this.element(17, sym, body, this.rangeOf(corners), { ...opt, z: [this.zr(sym), this.zr(sym)] });
  }
  /**
   * Complex chain (12) / shape (14) header followed by its components. Word counts are 16-bit: a
   * longer chain is split into several chains that meet end to end (a closed one too, with a note)
   * so no length is ever written wrong. opt.att: attribute data for the (first) header.
   */
  complex(type, sym, comps, opt = {}) {
    const groups = [];
    let cur = [], words = 5 + (opt.att ? opt.att.length / 2 : 0);
    for (const el of comps) {
      if (cur.length && words + el.length / 2 > MAX_WORDS) { groups.push(cur); cur = []; words = 5; }
      cur.push(el); words += el.length / 2;
    }
    if (cur.length) groups.push(cur);
    if (groups.length > 1) { if (type === 14) this.notes.splitShapes++; type = 12; this.notes.splitChains++; }
    const out = [];
    groups.forEach((list, gi) => {
      let n = 0;
      const r = [Infinity, Infinity, -Infinity, -Infinity], z = [Infinity, -Infinity];
      for (const el of list) {
        n += el.length / 2;
        const q = getRange(el);
        r[0] = Math.min(r[0], q[0]); r[1] = Math.min(r[1], q[1]); r[2] = Math.max(r[2], q[3]); r[3] = Math.max(r[3], q[4]);
        z[0] = Math.min(z[0], q[2]); z[1] = Math.max(z[1], q[5]);
      }
      const att = gi === 0 && groups.length === 1 ? opt.att : null;
      const body = [];
      pushU16(body, n + 5 + (att ? att.length / 2 : 0));
      pushU16(body, list.length);
      for (let i = 0; i < 8; i++) body.push(0);
      out.push(this.element(type, sym, body, r, { ...opt, att, z }), ...list);
    });
    return out;
  }
  /** Open run of vertices -> line string, or a complex chain when longer than 101 vertices. */
  run(sym, pts, closed, opt) {
    let p = pts;
    let zv = sym.zv;
    if (closed) {
      const n = p.length / 2;
      if (!(p[0] === p[2 * n - 2] && p[1] === p[2 * n - 1])) { p = [...p, p[0], p[1]]; if (zv) zv = [...zv, zv[0]]; }
    }
    if (zv && zv.length !== p.length / 2) zv = null;
    if (p.length / 2 <= MAXV) return [this.multi(closed ? 6 : 4, { ...sym, zv }, p, opt)];
    const comps = [];
    for (let s = 0; s < p.length / 2 - 1; s += MAXV - 1) {
      const e = Math.min(p.length / 2, s + MAXV);
      comps.push(this.multi(4, { ...sym, zv: zv ? zv.slice(s, e) : null }, p.slice(2 * s, 2 * e), { component: true }));
    }
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
    this.lw = model.format !== 'DGN'; // scene weights are DXF lineweight classes: map them to DGN weights
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
  /** DGN weight of an emitted item (texts carry none: their entity's). DXF lineweight classes map to the nearest weight. */
  weightOf(w, e) {
    if (w == null) return this.lw ? lwToWeight(e.lw ?? -1) : Math.min(31, e.weight | 0);
    return this.lw ? lwToWeight(DXF_LW[w - 1] ?? -1) : Math.min(31, w | 0);
  }
  styleOf(idx) { const n = this.tables.ltypes[idx] ? this.tables.ltypes[idx].name : ''; const m = /^DGN(\d)$/.exec(n); return m ? +m[1] : idx ? 2 : 0; }
  sym(p, e) {
    return {
      level: this.levelOf(this.tables.layers[p.layer] ? this.tables.layers[p.layer].name : '0'),
      color: this.colorIndex(p.color, e.ci), style: this.styleOf(p.style), weight: this.weightOf(p.weight, e),
      zr: e.zr, zv: e.zv, font: e.font, just: e.just,
    };
  }

  /** Elements for one entity. opt: { component, gg, props, att } (att etc. only when it is one element). */
  encode(e, opt = {}) {
    if (!e) return [];
    if (e.type === 'cell') return this.cell(e, opt);
    const { prims, texts } = emitItems(this.em, e);
    const E = this.enc, out = [];
    const comp = { component: !!opt.component };
    const dgnFill = e.fill != null; // a DGN fill: kept as a fill linkage, not drawn as an extra outline
    if (e.type === 'polyline' && e.bulges && e.bulges.some((v) => v) && prims.length) {
      out.push(...this.chain(e, this.sym(prims.find((p) => !(p.flags & FLAG.FILL)) || prims[0], e), comp));
    } else {
      for (const p of prims) {
        const s = this.sym(p, e);
        if (p.kind === KIND.POINT) out.push(E.line(s, p.pts[0], p.pts[1], p.pts[0], p.pts[1], comp));
        else if (p.kind === KIND.CONIC) { if (!(dgnFill && p.flags & FLAG.FILL)) out.push(E.conic(s, p.c, comp)); }
        else if (p.flags & (FLAG.FILL | FLAG.PATTERN)) {
          if (dgnFill) continue;
          this.notes.fills++;
          let ring = [];
          const flush = () => { if (ring.length >= 6) out.push(...E.run({ ...s, zv: null }, ring, true, comp)); ring = []; };
          for (let i = 0; i < p.pts.length; i += 2) { if (p.pts[i] !== p.pts[i]) flush(); else ring.push(p.pts[i], p.pts[i + 1]); }
          flush();
        } else if (e.type === 'line' && p.pts.length === 4 && !(p.flags & FLAG.CLOSED)) out.push(E.line(s, p.pts[0], p.pts[1], p.pts[2], p.pts[3], comp));
        else {
          if (p.flags & FLAG.CURVEPTS) this.notes.curves++;
          const closed = !!(p.flags & FLAG.CLOSED) && p.pts.length >= 6;
          if (p.pts.length >= 4) out.push(...E.run(e.type === 'polyline' && e.zv && e.zv.length === p.pts.length / 2 ? s : { ...s, zv: null }, p.pts, closed, comp));
        }
      }
    }
    for (const t of texts) out.push(E.text(this.sym(t, e), t, comp));
    if (dgnFill && out.length && !opt.att && !(opt.head && opt.head.att)) {
      const k = out.findIndex((el) => [6, 14, 15].includes(el[1] & 0x7f));
      if (k >= 0) out[k] = addAtt(out[k], fillAtt(this.colorIndex(e.fill, e.fci)));
      else this.notes.fillsLost++;
    }
    if (out.length === 1 && (opt.gg || opt.props || opt.att)) {
      // one element replacing one element: keep the original graphic group, properties and attribute data
      const el = out[0], q = getRange(el);
      const sym = { level: el[0] & 63, color: el[35], style: el[34] & 7, weight: el[34] >> 3 };
      const body = Array.from(el.subarray(36, attStart(el)));
      out[0] = E.element(el[1] & 0x7f, sym, body, [q[0], q[1], q[3], q[4]], { ...comp, gg: opt.gg, props: opt.props, att: opt.att, z: [q[2], q[5]] });
    } else if (out.length > 1 && opt.head && (out[0][1] & 0x7f) === opt.head.type) {
      // a complex chain / shape replacing one: its header keeps the original graphic group, properties and linkages
      let el = out[0];
      setU16(el, 28, opt.head.gg); setU16(el, 32, opt.head.props & ~0x0800);
      if (opt.head.att) el = addAtt(el, opt.head.att);
      out[0] = el;
    }
    return out;
  }

  /**
   * Bulged polyline -> one complex chain / shape: runs of straight segments as line strings and every
   * bulge as an arc element running the same way as the polyline (start at its first vertex, signed sweep).
   */
  chain(e0, sym, comp) {
    const e = e0.xf ? bakeOcs(e0) : e0;
    const E = this.enc, pts = e.pts, n = pts.length / 2, segs = e.closed ? n : n - 1;
    const zv = e.zv && e.zv.length === n ? e.zv : null;
    const comps = [];
    let run = [0];
    const flush = () => {
      if (run.length < 2) return;
      for (let k = 0; k < run.length - 1; k += MAXV - 1) {
        const ids = run.slice(k, Math.min(run.length, k + MAXV)), p = [];
        for (const i of ids) p.push(pts[2 * i], pts[2 * i + 1]);
        comps.push(E.multi(4, { ...sym, zv: zv ? ids.map((i) => zv[i]) : null }, p, { component: true }));
      }
    };
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const arc = bulgeToArc(pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1], e.bulges[i] || 0);
      if (!arc) { run.push(j); continue; }
      flush();
      comps.push(E.arc({ ...sym, zr: zv ? zv[i] : sym.zr, zv: null }, arc.cx, arc.cy, arc.r, arc.a0, arc.sweep, { component: true }));
      run = [j];
    }
    flush();
    if (!comps.length) return [];
    return E.complex(e.closed ? 14 : 12, { ...sym, zv: null }, comps, comp);
  }

  /** Cell: its original header (patched) or a new one (pasted / duplicated cells, new files), then its components. */
  cell(e, opt) {
    const kids = [];
    for (const c of e.children || []) kids.push(...this.child(c));
    let words = 0;
    const R = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const el of kids) {
      words += el.length / 2;
      const q = getRange(el);
      for (let k = 0; k < 3; k++) { R[k] = Math.min(R[k], q[k]); R[k + 3] = Math.max(R[k + 3], q[k + 3]); }
    }
    if (!kids.length) return [];
    const src = this.bytes && e.dgn ? this.bytes : null;
    if (!src) return [this.newCell(e, R, words, opt), ...kids];
    const o = e.dgn[0];
    const hdr = src.slice(o, o + elemSize(src, o));
    const r = rd(hdr), g = this.enc.g;
    hdr[0] = (hdr[0] & 0x3f) | (opt.component ? 0x80 : 0);
    hdr[1] &= 0x7f;
    const tot = (hdr.length - 38) / 2 + words;
    if (tot > MAX_WORDS) throw cellTooBig(e);
    setU16(hdr, 36, tot);
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
    if (e.rgb != null) hdr[35] = this.colorIndex(e.rgb, e.ci); // restyled cells: header colour and weight follow
    if (!this.lw) hdr[34] = (hdr[34] & 7) | ((Math.min(31, e.weight | 0)) << 3);
    return [hdr, ...kids];
  }

  /**
   * A fresh type-2 cell header (ISFF layout as read by dgn.js): name (RAD50), class 0, all levels,
   * range, transform (1.0 = 214748; 2D 2x2, 3D 3x3 rows) and origin. The transform is the cell's
   * own (`trans` / `trans3` from its source file, else identity) after any edit move/rotate (`mv`).
   */
  newCell(e, R, words, opt) {
    const g = this.enc.g, d3 = g.dim === 3, a = [];
    const r50 = (s) => { let v = 0; for (const ch of s) v = v * 40 + Math.max(0, ' ABCDEFGHIJKLMNOPQRSTUVWXYZ$.?0123456789'.indexOf(ch)); return v; };
    const nm = (String(e.name || '').toUpperCase() + '      ').slice(0, 6);
    pushU16(a, 0); pushU16(a, r50(nm.slice(0, 3))); pushU16(a, r50(nm.slice(3))); pushU16(a, 0);
    for (let k = 0; k < 4; k++) pushU16(a, 0xffff);
    for (const v of d3 ? R : [R[0], R[1], R[3], R[4]]) pushI32(a, v);
    const t = e.trans || [1, 0, 0, 1], M = e.mv;
    let T = e.trans3 || [t[0], t[1], 0, t[2], t[3], 0, 0, 0, 1];
    if (M) { const L = [M[0], M[2], 0, M[1], M[3], 0, 0, 0, 1]; T = T.map((_, k) => { const i = (k / 3) | 0, j = k % 3; return L[3 * i] * T[j] + L[3 * i + 1] * T[3 + j] + L[3 * i + 2] * T[6 + j]; }); }
    for (const v of d3 ? T : [T[0], T[1], T[3], T[4]]) pushI32(a, v * 214748);
    const p = e.origin || [(R[0] / g.uor) - g.ox, (R[1] / g.uor) - g.oy];
    pushI32(a, this.enc.X(p[0])); pushI32(a, this.enc.Y(p[1]));
    if (d3) pushI32(a, e.zr || 0);
    const tot = (a.length - 2) / 2 + words;
    if (tot > MAX_WORDS) throw cellTooBig(e);
    a[0] = tot & 255; a[1] = (tot >> 8) & 255;
    const sym = { level: this.levelOf(e.layer ?? '0'), color: this.colorIndex(e.rgb, e.ci), style: 0, weight: this.weightOf(null, e) };
    return this.enc.element(2, sym, a, [R[0], R[1], R[3], R[4]], { component: !!opt.component, z: [R[2], R[5]] });
  }

  /**
   * One component of a cell. Unchanged since the file was read (the same object): its original bytes.
   * Changed but still one element of the original (e.g. a text typed over): re-encoded, keeping its
   * graphic group, properties and attribute data. Anything else: encoded afresh.
   */
  child(c) {
    const src = this.bytes;
    if (src && c && c.dgn && this.pristine && this.pristine.has(c)) return [src.slice(c.dgn[0], c.dgn[1])];
    const keep = src && c && c.dgn && c.type !== 'cell' ? keepOf(src, c.dgn[0], c.dgn[1]) : {};
    return this.encode(c, { component: true, ...keep });
  }
}

const cellTooBig = (e) => Object.assign(new Error(`The cell "${e.name || '?'}" is too large for DGN v7 (its parts need more than 65,535 words), so nothing was saved. Split it into smaller cells, or save as DXF.`), { code: 'dgn-cell-too-big' });

/** Graphic group, properties and attribute data of the element at o: for one element, or the header of a complex chain / shape. */
function keepOf(b, o, end) {
  const size = elemSize(b, o);
  const r = rd(b), keep = { gg: r.u16(o + 28), props: r.u16(o + 32) };
  const att = o + 32 + 2 * r.u16(o + 30);
  const data = att >= o + 36 && att < o + size ? Array.from(b.subarray(att, o + size)) : null;
  if (end - o === size) { if (data) keep.att = data; return keep; }
  const type = b[o + 1] & 0x7f;
  if (type === 12 || type === 14) return { head: { type, gg: keep.gg, props: keep.props, att: data } };
  return {};
}

/** Every component object of the cells in `ents` (nested cells too). */
function cellComponents(ents, set = new Set()) {
  for (const e of ents) if (e && e.type === 'cell') for (const c of e.children || []) { set.add(c); if (c && c.type === 'cell') cellComponents([c], set); }
  return set;
}

// ------------------------------------------------------------------ byte-level editing
/** Element tree of the bytes [s, e): nodes { o, size, type, kids? }, grouped by the reader's rules. Null if malformed. */
export function elementTree(b, s, e) {
  const top = [], stack = [];
  for (let o = s; o < e;) {
    if (o + 4 > e) return null;
    const size = elemSize(b, o);
    if (o + size > e) return null;
    const type = b[o + 1] & 0x7f, comp = !!(b[o] & 0x80);
    while (stack.length && groupEnds(stack[stack.length - 1].g, o, type, comp)) stack.pop();
    const node = { o, size, type };
    if (stack.length) { const t = stack[stack.length - 1]; t.node.kids.push(node); t.g.seen++; } else top.push(node);
    if (!(b[o + 1] & 0x80) && isContainer(type) && size >= 40) { node.kids = []; stack.push({ node, g: { ...groupOf(b, o, type), seen: 0 } }); }
    o += size;
  }
  return top;
}

/** Geometry of an entity as numbers (emitted primitives and text placements), for "is this still a transform of the original?" checks. */
function geomOf(em, e) {
  const { prims, texts } = emitItems(em, e);
  const out = [prims.length, texts.length];
  for (const p of prims) {
    out.push(p.kind, p.flags);
    if (p.kind === KIND.CONIC) {
      const c = p.c, P = (t) => [c[0] + c[2] * Math.cos(t) + c[4] * Math.sin(t), c[1] + c[3] * Math.cos(t) + c[5] * Math.sin(t)];
      out.push(c[0], c[1], c[2], c[3], c[4], c[5], ...P(c[6]), ...P(c[7]), c[7] - c[6]);
    } else out.push(p.pts.length, ...p.pts);
  }
  for (const t of texts) out.push(t.x, t.y, ...t.m);
  return out;
}

/**
 * Rebuilds edited items from their original bytes (see the file comment). One call of `unit()` per
 * original byte range (a top-level item, or a top-level text node with the texts in it).
 */
class Patcher {
  constructor(w, b, g) {
    this.w = w; this.b = b; this.g = g;
    this.P = g.dim === 3 ? 12 : 8;
  }
  /** Raw (UOR) affine of a world transform M; null if M is not a move / rotate / uniform scale. */
  rawAffine(M) {
    if (!M) return null;
    const [a, b, c, d, e, f] = M;
    const s = Math.hypot(a, b);
    if (!(s > 0) || Math.abs(a - d) > 1e-9 * s || Math.abs(b + c) > 1e-9 * s) return { bad: true };
    const { uor, ox, oy } = this.g;
    const A = [a, b, c, d];
    const T = [(e + ox - (a * ox + c * oy)) * uor, (f + oy - (b * ox + d * oy)) * uor];
    const th = Math.atan2(b, a);
    const one = Math.abs(s - 1) < 1e-12;
    const none = one && Math.abs(th) < 1e-15 && !e && !f; // the identity: nothing moves
    return { A, T, th: Math.abs(th) < 1e-15 ? 0 : th, s: one ? 1 : s, none, M };
  }

  /**
   * New bytes for the range [s, e) or { fail: reason } / { removed }. pairs: Map start offset -> { cur,
   * orig } of every modelled item in the range (cur null = removed). opt.copy: the range is a copy
   * (duplicate / paste), so its first element stands alone (no complex bit). opt.common: { X, diff } for
   * elements no modelled item owns (a top-level text node's header).
   */
  unit(s, e, pairs, opt = {}) {
    const tree = elementTree(this.b, s, e);
    if (!tree || tree.length !== 1) return { fail: 'structure' };
    this.pairs = pairs;
    this.common = opt.common || { X: null, diff: null };
    this.unmovable = [];
    this.levelsChanged = false;
    for (const pr of pairs.values()) {
      pr.X = pr.cur ? this.rawAffine(pr.cur.xm || null) : null;
      if (pr.X && pr.X.bad) return { fail: 'mirror' };
      if (pr.cur && !this.sameGeometry(pr)) return { fail: 'reshaped' };
      pr.diff = pr.cur ? this.diff(pr.cur, pr.orig) : null;
    }
    const r = this.node(tree[0], null);
    if (this.unmovable.length) return { fail: 'unmovable', types: this.unmovable };
    if (!r) return { removed: true };
    const out = concat(r.parts);
    if (opt.copy) out[0] &= 0x7f;
    return { bytes: out };
  }

  /** Is the edited item (pr.cur) its original transformed by its own move/rotate (and retyped)? */
  sameGeometry(pr) {
    const { cur, orig } = pr;
    if (cur.type !== orig.type) return false;
    if (cur.type === 'cell') return (cur.children || []).length <= (orig.children || []).length; // parts are checked one by one
    let exp = cur.xm ? transformEntity({ ...orig, xm: undefined }, cur.xm) : orig;
    if (cur.type === 'text' && cur.text !== orig.text) exp = { ...exp, text: cur.text };
    const em = this.w.em, x = geomOf(em, exp), y = geomOf(em, cur);
    if (x.length !== y.length) return false;
    const tol = 0.01 / this.g.uor;
    for (let k = 0; k < x.length; k++) if (!(Math.abs(x[k] - y[k]) <= tol + 1e-9 * Math.abs(x[k]))) return false;
    return true;
  }

  /** Symbology changes of an item: { level, color, weight, style } (only the ones that changed). */
  diff(cur, orig) {
    const w = this.w, d = {};
    if (cur.layer !== orig.layer) { d.level = w.levelOf(cur.layer); this.levelsChanged = true; }
    if (cur.rgb !== orig.rgb || cur.ci !== orig.ci) d.color = w.colorIndex(cur.rgb, cur.ci);
    if ((cur.weight | 0) !== (orig.weight | 0)) d.weight = Math.min(31, cur.weight | 0);
    if ((cur.ltype || 'CONTINUOUS') !== (orig.ltype || 'CONTINUOUS')) { const m = /^DGN(\d)$/.exec(cur.ltype || ''); d.style = m ? +m[1] : 0; }
    return d;
  }

  /** Rebuild one node (and its components). owner: the innermost modelled item around it. Returns { parts, rng, geo, levels } or null (removed). */
  node(n, owner) {
    const b = this.b, pairs = this.pairs;
    const pr = pairs.get(n.o);
    if (pr && !pr.cur) return null;
    if (pr) owner = pr;
    let el = b.slice(n.o, n.o + n.size);
    let spliced = false;
    if (pr && pr.cur.type === 'text' && pr.cur.text !== pr.orig.text && n.type === 17) { el = this.splice(el, pr.cur.text); spliced = true; }
    const X = owner ? owner.X : this.common.X;
    const diff = owner ? owner.diff : this.common.diff;
    if (diff && !NONGRAPHIC.has(n.type) && el.length >= 36) {
      if (diff.level != null) el[0] = (el[0] & 0xc0) | (diff.level & 63);
      if (diff.color != null) el[35] = diff.color;
      if (diff.weight != null) el[34] = (el[34] & 7) | (diff.weight << 3);
      if (diff.style != null) el[34] = (el[34] & 0xf8) | (diff.style & 7);
    }
    const moved = X && !X.none;
    if (moved && !this.transform(el, n.type, X)) this.unmovable.push(TYPE_NAMES[n.type] || 'TYPE_' + n.type);
    let geo = moved || spliced, sized = spliced, kidsOut = null, removed = 0, dWords = 0;
    const levels = new Set();
    if (n.kids) {
      kidsOut = [];
      for (const k of n.kids) {
        const r = this.node(k, owner);
        if (!r) { removed++; dWords -= treeWords(k); geo = sized = true; continue; }
        kidsOut.push(r);
        dWords += r.words - treeWords(k);
        if (r.geo) geo = true;
        if (r.sized) sized = true;
        for (const lv of r.levels) levels.add(lv);
      }
      if (n.type === 27 || n.type === 24) { if (dWords) setI32(el, 36, i32At(el, 36) + dWords); }
      else {
        const tot = u16At(el, 36) + dWords;
        if (tot > MAX_WORDS || tot < 0) throw cellTooBig({ name: n.type === 2 ? cellName(el) : TYPE_NAMES[n.type] });
        setU16(el, 36, tot);
        if (removed && (n.type === 7 || n.type === 12 || n.type === 14 || n.type === 18 || n.type === 19)) setU16(el, 38, Math.max(0, u16At(el, 38) - removed));
      }
      if (n.type === 7 && kidsOut.some((r) => r.spliced)) this.nodeLengths(el, kidsOut);
      if (n.type === 2 && this.levelsChanged) this.cellLevels(el, n, levels);
    }
    const graphic = el.length >= 36 && !NONGRAPHIC.has(n.type);
    if (graphic) levels.add(el[0] & 63);
    // range: shifted with a plain move, else what the element (or what it holds) covers now
    if (geo && graphic) {
      const R0 = getRange(b.subarray(n.o, n.o + 28));
      const held = kidsOut ? kidsOut.map((r) => r.rng).filter(Boolean) : [];
      let R = null;
      if (moved && X.th === 0 && X.s === 1 && !sized) R = [R0[0] + X.T[0], R0[1] + X.T[1], R0[2], R0[3] + X.T[0], R0[4] + X.T[1], R0[5]].map(Math.round);
      else if (held.length) R = union(held);
      else if (spliced) R = this.textRange(el);
      else if (moved) R = this.leafRange(el, n.type, X, R0) || this.cornersRange(R0, X);
      if (R) {
        for (const k of [0, 1, 3, 4]) setRange(el, 4 + 4 * k, R[k]);
        if (n.type === 2) this.cellRange(el, R0, R);
      }
    }
    const parts = [el];
    if (kidsOut) for (const r of kidsOut) parts.push(...r.parts);
    let words = 0;
    for (const p of parts) words += p.length / 2;
    return { parts, words, geo, sized, spliced, levels, rng: graphic ? getRange(el) : null };
  }

  /** Move / rotate / scale the coordinates of one element in place. False: this element type cannot be moved. */
  transform(el, type, X) {
    const d3 = this.g.dim === 3, P = this.P;
    const { A, T, th, s } = X;
    const pt = (o) => { const x = i32At(el, o), y = i32At(el, o + 4); setI32(el, o, A[0] * x + A[2] * y + T[0]); setI32(el, o + 4, A[1] * x + A[3] * y + T[1]); };
    const vpt = (o) => { const r = rd(el); const x = r.vax(o), y = r.vax(o + 8); const nx = A[0] * x + A[2] * y + T[0], ny = A[1] * x + A[3] * y + T[1]; toI32(nx); toI32(ny); setVax(el, o, nx); setVax(el, o + 8, ny); };
    const ang = (o) => { if (!th) return; let v = Math.round(i32At(el, o) + th * D360) % FULL_TURN; if (v < 0) v += FULL_TURN; setI32(el, o, v); };
    const quat = (o) => {
      if (!th) return;
      const q = [0, 1, 2, 3].map((k) => i32At(el, o + 4 * k) / 2147483648);
      const c = Math.cos(th / 2), sn = -Math.sin(th / 2); // q * (c, 0, 0, sn) (Hamilton product)
      const n = [q[0] * c - q[3] * sn, q[1] * c + q[2] * sn, q[2] * c - q[1] * sn, q[0] * sn + q[3] * c];
      n.forEach((v, k) => setI32(el, o + 4 * k, Math.max(-2147483647, Math.min(2147483647, v * 2147483648))));
    };
    const sc = (o) => { if (s !== 1) setI32(el, o, i32At(el, o) * s); };
    const scv = (o) => { if (s !== 1) setVax(el, o, rd(el).vax(o) * s); };
    switch (type) {
      case 3: pt(36); pt(d3 ? 48 : 44); return true;
      case 4: case 6: case 11: case 21: case 22: {
        const n = u16At(el, 36);
        if (38 + n * P > attStart(el)) return false;
        for (let i = 0; i < n; i++) pt(38 + i * P);
        return true;
      }
      case 15: scv(36); scv(44); if (d3) { quat(52); vpt(68); } else { ang(52); vpt(56); } return true;
      case 16: scv(44); scv(52); if (d3) { quat(60); vpt(76); } else { ang(60); vpt(64); } return true;
      case 17: sc(38); sc(42); if (d3) { quat(46); pt(62); } else { ang(46); pt(50); } return true;
      case 7: sc(46); sc(50); sc(54); if (d3) { quat(58); pt(74); } else { ang(58); pt(62); } return true;
      case 2: {
        if (d3) {
          const t = []; for (let k = 0; k < 9; k++) t.push(i32At(el, 76 + 4 * k) / 214748);
          const L = [[A[0], A[2], 0], [A[1], A[3], 0], [0, 0, 1]];
          if (th || s !== 1) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) setI32(el, 76 + 4 * (3 * i + j), (L[i][0] * t[j] + L[i][1] * t[3 + j] + L[i][2] * t[6 + j]) * 214748);
          pt(112);
        } else {
          const t = [0, 1, 2, 3].map((k) => i32At(el, 68 + 4 * k) / 214748);
          if (th || s !== 1) [A[0] * t[0] + A[2] * t[2], A[0] * t[1] + A[2] * t[3], A[1] * t[0] + A[3] * t[2], A[1] * t[1] + A[3] * t[3]].forEach((v, k) => setI32(el, 68 + 4 * k, v * 214748));
          pt(84);
        }
        return true;
      }
      case 12: case 14: case 18: case 19: case 24: case 25: case 26: case 27: case 28: return true; // headers (range only) and parameter-space data
      default: return NONGRAPHIC.has(type) || type === 34;
    }
  }

  /** Exact range of a moved leaf element (raw UOR), or null to use its moved range box. */
  leafRange(el, type, X, R0) {
    const d3 = this.g.dim === 3, P = this.P;
    if (X.th === 0 && X.s === 1) return [R0[0] + X.T[0], R0[1] + X.T[1], R0[2], R0[3] + X.T[0], R0[4] + X.T[1], R0[5]].map(Math.round);
    const box = [Infinity, Infinity, R0[2], -Infinity, -Infinity, R0[5]];
    const add = (x, y) => { box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[3] = Math.max(box[3], x); box[4] = Math.max(box[4], y); };
    const r = rd(el);
    switch (type) {
      case 3: add(i32At(el, 36), i32At(el, 40)); add(i32At(el, d3 ? 48 : 44), i32At(el, d3 ? 52 : 48)); break;
      case 4: case 6: case 21: case 22: { const n = u16At(el, 36); for (let i = 0; i < n; i++) add(i32At(el, 38 + i * P), i32At(el, 42 + i * P)); break; }
      case 15: case 16: {
        const arc = type === 16, o = arc ? 44 : 36;
        const r1 = r.vax(o), r2 = r.vax(o + 8);
        let ux, uy, vx, vy, cx, cy;
        if (d3) { const m = quatToMatrix(...[0, 1, 2, 3].map((k) => i32At(el, o + 16 + 4 * k) / 2147483648)); ux = m[0] * r1; uy = m[3] * r1; vx = m[1] * r2; vy = m[4] * r2; cx = r.vax(o + 32); cy = r.vax(o + 40); }
        else { const a = (i32At(el, o + 16) / 360000) * (Math.PI / 180), c = Math.cos(a), sn = Math.sin(a); ux = c * r1; uy = sn * r1; vx = -sn * r2; vy = c * r2; cx = r.vax(o + 20); cy = r.vax(o + 28); }
        let t0 = 0, t1 = TAU;
        if (arc) {
          const st = (i32At(el, 36) / 360000) * (Math.PI / 180);
          let sw = i32At(el, 40) & 0x7fffffff; if (el[41] & 0x80) sw = -sw;
          const sweep = sw === 0 ? TAU : (sw / 360000) * (Math.PI / 180);
          t0 = Math.min(st, st + sweep); t1 = Math.max(st, st + sweep);
        }
        const bb = conicBox([cx, cy, ux, uy, vx, vy, t0, t1]);
        box[0] = Math.floor(bb[0]); box[1] = Math.floor(bb[1]); box[3] = Math.ceil(bb[2]); box[4] = Math.ceil(bb[3]);
        return box;
      }
      default: return null;
    }
    return box.map(Math.round);
  }
  /** Original range box moved (conservative after a rotation). */
  cornersRange(R0, X) {
    const { A, T } = X;
    const box = [Infinity, Infinity, R0[2], -Infinity, -Infinity, R0[5]];
    for (const [x, y] of [[R0[0], R0[1]], [R0[3], R0[1]], [R0[3], R0[4]], [R0[0], R0[4]]]) {
      const nx = A[0] * x + A[2] * y + T[0], ny = A[1] * x + A[3] * y + T[1];
      box[0] = Math.min(box[0], Math.floor(nx)); box[1] = Math.min(box[1], Math.floor(ny)); box[3] = Math.max(box[3], Math.ceil(nx)); box[4] = Math.max(box[4], Math.ceil(ny));
    }
    return box;
  }
  /** Range of a retyped text: its character cells (length multiplier x characters, height multiplier) around its origin. */
  textRange(el) {
    const d3 = this.g.dim === 3;
    const lm = (i32At(el, 38) * 6) / 1000, hm = (i32At(el, 42) * 6) / 1000;
    let dx, dy;
    if (d3) { const m = quatToMatrix(...[0, 1, 2, 3].map((k) => i32At(el, 46 + 4 * k) / 2147483648)); dx = [m[0], m[3]]; dy = [m[1], m[4]]; }
    else { const a = (i32At(el, 46) / 360000) * (Math.PI / 180); dx = [Math.cos(a), Math.sin(a)]; dy = [-Math.sin(a), Math.cos(a)]; }
    const ox = i32At(el, d3 ? 62 : 50), oy = i32At(el, d3 ? 66 : 54);
    const n = el[d3 ? 74 : 58], wide = el[d3 ? 76 : 60] === 0xff && el[d3 ? 77 : 61] === 0xfd;
    const W = lm * (wide ? (n - 2) / 2 : n), R0 = getRange(el);
    const box = [Infinity, Infinity, R0[2], -Infinity, -Infinity, R0[5]];
    for (const [u, v] of [[0, 0], [W, 0], [W, hm], [0, hm]]) {
      const x = ox + u * dx[0] + v * dy[0], y = oy + u * dx[1] + v * dy[1];
      box[0] = Math.min(box[0], Math.floor(x)); box[1] = Math.min(box[1], Math.floor(y)); box[3] = Math.max(box[3], Math.ceil(x)); box[4] = Math.max(box[4], Math.ceil(y));
    }
    return box;
  }
  /** A cell header's own range fields (52..) follow its new range when they held the old one (world coordinates); a local definition range stays. */
  cellRange(el, R0, R) {
    const d3 = this.g.dim === 3;
    const f = d3 ? [52, 56, 60, 64, 68, 72] : [52, 56, 60, 64];
    const old = f.map((o) => i32At(el, o));
    const was = d3 ? [R0[0], R0[1], R0[2], R0[3], R0[4], R0[5]] : [R0[0], R0[1], R0[3], R0[4]];
    if (!old.every((v, k) => Math.abs(v - was[k]) <= 2)) return;
    const now = d3 ? R : [R[0], R[1], R[3], R[4]];
    f.forEach((o, k) => setI32(el, o, now[k]));
  }
  /** A cell header's level mask (bytes 44..51, bit n-1 = level n) after levels changed: exact if it was exact, else widened. */
  cellLevels(el, n, levels) {
    const b = this.b, before = new Set();
    const walk = (k) => { if (!NONGRAPHIC.has(k.type) && k.size >= 36) before.add(b[k.o] & 63); for (const c of k.kids || []) walk(c); };
    for (const k of n.kids) walk(k);
    before.delete(0);
    const mask = el.subarray(44, 52);
    const has = (lv) => !!(mask[(lv - 1) >> 3] & (1 << ((lv - 1) & 7)));
    let exact = true;
    for (let lv = 1; lv <= 64; lv++) if (has(lv) !== before.has(lv)) exact = false;
    if (exact) mask.fill(0);
    for (const lv of levels) if (lv >= 1) mask[(lv - 1) >> 3] |= 1 << ((lv - 1) & 7);
  }
  /** Text node: longest line (max_used, byte 43) after a retype; max_length (42) grows with it. */
  nodeLengths(el, kids) {
    const d3 = this.g.dim === 3;
    let most = 0;
    for (const r of kids) { const t = r.parts[0]; if ((t[1] & 0x7f) === 17) most = Math.max(most, t[d3 ? 74 : 58]); }
    el[43] = Math.min(255, most);
    if (el[42] < el[43]) el[42] = el[43];
  }
  /**
   * A type-17 element with new text: the original header, font, justification, size, rotation and
   * origin; the new characters; the enter-data field descriptors and the attribute data as they were.
   */
  splice(el, text) {
    const d3 = this.g.dim === 3, to = d3 ? 76 : 60, nOff = to - 2;
    const n = el[nOff], ed = el[nOff + 1], att = attStart(el);
    const chars = textBytes(text, this.w.notes);
    if (ed) { // keep the descriptors' word alignment: a space after the text when its length changed parity
      this.w.notes.edf++;
      if (chars[0] !== 0xff && (chars.length & 1) !== (n & 1) && chars.length < 255) { chars.push(32); this.w.notes.edfSpace++; }
    }
    const out = [...el.subarray(0, to), ...chars];
    out[nOff] = chars.length;
    if (ed) out.push(...el.subarray(Math.min(to + n, att), att));
    if (out.length & 1) out.push(0);
    const a = out.length;
    out.push(...el.subarray(att));
    const r = Uint8Array.from(out);
    setU16(r, 30, (a - 32) / 2);
    setU16(r, 2, (r.length - 4) / 2);
    return r;
  }
}
/** Words of a tree node and everything it holds. */
const treeWords = (n) => { let w = n.size / 2; for (const k of n.kids || []) w += treeWords(k); return w; };
const cellName = (el) => { const a = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ$.?0123456789', r = (v) => a[Math.floor(v / 1600) % 40] + a[Math.floor(v / 40) % 40] + a[v % 40]; return (r(u16At(el, 38)) + r(u16At(el, 40))).trim(); };
function union(list) {
  if (!list.length) return null;
  const R = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const q of list) for (let k = 0; k < 3; k++) { R[k] = Math.min(R[k], q[k]); R[k + 3] = Math.max(R[k + 3], q[k + 3]); }
  return R;
}
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ------------------------------------------------------------------ public API
function newNotes() {
  return { truncated: 0, fills: 0, fillsLost: 0, curves: 0, merged: 0, levels: [], wide: 0, edf: 0, edfSpace: 0, splitChains: 0, splitShapes: 0, layer0: 0, layer0Level: 0, rebuilt: new Map(), unmovable: new Map(), unmovableCells: 0 };
}
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
function noteList(n) {
  const out = [];
  if (n.levels.length) out.push(`Layers became DGN levels (DGN v7 has no layer names): ${n.levels.join(', ')}.`);
  if (n.merged) out.push(`${n.merged} layer${n.merged === 1 ? '' : 's'} beyond 63 were merged into level 63.`);
  if (n.layer0) out.push(`${plural(n.layer0, 'item')} on layer "0" (not a DGN level) ${n.layer0 === 1 ? 'was' : 'were'} saved on level ${n.layer0Level}.`);
  if (n.unmovable.size) {
    const t = [...n.unmovable].map(([k, v]) => `${k}${v > 1 ? ' ×' + v : ''}`).join(', ');
    const c = [...n.unmovable.values()].reduce((s, v) => s + v, 0);
    out.push(`${plural(c, 'item')} inside cells could not be moved: ${t}. ${n.unmovableCells === 1 ? 'That cell was' : 'Those cells were'} rebuilt from what Linework shows, without ${c === 1 ? 'it' : 'them'}.`);
  }
  const was = (k) => (k === 1 ? 'was' : 'were');
  for (const [why, k] of n.rebuilt) {
    if (why === 'mirror') out.push(`${plural(k, 'edited item')} ${was(k)} mirrored or skewed and rewritten from what Linework shows.`);
    else if (why === 'cell') out.push(`${plural(k, 'cell')} ${was(k)} rebuilt from what Linework shows (parts it cannot show were left out).`);
    else if (why === 'tess') out.push(`${plural(k, 'reshaped complex chain')} with elliptical arcs or curves ${was(k)} rewritten with those parts as line strings.`);
    else out.push(`${plural(k, 'edited item')} ${was(k)} rewritten from what Linework shows.`);
  }
  if (n.curves) out.push(`${n.curves} curve${n.curves === 1 ? ' was' : 's were'} written as line strings.`);
  if (n.fills) out.push(`${n.fills} filled area${n.fills === 1 ? ' was' : 's were'} written as outlines.`);
  if (n.fillsLost) out.push(`${plural(n.fillsLost, 'fill')} could not be kept (the outline was split).`);
  if (n.splitChains) out.push(`${plural(n.splitChains, 'very long outline')} ${n.splitChains === 1 ? 'was' : 'were'} split into several complex chains (DGN v7 limits one to 65,535 words)${n.splitShapes ? `; ${n.splitShapes} closed one${n.splitShapes === 1 ? ' is' : 's are'} no longer closed shapes` : ''}.`);
  if (n.truncated) out.push(`${n.truncated} text${n.truncated === 1 ? ' was' : 's were'} longer than DGN v7 allows and ${n.truncated === 1 ? 'was' : 'were'} shortened.`);
  if (n.wide) out.push(`${plural(n.wide, 'text')} with characters outside the Western character set (e.g. Ω) ${n.wide === 1 ? 'was' : 'were'} saved as 16-bit text: GDAL reads ${n.wide === 1 ? 'it' : 'them'} back, older CAD programs may show other characters.`);
  if (n.edf) out.push(`${plural(n.edf, 'retyped text')} ${n.edf === 1 ? 'has' : 'have'} enter-data fields; their field positions were kept as they were${n.edfSpace ? ` (${n.edfSpace === n.edf ? (n.edf === 1 ? 'it' : 'they') : n.edfSpace} got a space at the end to keep the field data aligned)` : ''}.`);
  return out;
}
const bump = (map, k, n = 1) => map.set(k, (map.get(k) || 0) + n);

/** Palette of a DGN file: its colour table (type 5, level 1; the last one when there are several, as GDAL and the reader do) or the default DGN palette. */
export function dgnPalette(b) {
  let p = DGN_DEFAULT;
  for (let o = 0; o + 4 <= b.length;) {
    if (b[o] === 0xff && b[o + 1] === 0xff) break;
    const size = elemSize(b, o);
    if ((b[o + 1] & 0x7f) === 5 && (b[o] & 0x3f) === 1 && size >= 806 && o + size <= b.length && !(b[o + 1] & 0x80)) {
      p = new Uint32Array(256);
      for (let i = 0; i < 255; i++) p[i] = (b[o + 41 + 3 * i] << 16) | (b[o + 42 + 3 * i] << 8) | b[o + 43 + 3 * i];
      p[255] = (b[o + 38] << 16) | (b[o + 39] << 8) | b[o + 40];
    }
    o += size;
  }
  return p;
}

const levelFromName = (name) => { const m = /^Level (\d+)$/i.exec(String(name)); return m ? Math.min(63, +m[1]) : null; };
/** Thrown when items do not fit the 32-bit coordinate grid. */
function rangeError(n, g) {
  const span = Math.round(2147483647 / g.uor).toLocaleString('en-US');
  return Object.assign(new Error(`${plural(n, 'item')} ${n === 1 ? 'lies' : 'lie'} outside the DGN v7 coordinate range (about ±${span} drawing units from the file's global origin), so nothing was saved. Move ${n === 1 ? 'it' : 'them'} closer to the rest of the drawing, or save as DXF.`), { code: 'dgn-range', count: n });
}
/** Encode with the 32-bit range check: items outside are counted (the save then fails). */
function guarded(stats, fn) {
  const prev = OVF;
  OVF = { hit: false };
  try { const r = fn(); if (OVF.hit) stats.out++; return r; } finally { OVF = prev; }
}

/**
 * Write a DGN v7 file. opts: { bytes, orig, extents, level }. With `bytes` (the original DGN file) and
 * `orig` (the original entity objects by slot) it is a byte-preserving round trip. level: the drawing's
 * current level (items on layer "0" go there). Returns { bytes: Uint8Array, notes: [..], mode:
 * 'round-trip' | 'new' }. Throws an Error with a user-facing message when the drawing cannot be saved
 * as DGN v7 (coordinates outside the 32-bit grid, a cell too large).
 */
export function writeDgn(model, opts = {}) {
  if (model.format === 'DGN' && opts.bytes && opts.orig) return roundTrip(model, opts);
  return fromSeed(model, opts);
}

function roundTrip(model, { bytes, orig, level }) {
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
  const cur0 = levelFromName(level) || 1;
  const levelOf = (name) => { // "Level N" keeps N (0 too: as the file had it); anything else (layer "0") goes to the current level
    const lv = levelFromName(name);
    if (lv != null) return lv;
    notes.layer0++; notes.layer0Level = cur0;
    return cur0;
  };
  const w = new Writer(model, g, palette, notes, { levelOf });
  w.bytes = b;
  w.pristine = cellComponents(orig);
  const P = new Patcher(w, b, g);
  let eod = model.header && model.header.eod != null ? model.header.eod : b.length;
  if (eod > b.length) eod = b.length;
  const head = b.slice(0, eod);
  const appended = [];
  const stats = { out: 0 };
  const markDeleted = (from, to) => { for (let o = from; o + 4 <= to;) { head[o + 1] |= 0x80; o += elemSize(head, o); } };
  // original items by the start of their byte range (cell components too)
  const byStart = new Map();
  const index = (e) => { if (!e || !e.dgn) return; byStart.set(e.dgn[0], e); for (const c of e.children || []) index(c); };
  for (const e of orig) index(e);

  /** pairs (start -> { cur, orig }) of an item and its parts; null when the parts no longer match. */
  const pairsOf = (cur, o, map = new Map()) => {
    map.set(o.dgn[0], { cur, orig: o });
    if (o.type === 'cell') {
      const now = new Map();
      for (const c of (cur && cur.children) || []) { if (!c || !c.dgn) return null; now.set(c.dgn[0], c); }
      for (const c of o.children || []) { if (!pairsOf(cur ? now.get(c.dgn[0]) || null : null, c, map)) return null; now.delete(c.dgn[0]); }
      if (now.size) return null; // a part that was not in the original
    }
    return map;
  };
  /** The item rebuilt from its original bytes, or null (then it is encoded afresh). */
  const fromBytes = (cur, copy) => {
    const o = cur && cur.dgn && byStart.get(cur.dgn[0]);
    if (!o || o.dgn[1] !== cur.dgn[1]) return { fail: 'no source' };
    const pairs = pairsOf(cur, o);
    if (!pairs) return { fail: 'parts' };
    return P.unit(o.dgn[0], o.dgn[1], pairs, { copy });
  };
  const fresh = (cur, was, why) => {
    const keep = was && was.dgn && cur.type !== 'cell' ? keepOf(b, was.dgn[0], was.dgn[1]) : {};
    if (why) {
      if (why.fail === 'unmovable') { for (const t of why.types) bump(notes.unmovable, t); notes.unmovableCells++; }
      else if (why.fail === 'mirror') bump(notes.rebuilt, 'mirror');
      else if (cur.type === 'cell') bump(notes.rebuilt, 'cell');
      else if (cur.tess) bump(notes.rebuilt, 'tess');
      else if (why.fail !== 'reshaped') bump(notes.rebuilt, 'other');
    }
    return w.encode(cur, keep);
  };
  const append = (els) => { for (const el of els) appended.push(el); };
  const sameBytes = (x, s, e) => x.length === e - s && x.every((v, k) => v === b[s + k]);

  // top-level text nodes (and surfaces) whose texts were edited: rebuilt as a whole
  const units = new Map();
  const n = Math.max(orig.length, model.entities.length);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const cur = model.entities[i] || null, was = orig[i] || null;
    if (cur === was) continue;
    changed++;
    if (was && was.ctr && was.dgn) {
      const k = was.ctr[0];
      if (!units.has(k)) units.set(k, { ctr: was.ctr, slots: [] });
      units.get(k).slots.push({ cur, was });
      if (cur && !(cur.dgn && cur.dgn[0] === was.dgn[0])) units.get(k).slots[units.get(k).slots.length - 1].extra = cur; // replaced by something else
      continue;
    }
    guarded(stats, () => {
      if (was && was.dgn) {
        if (cur && cur.dgn && cur.dgn[0] === was.dgn[0]) {
          const res = fromBytes(cur, false);
          if (res.bytes) { if (!sameBytes(res.bytes, was.dgn[0], was.dgn[1])) { markDeleted(was.dgn[0], was.dgn[1]); appended.push(res.bytes); } return; }
          markDeleted(was.dgn[0], was.dgn[1]);
          append(fresh(cur, was, res));
          return;
        }
        markDeleted(was.dgn[0], was.dgn[1]);
      }
      if (!cur) return;
      const res = cur.dgn ? fromBytes(cur, true) : null; // a duplicate / paste of an item of this file: a copy of its bytes
      if (res && res.bytes) appended.push(res.bytes);
      else append(fresh(cur, null, res && res.fail !== 'no source' ? res : null));
    });
  }
  for (const { ctr, slots } of units.values()) {
    guarded(stats, () => {
      const [s, e] = ctr;
      const pairs = new Map(), tree = elementTree(b, s, e);
      // every modelled text of the node: its current version (edited, removed or unchanged)
      const edited = new Map(slots.map((x) => [x.was.dgn[0], x]));
      for (const k of (tree && tree[0] && tree[0].kids) || []) {
        const o = byStart.get(k.o);
        if (!o) continue;
        const x = edited.get(k.o);
        const cur = x ? (x.cur && x.cur.dgn && x.cur.dgn[0] === k.o ? x.cur : null) : o;
        pairs.set(k.o, { cur, orig: o });
      }
      const live = [...pairs.values()].filter((p) => p.cur);
      // the node header (and parts not shown) follow its texts when they all moved / changed alike
      const X0 = live.length ? live[0].cur.xm : null;
      const same = live.length && live.every((p) => JSON.stringify(p.cur.xm || null) === JSON.stringify(X0 || null));
      const common = { X: same && X0 ? P.rawAffine(X0) : null, diff: null };
      if (same) { const d = live.map((p) => JSON.stringify(P.diff(p.cur, p.orig))); if (d.every((v) => v === d[0])) common.diff = P.diff(live[0].cur, live[0].orig); }
      const res = live.length ? P.unit(s, e, pairs, { common }) : { removed: true };
      if (res.fail) { // rewrite the texts on their own
        markDeleted(s, e);
        for (const p of live) append(fresh(p.cur, p.orig, null));
      } else if (res.bytes) {
        if (!sameBytes(res.bytes, s, e)) { markDeleted(s, e); appended.push(res.bytes); }
      } else markDeleted(s, e);
      for (const x of slots) if (x.extra) append(fresh(x.extra, null, null));
    });
  }
  if (stats.out) throw rangeError(stats.out, g);
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
  // ---- layers -> levels (in table order, only layers with items), colours -> palette
  const tables = sceneTables(model);
  const em = createEmitter(model, tables);
  const counts = new Map(), colors = new Map();
  let maxText = 0;
  for (const e of model.entities) {
    if (!e) continue;
    const { prims, texts } = emitItems(em, e);
    for (const t of texts) maxText = Math.max(maxText, Math.hypot(t.m[0], t.m[1]), Math.hypot(t.m[2], t.m[3]));
    for (const p of [...prims, ...texts]) {
      const name = tables.layers[p.layer].name;
      counts.set(name, (counts.get(name) || 0) + 1);
      const c = p.color === FG ? 0xffffff : p.color;
      colors.set(c, (colors.get(c) || 0) + 1);
    }
  }
  // ---- working units and global origin: coordinates must fit the 32-bit UOR grid
  let ext = extents && extents[0] <= extents[2] ? extents : [0, 0, 1, 1];
  const cx = (ext[0] + ext[2]) / 2, cy = (ext[1] + ext[3]) / 2;
  const half = Math.max(ext[2] - ext[0], ext[3] - ext[1], 1e-9) * 0.6;
  let k = Math.floor(Math.log10(2 ** 30 / half));
  // text sizes are stored as UOR x 1000 / 6 in 32 bits: big text needs a coarser grid
  if (maxText > 0) k = Math.min(k, Math.floor(Math.log10((2 ** 31 * 6) / 1000 / maxText / 1.01)));
  k = Math.max(0, Math.min(6, k));
  const uor = 10 ** k;
  const g = { dim: 2, uor, ox: -cx, oy: -cy, oz: 0 };
  const tcb = seed.slice(0, 1536);
  setI32(tcb, 1112, 1); setI32(tcb, 1116, uor);
  const unit = (model.units && model.units.abbr ? model.units.abbr : '').replace('µ', 'u').replace(/[^\x20-\x7e]/g, '').slice(0, 2).padEnd(2, ' ');
  for (const o of [1120, 1122]) { tcb[o] = unit.charCodeAt(0); tcb[o + 1] = unit.charCodeAt(1); }
  tcb[1214] &= ~0x40;
  const ov = [];
  pushVax(ov, g.ox * uor); pushVax(ov, g.oy * uor); pushVax(ov, 0);
  tcb.set(ov, 1240);
  // ---- saved view 1 shows the drawing (MicroStation opens on it): origin = lower left, delta = size (UOR),
  // widened to the seed view's proportions, with a small margin
  {
    const v = 46, d0 = i32At(tcb, v + 22), d1 = i32At(tcb, v + 26), asp = d0 > 0 && d1 > 0 ? d0 / d1 : 4 / 3;
    let w = (ext[2] - ext[0]) * 1.05 || 1, h = (ext[3] - ext[1]) * 1.05 || 1;
    if (w / h > asp) h = w / asp; else w = h * asp;
    const lo = [(cx - w / 2 + g.ox) * uor, (cy - h / 2 + g.oy) * uor];
    if ([lo[0], lo[1], w * uor, h * uor].every((x) => Math.abs(x) < 2 ** 31)) {
      setI32(tcb, v + 10, lo[0]); setI32(tcb, v + 14, lo[1]);
      setI32(tcb, v + 22, w * uor); setI32(tcb, v + 26, h * uor);
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
  const stats = { out: 0 };
  for (const e of model.entities) if (e) guarded(stats, () => els.push(...w.encode(e)));
  if (stats.out) throw rangeError(stats.out, g);
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
  if (notes.paper) list.push(`${notes.paper} paper-space (layout) item${notes.paper === 1 ? ' is' : 's are'} not written (DGN has no layouts).`);
  return { bytes: out, notes: list, mode: 'new', uor };
}
