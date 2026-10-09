// Model -> render scene. Expands block references (nested, mirrored, arrayed), resolves layers,
// colours and line types, converts curves to exact conic primitives, lays out text, moves
// everything to a local origin (precision far from 0,0) and builds a uniform-grid spatial index.
// Output is plain objects + typed arrays so it can be transferred from the parse worker.

import { FG } from './model.js';
import { ACI } from './palettes.js';
import { bulgeToArc, insertMatrix, mul, apply, applyVec, TAU } from './geom.js';

export const KIND = { POLY: 1, CONIC: 2, POINT: 3 };
export const FLAG = { CLOSED: 1, FILL: 2, CURVEPTS: 4, EVENODD: 8, FULL: 16, PATTERN: 32 };

const MAX_DEPTH = 24;
const CHAR_W = 0.62; // average glyph advance in cap-height units (layout estimate)

function aciRgb(aci) {
  if (aci === 7 || aci <= 0 || aci > 255) return FG;
  return ACI[aci];
}

/** Convert a DXF LTYPE pattern (drawing units) to a screen-pixel dash array. */
export function dashFromPattern(pattern) {
  if (!pattern || !pattern.length) return null;
  const total = pattern.reduce((s, v) => s + Math.abs(v), 0);
  if (!(total > 0)) return null;
  const k = 24 / total;
  const out = [];
  let wantDash = true;
  for (const v of pattern) {
    const isDash = v >= 0;
    const len = Math.max(isDash ? 1 : 2, Math.abs(v) * k);
    if (isDash !== wantDash) out.push(isDash ? 2 : 1); // keep dash/gap alternation
    out.push(len);
    wantDash = !isDash;
  }
  if (out.length % 2) out.push(2);
  return out.every((v, i) => i % 2 === 1 || v > 0) ? out : null;
}

class Builder {
  constructor() {
    this.kind = []; this.flags = []; this.layer = []; this.color = []; this.style = []; this.weight = [];
    this.src = []; this.blk = []; this.start = []; this.count = [];
    this.coords = []; this.conics = [];
    this.texts = [];
    this.invalid = 0;
  }
  base(k, flags, a) {
    this.kind.push(k); this.flags.push(flags); this.layer.push(a.layer); this.color.push(a.color);
    this.style.push(a.style); this.weight.push(a.weight); this.src.push(a.src); this.blk.push(a.blk);
  }
  poly(pts, flags, a) {
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      if (Math.abs(x) < 1e15 && Math.abs(y) < 1e15) continue;
      if ((flags & (FLAG.FILL | FLAG.PATTERN)) && Number.isNaN(x) && Number.isNaN(y)) continue; // ring separator
      this.invalid++;
      return;
    }
    if (pts.length < 2) return;
    this.base(KIND.POLY, flags, a);
    this.start.push(this.coords.length / 2);
    this.count.push(pts.length / 2);
    for (let i = 0; i < pts.length; i++) this.coords.push(pts[i]);
  }
  point(x, y, a) {
    if (!(Math.abs(x) < 1e15 && Math.abs(y) < 1e15)) { this.invalid++; return; }
    this.base(KIND.POINT, 0, a);
    this.start.push(this.coords.length / 2);
    this.count.push(1);
    this.coords.push(x, y);
  }
  conic(cx, cy, ux, uy, vx, vy, t0, t1, full, a) {
    const v = [cx, cy, ux, uy, vx, vy, t0, t1];
    for (const x of v) if (!(Math.abs(x) < 1e15)) { this.invalid++; return; }
    this.base(KIND.CONIC, full ? FLAG.FULL | FLAG.CLOSED : 0, a);
    this.start.push(this.conics.length / 8);
    this.count.push(1);
    this.conics.push(...v);
  }
}

