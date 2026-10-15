// Model -> render scene. Expands block references (nested, mirrored, arrayed), resolves layers,
// colours and line types, converts curves to exact conic primitives, lays out text, moves
// everything to a local origin (precision far from 0,0) and builds a uniform-grid spatial index.
// Output is plain objects + typed arrays so it can be transferred from the parse worker.
//
// Every primitive and text remembers the top-level model entity it came from (`ent`), and the
// items of entity i are contiguous at build time (entPrim / entText offsets), so an edit can
// replace one entity's items without rebuilding anything else (see edit/live-scene.js).

import { FG } from './model.js';
import { ACI } from './palettes.js';
import { bulgeToArc, insertMatrix, mul, apply, applyVec, TAU } from './geom.js';

export const KIND = { POLY: 1, CONIC: 2, POINT: 3 };
export const FLAG = { CLOSED: 1, FILL: 2, CURVEPTS: 4, EVENODD: 8, FULL: 16, PATTERN: 32 };
/** Spatial-index ids: primitives are 0..n-1, texts are TEXT_ID + text index. */
export const TEXT_ID = 0x80000000;

const MAX_DEPTH = 24;
/**
 * Most items one build may walk inside blocks. A tiny hostile file (a 10000 x 10000 array insert,
 * blocks nested many levels deep) would otherwise expand forever: past this, block copies are skipped and
 * reported as not shown.
 */
export const MAX_EXPANDED = 1000000;
export const NS_COPIES = 'Block copies (too many to draw)';
export const CHAR_W = 0.62; // average glyph advance in cap-height units (layout estimate)

function aciRgb(aci) {
  if (aci === 7 || aci <= 0 || aci > 255) return FG;
  return ACI[aci];
}

/** Closed outline of a polyline with bulges as points (arcs at 5 degree steps), e.g. for a fill. */
export function bulgeRing(pts, bulges) {
  if (!bulges) return pts;
  const out = [], n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, x1 = pts[2 * i], y1 = pts[2 * i + 1];
    out.push(x1, y1);
    const arc = bulgeToArc(x1, y1, pts[2 * j], pts[2 * j + 1], bulges[i]);
    if (arc) {
      const k = Math.max(4, Math.ceil(Math.abs(arc.sweep) / (Math.PI / 36)));
      for (let s = 1; s < k; s++) { const t = arc.a0 + (arc.sweep * s) / k; out.push(arc.cx + arc.r * Math.cos(t), arc.cy + arc.r * Math.sin(t)); }
    }
  }
  return out;
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

/** DXF lineweights (1/100 mm). A DXF item's scene weight is 1 + its index here (nearest; 0 = default). */
export const DXF_LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
/** DGN weight n (1..31) <-> DXF lineweight: DGN_LW[n - 1] (10 and above: the last entry); weight 0 = default. */
export const DGN_LW = [13, 18, 25, 35, 50, 70, 100, 140, 200, 211];
export const weightToLw = (w) => (w > 0 ? DGN_LW[Math.min(DGN_LW.length, w) - 1] : -1);
const nearest = (list, v) => { let k = 0; for (let j = 1; j < list.length; j++) if (Math.abs(list[j] - v) < Math.abs(list[k] - v)) k = j; return k; };
/** DXF lineweight -> nearest DGN weight (below 0.10 mm and default -> 0). */
export const lwToWeight = (lw) => (lw >= 10 ? 1 + nearest(DGN_LW, lw) : 0);
const lwClass = (lw) => (lw >= 0 ? 1 + nearest(DXF_LW, lw) : 0);
/** Screen width (px) of a scene weight: DGN 1 + 0.75 per step (max 7); DXF 0.25 mm = 1 px (max 8). */
export const weightPx = (w, format) => (!w ? 1 : format === 'DGN' ? 1 + Math.min(6, w * 0.75) : Math.max(1, Math.min(8, DXF_LW[w - 1] / 25)));

