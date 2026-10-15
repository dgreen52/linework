// Paper-space layouts (DXF / DWG), loaded with a drawing that has them, so the start-up code stays small.
// The reader only keeps what it met (model.layoutData: the LAYOUT objects, the block records, the layer
// handles, the paper-space items; VIEWPORTs as raw groups); here they become pages: 1 = model space, 2.. =
// each layout in tab order. A layout page shows its sheet and, through each viewport, model space at the
// viewport's scale, clipped to its frame (the scene's Builder calls `clipper` while a viewport is drawn).
import { FLAG, NS_COPIES, conicBBox } from './scene.js';

const D2R = Math.PI / 180;

/**
 * Clip a polyline (flat [x, y, ...]; closed: the last point joins the first) to the rectangle r = [x0, y0, x1, y1]:
 * the pieces inside, each an open polyline of 2+ points (Liang-Barsky per segment, joined where they touch).
 */
export function clipPolyline(pts, closed, r) {
  const n = pts.length / 2, out = [];
  if (n < 2) return out;
  let cur = null;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n, ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
    const dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, ax - r[0]], [dx, r[2] - ax], [-dy, ay - r[1]], [dy, r[3] - ay]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; } else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok) { if (cur) { out.push(cur); cur = null; } continue; }
    const px = ax + t0 * dx, py = ay + t0 * dy, qx = ax + t1 * dx, qy = ay + t1 * dy;
    if (cur && cur[cur.length - 2] === px && cur[cur.length - 1] === py) cur.push(qx, qy);
    else { if (cur) out.push(cur); cur = [px, py, qx, qy]; }
    if (t1 < 1) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  // a closed outline that starts inside: its last piece runs on into its first
  if (closed && out.length > 1) {
    const a = out[0], z = out[out.length - 1];
    if (z[z.length - 2] === a[0] && z[z.length - 1] === a[1]) { for (let k = 2; k < a.length; k++) z.push(a[k]); out[0] = z; out.pop(); }
  }
  return out;
}

/** Clip a filled ring (flat [x, y, ...]) to the rectangle r (Sutherland-Hodgman): the ring inside (maybe empty). */
export function clipRing(pts, r) {
  let ring = pts;
  for (let side = 0; side < 4 && ring.length; side++) {
    const axis = side >> 1, lim = r[side === 0 ? 0 : side === 1 ? 2 : side === 2 ? 1 : 3], keepLow = side === 1 || side === 3;
    const inside = (x, y) => { const v = axis ? y : x; return keepLow ? v <= lim : v >= lim; };
    const cut = (ax, ay, bx, by) => (axis ? [ax + ((bx - ax) * (lim - ay)) / (by - ay), lim] : [lim, ay + ((by - ay) * (lim - ax)) / (bx - ax)]);
    const n = ring.length / 2, next = [];
    for (let i = 0; i < n; i++) {
      const j = (i + n - 1) % n, ax = ring[2 * j], ay = ring[2 * j + 1], bx = ring[2 * i], by = ring[2 * i + 1];
      const ain = inside(ax, ay), bin = inside(bx, by);
      if (ain !== bin) { const p = cut(ax, ay, bx, by); next.push(p[0], p[1]); }
      if (bin) next.push(bx, by);
    }
    ring = next;
  }
  return ring.length >= 6 ? ring : [];
}

/** bbox b against the rectangle c: 0 inside, 1 partly, 2 outside. */
const state = (b, c) => (b[0] >= c[0] && b[1] >= c[1] && b[2] <= c[2] && b[3] <= c[3] ? 0 : b[2] < c[0] || b[0] > c[2] || b[3] < c[1] || b[1] > c[3] ? 2 : 1);

/**
 * What the scene's Builder calls while B.clip is set (a viewport's model space): each returns true when it dealt
 * with the item (left it out, or drew the pieces inside), false when the item is wholly inside (drawn as it is).
 */
