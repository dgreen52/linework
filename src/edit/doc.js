// Edit document: the model being edited, the change list behind undo/redo, dirty tracking, and
// selection maths. A change is { i, before, after } (entity slot i; null = absent),
// { layer: name, before, after } (layer record; null = absent) or { table: 'blocks' | 'ltypes' |
// 'styles', key, before, after } (a definition added by a paste). Undo applies `before`, redo
// `after`, so the model is always a pure function of the history and undoing back to the start
// restores the original objects (the DGN writer then keeps those elements byte for byte).
import { replaceEntities, entityItems, entityBBox, makeLive } from './live-scene.js';
import { KIND, FLAG, TEXT_ID, queryRect, conicPoint } from '../scene.js';
import { TAU } from '../geom.js';

export class EditDoc {
  /** opts.bytes: original file bytes (DGN round trip). */
  constructor(model, scene, opts = {}) {
    this.model = model;
    this.scene = scene;
    this.bytes = opts.bytes || null;
    if (!model.layerIndex) model.layerIndex = new Map(model.layers.map((l) => [l.name.toUpperCase(), l]));
    this.orig = model.entities.slice(); // original objects, by slot
    this.seq = 0;
    this.cur = 0;
    this.saved = 0;
    makeLive(scene);
  }

  get format() { return this.model.format; }
  get dirty() { return this.cur !== this.saved; }
  markSaved() { this.saved = this.cur; }
  entity(i) { return this.model.entities[i] || null; }
  /** Slot for a new entity. Each call reserves the next index. */
  nextIndex(k = 0) { return this.model.entities.length + k; }

  /** Apply a new change list. Returns the history entry (kind 'edit'). */
  commit(label, changes, meta = {}) {
    const entry = { kind: 'edit', id: ++this.seq, prev: this.cur, label, changes, ...meta };
    entry.result = this.apply(entry, 'after');
    this.cur = entry.id;
    return entry;
  }
  revert(entry) { const r = this.apply(entry, 'before'); this.cur = entry.prev; return r; }
  reapply(entry) { const r = this.apply(entry, 'after'); this.cur = entry.id; return r; }

  apply(entry, side) {
    const list = side === 'before' ? entry.changes.slice().reverse() : entry.changes;
    const touched = new Set();
    let layersChanged = false;
    for (const c of list) {
      const v = c[side];
      if (c.layer != null) { this.setLayer(c.layer, v); layersChanged = true; continue; }
      if (c.table) { const t = this.model[c.table] || (this.model[c.table] = {}); if (v) t[c.key] = v; else delete t[c.key]; continue; }
      this.model.entities[c.i] = v;
      touched.add(c.i);
    }
    // trailing empty slots can go (keeps "new entity" indices stable across undo/redo)
    const r = replaceEntities(this.scene, this.model, [...touched]);
    r.layersChanged = layersChanged || r.layersAdded;
    r.touched = [...touched];
    return r;
  }

  /** Add/replace/remove a layer record (by name) in the model and the scene layer table. */
  setLayer(name, rec) {
    const key = String(name).toUpperCase();
    const m = this.model;
    const at = m.layers.findIndex((l) => l.name.toUpperCase() === key);
    if (!rec) {
      if (at >= 0) m.layers.splice(at, 1);
      m.layerIndex.delete(key);
    } else {
      const L = { name: rec.name, color: rec.color, aci: rec.aci, visible: true, frozen: false, ltype: rec.ltype || 'CONTINUOUS', lw: rec.lw };
      if (at >= 0) m.layers[at] = L; else m.layers.push(L);
      m.layerIndex.set(key, L);
    }
    const sl = this.scene.layers;
    let si = sl.findIndex((l) => l.name.toUpperCase() === key);
    if (si < 0 && rec) { si = sl.length; sl.push({ name: rec.name, color: rec.color, visible: true, frozen: false, ltype: 'CONTINUOUS', count: 0, added: true }); }
    if (si >= 0) { sl[si].removed = !rec; if (rec) Object.assign(sl[si], { color: rec.color, ltype: rec.ltype || 'CONTINUOUS', lw: rec.lw }); }
  }

  /** Layer names that can receive new items (in display order). */
  layerNames() {
    return this.scene.layers.filter((l) => !l.removed).map((l) => l.name);
  }

