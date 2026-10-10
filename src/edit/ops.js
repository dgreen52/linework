// Pure edit operations on model entities (drawing units, absolute coordinates). Every function
// returns a NEW entity and never mutates its input, so undo/redo can keep the old object as is
// (and the DGN writer can tell untouched entities by identity).
import { apply, applyVec, det, mul, translate, rotate, bulgeToArc, TAU, nearestOnSeg } from '../geom.js';
import { FG } from '../model.js';
import { ACI } from '../palettes.js';

const clonePts = (p) => (p ? p.slice() : p);
const xfPts = (M, pts) => {
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (x !== x) { out[i] = x; out[i + 1] = y; continue; } // NaN ring separator
    out[i] = M[0] * x + M[2] * y + M[4];
    out[i + 1] = M[1] * x + M[3] * y + M[5];
  }
  return out;
};
const angleOf = (M, a) => { const v = applyVec(M, Math.cos(a), Math.sin(a)); return Math.atan2(v[1], v[0]); };
const scaleOf = (M) => Math.sqrt(Math.abs(det(M)));
const isConformal = (M, tol = 1e-9) => {
  const n1 = Math.hypot(M[0], M[1]), n2 = Math.hypot(M[2], M[3]);
  return Math.abs(M[0] * M[2] + M[1] * M[3]) <= tol * n1 * n2 && Math.abs(n1 - n2) <= tol * Math.max(n1, n2);
};

/** Entity with its OCS transform (e.xf from an extrusion vector) applied: plain plan geometry. */
export function bakeOcs(e) {
  if (!e || !e.xf) return e;
  const M = e.xf;
  const out = { ...e };
  delete out.xf; delete out.ext;
  return transformEntity(out, M, true);
}

/**
 * Apply an affine transform M to an entity (move, rotate, uniform scale; reflections are
 * handled). Returns a new entity. `baking` is internal (OCS to plan).
 */
export function transformEntity(e, M, baking = false) {
  if (!e) return e;
  if (e.xf && !baking && e.type !== 'dimension') e = bakeOcs(e);
  const d = det(M), s = scaleOf(M), flip = d < 0;
  const o = { ...e };
  switch (e.type) {
    case 'line': o.a = apply(M, ...e.a); o.b = apply(M, ...e.b); break;
    case 'point': o.p = apply(M, ...e.p); break;
    case 'polyline':
      o.pts = xfPts(M, e.pts);
      if (e.bulges) o.bulges = flip ? e.bulges.map((b) => -b) : e.bulges.slice();
      break;
    case 'spline': case 'solid': o.pts = xfPts(M, e.pts); break;
    case 'hatch':
      o.loops = e.loops.map((L) => ({ ...L, pts: xfPts(M, L.pts), bulges: L.bulges ? (flip ? L.bulges.map((b) => -b) : L.bulges.slice()) : L.bulges }));
      break;
    case 'circle':
      if (isConformal(M)) { o.c = apply(M, ...e.c); o.r = e.r * s; }
      else return transformEntity({ ...e, type: 'ellipse', major: [e.r, 0], minor: [0, e.r], t0: 0, t1: TAU }, M);
      break;
    case 'arc':
      if (isConformal(M)) {
        o.c = apply(M, ...e.c); o.r = e.r * s;
        if (flip) { o.a0 = angleOf(M, e.a1); o.a1 = angleOf(M, e.a0); } else { o.a0 = angleOf(M, e.a0); o.a1 = angleOf(M, e.a1); }
      } else {
        return transformEntity({ ...e, type: 'ellipse', major: [e.r, 0], minor: [0, e.r], t0: e.a0, t1: e.a1 }, M);
      }
      break;
    case 'ellipse':
      o.c = apply(M, ...e.c); o.major = applyVec(M, ...e.major); o.minor = applyVec(M, ...e.minor);
      break;
    case 'text': case 'mtext': {
      o.p = apply(M, ...e.p);
      if (e.p2) o.p2 = apply(M, ...e.p2);
      o.rot = angleOf(M, e.rot || 0);
      o.h = e.h * s;
      if (e.width) o.width = e.width * s;
      if (flip) o.mirrorY = !e.mirrorY;
      break;
    }
    case 'insert': {
      o.p = apply(M, ...e.p);
      o.rot = angleOf(M, e.rot || 0);
      o.sx = (e.sx ?? 1) * s;
      o.sy = (e.sy ?? 1) * s * (flip ? -1 : 1);
      if (e.dc) o.dc = e.dc * s;
      if (e.dr) o.dr = e.dr * s;
      if (e.attribs) o.attribs = e.attribs.map((a) => transformEntity(a, M));
      break;
    }
    case 'dimension': // geometry lives in an anonymous block (or fallback): keep a pending transform that the scene and the writer apply
      o.mv = e.mv ? mul(M, e.mv) : M.slice();
      break;
    case 'cell':
      o.children = e.children.map((c) => transformEntity(c, M));
      if (e.origin) o.origin = apply(M, ...e.origin);
      o.mv = e.mv ? mul(M, e.mv) : M.slice(); // the DGN writer patches the cell header with this
      break;
    default:
      break;
  }
  return o;
}