export const clipper = {
  poly(B, pts, flags, a) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 1 < pts.length; i += 2) { const x = pts[i], y = pts[i + 1]; if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
    const c = B.clip, st = state(b, c);
    if (st !== 1) return st === 2;
    B.clip = null; // (the pieces are inside)
    try {
      if (flags & (FLAG.FILL | FLAG.PATTERN)) { // fills: each ring (separated by NaN) cut to the rectangle
        const all = [];
        let ring = [];
        const flush = () => { const r = clipRing(ring, c); if (r.length) { if (all.length) all.push(NaN, NaN); for (const v of r) all.push(v); } ring = []; };
        for (let i = 0; i + 1 < pts.length; i += 2) { if (Number.isNaN(pts[i])) flush(); else ring.push(pts[i], pts[i + 1]); }
        flush();
        if (all.length) B.poly(all, flags, a);
      } else for (const piece of clipPolyline(pts, !!(flags & FLAG.CLOSED), c)) B.poly(piece, flags & ~FLAG.CLOSED, a);
    } finally { B.clip = c; }
    return true;
  },
  point(B, x, y) { return state([x, y, x, y], B.clip) !== 0; },
  /** v: [cx, cy, ux, uy, vx, vy, t0, t1]. A curve the edge cuts is drawn as points along it (every 3 degrees), clipped. */
  conic(B, v, full, a, extra) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    conicBBox(v, 0, b);
    const st = state(b, B.clip);
    if (st !== 1) return st === 2;
    const [cx, cy, ux, uy, vx, vy, t0, t1] = v, k = Math.max(8, Math.ceil(Math.abs(t1 - t0) / (Math.PI / 60))), pts = [];
    for (let i = 0; i <= k; i++) { const t = t0 + ((t1 - t0) * i) / k; pts.push(cx + ux * Math.cos(t) + vx * Math.sin(t), cy + uy * Math.cos(t) + vy * Math.sin(t)); }
    if (full) { pts.length -= 2; B.poly(pts, FLAG.CLOSED | (extra & ~FLAG.FULL), a); } else B.poly(pts, extra & ~FLAG.FULL, a);
    return true;
  },
};

/**
 * The reader's raw records (model.layoutData.raw: [type, codes, vals] for LAYER, BLOCK_RECORD and LAYOUT), decoded once:
 * { lh: layer handle -> name, recs: block record handle -> [name, its layout's handle], objs: [[codes, vals]] (LAYOUTs) }.
 */
function tablesOf(L) {
  if (L.t) return L.t;
  const t = (L.t = { lh: {}, recs: {}, objs: [] });
  for (const [type, codes, vals] of L.raw || []) {
    const at = (c) => { const k = codes.indexOf(c); return k < 0 ? '' : String(vals[k]).trim(); };
    if (type === 'LAYOUT') t.objs.push([codes, vals]);
    else if (!at(5)) continue;
    else if (type === 'LAYER') t.lh[at(5).toUpperCase()] = at(2) || '0';
    else t.recs[at(5).toUpperCase()] = [at(2), at(340).toUpperCase()];
  }
  return t;
}

/** A VIEWPORT's numbers from its groups (raw: [codes, vals]); lh: layer handle -> name. */
function viewportOf(raw, lh) {
  const [codes, vals] = raw;
  const f = (c, d = 0) => { const k = codes.indexOf(c); const v = k < 0 ? NaN : parseFloat(vals[k]); return Number.isFinite(v) ? v : d; };
  const vh = f(45);
  return {
    c: [f(10), f(20)], w: f(40), h: f(41), view: [f(12) + f(17), f(22) + f(27)], vh, twist: f(51) * D2R,
    on: f(68, 1) !== 0 && codes.includes(45) && vh > 0, // (R12 keeps the view in extended data: its frame only)
    frozen: codes.flatMap((c, k) => (c === 331 && lh[String(vals[k]).trim().toUpperCase()] ? [lh[String(vals[k]).trim().toUpperCase()].toUpperCase()] : [])),
  };
}

/**
 * Draw a layout's viewport (called by the scene for a 'viewport' item): its frame, then model space at its scale
 * around its view centre, clipped to it; layers frozen in it left out; texts kept when their middle is inside.
 * M, a, depth: the item's transform, attributes and block depth; api: { B, model, top (top context), walk(ents, ctx), over(), ns(key) }.
 */
