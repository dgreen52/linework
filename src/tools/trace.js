// Wire / net tracing (pure; loaded with the Trace tool). A connectivity graph of the scene's wires (open
// lines, line strings, chains and arcs outside cells) built once per drawing on a spatial hash: ends that
// meet, an end on another wire (a T) and junction dots (small filled shapes, small circles) join wires; a
// plain crossing does not (the schematic convention; `crossings` joins them). A wire end on a cell
// (connector, terminal strip) ends the net there, reported with the cell's nearest text (the pin); texts
// next to the net's wires are its labels. Scene-local coordinates throughout.
import { KIND, FLAG, CHAR_W } from '../scene.js';
import { entityItems } from '../edit/live-scene.js';
import { pickItem } from './snap.js';

export const ROLE = { WIRE: 1, DOT: 2, PART: 3, SHAPE: 4 };

const bufOf = (T) => class { // growable typed array (a class per type keeps push() fast)
  constructor() { this.a = new T(1024); this.n = 0; }
  push(v) { if (this.n === this.a.length) { const b = new T(this.n * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  get v() { return this.a.subarray(0, this.n); }
};
const I32 = bufOf(Int32Array), U8 = bufOf(Uint8Array), F64 = bufOf(Float64Array);

const textH = (t) => Math.hypot(t.m[2], t.m[3]) || 1;
/** Corners of a drawn text's box (descender to cap height): [x0, y0, ... x3, y3]. */
export function textQuad(t) {
  const W = t.fit || (t.w != null ? t.w : CHAR_W * t.s.length), u0 = t.align === 0 ? 0 : t.align === 1 ? -W / 2 : -W, [a, b, c, d] = t.m, q = [];
  for (const [u, v] of [[u0, -0.2], [u0 + W, -0.2], [u0 + W, 1], [u0, 1]]) q.push(t.x + u * a + v * c, t.y + u * b + v * d);
  return q;
}
function d2seg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
}
const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
/** Segments AB and CD cross (each one's ends strictly on both sides of the other). */
const crosses = (ax, ay, bx, by, cx, cy, dx, dy) => orient(cx, cy, dx, dy, ax, ay) * orient(cx, cy, dx, dy, bx, by) < 0 && orient(ax, ay, bx, by, cx, cy) * orient(ax, ay, bx, by, dx, dy) < 0;
function inQuad(q, x, y) {
  let s = 0;
  for (let k = 0; k < 8; k += 2) {
    const o = Math.sign(orient(q[k], q[k + 1], q[(k + 2) % 8], q[(k + 3) % 8], x, y));
    if (o) { if (s && o !== s) return false; s = o; }
  }
  return true;
}
/** Distance from a text quad to segment AB (0 when they overlap). */
export function quadDist(q, ax, ay, bx, by) {
  if (inQuad(q, ax, ay) || inQuad(q, bx, by)) return 0;
  let m = Infinity;
  for (let k = 0; k < 8; k += 2) {
    const x0 = q[k], y0 = q[k + 1], x1 = q[(k + 2) % 8], y1 = q[(k + 3) % 8];
    if (crosses(x0, y0, x1, y1, ax, ay, bx, by)) return 0;
    m = Math.min(m, d2seg(x0, y0, ax, ay, bx, by), d2seg(ax, ay, x0, y0, x1, y1), d2seg(bx, by, x0, y0, x1, y1));
  }
  return Math.sqrt(m);
}
const conicAt = (K, k, t) => [K[k] + K[k + 2] * Math.cos(t) + K[k + 4] * Math.sin(t), K[k + 1] + K[k + 3] * Math.cos(t) + K[k + 5] * Math.sin(t)];

/** Uniform hash of boxes: add() every item, fill(), add() them again, done(); near(box) -> n distinct ids in hits. */
class Hash {
  constructor(b, cs) {
    this.nx = Math.max(1, Math.min(4096, Math.ceil((b[2] - b[0]) / cs))); this.ny = Math.max(1, Math.min(4096, Math.ceil((b[3] - b[1]) / cs)));
    this.x0 = b[0]; this.y0 = b[1]; this.cw = (b[2] - b[0]) / this.nx || 1; this.ch = (b[3] - b[1]) / this.ny || 1;
    this.start = new Uint32Array(this.nx * this.ny + 1); this.f = null;
  }
  ix(x) { const i = Math.floor((x - this.x0) / this.cw); return i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i; }
  iy(y) { const i = Math.floor((y - this.y0) / this.ch); return i < 0 ? 0 : i >= this.ny ? this.ny - 1 : i; }
  add(j, x0, y0, x1, y1) {
    const nx = this.nx, i0 = this.ix(x0), i1 = this.ix(x1), j0 = this.iy(y0), j1 = this.iy(y1), f = this.f;
    if (f) { const items = this.items; for (let r = j0; r <= j1; r++) for (let c = r * nx + i0, ce = r * nx + i1; c <= ce; c++) items[f[c]++] = j; }
    else { const start = this.start; for (let r = j0; r <= j1; r++) for (let c = r * nx + i0 + 1, ce = r * nx + i1 + 1; c <= ce; c++) start[c]++; }
  }
  fill() {
    const N = this.nx * this.ny, start = this.start;
    for (let c = 1; c <= N; c++) start[c] += start[c - 1];
    this.f = start.slice(0, N); this.items = new Uint32Array(start[N]);
  }
  done(count) { this.f = null; this.stamp = new Uint32Array(count); this.q = 0; this.hits = new Int32Array(256); }
  near(x0, y0, x1, y1) {
    if (++this.q === 0xffffffff) { this.stamp.fill(0); this.q = 1; }
    const { start, items, stamp, q, nx } = this, i0 = this.ix(x0), i1 = this.ix(x1), j1 = this.iy(y1);
    let n = 0, hits = this.hits;
    for (let r = this.iy(y0); r <= j1; r++) {
      for (let c = r * nx + i0, ce = r * nx + i1; c <= ce; c++) {
        for (let k = start[c], ke = start[c + 1]; k < ke; k++) {
          const j = items[k];
          if (stamp[j] === q) continue;
          stamp[j] = q;
          if (n === hits.length) { const h = new Int32Array(n * 2); h.set(hits); this.hits = hits = h; }
          hits[n++] = j;
        }
      }
    }
    return n;
  }
}
/** Adjacency of n nodes (both directions) from the edges a[k] - b[k]. */
function csr(n, a, b, m) {
  const start = new Uint32Array(n + 1), adj = new Int32Array(2 * m);
  for (let k = 0; k < m; k++) { start[a[k] + 1]++; start[b[k] + 1]++; }
  for (let i = 1; i <= n; i++) start[i] += start[i - 1];
  const f = start.slice(0, n);
  for (let k = 0; k < m; k++) { adj[f[a[k]]++] = b[k]; adj[f[b[k]]++] = a[k]; }
  return { start, adj };
}

/**
 * The connectivity graph of the scene's wires, for traceNet / pickWire (build it again after an edit).
 * opts.tol: the largest gap still taken as touching (default 5 % of the median text height).
 */
export function buildNetGraph(scene, opts = {}) {
  for (const it = graphSteps(scene, opts); ;) { const r = it.next(); if (r.done) return r.value; }
}
/** The same a slice at a time (the page gets a turn every sliceMs): the graph (.busy: time working), or null once stale(). */
export async function buildNetGraphAsync(scene, opts = {}, sliceMs = 12, stale = () => false) {
  const it = graphSteps(scene, opts);
  for (let busy = 0, t = performance.now(); ;) {
    const r = it.next(), now = performance.now();
    if (r.done) { r.value.busy = busy + now - t; return r.value; }
    if (now - t < sliceMs) continue;
    busy += now - t;
    await new Promise((res) => setTimeout(res, 0));
    if (stale()) return null;
    t = performance.now();
  }
}

function* graphSteps(scene, opts) {
  const t0 = performance.now(), n = scene.n, dead = scene.dead, kind = scene.kind, flags = scene.flags, blk = scene.blk, bb = scene.bbox;
  const C = scene.coords, K = scene.conics, texts = scene.texts || [];
  // scale: the text height (a schematic's own unit), else the drawing size
  const hs = [];
  for (let k = 0, step = Math.max(1, Math.floor(texts.length / 4000)); k < texts.length; k += step) if (!texts[k].dead) hs.push(textH(texts[k]));
  hs.sort((x, y) => x - y);
  const H = hs.length ? hs[hs.length >> 1] : 0, e = scene.extents, D = Math.hypot(e[2] - e[0], e[3] - e[1]) || 1;
  const tol = opts.tol > 0 ? opts.tol : H ? Math.min(D * 1e-3, Math.max(D * 1e-9, H * 0.05)) : D * 1e-4, dotMax = H ? H * 1.6 : D * 0.01;
  // roles: a small filled item (or a small circle outside cells) is a dot; inside a cell a part; open: a wire; closed: a shape
  const role = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!(i & 4095)) yield;
    const f = flags[i], o = 4 * i, small = Math.max(bb[o + 2] - bb[o], bb[o + 3] - bb[o + 1]) <= dotMax;
    if ((dead && dead[i]) || kind[i] === KIND.POINT || f & FLAG.PATTERN) continue;
    if (f & FLAG.FILL) { if (small) role[i] = ROLE.DOT; continue; }
    let closed = !!(f & (FLAG.FULL | FLAG.CLOSED));
    if (kind[i] === KIND.POLY) {
      const s = scene.start[i] * 2, c = scene.count[i];
      if (c < 2) continue;
      closed = closed || (c >= 4 && Math.sqrt((C[s] - C[s + 2 * c - 2]) ** 2 + (C[s + 1] - C[s + 2 * c - 1]) ** 2) <= tol); // a line string closed on itself
    }
    role[i] = blk[i] ? ROLE.PART : !closed ? ROLE.WIRE : kind[i] === KIND.CONIC && small ? ROLE.DOT : ROLE.SHAPE;
  }
  // segments of item i (arcs as chords within tol / 2; fewer for cell parts and shapes): seg(ax, ay, bx, by)
  const segsOf = (i, seg) => {
    if (kind[i] === KIND.CONIC) {
      const k = scene.start[i] * 8, t0 = K[k + 6], dt = K[k + 7] - t0, R = Math.max(Math.hypot(K[k + 2], K[k + 3]), Math.hypot(K[k + 4], K[k + 5]));
      const m = Math.max(1, Math.min(role[i] === ROLE.WIRE ? 64 : 16, Math.ceil(dt / (R > 0 ? 2 * Math.acos(Math.max(-1, 1 - tol / (2 * R))) : 7))));
      let px = K[k] + K[k + 2] * Math.cos(t0) + K[k + 4] * Math.sin(t0), py = K[k + 1] + K[k + 3] * Math.cos(t0) + K[k + 5] * Math.sin(t0);
      for (let s = 1; s <= m; s++) {
        const c = Math.cos(t0 + (dt * s) / m), sn = Math.sin(t0 + (dt * s) / m), qx = K[k] + K[k + 2] * c + K[k + 4] * sn, qy = K[k + 1] + K[k + 3] * c + K[k + 5] * sn;
        seg(px, py, qx, qy);
        px = qx; py = qy;
      }
      return;
    }
    const s = scene.start[i] * 2, c = scene.count[i], last = flags[i] & FLAG.CLOSED ? c : c - 1;
    for (let k = 0; k < last; k++) { const u = s + 2 * k, v = s + 2 * ((k + 1) % c); if (C[u] === C[u] && C[v] === C[v]) seg(C[u], C[u + 1], C[v], C[v + 1]); }
  };
  // capsules: wire segments, and dots as a centre + radius
  let nc = 0, j = 0, cp = 0, cr = 0;
  const one = () => nc++;
  for (let i = 0; i < n; i++) if (role[i] === ROLE.DOT) nc++; else if (role[i] === ROLE.WIRE) segsOf(i, one);
  const S = new Float64Array(4 * nc), CP = new Int32Array(nc), CR = new Float64Array(nc), b = [Infinity, Infinity, -Infinity, -Infinity];
  const cap = (ax, ay, bx, by) => {
    S[4 * j] = ax; S[4 * j + 1] = ay; S[4 * j + 2] = bx; S[4 * j + 3] = by; CP[j] = cp; CR[j++] = cr;
    b[0] = Math.min(b[0], ax - cr, bx - cr); b[1] = Math.min(b[1], ay - cr, by - cr); b[2] = Math.max(b[2], ax + cr, bx + cr); b[3] = Math.max(b[3], ay + cr, by + cr);
  };
  for (cp = 0; cp < n; cp++) {
    if (!(cp & 2047)) yield;
    const o = 4 * cp, x = (bb[o] + bb[o + 2]) / 2, y = (bb[o + 1] + bb[o + 3]) / 2;
    if (role[cp] === ROLE.DOT) { cr = Math.max(bb[o + 2] - bb[o], bb[o + 3] - bb[o + 1]) / 2; cap(x, y, x, y); cr = 0; } else if (role[cp] === ROLE.WIRE) segsOf(cp, cap);
  }
  nc = j;
  if (!(b[0] <= b[2])) b.splice(0, 4, 0, 0, 1, 1);
  b[0] -= tol; b[1] -= tol; b[2] += tol; b[3] += tol;
  let total = 0;
  for (let k = 0; k < nc; k++) total += Math.sqrt((S[4 * k + 2] - S[4 * k]) ** 2 + (S[4 * k + 3] - S[4 * k + 1]) ** 2);
  const area = Math.max((b[2] - b[0]) * (b[3] - b[1]), 1e-300);
  const cs = Math.max(tol * 2, Math.sqrt(area / Math.min(1 << 19, Math.max(16, 2 * nc))), total / Math.max(1, nc) / 2, Math.sqrt(area / (1 << 22)));
  const G = { scene, n, role, tol, dotMax, H, caps: nc, seg: S, capPrim: CP, capR: CR }, hash = (G.hash = new Hash(b, cs));
  for (let pass = 0; pass < 2; pass++) {
    if (pass) hash.fill();
    for (let k = 0; k < nc; k++) {
      if (!(k & 8191)) yield;
      const ax = S[4 * k], ay = S[4 * k + 1], bx = S[4 * k + 2], by = S[4 * k + 3], r = CR[k] + tol;
      // a long diagonal goes in piece by piece (its box would cover many cells it does not touch)
      const m = Math.abs(bx - ax) > cs && Math.abs(by - ay) > cs ? Math.min(4096, Math.ceil(Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2) / cs)) : 1;
      for (let s = 0, px = ax, py = ay; s < m; s++) {
        const qx = ax + ((bx - ax) * (s + 1)) / m, qy = ay + ((by - ay) * (s + 1)) / m;
        hash.add(k, Math.min(px, qx) - r, Math.min(py, qy) - r, Math.max(px, qx) + r, Math.max(py, qy) + r);
        px = qx; py = qy;
      }
    }
  }
  hash.done(nc);
  // wire ends (in wire order), and the cell part or shape each one is on: the segments of cells and shapes
  // are matched against a hash of the ends (they are not hashed themselves)
  const EX = new F64(), EY = new F64();
  for (let p = 0; p < n; p++) {
    if (role[p] !== ROLE.WIRE) continue;
    if (kind[p] === KIND.CONIC) { const k = scene.start[p] * 8, a = conicAt(K, k, K[k + 6]), z = conicAt(K, k, K[k + 7]); EX.push(a[0]); EY.push(a[1]); EX.push(z[0]); EY.push(z[1]); }
    else { const s = scene.start[p] * 2, c = scene.count[p]; EX.push(C[s]); EY.push(C[s + 1]); EX.push(C[s + 2 * c - 2]); EY.push(C[s + 2 * c - 1]); }
  }
  const ne = EX.n, X = EX.a, Y = EY.a, eh = new Hash(b, cs), on = [new Int32Array(ne).fill(-1), new Int32Array(ne).fill(-1)], onD = [new Float64Array(ne).fill(Infinity), new Float64Array(ne).fill(Infinity)];
  for (let pass = 0; pass < 2; pass++) {
    if (pass) eh.fill();
    for (let k = 0; k < ne; k++) { if (!(k & 16383)) yield; eh.add(k, X[k], Y[k], X[k], Y[k]); }
  }
  eh.done(ne);
  for (cp = 0; cp < n; cp++) {
    if (!(cp & 1023)) yield;
    const w = role[cp] === ROLE.PART ? 0 : role[cp] === ROLE.SHAPE ? 1 : -1;
    if (w >= 0) segsOf(cp, (ax, ay, bx, by) => {
      const nh = eh.near(Math.min(ax, bx) - tol, Math.min(ay, by) - tol, Math.max(ax, bx) + tol, Math.max(ay, by) + tol);
      for (let h = 0; h < nh; h++) {
        const k = eh.hits[h], d = Math.sqrt(d2seg(X[k], Y[k], ax, ay, bx, by));
        if (d <= tol && d < onD[w][k]) { onD[w][k] = d; on[w][k] = cp; }
      }
    });
  }
  // the extent of each cell / block reference (not a sheet frame), for wire ends drawn into one
  const cellBox = new Map();
  for (let i = 0; i < n; i++) {
    if (!(i & 8191)) yield;
    if (!blk[i] || (role[i] !== ROLE.PART && role[i] !== ROLE.DOT)) continue;
    const o = 4 * i, q = cellBox.get(scene.ent[i]) || [Infinity, Infinity, -Infinity, -Infinity];
    cellBox.set(scene.ent[i], [Math.min(q[0], bb[o]), Math.min(q[1], bb[o + 1]), Math.max(q[2], bb[o + 2]), Math.max(q[3], bb[o + 3])]);
  }
  const cells = [...cellBox].filter(([, q]) => !(q[2] - q[0] > (e[2] - e[0]) * 0.3 && q[3] - q[1] > (e[3] - e[1]) * 0.3)), cellHash = new Hash(b, cs * 4);
  for (let pass = 0; pass < 2; pass++) {
    if (pass) cellHash.fill();
    cells.forEach(([, q], k) => cellHash.add(k, q[0] - tol, q[1] - tol, q[2] + tol, q[3] + tol));
  }
  cellHash.done(cells.length);
  // edges between wires (and dots); where each wire end stops: 1 a cell, 2 a shape, 3 nothing (open)
  const eA = new I32(), eB = new I32(), rec = { wire: new I32(), kind: new U8(), part: new I32(), ent: new I32(), x: new F64(), y: new F64() }, recStart = new Uint32Array(n + 1);
  const addRec = (p, k, part, id, x, y) => { rec.wire.push(p); rec.kind.push(k); rec.part.push(part); rec.ent.push(id); rec.x.push(x); rec.y.push(y); };
  const endAt = (p, e) => {
    const x = X[e], y = Y[e], nh = hash.near(x - tol, y - tol, x + tol, y + tol), hits = hash.hits;
    let joined = false, cell = on[0][e], dc = onD[0][e];
    for (let h = 0; h < nh; h++) {
      const k = hits[h], q = CP[k];
      if (q === p) continue;
      const d = Math.sqrt(d2seg(x, y, S[4 * k], S[4 * k + 1], S[4 * k + 2], S[4 * k + 3])) - CR[k];
      if (d > tol) continue;
      eA.push(p); eB.push(q); joined = true;
      if (blk[q] && d < dc) { dc = d; cell = q; } // a pin dot of a cell
    }
    if (cell >= 0) addRec(p, 1, cell, scene.ent[cell], x, y);
    else if (on[1][e] >= 0) addRec(p, 2, on[1][e], -1, x, y);
    else if (!joined) { // inside a cell's extent (drawn into a connector up to its pin text)? the smallest one
      const nh2 = cellHash.near(x, y, x, y);
      let best = -1, ba = Infinity;
      for (let h = 0; h < nh2; h++) {
        const [id, q] = cells[cellHash.hits[h]], a = (q[2] - q[0]) * (q[3] - q[1]);
        if (x >= q[0] - tol && x <= q[2] + tol && y >= q[1] - tol && y <= q[3] + tol && a < ba) { ba = a; best = id; }
      }
      addRec(p, best >= 0 ? 1 : 3, -1, best, x, y);
    }
  };
  for (let p = 0, e = 0; p < n; p++) {
    if (!(p & 1023)) yield;
    recStart[p] = rec.wire.n;
    if (role[p] === ROLE.WIRE) { endAt(p, e++); endAt(p, e++); }
  }
  recStart[n] = rec.wire.n;
  for (let k = 0; k < nc; k++) { // a dot joins every wire through or touching it
    if (!(k & 8191)) yield;
    const d = CP[k], x = S[4 * k], y = S[4 * k + 1], r = CR[k] + tol;
    if (role[d] !== ROLE.DOT) continue;
    const nh = hash.near(x - r, y - r, x + r, y + r), hits = hash.hits;
    for (let h = 0; h < nh; h++) { const i = hits[h]; if (role[CP[i]] === ROLE.WIRE && d2seg(x, y, S[4 * i], S[4 * i + 1], S[4 * i + 2], S[4 * i + 3]) <= r * r) { eA.push(d); eB.push(CP[i]); } }
  }
  Object.assign(G, csr(n, eA.a, eB.a, eA.n));
  G.rec = { wire: rec.wire.v, kind: rec.kind.v, part: rec.part.v, ent: rec.ent.v, x: rec.x.v, y: rec.y.v, start: recStart, pin: new Map() };
  G.cellRecs = new Map();
  for (let r = 0; r < rec.wire.n; r++) if (G.rec.kind[r] === 1) { const id = G.rec.ent[r]; if (!G.cellRecs.has(id)) G.cellRecs.set(id, []); G.cellRecs.get(id).push(r); }
  // labels: a text belongs to the nearest wire within 0.8 of its height
  const textWire = (G.textWire = new Int32Array(texts.length).fill(-1));
  for (let t = 0; t < texts.length; t++) {
    if (!(t & 511)) yield;
    if (texts[t].dead || !texts[t].s) continue;
    const q = textQuad(texts[t]), dm = 0.8 * textH(texts[t]), xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    const nh = hash.near(Math.min(...xs) - dm, Math.min(...ys) - dm, Math.max(...xs) + dm, Math.max(...ys) + dm), hits = hash.hits;
    let bd = dm;
    for (let h = 0; h < nh; h++) {
      const k = hits[h];
      if (role[CP[k]] !== ROLE.WIRE) continue;
      const d = quadDist(q, S[4 * k], S[4 * k + 1], S[4 * k + 2], S[4 * k + 3]);
      if (d <= bd) { bd = d; textWire[t] = CP[k]; }
    }
  }
  G.ms = performance.now() - t0;
  return G;
}

