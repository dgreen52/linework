// Markup data model: plain JSON objects in DRAWING (world) coordinates, independent of the view.
// Shape of one markup (see MARKUP_FORMAT.md):
//   { id, type, pts:[x,y,...], color:'#rrggbb', width (screen px), opacity?, text?, size? (drawing
//     units, text height), arc? (drawing units, cloud scallop length), author, created, modified }

import { bulgeToArc, signedArea } from '../geom.js';

export const MARKUP_TYPES = ['pen', 'line', 'arrow', 'rect', 'ellipse', 'cloud', 'callout', 'highlight'];

let seq = 0;
export function newId() {
  seq = (seq + 1) % 1e6;
  return 'm' + Date.now().toString(36) + seq.toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

export function createMarkup(type, pts, props = {}) {
  const now = new Date().toISOString();
  const m = {
    id: props.id || newId(),
    type,
    pts: pts.slice(),
    color: props.color || '#e5262b',
    width: props.width ?? 2,
    author: props.author || '',
    created: props.created || now,
    modified: props.modified || now,
  };
  if (type === 'highlight') m.opacity = props.opacity ?? 0.35;
  if (props.text != null) m.text = String(props.text);
  if (props.size != null) m.size = props.size;
  if (props.arc != null) m.arc = props.arc;
  return m;
}

export const cloneMarkups = (list) => list.map((m) => ({ ...m, pts: m.pts.slice() }));

/** Axis-aligned bbox of a markup in drawing units (text box included when `textBox` given). */
export function markupBBox(m) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.pts.length; i += 2) {
    const x = m.pts[i], y = m.pts[i + 1];
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  if (m.type === 'callout' && m.box) {
    const bx = m.box;
    if (bx[0] < b[0]) b[0] = bx[0]; if (bx[1] < b[1]) b[1] = bx[1]; if (bx[2] > b[2]) b[2] = bx[2]; if (bx[3] > b[3]) b[3] = bx[3];
  }
  if (m.type === 'cloud' && m.arc) { b[0] -= m.arc; b[1] -= m.arc; b[2] += m.arc; b[3] += m.arc; }
  return b;
}

export function moveMarkup(m, dx, dy) {
  const pts = m.pts.slice();
  for (let i = 0; i < pts.length; i += 2) { pts[i] += dx; pts[i + 1] += dy; }
  return { ...m, pts, modified: new Date().toISOString() };
}

/** Rectangle corners (CCW) from two opposite corners. */
export function rectCorners(x0, y0, x1, y1) {
  const a = Math.min(x0, x1), b = Math.min(y0, y1), c = Math.max(x0, x1), d = Math.max(y0, y1);
  return [a, b, c, b, c, d, a, d];
}

/**
 * Revision-cloud scallops along a closed polygon. Returns { verts:[x,y,...], bulges:[...] }:
 * a closed bulged polyline whose arcs all bulge OUTWARD. arcLen = target chord length.
 */
export function cloudPath(poly, arcLen) {
  const n = poly.length / 2;
  if (n < 2 || !(arcLen > 0)) return { verts: poly.slice(), bulges: new Array(n).fill(0) };
  const ccw = signedArea(poly) >= 0;
  const BULGE = Math.tan((160 * Math.PI) / 180 / 4); // 160-degree scallops
  const bulge = ccw ? BULGE : -BULGE; // CCW polygon: outward is to the right -> positive bulge
  const verts = [], bulges = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[2 * i], ay = poly[2 * i + 1], bx = poly[2 * j], by = poly[2 * j + 1];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-12) continue;
    const k = Math.max(1, Math.round(L / arcLen));
    for (let s = 0; s < k; s++) {
      verts.push(ax + ((bx - ax) * s) / k, ay + ((by - ay) * s) / k);
      bulges.push(bulge);
    }
  }
  return { verts, bulges };
}

/** Same as cloudPath but returned as arcs: [{cx, cy, r, a0, sweep}] for rendering/tests. */
export function cloudArcs(poly, arcLen) {
  const { verts, bulges } = cloudPath(poly, arcLen);
  const n = verts.length / 2, out = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = bulgeToArc(verts[2 * i], verts[2 * i + 1], verts[2 * j], verts[2 * j + 1], bulges[i]);
    if (a) out.push(a);
  }
  return out;
}