export function emitViewport(e, M, a, depth, api) {
  const { B, model } = api, v = e.vp || (e.vp = viewportOf(e.raw, model.layoutData ? tablesOf(model.layoutData).lh : {}));
  if (!(v.w > 0 && v.h > 0)) return;
  const x0 = v.c[0] - v.w / 2, y0 = v.c[1] - v.h / 2, x1 = v.c[0] + v.w / 2, y1 = v.c[1] + v.h / 2;
  const frame = [x0, y0, x1, y0, x1, y1, x0, y1];
  if (M) for (let k = 0; k < 8; k += 2) { const x = frame[k], y = frame[k + 1]; frame[k] = M[0] * x + M[2] * y + M[4]; frame[k + 1] = M[1] * x + M[3] * y + M[5]; }
  B.poly(frame, FLAG.CLOSED, a);
  const ms = model.modelSpace;
  if (!v.on || !ms || !ms.length || depth || M || B.clip) return; // (on a layout page, at the top level only)
  const s = v.h / v.vh, r = -(v.twist || 0), co = Math.cos(r) * s, si = Math.sin(r) * s;
  const Mv = [co, si, -si, co, v.c[0] - (co * v.view[0] - si * v.view[1]), v.c[1] - (si * v.view[0] + co * v.view[1])];
  const frozen = new Set(v.frozen), up = B.curSub, t0 = B.texts.length;
  B.curSub = '#v'; // (model space seen through a viewport: not an item of this page)
  B.clip = [x0, y0, x1, y1];
  try {
    const ctx = { ...api.top, M: Mv, depth: 1 };
    for (const m of ms) {
      if (!m || m.invisible || (frozen.size && frozen.has(String(m.layer == null ? '0' : m.layer).toUpperCase()))) continue;
      if (api.over()) { api.ns(NS_COPIES); break; }
      api.walk([m], ctx);
    }
  } finally { B.clip = null; B.curSub = up; }
  let k = t0;
  for (let i = t0; i < B.texts.length; i++) {
    const t = B.texts[i], cx = (t.bbox[0] + t.bbox[2]) / 2, cy = (t.bbox[1] + t.bbox[3]) / 2;
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) B.texts[k++] = t;
  }
  B.texts.length = k;
}

/** The paper-space layouts in tab order: [{ name, order, entities }] (the model tab left out). */
export function layoutsOf(model) {
  const L = model.layoutData, out = [];
  if (!L) return out;
  const { recs, objs } = tablesOf(L), byLayout = {};
  for (const r of Object.values(recs)) if (r[1]) byLayout[r[1]] = r[0];
  for (const [codes, vals] of objs) {
    // the layout's own groups come after "100 AcDbLayout" (before it: the plot settings, which also use 1 and 70)
    let k = codes.findIndex((c, i) => c === 100 && String(vals[i]).trim() === 'AcDbLayout');
    if (k < 0) k = 0;
    const at = (code) => { for (let i = k; i < codes.length; i++) if (codes[i] === code) return String(vals[i]).trim(); return ''; };
    const h = codes.indexOf(5), handle = h >= 0 ? String(vals[h]).trim().toUpperCase() : '', name = at(1), br = at(330).toUpperCase();
    const bname = String((recs[br] && recs[br][0]) || byLayout[handle] || '').toUpperCase();
    if (bname === '*MODEL_SPACE' || (!bname && name.toUpperCase() === 'MODEL')) continue;
    const entities = bname === '*PAPER_SPACE' ? L.paper : (model.blocks[bname] && model.blocks[bname].entities) || [];
    out.push({ name: name || `Layout ${out.length + 1}`, order: parseInt(at(71), 10) || 0, entities });
  }
  if (!out.length && L.paper.length) out.push({ name: 'Paper space', order: 1, entities: L.paper });
  return out.sort((a, b) => a.order - b.order);
}

export const PS_NOTE = 'Paper-space (layout) items (see the layout pages)';

/**
 * Make the drawing's layouts pages (page: 1 = model space, the default; 2.. = a layout in tab order; out of range:
 * 1, or the first layout when model space is empty). Sets model.page { n, count, label, labels, layout, cad }; on a
 * layout page model.entities are its items and model.modelSpace the model space its viewports show. A drawing with
 * no layout, or only paper space and one layout, is left as the reader made it. Returns the model.
 */
export function applyLayouts(model, page) {
  const L = model.layoutData;
  if (!L) return model;
  const fallback = L.paper.length && model.entities === L.paper; // (the reader showed paper space for an empty model)
  const ms = fallback ? [] : model.entities, layouts = layoutsOf(model);
  if (!layouts.length || !(ms.length || layouts.length > 1)) return model;
  const count = layouts.length + 1, labels = ['Model', ...layouts.map((l) => l.name)];
  let n = Math.round(Number(page) || 0);
  if (!(n >= 1 && n <= count)) n = ms.length ? 1 : 2;
  model.page = { n, count, label: labels[n - 1], labels, layout: n > 1, cad: true };
  const st = model.stats, ns = st.notShown;
  for (const k of Object.keys(ns)) if (/^Paper-space/.test(k)) delete ns[k];
  st.warnings = st.warnings.filter((w) => !/paper-space layout instead/.test(w));
  model.paperEntities = [];
  if (n > 1) { model.modelSpace = ms; model.entities = layouts[n - 2].entities.slice(); }
  else { model.entities = ms; if (L.paper.length) ns[PS_NOTE] = L.paper.length; }
  st.entities = model.entities.length;
  return model;
}
