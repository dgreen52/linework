// Incremental scene updates for editing. Replacing an entity never re-parses the file or rebuilds
// the scene: the entity's old primitives/texts are flagged dead (skipped by the renderer, snaps
// and picking), its new version is emitted with the same code as the full build and appended,
// the new items go into a dynamic overlay of the spatial grid, and only the render batches that
// held the old items (or receive the new ones) are rebuilt.
import { createEmitter, sceneTables, typedPrims, gridCell, TEXT_ID, KIND } from '../scene.js';

const PRIM_ARRAYS = { kind: Uint8Array, flags: Uint8Array, layer: Uint16Array, color: Uint32Array, style: Uint8Array, weight: Uint8Array,
  src: Uint16Array, blk: Uint16Array, ent: Uint32Array, start: Uint32Array, count: Uint32Array, dead: Uint8Array };

/** Prepare a scene for edits (idempotent). */
export function makeLive(scene) {
  if (scene.live) return scene;
  scene.live = true;
  scene.cap = scene.n;
  scene.dead = new Uint8Array(scene.n);
  scene.coordsLen = scene.coords.length;
  scene.conicsLen = scene.conics.length;
  scene.override = new Map(); // entity index -> { prims: [], texts: [] } once it has been edited
  scene.grid.dyn = new Map(); // grid cell -> ids added by edits
  return scene;
}

/** Live primitive ids and text indices of top-level entity i. */
export function entityItems(scene, i) {
  const ov = scene.override && scene.override.get(i);
  if (ov) return ov;
  if (i >= scene.E) return { prims: [], texts: [] };
  const prims = [], texts = [];
  for (let k = scene.entPrim[i]; k < scene.entPrim[i + 1]; k++) prims.push(k);
  for (let k = scene.entText[i]; k < scene.entText[i + 1]; k++) texts.push(k);
  return { prims, texts };
}

function growTyped(a, need, Type) {
  if (a.length >= need) return a;
  const b = new (Type || a.constructor)(Math.max(need, Math.ceil(a.length * 1.5) + 256));
  b.set(a);
  return b;
}

function ensureCap(scene, nPrims, nCoords, nConics) {
  const need = scene.n + nPrims;
  if (need > scene.cap) {
    const cap = Math.max(need, Math.ceil(scene.cap * 1.5) + 256);
    for (const k of Object.keys(PRIM_ARRAYS)) {
      const b = new PRIM_ARRAYS[k](cap);
      b.set(scene[k].subarray(0, scene.n));
      scene[k] = b;
    }
    const bb = new Float64Array(cap * 4);
    bb.set(scene.bbox.subarray(0, scene.n * 4));
    scene.bbox = bb;
    scene.cap = cap;
  }
  scene.coords = growTyped(scene.coords, scene.coordsLen + nCoords);
  scene.conics = growTyped(scene.conics, scene.conicsLen + nConics);
}

/**
 * Re-emit entities `indices` from model.entities into the scene (null/missing entity = removed).
 * Returns { killed: [primIds], added: [primIds], layersAdded: bool }.
 */
