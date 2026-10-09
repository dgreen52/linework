// Object snaps on the render scene (scene-local coordinates). Pure functions, no DOM.
import { KIND, FLAG, TEXT_ID, queryRect, conicPoint } from '../scene.js';
import { segSeg, nearestOnSeg, pointInPolygon, TAU } from '../geom.js';

export const SNAP_KINDS = ['endpoint', 'midpoint', 'center', 'intersection', 'nearest'];
const PRIORITY = { endpoint: 0, intersection: 0, midpoint: 1, center: 2, nearest: 3 };

/** Polyline approximation of a conic in scene coords (for nearest / intersection). */
function conicPolyline(scene, i, segsPerTurn = 128) {
  const c = scene.conics, o = scene.start[i] * 8;
  const t0 = c[o + 6], t1 = c[o + 7];
  const n = Math.max(4, Math.ceil((segsPerTurn * (t1 - t0)) / TAU));
  const out = [];
  for (let k = 0; k <= n; k++) {
    const p = conicPoint(scene, i, t0 + ((t1 - t0) * k) / n);
    out.push(p[0], p[1]);
  }
  return out;
}

/**
 * Find the best snap near (x, y) within `tol` (scene units).
 * opts.enabled: { endpoint, midpoint, center, intersection, nearest } (all true by default)
 * opts.isVisible(layerIndex) -> bool;  opts.skip(primId) -> bool (e.g. items being moved)
 * Returns { x, y, kind, prim } or null.
 */
export function findSnap(scene, x, y, tol, opts = {}) {
  if (!scene || scene.n === 0) return null;
  const en = { endpoint: true, midpoint: true, center: true, intersection: true, nearest: true, ...(opts.enabled || {}) };
  const vis = opts.isVisible || (() => true);
  const skip = opts.skip || null;
  const t2 = tol * tol;
  let best = null;
  const consider = (px, py, kind, prim) => {
    if (!en[kind]) return;
    const d2 = (px - x) ** 2 + (py - y) ** 2;
    if (d2 > t2) return;
    const p = PRIORITY[kind];
    if (!best || p < best.p || (p === best.p && d2 < best.d2)) best = { x: px, y: py, kind, prim, p, d2 };
  };
  const segs = []; // [ax, ay, bx, by, prim] near the cursor for intersections
  const segNear = (ax, ay, bx, by) => {
    const r = nearestOnSeg(x, y, ax, ay, bx, by);
    return r[3] <= t2 * 4;
  };

  queryRect(scene, x - tol, y - tol, x + tol, y + tol, (id) => {
    if (id >= TEXT_ID) return; // text: no snaps
    if (!vis(scene.layer[id]) || (skip && skip(id))) return;
    const k = scene.kind[id];
    if (k === KIND.POINT) {
      const s = scene.start[id] * 2;
      consider(scene.coords[s], scene.coords[s + 1], 'endpoint', id);
      return;
    }
    let pts, closed, curve = false;
    if (k === KIND.CONIC) {
      const c = scene.conics, o = scene.start[id] * 8;
      const full = !!(scene.flags[id] & FLAG.FULL);
      if (!full) {
        const a = conicPoint(scene, id, c[o + 6]), b = conicPoint(scene, id, c[o + 7]);
        consider(a[0], a[1], 'endpoint', id);
        consider(b[0], b[1], 'endpoint', id);
        const m = conicPoint(scene, id, (c[o + 6] + c[o + 7]) / 2);
        consider(m[0], m[1], 'midpoint', id);
      }
      pts = conicPolyline(scene, id);
      closed = false;
      curve = true;
      // centre: when the cursor is at the centre, or on the curve of a small circle/arc
      const r = Math.max(Math.hypot(c[o + 2], c[o + 3]), Math.hypot(c[o + 4], c[o + 5]));
      const dc = Math.hypot(c[o] - x, c[o + 1] - y);
      if (dc <= tol) consider(c[o], c[o + 1], 'center', id);
      else if (en.center && r <= 4 * tol && Math.abs(dc - r) <= tol) {
        // report the centre even though it is outside the pick radius
        const p = PRIORITY.center;
        if (!best || p < best.p) best = { x: c[o], y: c[o + 1], kind: 'center', prim: id, p, d2: t2 };
      }
    } else {
      const s = scene.start[id] * 2, n = scene.count[id];
      const f = scene.flags[id];
      closed = !!(f & FLAG.CLOSED);
      curve = !!(f & FLAG.CURVEPTS);
      pts = scene.coords.subarray(s, s + n * 2);
      if (f & FLAG.EVENODD) curve = true; // multi-ring hatch: outline points only
    }
    const n = pts.length / 2;
    const segCount = closed ? n : n - 1;
    if (k !== KIND.CONIC) {
      if (curve) {
        if (!closed) { consider(pts[0], pts[1], 'endpoint', id); consider(pts[2 * n - 2], pts[2 * n - 1], 'endpoint', id); }
      } else {
        for (let i = 0; i < n; i++) if (pts[2 * i] === pts[2 * i]) consider(pts[2 * i], pts[2 * i + 1], 'endpoint', id);
      }
    }
    for (let i = 0; i < segCount; i++) {
      const j = (i + 1) % n;
      const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
      if (ax !== ax || bx !== bx) continue; // NaN ring separator
      if (!curve && k !== KIND.CONIC) consider((ax + bx) / 2, (ay + by) / 2, 'midpoint', id);
      const r = nearestOnSeg(x, y, ax, ay, bx, by);
      consider(r[0], r[1], 'nearest', id);
      if (en.intersection && segs.length < 400 && segNear(ax, ay, bx, by)) segs.push([ax, ay, bx, by, id]);
    }
  });

  if (en.intersection && segs.length > 1) {
    for (let i = 0; i < segs.length; i++) {
      const A = segs[i];
      for (let j = i + 1; j < segs.length; j++) {
        const B = segs[j];
        if (A[4] === B[4]) continue;
        const r = segSeg(A[0], A[1], A[2], A[3], B[0], B[1], B[2], B[3]);
        if (r) consider(r[0], r[1], 'intersection', A[4]);
      }
    }
  }
  if (!best) return null;
  return { x: best.x, y: best.y, kind: best.kind, prim: best.prim };
}