export const moveEntity = (e, dx, dy) => transformEntity(e, translate(dx, dy));
export const rotateEntity = (e, a, cx, cy) => transformEntity(e, mul(translate(cx, cy), mul(rotate(a), translate(-cx, -cy))));

// ------------------------------------------------------------------ grips (vertex handles)
/** Which entity types can be reshaped with handles. */
export const canReshape = (e) => !!e && !e.xf && ['line', 'polyline', 'circle', 'arc', 'ellipse', 'point'].includes(e.type);

/** Handles: [{ x, y, kind: 'v'|'c'|'r'|'m', k }]  v = vertex k, c = centre, r = radius, m = major axis end. */
export function gripsOf(e) {
  if (!canReshape(e)) return [];
  switch (e.type) {
    case 'line': return [{ x: e.a[0], y: e.a[1], kind: 'v', k: 0 }, { x: e.b[0], y: e.b[1], kind: 'v', k: 1 }];
    case 'point': return [{ x: e.p[0], y: e.p[1], kind: 'v', k: 0 }];
    case 'polyline': {
      const out = [];
      for (let k = 0; k < e.pts.length / 2; k++) out.push({ x: e.pts[2 * k], y: e.pts[2 * k + 1], kind: 'v', k });
      return out;
    }
    case 'circle': return [{ x: e.c[0], y: e.c[1], kind: 'c' }, { x: e.c[0] + e.r, y: e.c[1], kind: 'r' }];
    case 'arc': {
      let a1 = e.a1; while (a1 <= e.a0) a1 += TAU;
      const m = (e.a0 + a1) / 2;
      return [{ x: e.c[0], y: e.c[1], kind: 'c' }, { x: e.c[0] + e.r * Math.cos(m), y: e.c[1] + e.r * Math.sin(m), kind: 'r' }];
    }
    case 'ellipse': return [{ x: e.c[0], y: e.c[1], kind: 'c' }, { x: e.c[0] + e.major[0], y: e.c[1] + e.major[1], kind: 'm' }];
    default: return [];
  }
}

/** Move one handle to (x, y). Returns a new entity. */
export function moveGrip(e, grip, x, y) {
  const o = { ...e };
  switch (grip.kind) {
    case 'v':
      if (e.type === 'line') { if (grip.k === 0) o.a = [x, y]; else o.b = [x, y]; }
      else if (e.type === 'point') o.p = [x, y];
      else { o.pts = e.pts.slice(); o.pts[2 * grip.k] = x; o.pts[2 * grip.k + 1] = y; if (e.bulges) o.bulges = e.bulges.slice(); }
      return o;
    case 'c': return moveEntity(e, x - e.c[0], y - e.c[1]);
    case 'r': o.r = Math.max(1e-9, Math.hypot(x - e.c[0], y - e.c[1])); return o;
    case 'm': { // ellipse: rotate + scale keeping the axis ratio
      const L0 = Math.hypot(...e.major), L1 = Math.hypot(x - e.c[0], y - e.c[1]);
      if (!(L0 > 0) || !(L1 > 0)) return e;
      const a = Math.atan2(y - e.c[1], x - e.c[0]) - Math.atan2(e.major[1], e.major[0]);
      const k = L1 / L0, c = Math.cos(a) * k, s = Math.sin(a) * k;
      o.major = [e.major[0] * c - e.major[1] * s, e.major[0] * s + e.major[1] * c];
      o.minor = [e.minor[0] * c - e.minor[1] * s, e.minor[0] * s + e.minor[1] * c];
      return o;
    }
    default: return e;
  }
}