/** Exact bbox of conic arc P(t) = C + U cos t + V sin t, t in [t0, t1]. */
export function conicBBox(c, o, out) {
  const cx = c[o], cy = c[o + 1], ux = c[o + 2], uy = c[o + 3], vx = c[o + 4], vy = c[o + 5], t0 = c[o + 6], t1 = c[o + 7];
  const P = (t) => [cx + ux * Math.cos(t) + vx * Math.sin(t), cy + uy * Math.cos(t) + vy * Math.sin(t)];
  const add = (p) => { if (p[0] < out[0]) out[0] = p[0]; if (p[1] < out[1]) out[1] = p[1]; if (p[0] > out[2]) out[2] = p[0]; if (p[1] > out[3]) out[3] = p[1]; };
  add(P(t0)); add(P(t1));
  const inRange = (t) => {
    let d = (t - t0) % TAU; if (d < 0) d += TAU;
    return d <= t1 - t0 + 1e-12;
  };
  for (const base of [Math.atan2(vx, ux), Math.atan2(vy, uy)]) {
    for (const t of [base, base + Math.PI]) if (inRange(t)) add(P(t));
  }
  return out;
}

/**
 * Build the scene. opts: { onProgress(fraction), fileName }
 */
export function buildScene(model, opts = {}) {
  const B = new Builder();
  const stats = model.stats;
  const notShown = { ...stats.notShown };
  const warnings = [...stats.warnings];
  const addNS = (k, n = 1) => { notShown[k] = (notShown[k] || 0) + n; };

  // ---- layers
  const layers = model.layers.map((l) => ({ name: l.name, color: l.color, visible: l.visible !== false, frozen: !!l.frozen, ltype: l.ltype || 'CONTINUOUS', count: 0 }));
  const layerIdx = new Map(layers.map((l, i) => [l.name.toUpperCase(), i]));
  const getLayer = (name) => {
    const key = String(name).toUpperCase();
    let i = layerIdx.get(key);
    if (i === undefined) { i = layers.length; layers.push({ name: String(name), color: FG, visible: true, frozen: false, ltype: 'CONTINUOUS', count: 0 }); layerIdx.set(key, i); }
    return i;
  };
  getLayer('0');

  // ---- line types
  const ltypes = [{ name: 'CONTINUOUS', dash: null }];
  const ltIdx = new Map([['CONTINUOUS', 0]]);
  const getLtype = (name) => {
    name = String(name || 'CONTINUOUS').toUpperCase();
    if (ltIdx.has(name)) return ltIdx.get(name);
    const def = model.ltypes[name];
    const dash = def ? (def.px || dashFromPattern(def.pattern)) : null;
    let i = 0;
    if (dash) { i = ltypes.length; ltypes.push({ name, dash }); }
    ltIdx.set(name, i);
    return i;
  };

  // ---- name tables for hover info
  const srcNames = [''], srcIdx = new Map();
  const srcOf = (s) => { s = s || '?'; let i = srcIdx.get(s); if (i === undefined) { i = srcNames.length; srcNames.push(s); srcIdx.set(s, i); } return i; };
  const blockNames = [''], blkIdx = new Map();
  const blkOf = (s) => { let i = blkIdx.get(s); if (i === undefined) { i = blockNames.length; blockNames.push(s); blkIdx.set(s, i); } return i; };

  const blocks = model.blocks;
  const total = model.entities.length || 1;
  let done = 0, nextReport = 0;

  // ctx: { M (affine|null), layer (idx, for entities on layer 0 inside blocks), color (BYBLOCK colour), ltype (BYBLOCK), blk, depth, stack }
  const topCtx = { M: null, layer: -1, color: FG, ltype: 0, blk: 0, depth: 0, stack: [] };

  function attrsFor(e, ctx) {
    let li;
    const lname = e.layer == null ? '0' : e.layer;
    if (ctx.layer >= 0 && String(lname) === '0') li = ctx.layer; else li = getLayer(lname);
    const L = layers[li];
    let color;
    if (e.rgb != null) color = e.rgb;
    else {
      const c = e.color == null ? (ctx.depth ? 0 : 256) : e.color;
      if (c === 256) color = L.color;
      else if (c === 0) color = ctx.color;
      else color = aciRgb(c);
    }
    let style;
    const lt = e.ltype || (ctx.depth ? 'BYBLOCK' : 'BYLAYER');
    if (lt === 'BYLAYER') style = getLtype(L.ltype);
    else if (lt === 'BYBLOCK') style = ctx.ltype;
    else style = getLtype(lt);
    return { layer: li, color, style, weight: e.weight | 0, src: srcOf(e.src || e.type), blk: ctx.blk };
  }

  const xform = (M, pts) => {
    if (!M) return pts;
    const out = new Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      out[i] = M[0] * x + M[2] * y + M[4];
      out[i + 1] = M[1] * x + M[3] * y + M[5];
    }
    return out;
  };
  const compose = (M, xf) => (xf ? (M ? mul(M, xf) : xf) : M);

  function emitConic(M, cx, cy, ux, uy, vx, vy, t0, t1, full, a) {
    if (M) {
      const c = apply(M, cx, cy), u = applyVec(M, ux, uy), v = applyVec(M, vx, vy);
      cx = c[0]; cy = c[1]; ux = u[0]; uy = u[1]; vx = v[0]; vy = v[1];
    }
    B.conic(cx, cy, ux, uy, vx, vy, t0, t1, full, a);
  }

  function emitPolyline(e, M, a) {
    const pts = e.pts, n = pts.length / 2;
    if (n < 1) return;
    if (!e.bulges) {
      let p = pts;
      if (e.closed && n > 2 && p[0] === p[2 * n - 2] && p[1] === p[2 * n - 1]) p = p.slice(0, -2);
      B.poly(xform(M, p), e.closed && n > 2 ? FLAG.CLOSED : 0, a);
      return;
    }
    // split into straight runs (POLY) and exact arcs (CONIC)
    const segs = e.closed ? n : n - 1;
    let run = [pts[0], pts[1]];
    const flush = () => { if (run.length >= 4) B.poly(xform(M, run), 0, a); };
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const x1 = pts[2 * i], y1 = pts[2 * i + 1], x2 = pts[2 * j], y2 = pts[2 * j + 1];
      const arc = bulgeToArc(x1, y1, x2, y2, e.bulges[i]);
      if (!arc) { run.push(x2, y2); continue; }
      flush();
      run = [x2, y2];
      let t0 = arc.a0, t1 = arc.a0 + arc.sweep;
      if (t1 < t0) { const t = t0; t0 = t1; t1 = t; }
      emitConic(M, arc.cx, arc.cy, arc.r, 0, 0, arc.r, t0, t1, false, a);
    }
    flush();
  }

  function emitText(e, M, a) {
    const lines = e.type === 'mtext' ? layoutMtext(e) : [{ s: e.text, dy: 0 }];
    let rot = e.rot || 0;
    let p = e.p;
    const h = e.h > 0 ? e.h : 1;
    const wf = e.wf > 0 ? e.wf : 1;
    let align = 0, fitW = 0, vshift = 0;
    if (e.type === 'text') {
      const ha = e.halign | 0, va = e.valign | 0;
      if ((ha === 3 || ha === 5) && e.p2) {
        const dx = e.p2[0] - e.p[0], dy = e.p2[1] - e.p[1];
        const L = Math.hypot(dx, dy);
        if (L > 0) { rot = Math.atan2(dy, dx); fitW = L; p = [(e.p[0] + e.p2[0]) / 2, (e.p[1] + e.p2[1]) / 2]; align = 1; }
      } else if (ha === 1 || ha === 4) align = 1;
      else if (ha === 2) align = 2;
      if (ha === 4) vshift = -0.5;
      else if (va === 1) vshift = 0.3;
      else if (va === 2) vshift = -0.5;
      else if (va === 3) vshift = -1;
    } else {
      align = (e.attach - 1) % 3;
    }
    const c = Math.cos(rot), s = Math.sin(rot);
    const tanO = Math.tan(e.oblique || 0);
    let Xx = c * h * wf, Xy = s * h * wf;
    let Yx = -s * h + c * h * tanO, Yy = c * h + s * h * tanO;
    if (e.mirrorX) { Xx = -Xx; Xy = -Xy; }
    if (e.mirrorY) { Yx = -Yx; Yy = -Yy; }
    for (const ln of lines) {
      if (!ln.s || !ln.s.trim()) continue;
      // anchor in drawing units: p + dy (in heights) along the text's up vector, then the vshift
      const vy = ln.dy + vshift;
      const ax = p[0] + (-s * h) * vy;
      const ay = p[1] + (c * h) * vy;
      let x = ax, y = ay, X = [Xx, Xy], Y = [Yx, Yy];
      if (M) {
        [x, y] = apply(M, ax, ay);
        X = applyVec(M, Xx, Xy);
        Y = applyVec(M, Yx, Yy);
      }
      if (![x, y, ...X, ...Y].every(Number.isFinite)) { B.invalid++; continue; }
      const fit = fitW ? fitW / (h * wf) : 0; // in glyph units along the baseline
      const W = fit || CHAR_W * ln.s.length;
      const u0 = align === 0 ? 0 : align === 1 ? -W / 2 : -W, u1 = u0 + W;
      const bb = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [u, v] of [[u0, -0.3], [u1, -0.3], [u0, 1.1], [u1, 1.1]]) {
        const px = x + u * X[0] + v * Y[0], py = y + u * X[1] + v * Y[1];
        if (px < bb[0]) bb[0] = px; if (py < bb[1]) bb[1] = py; if (px > bb[2]) bb[2] = px; if (py > bb[3]) bb[3] = py;
      }
      B.texts.push({ s: ln.s, x, y, m: [X[0], X[1], Y[0], Y[1]], align, fit, layer: a.layer, color: a.color, blk: a.blk, bbox: bb });
    }
  }

  function walk(ents, ctx) {
    for (const e of ents) {
      if (!ctx.depth && opts.onProgress) {
        done++;
        if (done >= nextReport) { nextReport = done + total / 40; opts.onProgress(done / total); }
      }
      if (!e || e.invisible) continue;
      try {
        walkOne(e, ctx);
      } catch (err) {
        addNS((e.src || e.type) + ' (error)');
      }
    }
  }

  function walkOne(e, ctx) {
    const a = attrsFor(e, ctx);
    const M = compose(ctx.M, e.xf);
    switch (e.type) {
      case 'line':
        B.poly(xform(M, [e.a[0], e.a[1], e.b[0], e.b[1]]), 0, a);
        break;
      case 'polyline':
        emitPolyline(e, M, a);
        break;
      case 'spline':
        B.poly(xform(M, e.pts), FLAG.CURVEPTS | (e.closed ? FLAG.CLOSED : 0), a);
        break;
      case 'circle':
        if (e.r > 0) emitConic(M, e.c[0], e.c[1], e.r, 0, 0, e.r, 0, TAU, true, a);
        else { const p = M ? apply(M, e.c[0], e.c[1]) : e.c; B.point(p[0], p[1], a); }
        break;
      case 'arc': {
        let t0 = e.a0, t1 = e.a1;
        while (t1 <= t0) t1 += TAU;
        if (t1 - t0 > TAU) t1 -= TAU;
        if (e.r > 0) emitConic(M, e.c[0], e.c[1], e.r, 0, 0, e.r, t0, t1, false, a);
        break;
      }
      case 'ellipse': {
        let t0 = e.t0, t1 = e.t1;
        const full = Math.abs(t1 - t0) >= TAU - 1e-9 || (t0 === 0 && t1 === 0);
        if (full) { t0 = 0; t1 = TAU; } else while (t1 <= t0) t1 += TAU;
        emitConic(M, e.c[0], e.c[1], e.major[0], e.major[1], e.minor[0], e.minor[1], t0, t1, full, a);
        break;
      }
      case 'point': {
        const p = M ? apply(M, e.p[0], e.p[1]) : e.p;
        B.point(p[0], p[1], a);
        break;
      }
      case 'solid': {
        let p = e.pts;
        if (p.length === 8 && p[4] === p[6] && p[5] === p[7]) p = p.slice(0, 6);
        B.poly(xform(M, p), FLAG.FILL | FLAG.CLOSED, a);
        break;
      }
      case 'hatch': {
        const rings = e.loops.map((L) => {
          if (!L.bulges) return L.pts;
          const out = [];
          const n = L.pts.length / 2;
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const x1 = L.pts[2 * i], y1 = L.pts[2 * i + 1];
            out.push(x1, y1);
            const arc = bulgeToArc(x1, y1, L.pts[2 * j], L.pts[2 * j + 1], L.bulges[i]);
            if (arc) {
              const k = Math.max(4, Math.ceil(Math.abs(arc.sweep) / (Math.PI / 36)));
              for (let s = 1; s < k; s++) { const t = arc.a0 + (arc.sweep * s) / k; out.push(arc.cx + arc.r * Math.cos(t), arc.cy + arc.r * Math.sin(t)); }
            }
          }
          return out;
        }).filter((r) => r.length >= 6);
        // solid: filled; pattern: filled with a screen-space line pattern (v0.1 approximation)
        const all = [];
        rings.forEach((r, i) => { if (i) all.push(NaN, NaN); for (const v of xform(M, r)) all.push(v); });
        if (all.length >= 6) B.poly(all, (e.solid ? FLAG.FILL : FLAG.PATTERN) | FLAG.CLOSED | FLAG.EVENODD | FLAG.CURVEPTS, a);
        break;
      }
      case 'text':
      case 'mtext':
        emitText(e, M, a);
        break;
      case 'insert':
      case 'dimension': {
        const key = String(e.block || '').toUpperCase();
        const blk = key ? blocks[key] : null;
        const childCtxBase = {
          layer: a.layer,
          color: a.color,
          ltype: a.style,
          blk: ctx.blk || (e.type === 'insert' ? blkOf(e.block) : ctx.blk),
          depth: ctx.depth + 1,
          stack: ctx.stack,
        };
        if (e.type === 'dimension' && (!blk || !blk.entities.length)) {
          if (e.fallback && e.fallback.length) walk(e.fallback, { ...childCtxBase, M });
          else addNS('DIMENSION (no geometry)');
          break;
        }
        if (!blk) { addNS(`Missing block "${e.block}"`); break; }
        if (blk.xref) { addNS('External reference (xref)'); break; }
        if (ctx.depth >= MAX_DEPTH || ctx.stack.includes(key)) { addNS('Recursive block reference'); break; }
        const stack = [...ctx.stack, key];
        if (e.type === 'dimension') {
          walk(blk.entities, { ...childCtxBase, M, stack });
        } else {
          const cols = e.cols || 1, rows = e.rows || 1;
          const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
          for (let r = 0; r < rows; r++) {
            for (let k = 0; k < cols; k++) {
              const ox = k * (e.dc || 0), oy = r * (e.dr || 0);
              const px = e.p[0] + c * ox - s * oy, py = e.p[1] + s * ox + c * oy;
              const Mi = insertMatrix(px, py, e.sx ?? 1, e.sy ?? 1, e.rot || 0, blk.base[0], blk.base[1]);
              walk(blk.entities, { ...childCtxBase, M: M ? mul(M, Mi) : Mi, stack });
            }
          }
        }
        if (e.attribs && e.attribs.length) walk(e.attribs, { ...ctx, M: ctx.M });
        break;
      }
      default:
        addNS(e.type || 'unknown');
    }
  }

  walk(model.entities, topCtx);
  if (B.invalid) addNS('Items with invalid coordinates', B.invalid);
  if (model.format === 'DGN') {
    // DGN levels have no colour of their own: show the most common element colour as the swatch
    const tally = layers.map(() => new Map());
    const bump = (li, c) => tally[li].set(c, (tally[li].get(c) || 0) + 1);
    B.layer.forEach((li, i) => bump(li, B.color[i]));
    B.texts.forEach((t) => bump(t.layer, t.color));
    tally.forEach((m, li) => { let best = -1, bc = layers[li].color; for (const [c, n] of m) if (n > best) { best = n; bc = c; } layers[li].color = bc; });
  }

  return finalize(B, {
    format: model.format,
    version: model.version,
    units: model.units,
    layers,
    ltypes,
    srcNames,
    blockNames,
    notShown,
    warnings,
    byType: stats.byType,
    entityCount: stats.entities,
    header: model.header,
    fileName: opts.fileName || '',
  });
}