/** Edges between wires that cross (made once, when `crossings` is first asked for). */
function crossAdj(G) {
  if (G.cross) return G.cross;
  const { seg: S, capPrim: CP, capR: CR, role, hash } = G, a = new I32(), b = new I32();
  for (let j = 0; j < G.caps; j++) {
    const p = CP[j], ax = S[4 * j], ay = S[4 * j + 1], bx = S[4 * j + 2], by = S[4 * j + 3];
    if (role[p] !== ROLE.WIRE || CR[j]) continue;
    const nh = hash.near(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)), hits = hash.hits;
    for (let h = 0; h < nh; h++) {
      const k = hits[h], q = CP[k];
      if (k > j && q !== p && role[q] === ROLE.WIRE && crosses(ax, ay, bx, by, S[4 * k], S[4 * k + 1], S[4 * k + 2], S[4 * k + 3])) { a.push(p); b.push(q); }
    }
  }
  return (G.cross = csr(G.n, a.a, b.a, a.n));
}

/** The wire (or junction dot) nearest to (x, y) within r, else the wire ending on the cell part there; -1 if none. */
export function pickWire(G, x, y, r, isVisible = () => true) {
  const { seg: S, capPrim: CP, capR: CR, rec: R } = G, L = G.scene.layer, nh = G.hash.near(x - r, y - r, x + r, y + r);
  let best = -1, bd = r;
  for (let h = 0; h < nh; h++) {
    const j = G.hash.hits[h], d = Math.sqrt(d2seg(x, y, S[4 * j], S[4 * j + 1], S[4 * j + 2], S[4 * j + 3])) - CR[j];
    if (d <= bd && isVisible(L[CP[j]])) { bd = d; best = CP[j]; }
  }
  const it = best < 0 && pickItem(G.scene, x, y, r, isVisible);
  for (let k = 0, bd2 = Infinity; it && G.role[it.id] === ROLE.PART && k < R.wire.length; k++) {
    const d = Math.hypot(R.x[k] - x, R.y[k] - y);
    if (R.part[k] === it.id && isVisible(L[R.wire[k]]) && d < bd2) { bd2 = d; best = R.wire[k]; }
  }
  return best;
}

