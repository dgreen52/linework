// Markup resize handles (pure, DOM-free; loaded with the Select tool). A selected markup shows handles:
// lines and arrows their two ends, a callout its leader tip and its box point, everything else (box,
// ellipse, cloud, pen, highlighter) the eight handles of its outline — dragging one scales the markup's
// points from the opposite side (Shift keeps the proportions at a corner). Drawing coordinates throughout.

const SIDES = { nw: 'lt', n: 't', ne: 'rt', e: 'r', se: 'rb', s: 'b', sw: 'lb', w: 'l' };

/** The bbox of a markup's own points (no cloud scallops, no callout box): [x0, y0, x1, y1]. */
export function pointsBBox(pts) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  return b;
}

/**
 * The handles of markup m: [{ id, x, y, cursor }]. id: 'p0', 'p1' (a point: line / arrow ends, the callout's
 * leader tip and box point) or a side of the outline: 'nw' 'n' 'ne' 'e' 'se' 's' 'sw' 'w' (y up: n is the top).
 */
export function markupHandles(m) {
  if (!m || !m.pts || m.pts.length < 4) return [];
  if (m.type === 'line' || m.type === 'arrow' || m.type === 'callout') {
    return [{ id: 'p0', x: m.pts[0], y: m.pts[1], cursor: 'move' }, { id: 'p1', x: m.pts[2], y: m.pts[3], cursor: 'move' }];
  }
  const [x0, y0, x1, y1] = pointsBBox(m.pts), mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const all = [
    ['nw', x0, y1, 'nwse-resize'], ['n', mx, y1, 'ns-resize'], ['ne', x1, y1, 'nesw-resize'], ['e', x1, my, 'ew-resize'],
    ['se', x1, y0, 'nwse-resize'], ['s', mx, y0, 'ns-resize'], ['sw', x0, y0, 'nesw-resize'], ['w', x0, my, 'ew-resize'],
  ];
  // a flat outline (a straight highlighter stroke) has no height to drag: only its ends' handles
  const flatY = y1 - y0 < 1e-12, flatX = x1 - x0 < 1e-12;
  return all.filter(([id]) => !(flatY && /^[ns]$/.test(id)) && !(flatX && /^[ew]$/.test(id))).map(([id, x, y, cursor]) => ({ id, x, y, cursor }));
}

/** The handle within tol (drawing units) of (x, y), nearest first; null when none. */
export function handleAt(m, x, y, tol) {
  let best = null, bd = tol;
  for (const h of markupHandles(m)) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d <= bd) { bd = d; best = h; }
  }
  return best;
}

/**
 * Markup `orig` with handle `id` dragged to (x, y): a new markup (orig is not changed). opts: { keepRatio (corner
 * handles keep the outline's proportions), min (smallest outline size, drawing units; default 1e-9), now (ISO time) }.
 * The outline never turns inside out: a side dragged past the opposite one stops `min` short of it.
 */
export function resizeMarkup(orig, id, x, y, opts = {}) {
  const pts = orig.pts.slice(), out = { ...orig, pts, modified: opts.now || new Date().toISOString() };
  if (id === 'p0' || id === 'p1') {
    const k = id === 'p0' ? 0 : 2;
    pts[k] = x; pts[k + 1] = y;
    return out;
  }
  const sides = SIDES[id];
  if (!sides) return orig;
  const min = opts.min > 0 ? opts.min : 1e-9, [x0, y0, x1, y1] = pointsBBox(orig.pts), ow = x1 - x0, oh = y1 - y0;
  let L = x0, R = x1, B = y0, T = y1;
  if (sides.includes('l')) L = Math.min(x, x1 - min);
  if (sides.includes('r')) R = Math.max(x, x0 + min);
  if (sides.includes('b')) B = Math.min(y, y1 - min);
  if (sides.includes('t')) T = Math.max(y, y0 + min);
  if (opts.keepRatio && sides.length === 2 && ow > 0 && oh > 0) { // a corner: the larger stretch wins, the opposite corner stays
    const s = Math.max((R - L) / ow, (T - B) / oh);
    if (sides.includes('l')) L = x1 - ow * s; else R = x0 + ow * s;
    if (sides.includes('b')) B = y1 - oh * s; else T = y0 + oh * s;
  }
  const sx = ow > 0 ? (R - L) / ow : 1, sy = oh > 0 ? (T - B) / oh : 1;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    pts[i] = ow > 0 ? L + (orig.pts[i] - x0) * sx : orig.pts[i];
    pts[i + 1] = oh > 0 ? B + (orig.pts[i + 1] - y0) * sy : orig.pts[i + 1];
  }
  return out;
}