/** Vertex list of a reshapeable line/polyline: { pts, bulges, closed }. */
function vertsOf(e) {
  if (e.type === 'line') return { pts: [...e.a, ...e.b], bulges: null, closed: false };
  if (e.type === 'polyline') return { pts: e.pts, bulges: e.bulges, closed: !!e.closed };
  return null;
}

/** Segments for hit-testing / adding a vertex: [{ i, ax, ay, bx, by, bulge }]. */
export function segmentsOf(e) {
  const v = vertsOf(e);
  if (!v) return [];
  const n = v.pts.length / 2, out = [];
  for (let i = 0; i < (v.closed ? n : n - 1); i++) {
    const j = (i + 1) % n;
    out.push({ i, ax: v.pts[2 * i], ay: v.pts[2 * i + 1], bx: v.pts[2 * j], by: v.pts[2 * j + 1], bulge: v.bulges ? v.bulges[i] || 0 : 0 });
  }
  return out;
}

/** Closest point on a segment (straight or bulged arc) to (x, y): { x, y, d }. */
export function nearestOnSegment(sg, x, y) {
  const arc = sg.bulge ? bulgeToArc(sg.ax, sg.ay, sg.bx, sg.by, sg.bulge) : null;
  if (!arc) { const r = nearestOnSeg(x, y, sg.ax, sg.ay, sg.bx, sg.by); return { x: r[0], y: r[1], d: Math.sqrt(r[3]) }; }
  let t = Math.atan2(y - arc.cy, x - arc.cx) - arc.a0;
  // clamp the angle into the swept range
  const sw = arc.sweep;
  const norm = (v) => { v %= TAU; if (sw > 0) { if (v < 0) v += TAU; } else if (v > 0) v -= TAU; return v; };
  t = norm(t);
  if (Math.abs(t) > Math.abs(sw)) t = Math.abs(t - sw) < Math.abs(TAU - Math.abs(t)) ? sw : 0;
  const px = arc.cx + arc.r * Math.cos(arc.a0 + t), py = arc.cy + arc.r * Math.sin(arc.a0 + t);
  return { x: px, y: py, d: Math.hypot(px - x, py - y), t, arc };
}

/** Insert a vertex on segment `i` at (x, y) (snapped onto the segment). Lines become polylines. */
export function insertVertex(e, i, x, y) {
  const v = vertsOf(e);
  if (!v) return e;
  const sg = segmentsOf(e)[i];
  if (!sg) return e;
  const p = nearestOnSegment(sg, x, y);
  const pts = v.pts.slice();
  pts.splice(2 * i + 2, 0, p.x, p.y);
  let bulges = v.bulges ? v.bulges.slice() : null;
  if (bulges) {
    let b1 = 0, b2 = 0;
    if (p.arc) { b1 = Math.tan(p.t / 4); b2 = Math.tan((p.arc.sweep - p.t) / 4); }
    bulges.splice(i, 1, b1, b2);
  }
  const o = { ...e, type: 'polyline', pts, bulges, closed: v.closed };
  delete o.a; delete o.b;
  if (e.type === 'line') o.src = 'LWPOLYLINE';
  return o;
}

/** Delete vertex k. Returns null when too few vertices would remain (caller deletes the entity). */
export function deleteVertex(e, k) {
  const v = vertsOf(e);
  if (!v) return e;
  const n = v.pts.length / 2;
  if (n - 1 < (v.closed ? 3 : 2)) return null;
  const pts = v.pts.slice();
  pts.splice(2 * k, 2);
  let bulges = v.bulges ? v.bulges.slice() : null;
  if (bulges) { bulges.splice(k, 1); if (k > 0 && k - 1 < bulges.length) bulges[k - 1] = 0; }
  if (e.type === 'line') return null;
  return { ...e, pts, bulges: bulges && bulges.some((b) => b) ? bulges : null };
}

// ------------------------------------------------------------------ text and style
export const isText = (e) => !!e && (e.type === 'text' || e.type === 'mtext');