export class Builder {
  constructor() {
    this.kind = []; this.flags = []; this.layer = []; this.color = []; this.style = []; this.weight = [];
    this.src = []; this.blk = []; this.start = []; this.count = []; this.ent = [];
    this.coords = []; this.conics = [];
    this.texts = [];
    this.invalid = 0;
    this.curEnt = 0;
    this.curSub = ''; // path of the component being emitted inside a cell or insert ('c3.c1', 'a2'; '#…' = shared block content)
    this.clip = null; // (src/layout.js)
  }
  base(k, flags, a) {
    this.kind.push(k); this.flags.push(flags); this.layer.push(a.layer); this.color.push(a.color);
    this.style.push(a.style); this.weight.push(a.weight); this.src.push(a.src); this.blk.push(a.blk); this.ent.push(this.curEnt);
  }
  poly(pts, flags, a) {
    if (this.clip && this.clipper.poly(this, pts, flags, a)) return;
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
    if (this.clip && this.clipper.point(this, x, y)) return;
    this.base(KIND.POINT, 0, a);
    this.start.push(this.coords.length / 2);
    this.count.push(1);
    this.coords.push(x, y);
  }
  conic(cx, cy, ux, uy, vx, vy, t0, t1, full, a, extra = 0) {
    const v = [cx, cy, ux, uy, vx, vy, t0, t1];
    for (const x of v) if (!(Math.abs(x) < 1e15)) { this.invalid++; return; }
    if (this.clip && this.clipper.conic(this, v, full, a, extra)) return;
    this.base(KIND.CONIC, (full ? FLAG.FULL | FLAG.CLOSED : 0) | extra, a);
    this.start.push(this.conics.length / 8);
    this.count.push(1);
    this.conics.push(cx, cy, ux, uy, vx, vy, t0, t1);
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
 * Lookup tables shared by a full build and by incremental edits: layers, line types and the
 * name tables used for hover info. From a model (full build) or re-derived from a scene.
 */
export function sceneTables(model, scene = null) {
  const layers = scene ? scene.layers
    : model.layers.map((l) => ({ name: l.name, color: l.color, visible: l.visible !== false, frozen: !!l.frozen, ltype: l.ltype || 'CONTINUOUS', lw: l.lw, count: 0 }));
  const ltypes = scene ? scene.ltypes : [{ name: 'CONTINUOUS', dash: null }];
  const srcNames = scene ? scene.srcNames : [''];
  const blockNames = scene ? scene.blockNames : [''];
  const t = {
    layers, ltypes, srcNames, blockNames,
    layerIdx: new Map(layers.map((l, i) => [l.name.toUpperCase(), i])),
    ltIdx: new Map(ltypes.map((l, i) => [l.name, i])),
    srcIdx: new Map(srcNames.map((s, i) => [s, i])),
    blkIdx: new Map(blockNames.map((s, i) => [s, i])),
    notShown: scene ? {} : { ...model.stats.notShown },
  };
  t.srcIdx.delete('');
  t.blkIdx.delete('');
  return t;
}

/**
 * Emitter: turns model entities into scene primitives/texts (absolute drawing coordinates) in
 * `emitter.B`. emit(entity, entityIndex) handles one top-level entity (blocks expanded).
 */
export function createEmitter(model, tables, { maxExpanded = MAX_EXPANDED, layout = null } = {}) {
  const B = new Builder();
  if (layout) B.clipper = layout.clipper;
  let expanded = 0; // items walked inside blocks (the expansion budget)
  const { layers, ltypes, srcNames, blockNames, layerIdx, ltIdx, srcIdx, blkIdx, notShown } = tables;
  const addNS = (k, n = 1) => { notShown[k] = (notShown[k] || 0) + n; };
  const getLayer = (name) => {
    const key = String(name).toUpperCase();
    let i = layerIdx.get(key);
    if (i === undefined) { i = layers.length; layers.push({ name: String(name), color: FG, visible: true, frozen: false, ltype: 'CONTINUOUS', count: 0 }); layerIdx.set(key, i); }
    return i;
  };
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
  const srcOf = (s) => { s = s || '?'; let i = srcIdx.get(s); if (i === undefined) { i = srcNames.length; srcNames.push(s); srcIdx.set(s, i); } return i; };
  const blkOf = (s) => { let i = blkIdx.get(s); if (i === undefined) { i = blockNames.length; blockNames.push(s); blkIdx.set(s, i); } return i; };
  const blocks = model.blocks;
  const dxfLw = model.format !== 'DGN'; // DXF lineweights (lw, 1/100 mm; -1 ByLayer, -2 ByBlock, -3 default) vs DGN weights 0..31

  // ctx: { M (affine|null), layer (idx, for entities on layer 0 inside blocks), color (BYBLOCK colour), ltype (BYBLOCK), lw (BYBLOCK), blk, depth, stack }
  const topCtx = { M: null, layer: -1, color: FG, ltype: 0, lw: -3, blk: 0, depth: 0, stack: [] };
  const lapi = layout && { B, model, top: topCtx, walk, over: () => expanded >= maxExpanded, ns: addNS };

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
    let lw = e.lw ?? -1;
    if (lw === -1) lw = L.lw ?? -3; else if (lw === -2) lw = ctx.lw;
    return { layer: li, color, style, weight: dxfLw ? lwClass(lw) : e.weight | 0, lw, src: srcOf(e.src || e.type), blk: ctx.blk };
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

  function emitConic(M, cx, cy, ux, uy, vx, vy, t0, t1, full, a, extra = 0) {
    if (M) {
      const c = apply(M, cx, cy), u = applyVec(M, ux, uy), v = applyVec(M, vx, vy);
      cx = c[0]; cy = c[1]; ux = u[0]; uy = u[1]; vx = v[0]; vy = v[1];
    }
    B.conic(cx, cy, ux, uy, vx, vy, t0, t1, full, a, extra);
  }
  /** DGN fill (shape, complex shape, ellipse with a fill linkage): a filled item in the fill colour, under the outline. */
  const fillAttrs = (e, a) => ({ ...a, color: e.fill });

  function emitPolyline(e, M, a) {
    const pts = e.pts, n = pts.length / 2;
    if (n < 1) return;
    if (e.fill != null && e.closed && n > 2) B.poly(xform(M, bulgeRing(pts, e.bulges)), FLAG.FILL | FLAG.CLOSED, fillAttrs(e, a));
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
      B.texts.push({ s: ln.s, x, y, m: [X[0], X[1], Y[0], Y[1]], align, fit, layer: a.layer, color: a.color, blk: a.blk, bbox: bb, ent: B.curEnt, sub: B.curSub });
    }
  }

  function walk(ents, ctx) {
    for (const e of ents) {
      if (!e || e.invisible) continue;
      try {
        walkOne(e, ctx);
      } catch (err) {
        addNS((e.src || e.type) + ' (error)');
      }
    }
  }

  /** walk() for the components of a cell ('c') or the attributes of an insert ('a'), recording each one's path. */
  function walkParts(ents, kind, ctx) {
    const up = B.curSub;
    ents.forEach((e, k) => {
      B.curSub = up && up[0] === '#' ? up : (up ? up + '.' : '') + kind + k;
      walk([e], ctx);
    });
    B.curSub = up;
  }
  /** walk() for block-definition content: shared by every insert of the block, so not addressable. */
  function walkShared(ents, ctx) {
    const up = B.curSub;
    B.curSub = '#' + up;
    walk(ents, ctx);
    B.curSub = up;
  }

  function walkOne(e, ctx) {
    if (ctx.depth) expanded++;
    const a = attrsFor(e, ctx);
    // e.mv: a move/rotate applied by an edit to a dimension (its geometry lives in a block)
    const M = compose(e.mv && e.type === 'dimension' ? compose(ctx.M, e.mv) : ctx.M, e.xf);
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
        if (e.r > 0 && e.fill != null) emitConic(M, e.c[0], e.c[1], e.r, 0, 0, e.r, 0, TAU, true, fillAttrs(e, a), FLAG.FILL);
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
        if (full && e.fill != null) emitConic(M, e.c[0], e.c[1], e.major[0], e.major[1], e.minor[0], e.minor[1], t0, t1, full, fillAttrs(e, a), FLAG.FILL);
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
        const rings = e.loops.map((L) => bulgeRing(L.pts, L.bulges)).filter((r) => r.length >= 6);
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
      case 'viewport':
        if (layout) layout.emitViewport(e, M, a, ctx.depth, lapi);
        else addNS('VIEWPORT');
        break;
      case 'cell': // DGN cell: components are stored already placed; the cell is one selectable item
        walkParts(e.children || [], 'c', { ...ctx, blk: ctx.blk || blkOf(e.name || 'cell') });
        break;
      case 'insert':
      case 'dimension': {
        const key = String(e.block || '').toUpperCase();
        const blk = key ? blocks[key] : null;
        const childCtxBase = {
          layer: a.layer,
          color: a.color,
          ltype: a.style,
          lw: a.lw,
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
          if (expanded >= maxExpanded) addNS(NS_COPIES);
          else walkShared(blk.entities, { ...childCtxBase, M, stack });
        } else {
          const cols = e.cols || 1, rows = e.rows || 1;
          const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
          copies: for (let r = 0; r < rows; r++) {
            for (let k = 0; k < cols; k++) {
              if (expanded >= maxExpanded) { addNS(NS_COPIES, rows * cols - (r * cols + k)); break copies; }
              const ox = k * (e.dc || 0), oy = r * (e.dr || 0);
              const px = e.p[0] + c * ox - s * oy, py = e.p[1] + s * ox + c * oy;
              const Mi = insertMatrix(px, py, e.sx ?? 1, e.sy ?? 1, e.rot || 0, blk.base[0], blk.base[1]);
              walkShared(blk.entities, { ...childCtxBase, M: M ? mul(M, Mi) : Mi, stack });
            }
          }
        }
        if (e.attribs && e.attribs.length) walkParts(e.attribs, 'a', { ...ctx, M: ctx.M });
        break;
      }
      default:
        addNS(e.type || 'unknown');
    }
  }

