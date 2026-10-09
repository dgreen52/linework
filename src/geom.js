// Pure 2D geometry helpers (no DOM). All angles in radians, CCW positive.

export const TAU = Math.PI * 2;
export const EPS = 1e-12;

// ---------------------------------------------------------------- affine
// Matrix [a, b, c, d, e, f]:  x' = a*x + c*y + e ;  y' = b*x + d*y + f  (canvas convention)
export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

export function mul(m, n) { // m * n  (apply n first, then m)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const applyVec = (m, x, y) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
export function rotate(a) { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; }
export function det(m) { return m[0] * m[3] - m[1] * m[2]; }
export function invert(m) {
  const d = det(m);
  if (Math.abs(d) < EPS) return null;
  const a = m[3] / d, b = -m[1] / d, c = -m[2] / d, dd = m[0] / d;
  return [a, b, c, dd, -(a * m[4] + c * m[5]), -(b * m[4] + dd * m[5])];
}
export const isIdentity = (m) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
/** Typical linear scale factor of a matrix (sqrt of |det|). */
export const matScale = (m) => Math.sqrt(Math.abs(det(m)));

/** Insert/block transform: T(p) * R(rot) * S(sx, sy) * T(-base). */
export function insertMatrix(px, py, sx, sy, rot, bx = 0, by = 0) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const a = c * sx, b = s * sx, cc = -s * sy, d = c * sy;
  return [a, b, cc, d, px - (a * bx + cc * by), py - (b * bx + d * by)];
}

/**
 * DXF Object Coordinate System -> WCS, projected onto the XY plane (plan view).
 * Implements the public "arbitrary axis algorithm". Returns null for the default (0,0,1).
 * The returned affine maps OCS (x, y) to plan; `zx`/`zy` give the contribution of OCS z.
 */
export function ocsMatrix(nx, ny, nz) {
  const len = Math.hypot(nx, ny, nz);
  if (!(len > EPS)) return null;
  nx /= len; ny /= len; nz /= len;
  if (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9 && nz > 0) return null;
  let ax, ay, az;
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) { // Wy x N
    ax = nz; ay = 0; az = -nx;
  } else { // Wz x N
    ax = -ny; ay = nx; az = 0;
  }
  const al = Math.hypot(ax, ay, az); ax /= al; ay /= al; az /= al;
  // Ay = N x Ax
  const bx = ny * az - nz * ay, by = nz * ax - nx * az;
  const m = [ax, ay, bx, by, 0, 0];
  m.zx = nx; m.zy = ny;
  return m;
}

// ---------------------------------------------------------------- vectors
export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const normAngle = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };

// ---------------------------------------------------------------- arcs / bulges
/**
 * Bulge segment p1->p2 (bulge = tan(theta/4), positive = CCW) to arc parameters.
 * Returns null for a straight segment.
 */
export function bulgeToArc(x1, y1, x2, y2, bulge) {
  if (!bulge || Math.abs(bulge) < 1e-12) return null;
  const chord = Math.hypot(x2 - x1, y2 - y1);
  if (chord < EPS) return null;
  const theta = 4 * Math.atan(bulge);              // signed included angle
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const sagittaDist = (chord / 2) / Math.tan(theta / 2); // signed distance midpoint -> centre
  const ux = (x2 - x1) / chord, uy = (y2 - y1) / chord;
  // centre lies to the left of p1->p2 for CCW (positive bulge)
  const cx = mx - uy * sagittaDist, cy = my + ux * sagittaDist;
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  return { cx, cy, r, a0, sweep: theta };
}

/** Number of segments for an arc of radius r and sweep (radians), given chord tolerance tol. */
export function arcSegments(r, sweep, tol) {
  const s = Math.abs(sweep);
  if (!(r > 0) || !(s > 0)) return 1;
  let step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
  if (!(step > 0)) step = s;
  step = Math.min(step, Math.PI / 18);           // at least 36 segments per full circle
  step = Math.max(step, Math.PI / 512);
  return Math.max(2, Math.min(1024, Math.ceil(s / step)));
}