/** Where wire end r stops in a cell: { s: its nearest text (the pin), ref: the cell's tallest text when taller }. */
function pinOf(G, r) {
  const R = G.rec, T = G.scene.texts;
  if (R.pin.has(r)) return R.pin.get(r);
  let pin = null, bd = Infinity, top = null;
  for (const t of entityItems(G.scene, R.ent[r]).texts) {
    if (T[t].dead || !T[t].s.trim()) continue;
    const d = quadDist(textQuad(T[t]), R.x[r], R.y[r], R.x[r], R.y[r]);
    if (d < bd) { bd = d; pin = T[t]; }
    if (!top || textH(T[t]) > textH(top)) top = T[t];
  }
  const v = { s: pin ? pin.s.trim() : '', ref: pin && top !== pin && textH(top) > 1.2 * textH(pin) ? top.s.trim() : '' };
  R.pin.set(r, v);
  return v;
}
/** A hash of the drawing's texts (their boxes), made once per graph: for the texts by open ends and symbols. */
function textHash(G) {
  if (G.textHash) return G.textHash;
  const T = G.scene.texts, live = [], b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let t = 0; t < T.length; t++) {
    if (T[t].dead || !T[t].s.trim()) continue;
    const q = T[t].bbox;
    live.push(t);
    b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[2]); b[3] = Math.max(b[3], q[3]);
  }
  if (!live.length) b.splice(0, 4, 0, 0, 1, 1);
  const cs = Math.max(G.H || G.tol, Math.sqrt(((b[2] - b[0]) * (b[3] - b[1])) / Math.min(1 << 18, Math.max(16, 2 * live.length))), 1e-12);
  const h = new Hash(b, cs);
  for (let pass = 0; pass < 2; pass++) {
    if (pass) h.fill();
    for (const t of live) { const q = T[t].bbox; h.add(t, q[0], q[1], q[2], q[3]); }
  }
  h.done(T.length);
  return (G.textHash = h);
}
/** The text nearest to (x, y) within `within` (the first one on a tie) that is not a label of the net (its wires: G.mark === id), or ''. */
function textNear(G, x, y, within, id) {
  const T = G.scene.texts, th = textHash(G), x0 = x - within, y0 = y - within, x1 = x + within, y1 = y + within, nh = th.near(x0, y0, x1, y1);
  let best = -1, bd = within;
  for (let h = 0; h < nh; h++) {
    const k = th.hits[h], t = T[k], b = t.bbox, w = G.textWire[k];
    if (b[0] > x1 || b[2] < x0 || b[1] > y1 || b[3] < y0 || (w >= 0 && G.mark[w] === id)) continue;
    const d = quadDist(textQuad(t), x, y, x, y);
    if (d < bd || (d === bd && k < best)) { bd = d; best = k; }
  }
  return best >= 0 ? T[best].s.trim() : '';
}
function arcLength(K, k) {
  const ru = Math.hypot(K[k + 2], K[k + 3]), rv = Math.hypot(K[k + 4], K[k + 5]), t0 = K[k + 6], t1 = K[k + 7];
  if (Math.abs(ru - rv) <= 1e-9 * ru && Math.abs(K[k + 2] * K[k + 4] + K[k + 3] * K[k + 5]) <= 1e-9 * ru * ru) return ru * (t1 - t0); // circular: exact
  let L = 0;
  for (let s = 1, p = conicAt(K, k, t0); s <= 256; s++) { const q = conicAt(K, k, t0 + ((t1 - t0) * s) / 256); L += Math.hypot(q[0] - p[0], q[1] - p[1]); p = q; }
  return L;
}