  return {
    B,
    tables,
    /** Emit one top-level entity (index i) into B. */
    emit(e, i) {
      B.curEnt = i;
      B.curSub = '';
      if (!e || e.invisible) return;
      try {
        walkOne(e, topCtx);
      } catch (err) {
        addNS((e.src || e.type) + ' (error)');
      }
    },
  };
}

/**
 * Build the scene. opts: { onProgress(fraction), fileName, layout (src/layout.js) }
 */
export function buildScene(model, opts = {}) {
  const stats = model.stats;
  const tables = sceneTables(model);
  const { layers, ltypes, srcNames, blockNames, notShown } = tables;
  // layer "0" always exists
  if (!tables.layerIdx.has('0')) { tables.layerIdx.set('0', layers.length); layers.push({ name: '0', color: FG, visible: true, frozen: false, ltype: 'CONTINUOUS', count: 0 }); }
  const em = createEmitter(model, tables, { layout: opts.layout });
  const B = em.B;
  const warnings = [...stats.warnings];

  const ents = model.entities;
  const total = ents.length || 1;
  let nextReport = 0;
  for (let i = 0; i < ents.length; i++) {
    if (opts.onProgress && i + 1 >= nextReport) { nextReport = i + 1 + total / 40; opts.onProgress((i + 1) / total); }
    em.emit(ents[i], i);
  }
  if (B.invalid) notShown['Items with invalid coordinates'] = (notShown['Items with invalid coordinates'] || 0) + B.invalid;
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
    page: model.page || null, // PDF: { n, count, label, labels, box, raster }
    underlay: model.underlay || null, // PDF pictures: { image, dark, box, w, h }
  }, ents.length);
}