function layoutMtext(e) {
  const out = [];
  const paras = String(e.text).split('\n');
  const maxChars = e.width > 0 ? Math.max(1, Math.floor(e.width / (e.h * (e.wf || 1) * CHAR_W))) : Infinity;
  const lines = [];
  for (const para of paras) {
    if (para.length <= maxChars) { lines.push(para); continue; }
    let cur = '';
    for (const word of para.split(/(\s+)/)) {
      if ((cur + word).length > maxChars && cur.trim()) { lines.push(cur.trimEnd()); cur = word.trimStart(); }
      else cur += word;
    }
    if (cur) lines.push(cur);
  }
  const ls = (5 / 3) * (e.spacing || 1);
  const n = lines.length;
  const row = Math.floor(((e.attach || 1) - 1) / 3);
  const H = 1 + (n - 1) * ls;
  const top = row === 0 ? -1 : row === 1 ? H / 2 - 1 : H - 1;
  lines.forEach((s, i) => out.push({ s, dy: top - i * ls }));
  return out;
}

/** Local origin, typed arrays, per-primitive bboxes and the grid index. */
function finalize(B, meta) {
  const n = B.kind.length;
  const coords = new Float64Array(B.coords);
  const conics = new Float64Array(B.conics);
  const kind = Uint8Array.from(B.kind), flags = Uint8Array.from(B.flags);
  const layer = Uint16Array.from(B.layer), color = Uint32Array.from(B.color);
  const style = Uint8Array.from(B.style.map((s) => Math.min(255, s))), weight = Uint8Array.from(B.weight);
  const src = Uint16Array.from(B.src), blk = Uint16Array.from(B.blk);
  const start = Uint32Array.from(B.start), count = Uint32Array.from(B.count);
  const bbox = new Float64Array(n * 4);
  const ext = [Infinity, Infinity, -Infinity, -Infinity];
  const tmp = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    tmp[0] = tmp[1] = Infinity; tmp[2] = tmp[3] = -Infinity;
    if (kind[i] === KIND.CONIC) conicBBox(conics, start[i] * 8, tmp);
    else {
      const s = start[i] * 2, e = s + count[i] * 2;
      for (let k = s; k < e; k += 2) {
        const x = coords[k], y = coords[k + 1];
        if (x !== x) continue; // NaN ring separator
        if (x < tmp[0]) tmp[0] = x; if (y < tmp[1]) tmp[1] = y; if (x > tmp[2]) tmp[2] = x; if (y > tmp[3]) tmp[3] = y;
      }
    }
    bbox.set(tmp, i * 4);
    if (tmp[0] < ext[0]) ext[0] = tmp[0]; if (tmp[1] < ext[1]) ext[1] = tmp[1];
    if (tmp[2] > ext[2]) ext[2] = tmp[2]; if (tmp[3] > ext[3]) ext[3] = tmp[3];
  }
  const texts = B.texts;
  for (const t of texts) {
    const b = t.bbox;
    if (b[0] < ext[0]) ext[0] = b[0]; if (b[1] < ext[1]) ext[1] = b[1];
    if (b[2] > ext[2]) ext[2] = b[2]; if (b[3] > ext[3]) ext[3] = b[3];
  }
  const empty = !(ext[0] <= ext[2]);
  if (empty) { ext[0] = ext[1] = 0; ext[2] = ext[3] = 1; }
  // local origin = centre of the extents: keeps float32 GPU paths precise far from 0,0
  const ox = (ext[0] + ext[2]) / 2, oy = (ext[1] + ext[3]) / 2;
  for (let k = 0; k < coords.length; k += 2) { coords[k] -= ox; coords[k + 1] -= oy; }
  for (let k = 0; k < conics.length; k += 8) { conics[k] -= ox; conics[k + 1] -= oy; }
  for (let k = 0; k < bbox.length; k += 4) { bbox[k] -= ox; bbox[k + 1] -= oy; bbox[k + 2] -= ox; bbox[k + 3] -= oy; }
  for (const t of texts) { t.x -= ox; t.y -= oy; t.bbox[0] -= ox; t.bbox[1] -= oy; t.bbox[2] -= ox; t.bbox[3] -= oy; }
  const extents = [ext[0] - ox, ext[1] - oy, ext[2] - ox, ext[3] - oy];

  // layer item counts
  for (let i = 0; i < n; i++) meta.layers[layer[i]].count++;
  for (const t of texts) meta.layers[t.layer].count++;

  const fitBox = robustFit(bbox, n, texts, extents);
  const grid = buildGrid(bbox, n, texts, extents);
  return {
    ...meta,
    empty,
    origin: [ox, oy],
    extents,
    fitBox,
    n, kind, flags, layer, color, style, weight, src, blk, start, count, coords, conics, bbox,
    texts,
    grid,
    primCount: n,
    textCount: texts.length,
  };
}