/** Marks of the walks on a graph: G.mark[p] === id for the primitives of walk `id` (one array per graph, none per trace). */
function marks(G, walks = 1) {
  if (!G.mark || G.markId > 0x7ffffff0 - walks) { G.mark = new Int32Array(G.n); G.markId = 0; }
  return G.mark;
}
/** The texts next to each wire (from G.textWire, made once per graph): wire p's are list[start[p]] .. list[start[p + 1] - 1], in text order. */
function wireTexts(G) {
  if (G.wireTexts) return G.wireTexts;
  const tw = G.textWire, start = new Uint32Array(G.n + 1);
  for (let t = 0; t < tw.length; t++) if (tw[t] >= 0) start[tw[t] + 1]++;
  for (let i = 1; i <= G.n; i++) start[i] += start[i - 1];
  const f = start.slice(0, G.n), list = new Int32Array(start[G.n]);
  for (let t = 0; t < tw.length; t++) if (tw[t] >= 0) list[f[tw[t]]++] = t;
  return (G.wireTexts = { start, list });
}
/** Walk the net through `seed`, marking its primitives with `id`: { wires, dots, recs (its wire end records) }. */
function walk(G, seed, opts, id) {
  const S = G.scene, vis = opts.isVisible || (() => true), R = G.rec, mark = G.mark;
  const q = [], wires = [], dots = [], recs = [], cross = opts.crossings ? crossAdj(G) : null, pins = new Set();
  const visit = (v) => { if (v >= 0 && mark[v] !== id && G.role[v] && vis(S.layer[v])) { mark[v] = id; q.push(v); } };
  visit(seed);
  while (q.length) {
    const u = q.pop();
    (G.role[u] === ROLE.DOT ? dots : wires).push(u);
    for (let k = G.start[u]; k < G.start[u + 1]; k++) visit(G.adj[k]);
    if (cross) for (let k = cross.start[u]; k < cross.start[u + 1]; k++) visit(cross.adj[k]);
    for (let r = R.start[u]; r < R.start[u + 1]; r++) {
      recs.push(r);
      const p = opts.throughPins && R.kind[r] === 1 && pinOf(G, r).s, key = R.ent[r] + '\u0000' + p;
      if (!p || pins.has(key)) continue;
      pins.add(key);
      for (const r2 of G.cellRecs.get(R.ent[r])) if (pinOf(G, r2).s === p) visit(R.wire[r2]);
    }
  }
  return { wires, dots, recs };
}