  items(i) { return entityItems(this.scene, i); }
  bbox(i) { return entityBBox(this.scene, i); }
}

// ------------------------------------------------------------------ selection maths
/** Does segment a-b touch the rectangle [x0,y0,x1,y1]? (Liang-Barsky clip) */
export function segTouchesRect(ax, ay, bx, by, x0, y0, x1, y1) {
  if (ax >= x0 && ax <= x1 && ay >= y0 && ay <= y1) return true;
  if (bx >= x0 && bx <= x1 && by >= y0 && by <= y1) return true;
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dy, ay - y0) && clip(dy, y1 - ay) && t0 <= t1;
}

/** Does primitive id (scene-local) touch the rectangle? Exact for lines, sampled for curves. */
export function primTouchesRect(scene, id, r) {
  const [x0, y0, x1, y1] = r;
  const o = 4 * id, b = scene.bbox;
  if (b[o] >= x0 && b[o + 2] <= x1 && b[o + 1] >= y0 && b[o + 3] <= y1) return true; // fully inside
  if (b[o] > x1 || b[o + 2] < x0 || b[o + 1] > y1 || b[o + 3] < y0) return false;
  const k = scene.kind[id];
  if (k === KIND.POINT) return true; // bbox overlap == inside for a point
  let pts, closed;
  if (k === KIND.CONIC) {
    const c = scene.conics, q = scene.start[id] * 8;
    const t0 = c[q + 6], t1 = c[q + 7];
    const n = Math.max(16, Math.ceil((96 * (t1 - t0)) / TAU));
    pts = [];
    for (let s = 0; s <= n; s++) { const p = conicPoint(scene, id, t0 + ((t1 - t0) * s) / n); pts.push(p[0], p[1]); }
    closed = false;
  } else {
    const s = scene.start[id] * 2;
    pts = scene.coords.subarray(s, s + scene.count[id] * 2);
    closed = !!(scene.flags[id] & FLAG.CLOSED);
  }
  const n = pts.length / 2;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = (i + 1) % n;
    if (pts[2 * i] !== pts[2 * i] || pts[2 * j] !== pts[2 * j]) continue;
    if (segTouchesRect(pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1], x0, y0, x1, y1)) return true;
  }
  return false;
}

/**
 * Entities selected by a box (scene-local rect). mode 'window' (drag left -> right): the whole
 * entity must be inside. 'crossing' (right -> left): anything touching the box. Items on hidden
 * layers are ignored. Returns a Set of entity indices.
 */
export function selectInRect(scene, rect, mode, isVisible = () => true) {
  const [x0, y0, x1, y1] = rect;
  const cand = new Map(); // entity -> touched (crossing)
  queryRect(scene, x0, y0, x1, y1, (id) => {
    const isT = id >= TEXT_ID;
    const layer = isT ? scene.texts[id - TEXT_ID].layer : scene.layer[id];
    if (!isVisible(layer)) return;
    const e = isT ? scene.texts[id - TEXT_ID].ent : scene.ent[id];
    if (mode === 'crossing') {
      if (cand.get(e)) return;
      cand.set(e, isT ? true : primTouchesRect(scene, id, rect));
    } else cand.set(e, true);
  });
  const out = new Set();
  for (const [e, touched] of cand) {
    if (mode === 'crossing') { if (touched) out.add(e); continue; }
    // window: every visible item of the entity lies inside the box
    const it = entityItems(scene, e);
    let ok = true, any = false;
    for (const p of it.prims) {
      if (scene.dead && scene.dead[p]) continue;
      if (!isVisible(scene.layer[p])) continue;
      any = true;
      const o = 4 * p, b = scene.bbox;
      if (!(b[o] >= x0 && b[o + 2] <= x1 && b[o + 1] >= y0 && b[o + 3] <= y1)) { ok = false; break; }
    }
    if (ok) {
      for (const t of it.texts) {
        const T = scene.texts[t];
        if (T.dead || !isVisible(T.layer)) continue;
        any = true;
        const b = T.bbox;
        if (!(b[0] >= x0 && b[2] <= x1 && b[1] >= y0 && b[3] <= y1)) { ok = false; break; }
      }
    }
    if (ok && any) out.add(e);
  }
  return out;
}