/** If a few stray items sit very far from everything else, fit to the main cluster instead. */
function robustFit(bbox, n, texts, extents) {
  const m = n + texts.length;
  if (m < 50) return extents.slice();
  const xs = new Float64Array(m), ys = new Float64Array(m);
  for (let i = 0; i < n; i++) { xs[i] = (bbox[4 * i] + bbox[4 * i + 2]) / 2; ys[i] = (bbox[4 * i + 1] + bbox[4 * i + 3]) / 2; }
  texts.forEach((t, j) => { xs[n + j] = t.x; ys[n + j] = t.y; });
  xs.sort(); ys.sort();
  const q = (a, f) => a[Math.min(a.length - 1, Math.max(0, Math.floor(f * (a.length - 1))))];
  const core = [q(xs, 0.002), q(ys, 0.002), q(xs, 0.998), q(ys, 0.998)];
  const dFull = Math.hypot(extents[2] - extents[0], extents[3] - extents[1]);
  const dCore = Math.hypot(core[2] - core[0], core[3] - core[1]);
  if (dCore > 0 && dFull > 50 * dCore) {
    const px = (core[2] - core[0]) * 0.08 || 1, py = (core[3] - core[1]) * 0.08 || 1;
    const fb = [core[0] - px, core[1] - py, core[2] + px, core[3] + py];
    fb.outliers = true;
    return fb;
  }
  return extents.slice();
}