/**
 * The net through wire (or dot) `seed`. opts: { crossings, throughPins (wires on the same pin text of the
 * same cell join), isVisible(layer) }. Returns { wires, dots, parts (prim ids), count (wires as drawn),
 * junctions, length, segments, labels: [{ s, texts }], ends: [{ kind: 'cell'|'shape'|'open', x, y, name,
 * pin, ref, label, ent, part }], bbox, ms }.
 */
export function traceNet(G, seed, opts = {}) {
  const t0 = performance.now();
  marks(G);
  const id = ++G.markId;
  return summary(G, seed, walk(G, seed, opts, id), id, opts, t0);
}

/**
 * Every net of the drawing (each wire in exactly one; wires on hidden layers left out), as traceNet gives
 * them, in reading order (top left first). One graph, one walk per net. opts as traceNet.
 */
export function traceAll(G, opts = {}) {
  const S = G.scene, vis = opts.isVisible || (() => true), mark = marks(G, G.n), first = G.markId + 1, nets = [];
  for (let p = 0; p < G.n; p++) {
    if (G.role[p] !== ROLE.WIRE || mark[p] >= first || !vis(S.layer[p])) continue;
    const t0 = performance.now(), id = ++G.markId, net = summary(G, p, walk(G, p, opts, id), id, opts, t0);
    if (net.wires.length) nets.push(net);
  }
  return nets.sort((a, b) => b.bbox[3] - a.bbox[3] || a.bbox[0] - b.bbox[0] || a.seed - b.seed);
}

