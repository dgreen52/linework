// Hatch patterns as real lines (DXF / DWG HATCH): each pattern definition line is a family of parallel lines,
// cut to the hatch's boundary (even-odd, as the fill) and dashed, in drawing units. Loaded by the parse worker
// for drawings with pattern hatches and by the Edit mode; without it a pattern hatch is a screen-space tone.

/** Segments one hatch may have before it is drawn as a tone (and what one scene build may spend on them). */
export const HATCH_MAX = 20000, HATCH_BUDGET = 300000;

/**
 * The pattern definition lines of a hatch, from the groups the reader keeps after its loops (e.tail: [[code, value]]):
 * [{ a (radians), b: [x, y] (a point on line 0), o: [x, y] (from one line to the next), d: [dash (>0), gap (<0), dot (0)...] }].
 * DXF stores them with the pattern's scale and angle applied, in the hatch's own (OCS) coordinates.
 */
export function patternDefs(tail) {
  const defs = [];
  let L = null;
  for (const [c, v] of tail || []) {
    const x = parseFloat(v);
    if (c === 53) defs.push((L = { a: (x * Math.PI) / 180, b: [0, 0], o: [0, 0], d: [] }));
    else if (!L) continue;
    else if (c === 43) L.b[0] = x;
    else if (c === 44) L.b[1] = x;
    else if (c === 45) L.o[0] = x;
    else if (c === 46) L.o[1] = x;
    else if (c === 49) L.d.push(x);
    else if (c === 98 || c === 47 || c === 450) break; // seed points, pixel size, gradient: the definition is over
  }
  return defs.filter((D) => [D.a, ...D.b, ...D.o, ...D.d].every(Number.isFinite));
}

/**
 * The pattern lines of a hatch inside its boundary rings (flat [x, y, ...] each, the hatch's own coordinates):
 * [x0, y0, x1, y1, NaN, NaN, ...] (one segment per dash; a dot is a segment of length 0), or null when the hatch
 * has no pattern lines or would need more than HATCH_MAX segments (or more than budget.left, which it then spends).
 */
export function patternLines(e, rings, budget = { left: HATCH_BUDGET }) {
  const defs = e && !e.solid ? patternDefs(e.tail) : [];
  if (!defs.length || !rings.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); y0 = Math.min(y0, r[i + 1]); x1 = Math.max(x1, r[i]); y1 = Math.max(y1, r[i + 1]); }
  const size = Math.hypot(x1 - x0, y1 - y0);
  if (!(size > 0)) return null;
  const max = Math.min(HATCH_MAX, budget.left), out = [];
  let segs = 0;
  for (const D of defs) {
    const c = Math.cos(D.a), s = Math.sin(D.a);
    // a point is t along the lines (c, s) and v across them (-s, c); line k: v = v0 + k * h, its dashes start at t0 + k * along
    let h = -s * D.o[0] + c * D.o[1], along = c * D.o[0] + s * D.o[1];
    if (!(Math.abs(h) > size * 1e-9)) continue; // lines on top of each other: nothing to draw
    if (h < 0) { h = -h; along = -along; } // (the same lines, numbered the other way)
    const v0 = -s * D.b[0] + c * D.b[1], t0 = c * D.b[0] + s * D.b[1];
    let vmin = Infinity, vmax = -Infinity;
    for (const r of rings) for (let i = 0; i < r.length; i += 2) { const v = -s * r[i] + c * r[i + 1]; vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
    const ka = Math.ceil((vmin - v0) / h), n = Math.floor((vmax - v0) / h) - ka + 1;
    if (n > max) return null;
    if (n <= 0) continue;
    // where each line crosses the boundary (an edge counts for the lines with lo <= v < hi: a vertex once)
    const hits = new Array(n);
    let crossings = 0;
    for (const r of rings) {
      const m = r.length / 2;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m, px = r[2 * i], py = r[2 * i + 1], qx = r[2 * j], qy = r[2 * j + 1];
        const vp = -s * px + c * py, vq = -s * qx + c * qy;
        if (vp === vq) continue;
        const lo = Math.min(vp, vq), hi = Math.max(vp, vq);
        for (let k = Math.max(0, Math.ceil((lo - v0) / h) - ka); k < n; k++) {
          const v = v0 + (k + ka) * h;
          if (v >= hi) break;
          if (v < lo) continue;
          const f = (v - vp) / (vq - vp);
          (hits[k] || (hits[k] = [])).push(c * (px + (qx - px) * f) + s * (py + (qy - py) * f));
          if (++crossings > 4 * max) return null;
        }
      }
    }
    const period = D.d.reduce((p, x) => p + Math.abs(x), 0);
    const emit = (v, ta, tb) => {
      out.push(c * ta - s * v, s * ta + c * v, c * tb - s * v, s * tb + c * v, NaN, NaN);
      return ++segs > max;
    };
    for (let k = 0; k < n; k++) {
      const t = hits[k];
      if (!t || t.length < 2) continue;
      t.sort((p, q) => p - q);
      const v = v0 + (k + ka) * h, o = t0 + (k + ka) * along;
      for (let i = 0; i + 1 < t.length; i += 2) {
        const ta = t[i], tb = t[i + 1];
        if (!(tb > ta)) continue;
        if (!(period > 0) || D.d.every((x) => x >= 0)) { if (emit(v, ta, tb)) return null; continue; } // a solid line
        if ((tb - ta) / period > max) return null;
        let p = o + Math.floor((ta - o) / period) * period;
        while (p < tb) {
          for (const x of D.d) {
            const q = p + Math.abs(x);
            if (x >= 0 && q >= ta && p <= tb && emit(v, Math.max(p, ta), Math.min(q, tb))) return null;
            p = q;
          }
        }
      }
    }
  }
  if (!segs) return null;
  out.length -= 2; // (no separator after the last segment)
  budget.left -= segs;
  return out;
}
