// Revision compare (no DOM): items (top-level entities) only in A, only in B, or in both. Items are
// described by what they draw (layer, colour, line type, weight, geometry, text) and, in DGN, by the
// hash of their element bytes (a match wherever they sit in the file). Left-overs are paired: the
// same shape elsewhere is "moved", the same kind on the same layer in the same place "changed".
import { KIND } from '../scene.js';
import { entityItems } from '../edit/live-scene.js';

/** 53-bit hash of a string (cyrb53), as base-36 text. */
export function hashStr(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Rounding step: a power of ten about 1e-9 of the larger drawing. */
export function quantum(...scenes) {
  let d = 0;
  for (const s of scenes) { const e = s.extents; d = Math.max(d, Math.hypot(e[2] - e[0], e[3] - e[1])); }
  return 10 ** Math.floor(Math.log10(Math.max(d, 1e-6) * 1e-9));
}

/** Entity slots of a scene (an edited one may have more than it was built with). */
function entityCount(scene) {
  let n = scene.E || 0;
  if (scene.override) for (const k of scene.override.keys()) if (k >= n) n = k + 1;
  return n;
}

/**
 * Live entities of a scene: [{ ent, bh (byte hash), gk (geometry key), sk (without position), type,
 * layer, text, bbox (absolute) }]. opts: { q (rounding step), bytesKey(i) }.
 */
export function describeScene(scene, opts = {}) {
  const q = opts.q || 1e-9, [ox, oy] = scene.origin, out = [];
  const R = (v) => Math.round(v / q), A = (v) => Math.round(v * 1e9);
  const { coords: co, conics: cn, bbox: bb, dead } = scene;
  for (let i = 0, n = entityCount(scene); i < n; i++) {
    const it = entityItems(scene, i);
    const g = [], sh = [], box = [Infinity, Infinity, -Infinity, -Infinity];
    let rx = null, ry = 0, type = null, layer = null, text = null;
    const at = (x, y) => { if (rx === null) { rx = x; ry = y; } };
    const grow = (x0, y0, x1, y1) => { if (x0 < box[0]) box[0] = x0; if (y0 < box[1]) box[1] = y0; if (x1 > box[2]) box[2] = x1; if (y1 > box[3]) box[3] = y1; };
    for (const p of it.prims) {
      if (dead && dead[p]) continue;
      const k = scene.kind[p], L = scene.layers[scene.layer[p]].name, lt = scene.ltypes[scene.style[p]];
      if (type === null) { type = scene.srcNames ? scene.srcNames[scene.src[p]] : ''; layer = L; }
      const head = `${k}|${L}|${scene.color[p]}|${lt ? lt.name : ''}|${scene.weight[p]}|${scene.flags[p]}|`;
      let pos = '', rel = '';
      if (k === KIND.CONIC) {
        const o = scene.start[p] * 8, x = cn[o] + ox, y = cn[o + 1] + oy;
        at(x, y);
        const tail = `,${R(cn[o + 2])},${R(cn[o + 3])},${R(cn[o + 4])},${R(cn[o + 5])},${A(cn[o + 6])},${A(cn[o + 7])}`;
        pos = R(x) + ',' + R(y) + tail; rel = R(x - rx) + ',' + R(y - ry) + tail;
      } else {
        const s = scene.start[p] * 2, e = s + scene.count[p] * 2;
        for (let j = s; j < e; j += 2) {
          if (co[j] !== co[j]) { pos += ';'; rel += ';'; continue; }
          const x = co[j] + ox, y = co[j + 1] + oy;
          at(x, y);
          pos += R(x) + ',' + R(y) + ' '; rel += R(x - rx) + ',' + R(y - ry) + ' ';
        }
      }
      g.push(head + pos); sh.push(head + rel);
      const o = 4 * p;
      grow(bb[o] + ox, bb[o + 1] + oy, bb[o + 2] + ox, bb[o + 3] + oy);
    }
    for (const t of it.texts) {
      const T = scene.texts[t];
      if (T.dead) continue;
      const x = T.x + ox, y = T.y + oy, L = scene.layers[T.layer].name;
      at(x, y);
      if (type === null) { type = 'TEXT'; layer = L; }
      if (text === null) text = T.s;
      const head = `t|${L}|${T.color}|${T.align}|${R(T.fit || 0)}|${T.m.map(R).join(',')}|${T.s}|`;
      g.push(head + R(x) + ',' + R(y)); sh.push(head + R(x - rx) + ',' + R(y - ry));
      grow(T.bbox[0] + ox, T.bbox[1] + oy, T.bbox[2] + ox, T.bbox[3] + oy);
    }
    if (!g.length) continue;
    out.push({ ent: i, bh: opts.bytesKey ? opts.bytesKey(i) : null, gk: hashStr(g.join('\n')), sk: hashStr(sh.join('\n')), type: type || '', layer: layer || '', text, bbox: box });
  }
  return out;
}

const overlaps = (a, b, pad) => a[0] - pad <= b[2] && b[0] - pad <= a[2] && a[1] - pad <= b[3] && b[1] - pad <= a[3];
const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const union = (a, b) => (!a ? b.slice() : !b ? a.slice() : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);

/**
 * { same, sameBytes, onlyA, onlyB (indices), changes: [{ kind: moved | changed | removed | added, a, b,
 * bbox, type, layer, text, text2 }] (top to bottom, left to right) }.
 */
export function diffScenes(A, B) {
  const sa = new Uint8Array(A.length), sb = new Uint8Array(B.length); // 0 free, 1 same, 2 paired as a change
  const match = (key, mark) => {
    const idx = new Map(), out = [];
    B.forEach((d, j) => { if (!sb[j] && d[key] != null) { const l = idx.get(d[key]); if (l) l.push(j); else idx.set(d[key], [j]); } });
    A.forEach((d, i) => {
      if (sa[i] || d[key] == null) return;
      const l = idx.get(d[key]);
      if (!l || !l.length) return;
      const j = l.pop();
      sa[i] = sb[j] = mark;
      out.push([i, j]);
    });
    return out;
  };
  const sameBytes = match('bh', 1).length; // DGN: identical element bytes
  const same = sameBytes + match('gk', 1).length; // identical geometry and attributes
  const moved = match('sk', 2); // the same thing somewhere else
  // the same kind on the same layer, overlapping: changed (the nearest one)
  const changed = [], byKey = new Map();
  B.forEach((d, j) => { if (!sb[j]) { const k = d.type + '|' + d.layer; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(j); } });
  A.forEach((d, i) => {
    const l = byKey.get(d.type + '|' + d.layer);
    if (sa[i] || !l || l.length > 20000) return;
    const pad = 0.1 * Math.max(d.bbox[2] - d.bbox[0], d.bbox[3] - d.bbox[1]), [cx, cy] = centre(d.bbox);
    let best = -1, bd = Infinity;
    for (const j of l) {
      if (sb[j] || !overlaps(d.bbox, B[j].bbox, pad)) continue;
      const [x, y] = centre(B[j].bbox), dd = Math.hypot(x - cx, y - cy);
      if (dd < bd) { bd = dd; best = j; }
    }
    if (best >= 0) { sa[i] = sb[best] = 2; changed.push([i, best]); }
  });
  const changes = [];
  const add = (kind, i, j) => {
    const a = i >= 0 ? A[i] : null, b = j >= 0 ? B[j] : null, d = a || b;
    changes.push({ kind, a: i, b: j, bbox: union(a && a.bbox, b && b.bbox), type: d.type, layer: d.layer, text: d.text, text2: a && b && a.text !== b.text ? b.text : null });
  };
  for (const [i, j] of moved) add('moved', i, j);
  for (const [i, j] of changed) add('changed', i, j);
  A.forEach((d, i) => { if (!sa[i]) add('removed', i, -1); });
  B.forEach((d, j) => { if (!sb[j]) add('added', -1, j); });
  changes.sort((p, q) => { const a = centre(p.bbox), b = centre(q.bbox); return b[1] - a[1] || a[0] - b[0]; });
  const onlyA = [], onlyB = [];
  sa.forEach((v, i) => { if (v !== 1) onlyA.push(i); });
  sb.forEach((v, j) => { if (v !== 1) onlyB.push(j); });
  return { same, sameBytes, onlyA, onlyB, changes };
}