/**
 * Nearest primitive or text to a point within tol (hover info, picking). Returns
 * { id, isText, d, ent } (ent = top-level model entity). Ties go to the item drawn last (topmost).
 */
export function pickItem(scene, x, y, tol, isVisible = () => true) {
  let best = null;
  const better = (d, id) => !best || d < best.d - 1e-12 || (Math.abs(d - best.d) <= 1e-12 && id > best.id);
  queryRect(scene, x - tol, y - tol, x + tol, y + tol, (id) => {
    if (id >= TEXT_ID) {
      const t = scene.texts[id - TEXT_ID];
      if (!isVisible(t.layer)) return;
      const b = t.bbox;
      if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) {
        const d = tol * 0.5;
        if (better(d, id)) best = { id, isText: true, d, ent: t.ent };
      }
      return;
    }
    if (!isVisible(scene.layer[id])) return;
    const k = scene.kind[id];
    let pts, closed;
    if (k === KIND.CONIC) { pts = conicPolyline(scene, id, 96); closed = false; }
    else { const s = scene.start[id] * 2; pts = scene.coords.subarray(s, s + scene.count[id] * 2); closed = !!(scene.flags[id] & FLAG.CLOSED); }
    const n = pts.length / 2;
    let d2 = Infinity;
    if (n === 1) d2 = (pts[0] - x) ** 2 + (pts[1] - y) ** 2;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      if (pts[2 * i] !== pts[2 * i] || pts[2 * j] !== pts[2 * j]) continue;
      const r = nearestOnSeg(x, y, pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1]);
      if (r[3] < d2) d2 = r[3];
    }
    let d = Math.sqrt(d2);
    // inside a filled area (solid, hatch): pickable, but lines nearby win
    if (d > tol * 0.75 && (scene.flags[id] & (FLAG.FILL | FLAG.PATTERN)) && insideRings(x, y, pts)) d = tol * 0.75;
    if (d <= tol && better(d, id)) best = { id, isText: false, d, ent: scene.ent ? scene.ent[id] : undefined };
  });
  return best;
}

function insideRings(x, y, pts) {
  let inside = false, ring = [];
  const flush = () => { if (ring.length >= 6 && pointInPolygon(x, y, ring)) inside = !inside; ring = []; };
  for (let i = 0; i < pts.length; i += 2) { if (pts[i] !== pts[i]) flush(); else ring.push(pts[i], pts[i + 1]); }
  flush();
  return inside;
}
