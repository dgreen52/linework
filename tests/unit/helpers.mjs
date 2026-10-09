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
