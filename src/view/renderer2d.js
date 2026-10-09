// Canvas2D renderer. Interface (so a WebGL renderer can replace it later):
//   const r = new Canvas2DRenderer(canvas);
//   r.setScene(scene);                      // scene from ../scene.js (scene-local coordinates)
//   r.resize(cssW, cssH, dpr);
//   r.render(viewport, { theme, layerVisible, showText }) -> { ms, batches, texts }
//   r.drawTo(ctx2d, viewport, opts, dpr)    // render into another context (export / print)
//
// Strategy: primitives are bucketed into spatial chunks and, inside each chunk, into batches of
// identical style (layer, colour, line type, weight, fill). Each batch becomes one Path2D in
// scene coordinates, built lazily, and is drawn with the view transform, so pan/zoom never
// rebuilds geometry. Line widths are divided by the zoom so they stay N screen pixels wide.
// Conics use Path2D.ellipse (exact at every zoom). Text is drawn with a per-text transform;
// sub-pixel text is skipped and tiny text is "greeked" as a bar.

import { KIND, FLAG } from '../scene.js';
import { cssColor, THEMES } from './colors.js';
import { buildChunks, BK } from './batches.js';

export const CAP_HEIGHT = 0.71; // cap height / em for common sans fonts
const FONT_PX = 64;
const FONT_FAMILY = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export class Canvas2DRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.scene = null;
    this.chunks = [];
    this.dpr = 1;
    this.patterns = new Map();
  }

  setScene(scene) {
    this.scene = scene;
    // batches normally arrive pre-built from the parse worker (scene.chunks); build them here otherwise
    this.chunks = scene ? (scene.chunks || buildChunks(scene)) : [];
    this.patterns.clear();
  }

  resize(w, h, dpr) {
    this.dpr = dpr;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
  }

  render(view, opts) {
    return this.drawTo(this.ctx, view, opts, this.dpr, this.canvas.width, this.canvas.height);
  }

  drawTo(ctx, view, opts, dpr, W, H) {
    const t0 = performance.now();
    const theme = opts.theme || 'dark';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = THEMES[theme].bg;
    ctx.fillRect(0, 0, W, H);
    const scene = this.scene;
    if (!scene || scene.empty) return { ms: performance.now() - t0, batches: 0, texts: 0 };
    const vis = opts.layerVisible;
    const M = view.matrix(dpr);
    const s = view.scale;
    const vr = view.visibleRect(4);
    ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // collect visible batches, grouped by style key so state changes are minimal
    const groups = new Map();
    for (const ch of this.chunks) {
      const b = ch.bbox;
      if (b[0] > vr[2] || b[2] < vr[0] || b[1] > vr[3] || b[3] < vr[1]) continue;
      for (const g of ch.batches) {
        if (vis && !vis[g.layer]) continue;
        let list = groups.get(g.key);
        if (!list) { list = []; groups.set(g.key, list); }
        list.push(g);
      }
    }
    const ordered = [...groups.values()].sort((a, b) => a[0].order - b[0].order);
    let batches = 0;
    let lastDash = null;
    // progressive preparation: Path2D objects are built lazily; with a budget, building stops
    // once the budget is used and the caller is told to draw again next frame
    const budget = opts.budgetMs, tStart = performance.now();
    let incomplete = false, built = 0;
    const ready = (g) => {
      if (g.path) return true;
      // always build at least one batch per frame so progress is guaranteed
      if (budget && built > 0 && performance.now() - tStart > budget) { incomplete = true; return false; }
      g.path = buildPath(scene, g);
      built++;
      return true;
    };
    for (const list of ordered) {
      const g0 = list[0];
      const color = cssColor(g0.color, theme);
      if (g0.bk === BK.FILL) {
        ctx.fillStyle = color;
        for (const g of list) { if (!ready(g)) continue; ctx.fill(g.path, g.evenodd ? 'evenodd' : 'nonzero'); batches++; }
        continue;
      }
      if (g0.bk === BK.PATTERN) {
        ctx.fillStyle = this.pattern(ctx, color, M);
        for (const g of list) { if (!ready(g)) continue; ctx.fill(g.path, 'evenodd'); batches++; }
        continue;
      }
      ctx.strokeStyle = color;
      const wpx = g0.bk === BK.POINT ? 3 : 1 + Math.min(6, g0.weight * 0.75);
      ctx.lineWidth = wpx / s;
      const dash = g0.bk === BK.POINT ? null : g0.dash;
      if (dash !== lastDash) {
        ctx.setLineDash(dash ? dash.map((v) => v / s) : []);
        lastDash = dash;
      }
      for (const g of list) { if (!ready(g)) continue; ctx.stroke(g.path); batches++; }
    }
    ctx.setLineDash([]);
    const texts = opts.showText === false ? 0 : this.drawTexts(ctx, view, M, vr, vis, theme);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { ms: performance.now() - t0, batches, texts, incomplete };
  }

  pattern(ctx, color, M) {
    let p = this.patterns.get(color + ctx.canvas.width);
    if (!p) {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
      const g = c.getContext('2d');
      g.strokeStyle = color;
      g.globalAlpha = 0.75;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-1, 9); g.lineTo(9, -1);
      g.moveTo(-1, 1); g.lineTo(1, -1);
      g.moveTo(7, 9); g.lineTo(9, 7);
      g.stroke();
      p = ctx.createPattern(c, 'repeat');
      this.patterns.set(color + ctx.canvas.width, p);
    }
    // keep the pattern in screen space: undo the view transform
    try {
      const inv = new DOMMatrix([M[0], M[1], M[2], M[3], M[4], M[5]]).inverse();
      p.setTransform(inv);
    } catch { /* older engines: pattern scales with the view */ }
    return p;
  }

  drawTexts(ctx, view, M, vr, vis, theme) {
    const scene = this.scene;
    const s = view.scale;
    const dpr = M[0] / s;
    const greek = new Map();
    let drawn = 0;
    ctx.font = `${FONT_PX}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'alphabetic';
    const K = FONT_PX * CAP_HEIGHT;
    let lastAlign = -1, lastColor = '';
    for (const t of scene.texts) {
      const b = t.bbox;
      if (b[0] > vr[2] || b[2] < vr[0] || b[1] > vr[3] || b[3] < vr[1]) continue;
      if (vis && !vis[t.layer]) continue;
      const m = t.m;
      const hdev = Math.hypot(m[2], m[3]) * s * dpr; // cap height in device pixels
      if (hdev < 1.6) continue;
      const color = cssColor(t.color, theme);
      if (hdev < 6) { // too small to read: draw a "greeked" bar where the text is
        let p = greek.get(color);
        if (!p) { p = new Path2D(); greek.set(color, p); }
        const w = t.w != null ? t.w : 0.72 * t.s.length;
        const u0 = t.align === 0 ? 0 : t.align === 1 ? -w / 2 : -w;
        const u1 = u0 + (t.fit || w);
        const P = (u, v) => [t.x + u * m[0] + v * m[2], t.y + u * m[1] + v * m[3]];
        const a = P(u0, 0.1), bq = P(u1, 0.1), c = P(u1, 0.75), d = P(u0, 0.75);
        p.moveTo(a[0], a[1]); p.lineTo(bq[0], bq[1]); p.lineTo(c[0], c[1]); p.lineTo(d[0], d[1]); p.closePath();
        continue;
      }
      if (t.align !== lastAlign) { ctx.textAlign = t.align === 0 ? 'left' : t.align === 1 ? 'center' : 'right'; lastAlign = t.align; }
      if (color !== lastColor) { ctx.fillStyle = color; lastColor = color; }
      let fx = 1;
      if (t.fit) {
        if (t._mw == null) t._mw = ctx.measureText(t.s).width / K || 1;
        fx = t.fit / t._mw;
      }
      if (t.w == null) t.w = ctx.measureText(t.s).width / K; // cache width in cap-height units
      const a = (m[0] / K) * fx, bb = (m[1] / K) * fx, c = -m[2] / K, d = -m[3] / K;
      ctx.setTransform(M[0] * a, M[3] * bb, M[0] * c, M[3] * d, M[0] * t.x + M[4], M[3] * t.y + M[5]);
      ctx.fillText(t.s, 0, 0);
      drawn++;
    }
    ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    if (greek.size) {
      ctx.globalAlpha = 0.55;
      for (const [color, p] of greek) { ctx.fillStyle = color; ctx.fill(p); }
      ctx.globalAlpha = 1;
    }
    return drawn;
  }
}

// ---------------------------------------------------------------- paths
/** Append conic i to a Path2D (exact ellipse arc). */
export function addConic(p, scene, i) {
  const c = scene.conics, o = scene.start[i] * 8;
  const cx = c[o], cy = c[o + 1];
  let ux = c[o + 2], uy = c[o + 3], vx = c[o + 4], vy = c[o + 5];
  const t0 = c[o + 6], t1 = c[o + 7];
  const dot = ux * vx + uy * vy;
  let shift = 0;
  if (Math.abs(dot) > 1e-12 * (ux * ux + uy * uy + vx * vx + vy * vy)) {
    const ts = 0.5 * Math.atan2(2 * dot, ux * ux + uy * uy - (vx * vx + vy * vy));
    const cs = Math.cos(ts), sn = Math.sin(ts);
    const nux = ux * cs + vx * sn, nuy = uy * cs + vy * sn;
    const nvx = -ux * sn + vx * cs, nvy = -uy * sn + vy * cs;
    ux = nux; uy = nuy; vx = nvx; vy = nvy;
    shift = ts;
  }
  const rx = Math.hypot(ux, uy), ry = Math.hypot(vx, vy);
  const rot = Math.atan2(uy, ux);
  const cross = ux * vy - uy * vx;
  const a0 = t0 - shift, a1 = t1 - shift;
  const sx = cx + ux * Math.cos(a0) + vx * Math.sin(a0), sy = cy + uy * Math.cos(a0) + vy * Math.sin(a0);
  p.moveTo(sx, sy);
  if (rx < 1e-300 || ry < 1e-300) { // degenerate: draw as a line through the extreme points
    const ex = cx + ux * Math.cos(a1) + vx * Math.sin(a1), ey = cy + uy * Math.cos(a1) + vy * Math.sin(a1);
    p.lineTo(ex, ey);
    return;
  }
  if (cross >= 0) p.ellipse(cx, cy, rx, ry, rot, a0, a1, false);
  else p.ellipse(cx, cy, rx, ry, rot, -a0, -a1, true);
}

/** Append polyline primitive i (NaN pairs separate rings). */
export function addPoly(p, scene, i) {
  const co = scene.coords;
  const s = scene.start[i] * 2, e = s + scene.count[i] * 2;
  const closed = !!(scene.flags[i] & FLAG.CLOSED);
  let move = true;
  for (let k = s; k < e; k += 2) {
    const x = co[k], y = co[k + 1];
    if (x !== x) { if (closed && !move) p.closePath(); move = true; continue; }
    if (move) { p.moveTo(x, y); move = false; } else p.lineTo(x, y);
  }
  if (closed && !move) p.closePath();
}

function buildPath(scene, g) {
  const p = new Path2D();
  for (const i of g.ids) {
    const k = scene.kind[i];
    if (k === KIND.CONIC) addConic(p, scene, i);
    else if (k === KIND.POINT) {
      const s = scene.start[i] * 2;
      p.moveTo(scene.coords[s], scene.coords[s + 1]);
      p.lineTo(scene.coords[s], scene.coords[s + 1]);
    } else addPoly(p, scene, i);
  }
  return p;
}

/** Path for a single primitive (hover highlight). */
export function primPath(scene, i) {
  const p = new Path2D();
  const k = scene.kind[i];
  if (k === KIND.CONIC) addConic(p, scene, i);
  else if (k === KIND.POINT) { const s = scene.start[i] * 2; p.moveTo(scene.coords[s], scene.coords[s + 1]); p.lineTo(scene.coords[s], scene.coords[s + 1]); }
  else addPoly(p, scene, i);
  return p;
}