/** Append arc points (excluding the start point if skipFirst) to out[]. */
export function tessArc(out, cx, cy, r, a0, sweep, tol, skipFirst = false) {
  const n = arcSegments(r, sweep, tol);
  for (let i = skipFirst ? 1 : 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/** Ellipse points: centre, major axis vector (mx,my), minor vector (nx,ny), params t0..t1. */
export function tessEllipse(out, cx, cy, mx, my, nx, ny, t0, t1, tol) {
  let sweep = t1 - t0;
  if (sweep <= 0) sweep += TAU;
  if (sweep > TAU) sweep = TAU;
  const r = Math.max(Math.hypot(mx, my), Math.hypot(nx, ny));
  const n = arcSegments(r, sweep, tol);
  for (let i = 0; i <= n; i++) {
    const t = t0 + (sweep * i) / n;
    const c = Math.cos(t), s = Math.sin(t);
    out.push(cx + mx * c + nx * s, cy + my * c + ny * s);
  }
  return out;
}

// ---------------------------------------------------------------- splines
/** Evaluate a (rational) B-spline with de Boor. ctrl: [x,y,...], weights or null. */
export function tessBSpline(ctrl, degree, knots, weights, samples) {
  const n = ctrl.length / 2;
  const p = Math.max(1, Math.min(degree | 0, n - 1));
  if (n < 2) return ctrl.slice();
  let U = knots;
  if (!U || U.length !== n + p + 1) { // clamped uniform knot vector
    U = [];
    for (let i = 0; i <= n + p; i++) U.push(i <= p ? 0 : i >= n ? n - p : i - p);
  }
  const lo = U[p], hi = U[n];
  const out = [];
  const W = weights && weights.length === n ? weights : null;
  const dx = new Float64Array(p + 1), dy = new Float64Array(p + 1), dw = new Float64Array(p + 1);
  const m = Math.max(2, samples | 0);
  for (let s = 0; s <= m; s++) {
    const u = s === m ? hi : lo + ((hi - lo) * s) / m;
    let k = p;
    while (k < n - 1 && U[k + 1] <= u) k++;
    for (let j = 0; j <= p; j++) {
      const i = k - p + j;
      const w = W ? W[i] : 1;
      dx[j] = ctrl[2 * i] * w; dy[j] = ctrl[2 * i + 1] * w; dw[j] = w;
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = U[i + p - r + 1] - U[i];
        const a = den > EPS ? (u - U[i]) / den : 0;
        dx[j] = (1 - a) * dx[j - 1] + a * dx[j];
        dy[j] = (1 - a) * dy[j - 1] + a * dy[j];
        dw[j] = (1 - a) * dw[j - 1] + a * dw[j];
      }
    }
    const w = dw[p] || 1;
    out.push(dx[p] / w, dy[p] / w);
  }
  return out;
}

/** Centripetal-ish Catmull-Rom through points (used for fit-point splines and DGN curves). */
export function tessCatmullRom(pts, segsPer = 8, closed = false) {
  const n = pts.length / 2;
  if (n < 3) return pts.slice();
  const P = (i) => {
    if (closed) i = ((i % n) + n) % n; else i = Math.max(0, Math.min(n - 1, i));
    return [pts[2 * i], pts[2 * i + 1]];
  };
  const out = [pts[0], pts[1]];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 1; s <= segsPer; s++) {
      const t = s / segsPer, t2 = t * t, t3 = t2 * t;
      out.push(
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- measurement
export function polylineLength(pts, closed = false) {
  let L = 0;
  const n = pts.length / 2;
  for (let i = 1; i < n; i++) L += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  if (closed && n > 2) L += Math.hypot(pts[0] - pts[2 * n - 2], pts[1] - pts[2 * n - 1]);
  return L;
}

/** Signed shoelace area (positive = CCW). */
export function signedArea(pts) {
  let A = 0;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) A += pts[2 * j] * pts[2 * i + 1] - pts[2 * i] * pts[2 * j + 1];
  return A / 2;
}
export const polygonArea = (pts) => Math.abs(signedArea(pts));

/** Length of a bulged polyline (exact arcs). verts: [x,y,...], bulges: [b0, b1, ...] */
export function bulgePolylineLength(verts, bulges, closed) {
  const n = verts.length / 2;
  let L = 0;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const x1 = verts[2 * i], y1 = verts[2 * i + 1], x2 = verts[2 * j], y2 = verts[2 * j + 1];
    const arc = bulges ? bulgeToArc(x1, y1, x2, y2, bulges[i]) : null;
    L += arc ? Math.abs(arc.sweep) * arc.r : Math.hypot(x2 - x1, y2 - y1);
  }
  return L;
}

/** Area enclosed by a closed bulged polyline (exact: polygon + circular segments). */
export function bulgePolygonArea(verts, bulges) {
  let A = signedArea(verts);
  const n = verts.length / 2;
  if (bulges) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const arc = bulgeToArc(verts[2 * i], verts[2 * i + 1], verts[2 * j], verts[2 * j + 1], bulges[i]);
      if (!arc) continue;
      const th = Math.abs(arc.sweep);
      const seg = 0.5 * arc.r * arc.r * (th - Math.sin(th)); // circular segment area
      A += Math.sign(arc.sweep) * seg;
    }
  }
  return Math.abs(A);
}

