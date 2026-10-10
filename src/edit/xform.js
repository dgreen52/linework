// Transform tools (pure): mirror, scale, rotate about a point, linear arrays. Built on transformEntity,
// so a DGN item keeps its original bytes: a move, rotation or uniform scale is applied to them in place
// when saving; a mirror cannot be (DGN has no mirrored text or arcs), so mirrored items are written from
// what Linework shows and the save notes say so.
import { transformEntity, moveEntity, isText } from './ops.js';
import { mul, translate, rotate, scale } from '../geom.js';
import { CHAR_W } from '../scene.js';

const about = (M, cx, cy) => mul(translate(cx, cy), mul(M, translate(-cx, -cy)));
/** Mirror matrix: axis 'h' flips left <-> right about the line x = cx; 'v' flips top <-> bottom about y = cy. */
export const mirrorMatrix = (axis, cx, cy) => about(axis === 'v' ? scale(1, -1) : scale(-1, 1), cx, cy);
export const scaleMatrix = (f, cx, cy) => about(scale(f), cx, cy);
export const rotateMatrix = (a, cx, cy) => about(rotate(a), cx, cy);

/** Estimated centre of a single-line text's box (as the scene lays it out: CHAR_W per character). */
export function textCentre(e) {
  const h = e.h > 0 ? e.h : 1, W = CHAR_W * String(e.text).split('\n')[0].length * h * (e.wf > 0 ? e.wf : 1);
  const ha = e.type === 'text' ? e.halign | 0 : ((e.attach || 1) - 1) % 3;
  const u = ha === 1 || ha === 4 ? 0 : ha === 2 ? -W / 2 : W / 2, v = 0.4 * h;
  const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
  return [e.p[0] + u * c - v * s, e.p[1] + u * s + v * c];
}

/**
 * Mirror one entity. opts.readable (default true): text is not reversed; it moves so that its box (centre
 * `opts.centre`, world coordinates; default an estimate) lands on the mirrored place, keeping its angle —
 * a plain move, so a DGN text stays byte-for-byte except its position. Text inside a mirrored cell and a
 * block's attributes stay readable too.
 */
export function mirrorEntity(e, axis, cx, cy, opts = {}) {
  if (!e) return e;
  const readable = opts.readable !== false;
  if (readable && isText(e)) {
    const c = opts.centre || textCentre(e);
    const [mx, my] = axis === 'v' ? [c[0], 2 * cy - c[1]] : [2 * cx - c[0], c[1]];
    return moveEntity(e, mx - c[0], my - c[1]);
  }
  const o = transformEntity(e, mirrorMatrix(axis, cx, cy));
  if (readable && e.type === 'cell') o.children = e.children.map((k, i) => (isText(k) || k.type === 'cell' ? mirrorEntity(k, axis, cx, cy) : o.children[i]));
  if (readable && e.type === 'insert' && e.attribs) o.attribs = e.attribs.map((a) => mirrorEntity(a, axis, cx, cy));
  return o;
}
export const scaleEntity = (e, f, cx, cy) => transformEntity(e, scaleMatrix(f, cx, cy));

/** Entities of a linear array: `n` copies of `ents`, copy k (1..n) moved by k * (dx, dy). */
export function arrayCopies(ents, n, dx, dy) {
  const out = [];
  for (let k = 1; k <= n; k++) for (const e of ents) out.push(moveEntity(e, k * dx, k * dy));
  return out;
}