/** MTEXT lines: [{ s, dy }] with dy in text heights from the insertion point. */
export function layoutMtext(e) {
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

/** Builder arrays -> typed arrays + per-primitive bboxes (absolute coordinates). */
export function typedPrims(B) {
  const n = B.kind.length;
  const coords = new Float64Array(B.coords);
  const conics = new Float64Array(B.conics);
  const kind = Uint8Array.from(B.kind), flags = Uint8Array.from(B.flags);
  const layer = Uint16Array.from(B.layer), color = Uint32Array.from(B.color);
  const style = Uint8Array.from(B.style.map((s) => Math.min(255, s))), weight = Uint8Array.from(B.weight);
  const src = Uint16Array.from(B.src), blk = Uint16Array.from(B.blk), ent = Uint32Array.from(B.ent);
  const start = Uint32Array.from(B.start), count = Uint32Array.from(B.count);
  const bbox = new Float64Array(n * 4);
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
  }
  return { n, kind, flags, layer, color, style, weight, src, blk, ent, start, count, coords, conics, bbox };
}

/** Local origin, typed arrays, per-primitive bboxes and the grid index. */
function finalize(B, meta, entityTotal) {
  const P = typedPrims(B);
  const { n, layer, ent, coords, conics, bbox } = P;
  const ext = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const o = 4 * i;
    if (bbox[o] < ext[0]) ext[0] = bbox[o]; if (bbox[o + 1] < ext[1]) ext[1] = bbox[o + 1];
    if (bbox[o + 2] > ext[2]) ext[2] = bbox[o + 2]; if (bbox[o + 3] > ext[3]) ext[3] = bbox[o + 3];
  }
  const texts = B.texts;
  for (const t of texts) {
    const b = t.bbox;
    if (b[0] < ext[0]) ext[0] = b[0]; if (b[1] < ext[1]) ext[1] = b[1];
    if (b[2] > ext[2]) ext[2] = b[2]; if (b[3] > ext[3]) ext[3] = b[3];
  }
  if (meta.page && meta.page.box) { const b = meta.page.box; ext[0] = Math.min(ext[0], b[0]); ext[1] = Math.min(ext[1], b[1]); ext[2] = Math.max(ext[2], b[2]); ext[3] = Math.max(ext[3], b[3]); }
  const empty = !(ext[0] <= ext[2]);
  if (empty) { ext[0] = ext[1] = 0; ext[2] = ext[3] = 1; }
  // local origin = centre of the extents: keeps float32 GPU paths precise far from 0,0
  const ox = (ext[0] + ext[2]) / 2, oy = (ext[1] + ext[3]) / 2;
  for (let k = 0; k < coords.length; k += 2) { coords[k] -= ox; coords[k + 1] -= oy; }
  for (let k = 0; k < conics.length; k += 8) { conics[k] -= ox; conics[k + 1] -= oy; }
  for (let k = 0; k < bbox.length; k += 4) { bbox[k] -= ox; bbox[k + 1] -= oy; bbox[k + 2] -= ox; bbox[k + 3] -= oy; }
  for (const t of texts) { t.x -= ox; t.y -= oy; t.bbox[0] -= ox; t.bbox[1] -= oy; t.bbox[2] -= ox; t.bbox[3] -= oy; }
  const extents = [ext[0] - ox, ext[1] - oy, ext[2] - ox, ext[3] - oy];
  const local = (b) => [b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy];
  if (meta.page && meta.page.box) meta.page = { ...meta.page, box: local(meta.page.box) };
  if (meta.underlay) meta.underlay = { ...meta.underlay, box: local(meta.underlay.box) };

  // layer item counts
  for (let i = 0; i < n; i++) meta.layers[layer[i]].count++;
  for (const t of texts) meta.layers[t.layer].count++;

  // entity -> item ranges (items of one top-level entity are contiguous)
  const E = entityTotal;
  const entPrim = new Uint32Array(E + 1), entText = new Uint32Array(E + 1);
  for (let i = 0; i < n; i++) entPrim[ent[i] + 1]++;
  for (const t of texts) entText[t.ent + 1]++;
  for (let i = 1; i <= E; i++) { entPrim[i] += entPrim[i - 1]; entText[i] += entText[i - 1]; }

  const fitBox = robustFit(bbox, n, texts, extents);
  const grid = buildGrid(bbox, n, texts, extents);
  return {
    ...meta,
    empty,
    origin: [ox, oy],
    extents,
    fitBox,
    ...P,
    texts,
    grid,
    E,
    entPrim,
    entText,
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

/** Grid cell for a bbox (BIG bucket = nx*ny for very large items). */
export function gridCell(g, x0, y0, x1, y1) {
  if (x1 - x0 > 3 * g.cw || y1 - y0 > 3 * g.ch) return g.nx * g.ny;
  const ix = Math.min(g.nx - 1, Math.max(0, Math.floor(((x0 + x1) / 2 - g.x0) / g.cw)));
  const iy = Math.min(g.ny - 1, Math.max(0, Math.floor(((y0 + y1) / 2 - g.y0) / g.ch)));
  return iy * g.nx + ix;
}

function buildGrid(bbox, n, texts, ext) {
  const m = n + texts.length;
  const w = Math.max(ext[2] - ext[0], 1e-9), h = Math.max(ext[3] - ext[1], 1e-9);
  const target = Math.max(1, Math.min(16384, Math.ceil(m / 48)));
  let nx = Math.max(1, Math.round(Math.sqrt((target * w) / h)));
  nx = Math.min(256, nx);
  const ny = Math.max(1, Math.min(256, Math.ceil(target / nx)));
  const g = { nx, ny, x0: ext[0], y0: ext[1], cw: w / nx, ch: h / ny };
  const cells = nx * ny;
  const cellOf = new Int32Array(m);
  const counts = new Uint32Array(cells + 2);
  for (let i = 0; i < n; i++) { const c = gridCell(g, bbox[4 * i], bbox[4 * i + 1], bbox[4 * i + 2], bbox[4 * i + 3]); cellOf[i] = c; counts[c + 1]++; }
  for (let j = 0; j < texts.length; j++) { const b = texts[j].bbox; const c = gridCell(g, b[0], b[1], b[2], b[3]); cellOf[n + j] = c; counts[c + 1]++; }
  for (let c = 1; c <= cells + 1; c++) counts[c] += counts[c - 1];
  const cellStart = counts.slice(0, cells + 2); // CSR offsets, length cells+2 (BIG bucket included)
  const fill = cellStart.slice();
  const items = new Uint32Array(m); // item id: primitive index, or TEXT_ID + text index
  const loose = new Float64Array((cells + 1) * 4);
  for (let c = 0; c <= cells; c++) { loose[4 * c] = loose[4 * c + 1] = Infinity; loose[4 * c + 2] = loose[4 * c + 3] = -Infinity; }
  const grow = (c, x0, y0, x1, y1) => {
    const o = 4 * c;
    if (x0 < loose[o]) loose[o] = x0; if (y0 < loose[o + 1]) loose[o + 1] = y0;
    if (x1 > loose[o + 2]) loose[o + 2] = x1; if (y1 > loose[o + 3]) loose[o + 3] = y1;
  };
  for (let i = 0; i < m; i++) {
    const c = cellOf[i];
    if (i < n) { items[fill[c]++] = i; grow(c, bbox[4 * i], bbox[4 * i + 1], bbox[4 * i + 2], bbox[4 * i + 3]); }
    else { items[fill[c]++] = TEXT_ID + (i - n); const b = texts[i - n].bbox; grow(c, b[0], b[1], b[2], b[3]); }
  }
  return { ...g, cellStart, items, loose };
}

/**
 * Visit grid items whose bbox intersects [x0,y0,x1,y1] (scene-local). cb(id): id < TEXT_ID is a
 * primitive, otherwise text (id - TEXT_ID). Items removed by edits are skipped; items added by
 * edits live in grid.dyn (cell -> ids). Returning false from cb stops the walk.
 */
export function queryRect(scene, x0, y0, x1, y1, cb) {
  const g = scene.grid;
  const { nx, ny, cw, ch } = g;
  const dead = scene.dead, dyn = g.dyn;
  // clamp both ends: items outside the original extents (moved there by edits) live in the edge cells
  const cl = (v, n) => Math.max(0, Math.min(n - 1, v));
  const ix0 = cl(Math.floor((x0 - g.x0) / cw - 2), nx), ix1 = cl(Math.floor((x1 - g.x0) / cw + 2), nx);
  const iy0 = cl(Math.floor((y0 - g.y0) / ch - 2), ny), iy1 = cl(Math.floor((y1 - g.y0) / ch + 2), ny);
  const test = (id) => {
    let b0, b1, b2, b3;
    if (id < TEXT_ID) {
      if (dead && dead[id]) return;
      const o = 4 * id; b0 = scene.bbox[o]; b1 = scene.bbox[o + 1]; b2 = scene.bbox[o + 2]; b3 = scene.bbox[o + 3];
    } else {
      const t = scene.texts[id - TEXT_ID];
      if (t.dead) return;
      const b = t.bbox; b0 = b[0]; b1 = b[1]; b2 = b[2]; b3 = b[3];
    }
    if (b0 > x1 || b2 < x0 || b1 > y1 || b3 < y0) return;
    return cb(id);
  };
  const visit = (c) => {
    const L = g.loose;
    if (L[4 * c] > x1 || L[4 * c + 2] < x0 || L[4 * c + 1] > y1 || L[4 * c + 3] < y0) return;
    for (let k = g.cellStart[c]; k < g.cellStart[c + 1]; k++) if (test(g.items[k]) === false) return false;
    const extra = dyn && dyn.get(c);
    if (extra) for (const id of extra) if (test(id) === false) return false;
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
  const f = new Float64Array(n * 11), u = new Uint32Array(n * 5);
  const strs = new Array(n), subs = [];
  for (let i = 0; i < n; i++) {
    const t = T[i];
    if (t.sub) subs.push(i, t.sub); // paths inside cells/inserts: sparse [index, path, ...]
    f.set([t.x, t.y, t.m[0], t.m[1], t.m[2], t.m[3], t.fit || 0, t.bbox[0], t.bbox[1], t.bbox[2], t.bbox[3]], i * 11);
    u[i * 5] = t.layer; u[i * 5 + 1] = t.color; u[i * 5 + 2] = t.blk; u[i * 5 + 3] = t.align; u[i * 5 + 4] = t.ent;
    strs[i] = t.s;
  }
  scene.textPack = { n, f, u, s: strs.join('\u0000'), sub: subs };
  delete scene.texts;
  return scene;
}
export function unpackTexts(scene) {
  if (!scene.textPack) return scene;
  const { n, f, u } = scene.textPack;
  const strs = n ? scene.textPack.s.split('\u0000') : [];
  const texts = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 11, q = i * 5;
    texts[i] = {
      s: strs[i], x: f[o], y: f[o + 1], m: [f[o + 2], f[o + 3], f[o + 4], f[o + 5]], fit: f[o + 6],
      bbox: [f[o + 7], f[o + 8], f[o + 9], f[o + 10]], layer: u[q], color: u[q + 1], blk: u[q + 2], align: u[q + 3], ent: u[q + 4], sub: '',
    };
  }
  const subs = scene.textPack.sub || [];
  for (let k = 0; k + 1 < subs.length; k += 2) texts[subs[k]].sub = subs[k + 1];
  scene.texts = texts;
  delete scene.textPack;
  return scene;
}

/** Typed-array buffers to transfer from a worker. */
export function sceneTransferables(scene) {
  const g = scene.grid;
  const list = [scene.kind, scene.flags, scene.layer, scene.color, scene.style, scene.weight, scene.src, scene.blk, scene.ent, scene.start,
    scene.count, scene.coords, scene.conics, scene.bbox, scene.entPrim, scene.entText, g.cellStart, g.items, g.loose];
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
