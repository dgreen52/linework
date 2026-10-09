// Render batching (no DOM): primitives are bucketed into spatial chunks and, inside each chunk,
// into batches of identical style (layer, colour, line type, weight, fill). Runs in the parse
// worker so the main thread only has to build Path2D objects (lazily) when drawing.
import { KIND, FLAG } from '../scene.js';

export const BK = { STROKE: 0, FILL: 1, PATTERN: 2, POINT: 3 };

export function buildChunks(scene) {
  const n = scene.n;
  const ext = scene.extents;
  const W = Math.max(ext[2] - ext[0], 1e-9), H = Math.max(ext[3] - ext[1], 1e-9);
  const target = Math.max(1, Math.min(256, Math.ceil(n / 1500)));
  const nx = Math.max(1, Math.min(16, Math.round(Math.sqrt((target * W) / H))));
  const ny = Math.max(1, Math.min(16, Math.ceil(target / nx)));
  const cw = W / nx, chh = H / ny;
  const chunks = [];
  for (let i = 0; i <= nx * ny; i++) chunks.push({ bbox: [Infinity, Infinity, -Infinity, -Infinity], map: new Map(), batches: [] });
  const big = nx * ny;
  const ltypes = scene.ltypes;
  let order = 0;
  const orderOf = new Map();
  for (let i = 0; i < n; i++) {
    const o = 4 * i;
    const x0 = scene.bbox[o], y0 = scene.bbox[o + 1], x1 = scene.bbox[o + 2], y1 = scene.bbox[o + 3];
    let ci;
    if (x1 - x0 > 2 * cw || y1 - y0 > 2 * chh) ci = big;
    else {
      const ix = Math.min(nx - 1, Math.max(0, Math.floor(((x0 + x1) / 2 - ext[0]) / cw)));
      const iy = Math.min(ny - 1, Math.max(0, Math.floor(((y0 + y1) / 2 - ext[1]) / chh)));
      ci = iy * nx + ix;
    }
    const ch = chunks[ci];
    const f = scene.flags[i];
    const kind = scene.kind[i];
    const bk = kind === KIND.POINT ? BK.POINT : (f & FLAG.FILL) ? BK.FILL : (f & FLAG.PATTERN) ? BK.PATTERN : BK.STROKE;
    const layer = scene.layer[i], color = scene.color[i];
    // fills: the style slot carries the even-odd flag instead (so holes are never filled by a shared batch)
    const style = bk === BK.STROKE ? scene.style[i] : (f & FLAG.EVENODD ? 1 : 0), weight = bk === BK.STROKE ? scene.weight[i] : 0;
    // numeric key (string keys for 50k+ items are slow): bk 2 bits, style 8, weight 5, layer 16; colour in a sub-map
    const nk = ((bk * 256 + style) * 32 + weight) * 65536 + layer;
    let sub = ch.map.get(nk);
    if (!sub) { sub = new Map(); ch.map.set(nk, sub); }
    let g = sub.get(color);
    if (!g) {
      const key = nk + ':' + color;
      let ord = orderOf.get(key);
      if (ord === undefined) { ord = bk === BK.FILL ? order : bk === BK.PATTERN ? 1e6 + order : 2e6 + order; order++; orderOf.set(key, ord); }
      g = { key, bk, layer, color, weight, dash: bk === BK.STROKE && ltypes[style] ? ltypes[style].dash : null, evenodd: !!(f & FLAG.EVENODD), ids: [], path: null, order: ord };
      sub.set(color, g);
      ch.batches.push(g);
    }
    g.ids.push(i);
    const b = ch.bbox;
    if (x0 < b[0]) b[0] = x0; if (y0 < b[1]) b[1] = y0; if (x1 > b[2]) b[2] = x1; if (y1 > b[3]) b[3] = y1;
  }
  return chunks.filter((c) => c.batches.length).map((c) => ({
    bbox: c.bbox,
    batches: c.batches.map((g) => ({ ...g, ids: Uint32Array.from(g.ids), path: null })),
  }));
}

/** Typed arrays inside the chunk list (for transfer from the worker). */
export function chunkTransferables(chunks) {
  const out = [];
  for (const c of chunks) for (const g of c.batches) out.push(g.ids.buffer);
  return out;
}
