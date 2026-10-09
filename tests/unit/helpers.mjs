import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDrawing } from '../../src/formats/detect.js';
import { buildScene, KIND, conicPoint } from '../../src/scene.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fixture = (name) => {
  for (const dir of ['samples', 'tests/fixtures']) {
    const p = join(ROOT, dir, name);
    if (existsSync(p)) return p;
  }
  throw new Error('missing fixture ' + name);
};
export const bytes = (name) => new Uint8Array(readFileSync(fixture(name)));
export function load(name) {
  const model = parseDrawing(bytes(name), name);
  const scene = buildScene(model, { fileName: name });
  return { model, scene };
}

/** World-space point lists of every POLY primitive. */
export function polys(scene) {
  const out = [];
  const [ox, oy] = scene.origin;
  for (let i = 0; i < scene.n; i++) {
    if (scene.kind[i] !== KIND.POLY) continue;
    const s = scene.start[i] * 2, n = scene.count[i];
    const pts = [];
    for (let k = 0; k < n; k++) pts.push([scene.coords[s + 2 * k] + ox, scene.coords[s + 2 * k + 1] + oy]);
    out.push({ i, pts, layer: scene.layers[scene.layer[i]].name, color: scene.color[i] });
  }
  return out;
}

const close = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

/** Is there a POLY primitive with consecutive vertices a -> b (either direction)? */
export function findSegment(scene, a, b, tol = 1e-6) {
  for (const p of polys(scene)) {
    for (let k = 0; k + 1 < p.pts.length; k++) {
      const u = p.pts[k], v = p.pts[k + 1];
      if ((close(u, a, tol) && close(v, b, tol)) || (close(u, b, tol) && close(v, a, tol))) return p;
    }
  }
  return null;
}

/** World-space conics: { i, c:[x,y], u:[x,y], v:[x,y], t0, t1, start:[x,y], end:[x,y], color } */
export function conics(scene) {
  const out = [];
  const [ox, oy] = scene.origin;
  for (let i = 0; i < scene.n; i++) {
    if (scene.kind[i] !== KIND.CONIC) continue;
    const c = scene.conics, o = scene.start[i] * 8;
    const s = conicPoint(scene, i, c[o + 6]), e = conicPoint(scene, i, c[o + 7]);
    out.push({
      i, c: [c[o] + ox, c[o + 1] + oy], u: [c[o + 2], c[o + 3]], v: [c[o + 4], c[o + 5]], t0: c[o + 6], t1: c[o + 7],
      start: [s[0] + ox, s[1] + oy], end: [e[0] + ox, e[1] + oy], color: scene.color[i], layer: scene.layers[scene.layer[i]].name,
      r: Math.max(Math.hypot(c[o + 2], c[o + 3]), Math.hypot(c[o + 4], c[o + 5])),
    });
  }
  return out;
}

export function texts(scene) {
  const [ox, oy] = scene.origin;
  return scene.texts.map((t) => ({ ...t, wx: t.x + ox, wy: t.y + oy, layerName: scene.layers[t.layer].name }));
}

export const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------------ v0.2: comparing scenes (writers, edits)
import { FG } from '../../src/model.js';
import { KIND as K } from '../../src/scene.js';

/** Live items of a scene in world coordinates: { kind, layer, color, bbox, s? } (texts have kind 't'). */
export function liveItems(scene) {
  const [ox, oy] = scene.origin;
  const out = [];
  const col = (c) => (c === FG || c === 0xffffff ? 'FG' : c);
  for (let i = 0; i < scene.n; i++) {
    if (scene.dead && scene.dead[i]) continue;
    const o = 4 * i;
    out.push({ kind: scene.kind[i], layer: scene.layers[scene.layer[i]].name, color: col(scene.color[i]),
      bbox: [scene.bbox[o] + ox, scene.bbox[o + 1] + oy, scene.bbox[o + 2] + ox, scene.bbox[o + 3] + oy], flags: scene.flags[i] });
  }
  for (const t of scene.texts) {
    if (t.dead) continue;
    out.push({ kind: 't', s: t.s, layer: scene.layers[t.layer].name, color: col(t.color), x: t.x + ox, y: t.y + oy, h: Math.hypot(t.m[2], t.m[3]),
      bbox: [t.bbox[0] + ox, t.bbox[1] + oy, t.bbox[2] + ox, t.bbox[3] + oy] });
  }
  return out;
}

/**
 * Every item of `a` has a partner in `b` (same kind, text, colour and, unless opts.layerMap says
 * otherwise, layer) whose bbox matches within tol. opts.mergeKinds: treat POLY/CONIC alike (a
 * writer may turn arcs into polylines). Returns a list of problems (empty = same drawing).
 */
export function compareItems(a, b, tol, opts = {}) {
  const used = new Uint8Array(b.length);
  const problems = [];
  const kindOk = (x, y) => x.kind === y.kind || (opts.mergeKinds && x.kind !== 't' && y.kind !== 't');
  const layerMap = opts.layerMap || null;
  const close = (p, q, t) => p.every((v, k) => Math.abs(v - q[k]) <= t);
  for (const x of a) {
    const t = typeof tol === 'function' ? tol(x) : tol;
    let found = -1;
    for (let j = 0; j < b.length && found < 0; j++) {
      if (used[j]) continue;
      const y = b[j];
      if (!kindOk(x, y) || x.s !== y.s) continue;
      if (!opts.ignoreColor && x.color !== y.color) continue;
      if (layerMap ? layerMap(x.layer) !== y.layer : x.layer !== y.layer) continue;
      if (x.kind === 't' ? Math.hypot(x.x - y.x, x.y - y.y) <= (opts.textTol ? opts.textTol(x) : t) : close(x.bbox, y.bbox, t)) found = j;
    }
    if (found < 0) problems.push(`no match for ${x.kind === 't' ? 'text "' + x.s + '"' : 'kind ' + x.kind} on ${x.layer} at ${x.bbox.map((v) => +v.toFixed(4))}`);
    else used[found] = 1;
  }
  if (!opts.subset && a.length !== b.length) problems.push(`item count ${a.length} vs ${b.length}`);
  return problems;
}
export { K as SCENE_KIND };

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Python with GDAL (osgeo) for independent read-back checks; null when unavailable. */
import { spawnSync } from 'node:child_process';
let pyChecked = null;
export function gdalPython() {
  if (pyChecked !== null) return pyChecked;
  for (const exe of [process.env.LINEWORK_PYTHON, 'python', 'python3'].filter(Boolean)) {
    const r = spawnSync(exe, ['-c', 'from osgeo import ogr; print("ok")'], { encoding: 'utf8' });
    if (r.status === 0 && /ok/.test(r.stdout)) { pyChecked = exe; return exe; }
  }
  pyChecked = false;
  return false;
}
/** Read files with OGR: returns { [path]: { features: [...] } } (see tools/ogr_dump.py). */
export function ogrDump(paths) {
  const py = gdalPython();
  const r = spawnSync(py, [join(ROOT, 'tools', 'ogr_dump.py'), ...paths], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('ogr_dump failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}