function buildGrid(bbox, n, texts, ext) {
  const m = n + texts.length;
  const w = Math.max(ext[2] - ext[0], 1e-9), h = Math.max(ext[3] - ext[1], 1e-9);
  const target = Math.max(1, Math.min(16384, Math.ceil(m / 48)));
  let nx = Math.max(1, Math.round(Math.sqrt((target * w) / h)));
  nx = Math.min(256, nx);
  let ny = Math.max(1, Math.min(256, Math.ceil(target / nx)));
  const cw = w / nx, ch = h / ny;
  const cells = nx * ny;
  const BIG = cells; // extra bucket for very large items
  const cellOf = new Int32Array(m);
  const counts = new Uint32Array(cells + 2);
  const place = (x0, y0, x1, y1) => {
    if (x1 - x0 > 3 * cw || y1 - y0 > 3 * ch) return BIG;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const ix = Math.min(nx - 1, Math.max(0, Math.floor((cx - ext[0]) / cw)));
    const iy = Math.min(ny - 1, Math.max(0, Math.floor((cy - ext[1]) / ch)));
    return iy * nx + ix;
  };
  for (let i = 0; i < n; i++) { const c = place(bbox[4 * i], bbox[4 * i + 1], bbox[4 * i + 2], bbox[4 * i + 3]); cellOf[i] = c; counts[c + 1]++; }
  for (let j = 0; j < texts.length; j++) { const b = texts[j].bbox; const c = place(b[0], b[1], b[2], b[3]); cellOf[n + j] = c; counts[c + 1]++; }
  for (let c = 1; c <= cells + 1; c++) counts[c] += counts[c - 1];
  const cellStart = counts.slice(0, cells + 2); // CSR offsets, length cells+2 (BIG bucket included)
  const fill = cellStart.slice();
  const items = new Uint32Array(m); // item id: < n primitive, >= n text (id - n)
  const loose = new Float64Array((cells + 1) * 4);
  for (let c = 0; c <= cells; c++) { loose[4 * c] = loose[4 * c + 1] = Infinity; loose[4 * c + 2] = loose[4 * c + 3] = -Infinity; }
  const grow = (c, x0, y0, x1, y1) => {
    const o = 4 * c;
    if (x0 < loose[o]) loose[o] = x0; if (y0 < loose[o + 1]) loose[o + 1] = y0;
    if (x1 > loose[o + 2]) loose[o + 2] = x1; if (y1 > loose[o + 3]) loose[o + 3] = y1;
  };
  for (let i = 0; i < m; i++) {
    const c = cellOf[i];
    items[fill[c]++] = i;
    if (i < n) grow(c, bbox[4 * i], bbox[4 * i + 1], bbox[4 * i + 2], bbox[4 * i + 3]);
    else { const b = texts[i - n].bbox; grow(c, b[0], b[1], b[2], b[3]); }
  }
  return { nx, ny, x0: ext[0], y0: ext[1], cw, ch, cellStart, items, loose };
}