/** The net of a walk: length, ends, labels (see traceNet). */
function summary(G, seed, { wires, dots, recs }, id, opts, t0) {
  const S = G.scene, vis = opts.isVisible || (() => true), R = G.rec, at = (x, y) => Math.round(x / G.tol) + ',' + Math.round(y / G.tol);
  const C = S.coords, bbox = [Infinity, Infinity, -Infinity, -Infinity];
  let length = 0, segments = 0;
  for (const p of [...wires, ...dots]) {
    const o = 4 * p;
    bbox[0] = Math.min(bbox[0], S.bbox[o]); bbox[1] = Math.min(bbox[1], S.bbox[o + 1]); bbox[2] = Math.max(bbox[2], S.bbox[o + 2]); bbox[3] = Math.max(bbox[3], S.bbox[o + 3]);
    if (G.role[p] !== ROLE.WIRE) continue;
    if (S.kind[p] === KIND.CONIC) { length += arcLength(S.conics, S.start[p] * 8); segments++; continue; }
    const s = S.start[p] * 2, c = S.count[p];
    for (let k = 1; k < c; k++) length += Math.sqrt((C[s + 2 * k] - C[s + 2 * k - 2]) ** 2 + (C[s + 2 * k + 1] - C[s + 2 * k - 1]) ** 2);
    segments += c - 1;
  }
  // ends: one per cell pin, shape or open end
  const ends = [], keys = new Set(), parts = new Set(), endCells = new Set(), H = G.H || G.tol * 20;
  for (const r of recs) {
    const kind = R.kind[r], x = R.x[r], y = R.y[r], part = R.part[r], ent = R.ent[r], o = 4 * part;
    let e;
    if (part >= 0) parts.add(part);
    if (kind === 1) {
      const p = pinOf(G, r);
      endCells.add(ent);
      e = { kind: 'cell', name: S.blockNames[S.blk[part >= 0 ? part : entityItems(S, ent).prims[0]]] || 'Cell', pin: p.s, ref: p.ref, key: `c${ent}:${p.s || at(x, y)}` };
    } else if (kind === 2) {
      e = { kind: 'shape', name: S.kind[part] === KIND.CONIC ? 'Circle' : 'Shape', key: `s${part}:${at(x, y)}`, // the text in / by the symbol
        label: textNear(G, (S.bbox[o] + S.bbox[o + 2]) / 2, (S.bbox[o + 1] + S.bbox[o + 3]) / 2, Math.max(S.bbox[o + 2] - S.bbox[o], S.bbox[o + 3] - S.bbox[o + 1]) / 2 + H, id) };
    } else e = { kind: 'open', name: 'Open end', key: 'o' + at(x, y), label: textNear(G, x, y, 2 * H, id) };
    if (!keys.has(e.key)) { keys.add(e.key); ends.push(Object.assign(e, { x, y, ent, part })); }
  }
  const order = { cell: 0, shape: 1, open: 2 };
  ends.sort((a, b) => order[a.kind] - order[b.kind] || b.y - a.y || a.x - b.x);
  // labels: texts whose nearest wire is in the net (not the pin texts of the cells it ends in); only the
  // texts next to its own wires are looked at (each one trimmed once), in text order
  const byS = new Map(), T = S.texts, WT = wireTexts(G), near = [];
  for (const p of wires) for (let k = WT.start[p]; k < WT.start[p + 1]; k++) near.push(WT.list[k]);
  if (wires.length > 1) near.sort((a, b) => a - b);
  for (const t of near) {
    if (T[t].dead || !vis(T[t].layer) || endCells.has(T[t].ent)) continue;
    const s = T[t].s.trim();
    if (!byS.has(s)) byS.set(s, { s, texts: [] });
    byS.get(s).texts.push(t);
  }
  const labels = [...byS.values()].sort((a, b) => T[b.texts[0]].y - T[a.texts[0]].y || T[a.texts[0]].x - T[b.texts[0]].x);
  // as drawn: a chain with arcs is one wire, a filled circle (fill + outline) one junction dot, a pin dot in a cell none
  const count = new Set(wires.map((p) => S.ent[p])).size, junctions = new Set(dots.filter((p) => !S.blk[p]).map((p) => at((S.bbox[4 * p] + S.bbox[4 * p + 2]) / 2, (S.bbox[4 * p + 1] + S.bbox[4 * p + 3]) / 2))).size;
  return { seed, wires, dots, parts: [...parts], count, junctions, length, segments, labels, ends, bbox, ms: performance.now() - t0 };
}

