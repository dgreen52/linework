// Draws markups in SCREEN space (CSS px). Markups are stored in drawing coordinates; `toScreen`
// maps a world point to CSS px, `scale` is CSS px per drawing unit. Y is flipped on screen.
import { cloudPath } from './model.js';
import { bulgeToArc } from '../geom.js';

export const CALLOUT_FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function arrowHead(ctx, x0, y0, x1, y1, size) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - size * Math.cos(a - 0.42), y1 - size * Math.sin(a - 0.42));
  ctx.lineTo(x1 - size * Math.cos(a + 0.42), y1 - size * Math.sin(a + 0.42));
  ctx.closePath();
  ctx.fill();
}

/** Screen geometry of a callout text box: { x, y, w, h, lines, fontPx, pad, anchorX, anchorY }. */
export function calloutBox(ctx, m, toScreen, scale) {
  const [ax, ay] = toScreen(m.pts[2], m.pts[3]);
  const [tx] = toScreen(m.pts[0], m.pts[1]);
  const fontPx = Math.max(1, (m.size || 1) * scale);
  const lines = String(m.text ?? '').split('\n');
  ctx.font = `${fontPx}px ${CALLOUT_FONT}`;
  let w = 0;
  for (const l of lines) w = Math.max(w, ctx.measureText(l || ' ').width);
  const pad = fontPx * 0.45;
  const lh = fontPx * 1.25;
  const bw = w + pad * 2, bh = lines.length * lh + pad * 2 - (lh - fontPx);
  const right = ax >= tx;
  const x = right ? ax : ax - bw;
  const y = ay - bh / 2;
  return { x, y, w: bw, h: bh, lines, fontPx, pad, lh, anchorX: ax, anchorY: ay };
}

export function drawMarkup(ctx, m, toScreen, scale, opts = {}) {
  const pts = m.pts;
  const S = [];
  for (let i = 0; i < pts.length; i += 2) { const p = toScreen(pts[i], pts[i + 1]); S.push(p[0], p[1]); }
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineWidth = m.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  switch (m.type) {
    case 'pen':
    case 'highlight': {
      if (m.type === 'highlight') { ctx.globalAlpha = m.opacity ?? 0.35; ctx.lineCap = 'butt'; }
      ctx.beginPath();
      ctx.moveTo(S[0], S[1]);
      for (let i = 2; i < S.length; i += 2) ctx.lineTo(S[i], S[i + 1]);
      ctx.stroke();
      break;
    }
    case 'line':
    case 'arrow': {
      ctx.beginPath();
      ctx.moveTo(S[0], S[1]);
      ctx.lineTo(S[2], S[3]);
      ctx.stroke();
      if (m.type === 'arrow') arrowHead(ctx, S[0], S[1], S[2], S[3], 8 + m.width * 3);
      break;
    }
    case 'rect': {
      ctx.beginPath();
      ctx.moveTo(S[0], S[1]);
      for (let i = 2; i < S.length; i += 2) ctx.lineTo(S[i], S[i + 1]);
      ctx.closePath();
      ctx.stroke();
      break;
    }
    case 'ellipse': {
      const x0 = Math.min(S[0], S[2]), x1 = Math.max(S[0], S[2]), y0 = Math.min(S[1], S[3]), y1 = Math.max(S[1], S[3]);
      ctx.beginPath();
      ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.max(0.5, (x1 - x0) / 2), Math.max(0.5, (y1 - y0) / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'cloud': {
      const arc = m.arc || (16 / scale);
      const { verts, bulges } = cloudPath(pts, arc);
      const n = verts.length / 2;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = bulgeToArc(verts[2 * i], verts[2 * i + 1], verts[2 * j], verts[2 * j + 1], bulges[i]);
        if (!a) continue;
        const [cx, cy] = toScreen(a.cx, a.cy);
        // y flip: angles negate and direction reverses
        ctx.arc(cx, cy, a.r * scale, -a.a0, -(a.a0 + a.sweep), a.sweep > 0);
      }
      ctx.closePath();
      ctx.stroke();
      break;
    }
    case 'callout': {
      const b = calloutBox(ctx, m, toScreen, scale);
      m._screenBox = b;
      // leader + arrow at the tip
      ctx.beginPath();
      ctx.moveTo(b.anchorX, b.anchorY);
      ctx.lineTo(S[0], S[1]);
      ctx.stroke();
      arrowHead(ctx, b.anchorX, b.anchorY, S[0], S[1], 7 + m.width * 2.5);
      if (b.fontPx >= 3) {
        ctx.fillStyle = opts.boxFill || 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        ctx.rect(b.x, b.y, b.w, b.h);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = m.color;
        ctx.font = `${b.fontPx}px ${CALLOUT_FONT}`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        b.lines.forEach((l, i) => ctx.fillText(l, b.x + b.pad, b.y + b.pad + i * b.lh));
      } else {
        ctx.strokeRect(b.x, b.y, Math.max(2, b.w), Math.max(2, b.h));
      }
      break;
    }
    default:
  }
  ctx.restore();
}

/** Screen-space bbox of a markup (for selection outline + hit tests). */
export function markupScreenBox(ctx, m, toScreen, scale) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x, y) => { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; };
  for (let i = 0; i < m.pts.length; i += 2) add(...toScreen(m.pts[i], m.pts[i + 1]));
  if (m.type === 'callout') { const c = calloutBox(ctx, m, toScreen, scale); add(c.x, c.y); add(c.x + c.w, c.y + c.h); }
  if (m.type === 'cloud') { const r = (m.arc || 16 / scale) * scale * 0.6; b[0] -= r; b[1] -= r; b[2] += r; b[3] += r; }
  const pad = m.width / 2 + 1;
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

/** Distance (px) from screen point to the markup's drawn geometry; 0 when inside a callout box. */
export function markupHitDistance(ctx, m, toScreen, scale, sx, sy) {
  const S = [];
  for (let i = 0; i < m.pts.length; i += 2) S.push(...toScreen(m.pts[i], m.pts[i + 1]));
  const segDist = (ax, ay, bx, by) => {
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
    let t = L2 ? ((sx - ax) * vx + (sy - ay) * vy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(sx - (ax + vx * t), sy - (ay + vy * t));
  };
  const polyDist = (P, closed) => {
    let d = Infinity;
    const n = P.length / 2;
    if (n === 1) return Math.hypot(sx - P[0], sy - P[1]);
    for (let i = 0; i < (closed ? n : n - 1); i++) { const j = (i + 1) % n; d = Math.min(d, segDist(P[2 * i], P[2 * i + 1], P[2 * j], P[2 * j + 1])); }
    return d;
  };
  switch (m.type) {
    case 'pen': case 'highlight': return Math.max(0, polyDist(S, false) - m.width / 2);
    case 'line': case 'arrow': return polyDist(S, false);
    case 'rect': return polyDist(S, true);
    case 'cloud': return Math.max(0, polyDist(S, true) - (m.arc || 16 / scale) * scale * 0.5);
    case 'ellipse': {
      const cx = (S[0] + S[2]) / 2, cy = (S[1] + S[3]) / 2, rx = Math.abs(S[2] - S[0]) / 2 || 1, ry = Math.abs(S[3] - S[1]) / 2 || 1;
      const k = Math.hypot((sx - cx) / rx, (sy - cy) / ry);
      return Math.abs(k - 1) * Math.min(rx, ry);
    }
    case 'callout': {
      const b = calloutBox(ctx, m, toScreen, scale);
      if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) return 0;
      return segDist(b.anchorX, b.anchorY, S[0], S[1]);
    }
    default: return Infinity;
  }
}