// ---------------------------------------------------------------- intersections / nearest
/** Segment-segment intersection. Returns [x, y, t, u] or null. */
export function segSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < EPS * (Math.abs(rx) + Math.abs(ry) + 1) * (Math.abs(sx) + Math.abs(sy) + 1)) return null;
  const qx = cx - ax, qy = cy - ay;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  const e = 1e-9;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return [ax + rx * t, ay + ry * t, t, u];
}

/** Closest point on segment ab to p. Returns [x, y, t, d2]. */
export function nearestOnSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy;
  let t = L2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + vx * t, y = ay + vy * t;
  return [x, y, t, (px - x) ** 2 + (py - y) ** 2];
}

/** Distance from point to polyline (screen hit tests). */
export function distToPolyline(px, py, pts, closed = false) {
  const n = pts.length / 2;
  if (n === 1) return Math.hypot(px - pts[0], py - pts[1]);
  let best = Infinity;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const r = nearestOnSeg(px, py, pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1]);
    if (r[3] < best) best = r[3];
  }
  return Math.sqrt(best);
}

export function pointInPolygon(px, py, pts) {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i], yi = pts[2 * i + 1], xj = pts[2 * j], yj = pts[2 * j + 1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bboxOf(pts, out = [Infinity, Infinity, -Infinity, -Infinity]) {
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (x < out[0]) out[0] = x;
    if (y < out[1]) out[1] = y;
    if (x > out[2]) out[2] = x;
    if (y > out[3]) out[3] = y;
  }
  return out;
}

// ---------------------------------------------------------------- smoothing (freehand)
/** Ramer-Douglas-Peucker simplification. pts: flat [x,y,...] */
export function simplifyRDP(pts, tol) {
  const n = pts.length / 2;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const r = nearestOnSeg(pts[2 * i], pts[2 * i + 1], pts[2 * s], pts[2 * s + 1], pts[2 * e], pts[2 * e + 1]);
      if (r[3] > maxD) { maxD = r[3]; idx = i; }
    }
    if (maxD > t2) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

/** Chaikin corner cutting (keeps end points). */
export function chaikin(pts, iterations = 2) {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    const n = p.length / 2;
    if (n < 3) return p.slice();
    const out = [p[0], p[1]];
    for (let i = 0; i < n - 1; i++) {
      const x0 = p[2 * i], y0 = p[2 * i + 1], x1 = p[2 * i + 2], y1 = p[2 * i + 3];
      out.push(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1, 0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1);
    }
    out.push(p[2 * n - 2], p[2 * n - 1]);
    p = out;
  }
  return p;
}

/** Smooth a raw freehand stroke: drop jitter, then round the corners. */
export function smoothStroke(pts, tol) {
  if (pts.length < 6) return pts.slice();
  return chaikin(simplifyRDP(pts, tol), 2);
}