/** One line per end: "J4 · 3 (CONN)", "TB1-1 (TERM)", "K1 (circle)", "Open end · TO SH 2". */
export function endText(e) {
  if (e.kind === 'cell') return e.pin ? `${e.ref ? e.ref + ' · ' : ''}${e.pin} (${e.name})` : e.name;
  if (e.kind === 'shape') return e.label ? `${e.label} (${e.name.toLowerCase()})` : e.name;
  return e.label ? `Open end · ${e.label}` : 'Open end';
}

/** The net as plain text (Copy). o: { name (drawing), origin, dec, abbr, fmt(number, decimals) }. */
export function netText(net, o) {
  const f = o.fmt || ((v, d) => v.toFixed(d)), u = o.abbr ? ' ' + o.abbr : '', [ox, oy] = o.origin || [0, 0], pl = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  return [`Net ${net.labels.map((l) => l.s).join(', ') || '(no label)'}${o.name ? ' · ' + o.name : ''}`,
    `Length ${f(net.length, o.dec)}${u} · ${pl(net.count, 'wire')} · ${pl(net.segments, 'segment')}${net.junctions ? ' · ' + pl(net.junctions, 'junction dot') : ''}`,
    `Ends (${net.ends.length}):`, ...net.ends.map((e, k) => `  ${k + 1}. ${endText(e)} at X ${f(e.x + ox, o.dec)} Y ${f(e.y + oy, o.dec)}`)].join('\n');
}