export function replaceEntities(scene, model, indices) {
  makeLive(scene);
  const layers0 = scene.layers.length;
  const killed = [], added = [];
  const g = scene.grid;
  // 1) retire the old items
  for (const i of indices) {
    const it = entityItems(scene, i);
    for (const p of it.prims) { if (!scene.dead[p]) { scene.dead[p] = 1; killed.push(p); const L = scene.layers[scene.layer[p]]; if (L) L.count--; } }
    for (const t of it.texts) { const T = scene.texts[t]; if (!T.dead) { T.dead = true; const L = scene.layers[T.layer]; if (L) L.count--; } }
    scene.override.set(i, { prims: [], texts: [] });
  }
  // 2) emit the new versions with the same code as the full build
  const tables = sceneTables(model, scene);
  const em = createEmitter(model, tables);
  for (const i of indices) em.emit(model.entities[i], i);
  const B = em.B;
  const P = typedPrims(B);
  const [ox, oy] = scene.origin;
  ensureCap(scene, P.n, P.coords.length, P.conics.length);
  const base = scene.n, cBase = scene.coordsLen / 2, kBase = scene.conicsLen / 8;
  for (let j = 0; j < P.n; j++) {
    const id = base + j;
    for (const k of ['kind', 'flags', 'layer', 'color', 'style', 'weight', 'src', 'blk', 'ent']) scene[k][id] = P[k][j];
    scene.count[id] = P.count[j];
    scene.start[id] = (P.kind[j] === KIND.CONIC ? kBase : cBase) + P.start[j];
    scene.dead[id] = 0;
    const o = 4 * j;
    const b0 = P.bbox[o] - ox, b1 = P.bbox[o + 1] - oy, b2 = P.bbox[o + 2] - ox, b3 = P.bbox[o + 3] - oy;
    scene.bbox[4 * id] = b0; scene.bbox[4 * id + 1] = b1; scene.bbox[4 * id + 2] = b2; scene.bbox[4 * id + 3] = b3;
    addToGrid(g, id, b0, b1, b2, b3);
    scene.override.get(P.ent[j]).prims.push(id);
    const L = scene.layers[P.layer[j]]; if (L) L.count++;
    added.push(id);
  }
  for (let k = 0; k < P.coords.length; k += 2) { scene.coords[scene.coordsLen + k] = P.coords[k] - ox; scene.coords[scene.coordsLen + k + 1] = P.coords[k + 1] - oy; }
  for (let k = 0; k < P.conics.length; k += 8) {
    for (let q = 0; q < 8; q++) scene.conics[scene.conicsLen + k + q] = P.conics[k + q];
    scene.conics[scene.conicsLen + k] -= ox; scene.conics[scene.conicsLen + k + 1] -= oy;
  }
  scene.coordsLen += P.coords.length;
  scene.conicsLen += P.conics.length;
  scene.n += P.n;
  scene.primCount = scene.n;
  for (const t of B.texts) {
    t.x -= ox; t.y -= oy; t.bbox[0] -= ox; t.bbox[1] -= oy; t.bbox[2] -= ox; t.bbox[3] -= oy;
    const ti = scene.texts.length;
    scene.texts.push(t);
    addToGrid(g, TEXT_ID + ti, ...t.bbox);
    scene.override.get(t.ent).texts.push(ti);
    const L = scene.layers[t.layer]; if (L) L.count++;
  }
  scene.textCount = scene.texts.length;
  return { killed, added, layersAdded: scene.layers.length > layers0 };
}

function addToGrid(g, id, x0, y0, x1, y1) {
  if (!(x0 <= x1)) { x0 = x1 = g.x0; y0 = y1 = g.y0; }
  const c = gridCell(g, x0, y0, x1, y1);
  let list = g.dyn.get(c);
  if (!list) { list = []; g.dyn.set(c, list); }
  list.push(id);
  const L = g.loose, o = 4 * c;
  if (x0 < L[o]) L[o] = x0; if (y0 < L[o + 1]) L[o + 1] = y0;
  if (x1 > L[o + 2]) L[o + 2] = x1; if (y1 > L[o + 3]) L[o + 3] = y1;
}

/** Union bbox (scene-local) of an entity's live items, or null. */
export function entityBBox(scene, i) {
  const it = entityItems(scene, i);
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of it.prims) {
    if (scene.dead && scene.dead[p]) continue;
    const o = 4 * p;
    if (scene.bbox[o] < b[0]) b[0] = scene.bbox[o]; if (scene.bbox[o + 1] < b[1]) b[1] = scene.bbox[o + 1];
    if (scene.bbox[o + 2] > b[2]) b[2] = scene.bbox[o + 2]; if (scene.bbox[o + 3] > b[3]) b[3] = scene.bbox[o + 3];
  }
  for (const t of it.texts) {
    const T = scene.texts[t];
    if (T.dead) continue;
    const q = T.bbox;
    if (q[0] < b[0]) b[0] = q[0]; if (q[1] < b[1]) b[1] = q[1]; if (q[2] > b[2]) b[2] = q[2]; if (q[3] > b[3]) b[3] = q[3];
  }
  return b[0] <= b[2] ? b : null;
}

/** World-space extents of everything live (for $EXTMIN/$EXTMAX). */
export function liveExtents(scene) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < scene.n; i++) {
    if (scene.dead && scene.dead[i]) continue;
    const o = 4 * i;
    if (scene.bbox[o] < b[0]) b[0] = scene.bbox[o]; if (scene.bbox[o + 1] < b[1]) b[1] = scene.bbox[o + 1];
    if (scene.bbox[o + 2] > b[2]) b[2] = scene.bbox[o + 2]; if (scene.bbox[o + 3] > b[3]) b[3] = scene.bbox[o + 3];
  }
  for (const t of scene.texts) {
    if (t.dead) continue;
    const q = t.bbox;
    if (q[0] < b[0]) b[0] = q[0]; if (q[1] < b[1]) b[1] = q[1]; if (q[2] > b[2]) b[2] = q[2]; if (q[3] > b[3]) b[3] = q[3];
  }
  if (!(b[0] <= b[2])) return null;
  const [ox, oy] = scene.origin;
  return [b[0] + ox, b[1] + oy, b[2] + ox, b[3] + oy];
}