/** Visit grid items whose bbox intersects [x0,y0,x1,y1] (scene-local). cb(id) where id >= scene.n is a text. */
export function queryRect(scene, x0, y0, x1, y1, cb) {
  const g = scene.grid;
  const { nx, ny, cw, ch } = g;
  const ix0 = Math.max(0, Math.floor((x0 - g.x0) / cw - 2)), ix1 = Math.min(nx - 1, Math.floor((x1 - g.x0) / cw + 2));
  const iy0 = Math.max(0, Math.floor((y0 - g.y0) / ch - 2)), iy1 = Math.min(ny - 1, Math.floor((y1 - g.y0) / ch + 2));
  const visit = (c) => {
    const L = g.loose;
    if (L[4 * c] > x1 || L[4 * c + 2] < x0 || L[4 * c + 1] > y1 || L[4 * c + 3] < y0) return;
    for (let k = g.cellStart[c]; k < g.cellStart[c + 1]; k++) {
      const id = g.items[k];
      let b0, b1, b2, b3;
      if (id < scene.n) { const o = 4 * id; b0 = scene.bbox[o]; b1 = scene.bbox[o + 1]; b2 = scene.bbox[o + 2]; b3 = scene.bbox[o + 3]; }
      else { const b = scene.texts[id - scene.n].bbox; b0 = b[0]; b1 = b[1]; b2 = b[2]; b3 = b[3]; }
      if (b0 > x1 || b2 < x0 || b1 > y1 || b3 < y0) continue;
      if (cb(id) === false) return false;
    }
  };
  for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) if (visit(iy * nx + ix) === false) return;
  visit(nx * ny);
}