/** Replace the text content (single-line TEXT drops line breaks). */
/**
 * Component of a cell or insert by path: 'c3.c1' = children[3].children[1] (DGN cells, nested),
 * 'a2' = attribs[2] (a DXF insert's attributes). Paths come from the scene (text items' `sub`).
 */
export function partAt(e, path) {
  let cur = e;
  for (const step of String(path || '').split('.')) {
    const list = !cur ? null : step[0] === 'a' ? cur.attribs : step[0] === 'c' ? cur.children : null;
    cur = list ? list[Number(step.slice(1))] : null;
    if (!cur) return null;
  }
  return cur;
}

/** Copy of a cell or insert with the component at `path` replaced (or removed when part is null); the rest is shared. */
export function withPart(e, path, part) {
  const [step, ...rest] = String(path).split('.');
  const key = step[0] === 'a' ? 'attribs' : 'children';
  const k = Number(step.slice(1));
  const list = (e[key] || []).slice();
  if (rest.length) list[k] = withPart(list[k], rest.join('.'), part);
  else if (part) list[k] = part;
  else list.splice(k, 1);
  return { ...e, [key]: list };
}

export function setText(e, s) {
  const o = { ...e, text: e.type === 'text' ? String(s).replace(/[\r\n]+/g, ' ') : String(s).replace(/\r\n?/g, '\n') };
  delete o.raw; // the stored (escaped) form no longer matches
  return o;
}

/**
 * Change layer, colour and/or line weight. colour: { aci: 1..255 } | 'bylayer' (DXF), or for DGN a
 * colour-table entry { ci, rgb } (an ACI colour is also accepted; the DGN writer then uses the
 * nearest entry). weight: DGN 0..31; DXF lineweight in 1/100 mm, -1 = ByLayer. Cells apply all of
 * it to their components, inserts the layer and weight to their attributes.
 */
export function restyle(e, { layer, color, weight } = {}, format = 'DXF') {
  if (!e) return e;
  const o = { ...e };
  if (layer != null) o.layer = layer;
  if (weight != null) { if (format === 'DGN') o.weight = weight; else if (weight === -1) delete o.lw; else o.lw = weight; }
  if (color != null) {
    if (format === 'DGN') { // colour-table entry of the file { ci, rgb } (or an ACI colour, mapped later)
      if (color.ci != null) { o.rgb = color.rgb; o.ci = color.ci; }
      else { const aci = color === 'bylayer' ? 7 : color.aci; o.rgb = aci === 7 ? 0xffffff : ACI[aci]; delete o.ci; }
      o.color = 256;
    } else if (color === 'bylayer') { o.color = 256; o.rgb = null; }
    else { o.color = color.aci; o.rgb = null; }
  }
  if (e.type === 'cell') o.children = e.children.map((c) => restyle(c, { layer, color, weight }, format));
  if (e.type === 'insert' && e.attribs && (layer != null || weight != null)) o.attribs = e.attribs.map((a) => restyle(a, { layer, weight }, format));
  return o;
}

/** Line weight for the status bar: DGN "Weight 3", DXF "Weight 0.35 mm" / "ByLayer" / "ByBlock" / "Default". */
export function weightLabel(e, format) {
  if (format === 'DGN') return 'Weight ' + ((e && e.weight) | 0);
  const lw = e && e.lw != null ? e.lw : -1;
  return 'Weight ' + (lw >= 0 ? (lw / 100).toFixed(2) + ' mm' : ['ByLayer', 'ByBlock', 'Default'][-1 - lw] || 'Default');
}

/** Colour description for the status bar: { label, css } (css null = foreground). */
export function colorInfo(e, format) {
  if (!e) return { label: '', css: null };
  if (e.rgb != null) {
    if (format === 'DGN' && e.ci != null) return { label: `Colour ${e.ci}`, css: e.rgb };
    return { label: '#' + (e.rgb & 0xffffff).toString(16).padStart(6, '0'), css: e.rgb };
  }
  const c = e.color == null ? 256 : e.color;
  if (c === 256) return { label: 'ByLayer', css: undefined };
  if (c === 0) return { label: 'ByBlock', css: undefined };
  return { label: `Colour ${c}`, css: c === 7 ? FG : ACI[c] };
}