/**
 * Pack scene.texts (thousands of small objects, slow to structured-clone) into typed arrays + one
 * string for the trip from the worker. unpackTexts() restores the objects on the main thread.
 */
export function packTexts(scene) {
  const T = scene.texts, n = T.length;
  const f = new Float64Array(n * 11), u = new Uint32Array(n * 4);
  const strs = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = T[i];
    f.set([t.x, t.y, t.m[0], t.m[1], t.m[2], t.m[3], t.fit || 0, t.bbox[0], t.bbox[1], t.bbox[2], t.bbox[3]], i * 11);
    u[i * 4] = t.layer; u[i * 4 + 1] = t.color; u[i * 4 + 2] = t.blk; u[i * 4 + 3] = t.align;
    strs[i] = t.s;
  }
  scene.textPack = { n, f, u, s: strs.join(' ') };
  delete scene.texts;
  return scene;
}
export function unpackTexts(scene) {
  if (!scene.textPack) return scene;
  const { n, f, u } = scene.textPack;
  const strs = n ? scene.textPack.s.split(' ') : [];
  const texts = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 11, q = i * 4;
    texts[i] = {
      s: strs[i], x: f[o], y: f[o + 1], m: [f[o + 2], f[o + 3], f[o + 4], f[o + 5]], fit: f[o + 6],
      bbox: [f[o + 7], f[o + 8], f[o + 9], f[o + 10]], layer: u[q], color: u[q + 1], blk: u[q + 2], align: u[q + 3],
    };
  }
  scene.texts = texts;
  delete scene.textPack;
  return scene;
}

/** Typed-array buffers to transfer from a worker. */
export function sceneTransferables(scene) {
  const g = scene.grid;
  const list = [scene.kind, scene.flags, scene.layer, scene.color, scene.style, scene.weight, scene.src, scene.blk, scene.start,
    scene.count, scene.coords, scene.conics, scene.bbox, g.cellStart, g.items, g.loose];
  if (scene.textPack) list.push(scene.textPack.f, scene.textPack.u);
  return list.map((a) => a.buffer);
}

/** Point on a scene conic at parameter t. */
export function conicPoint(scene, i, t) {
  const c = scene.conics, o = scene.start[i] * 8;
  return [c[o] + c[o + 2] * Math.cos(t) + c[o + 4] * Math.sin(t), c[o + 1] + c[o + 3] * Math.cos(t) + c[o + 5] * Math.sin(t)];
}

/** Polyline approximation of any primitive (scene-local coords). */
export function primPoints(scene, i, segs = 96) {
  if (scene.kind[i] === KIND.CONIC) {
    const c = scene.conics, o = scene.start[i] * 8;
    const t0 = c[o + 6], t1 = c[o + 7];
    const n = Math.max(8, Math.ceil((segs * (t1 - t0)) / TAU));
    const out = [];
    for (let k = 0; k <= n; k++) { const p = conicPoint(scene, i, t0 + ((t1 - t0) * k) / n); out.push(p[0], p[1]); }
    return out;
  }
  const s = scene.start[i] * 2;
  return Array.from(scene.coords.subarray(s, s + scene.count[i] * 2));
}
