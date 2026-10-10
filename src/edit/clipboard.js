// Copy / paste of drawing items between drawings (and Duplicate inside one). A copy is a
// self-contained payload: the items, cloned with everything tied to the source file's bytes
// removed (DGN byte ranges, raw Z, cell ids) and their colours / line weights made explicit, plus
// what they depend on (block definitions, line types, text styles, layers), the source format and
// units, and the items' extents. On the system clipboard it is text/plain: a header line + JSON,
// so it travels between tabs and windows with no permission prompt. preparePaste() turns a payload
// into changes for a target drawing: unit scaling, layers / levels, colours through the target's
// colour table, line weights, block renames, DXF blocks exploded for DGN v7, Z for 3D DGN files.
import { transformEntity } from './ops.js';
import { weightToLw, lwToWeight } from '../scene.js';
import { ACI, DGN_DEFAULT } from '../palettes.js';
import { FG } from '../model.js';
import { insertMatrix, mul, scale, IDENTITY } from '../geom.js';

export const CLIP_HEADER = 'LINEWORK-CLIPBOARD 1';
export const CLIP_MAX = 24e6; // characters for the system clipboard (bigger copies stay in this tab)
// metres per drawing unit, by $INSUNITS code (0 = unitless: unknown)
const METRES = [0, 0.0254, 0.3048, 1609.344, 1e-3, 1e-2, 1, 1e3, 2.54e-8, 2.54e-5, 0.9144, 1e-10, 1e-9, 1e-6, 0.1, 10, 100, 1e9,
  1.495978707e11, 9.4607304725808e15, 3.0856775814913673e16, 1200 / 3937, 100 / 3937, 3600 / 3937, 6336000 / 3937];
const STD = new Set(['BYLAYER', 'BYBLOCK', 'CONTINUOUS']);
const up = (s) => String(s ?? '').toUpperCase();
const aciRgb = (c) => (c > 0 && c < 256 && c !== 7 ? ACI[c] : 0xffffff);
/** Each entity and its parts (cell components, attributes, dimension fallback), depth first. */
const each = (list, fn) => { for (const e of list) if (e) { fn(e); each(e.children || [], fn); each(e.attribs || [], fn); each(e.fallback || [], fn); } };

/** Copy of an entity without what only makes sense in its source file (byte ranges, raw Z, cell ids). */
function strip(e, z) {
  const o = { ...e };
  delete o.dgn; delete o.group; delete o.id; delete o.paper; delete o.pasted;
  if (o.zr != null) { if (z) o.z = z(o.zr); delete o.zr; }
  for (const k of ['children', 'attribs', 'fallback']) if (o[k]) o[k] = o[k].map((c) => c && strip(c, z));
  return o;
}

/**
 * Payload for entity slots `ids` of `model`. opts.ext: world extents of the items [x0, y0, x1, y1]
 * (the paste base point is their lower-left corner).
 */
export function makePayload(model, ids, { ext = [0, 0, 0, 0] } = {}) {
  const h = model.header || {}, dgn = model.format === 'DGN';
  const uor = (h.subPerMaster || 1) * (h.uorPerSub || 1);
  const z = dgn && h.dimension === 3 ? (zr) => zr / uor - (h.oz || 0) : null;
  const L = new Map(model.layers.map((l) => [up(l.name), l]));
  const lay = (n) => L.get(up(n ?? '0'));
  // DXF: ByLayer / ByBlock colour and line weight become explicit (marked, so a paste can give back
  // ByLayer when the target layer looks the same); DGN items already carry a colour-table entry
  const explicit = (o) => {
    if (dgn) return;
    const l = lay(o.layer);
    if (o.rgb == null && (o.color ?? 256) === 256) {
      o._bl = 1;
      const c = l ? l.color : FG;
      if (c === FG || c == null) o.color = 7;
      else if (l.aci && ACI[l.aci] === c) o.color = l.aci;
      else { o.rgb = c; o.color = 256; }
    } else if (o.rgb == null && o.color === 0) o.color = 7;
    const lw = o.lw ?? -1;
    if (lw === -1) { o.lw = l && l.lw != null ? l.lw : -3; o._bw = 1; } else if (lw === -2) o.lw = -3;
    for (const c of [...(o.children || []), ...(o.attribs || [])]) if (c) explicit(c); // copies made by strip()
  };
  const ents = [];
  for (const i of ids) { const e = model.entities[i]; if (!e) continue; const o = strip(e, z); explicit(o); ents.push(o); }
  // dependencies: blocks (nested and dimension blocks too), layers, line types, text styles
  const blocks = {}, layers = new Map(), ltypes = {}, styles = {};
  const use = (list) => each(list, (e) => {
    const l = lay(e.layer);
    if (!layers.has(up(e.layer ?? '0'))) layers.set(up(e.layer ?? '0'), l ? { name: l.name, color: l.color, aci: l.aci, ltype: l.ltype, lw: l.lw } : { name: String(e.layer ?? '0'), color: FG });
    for (const n of [e.ltype, l && l.ltype]) if (n && !STD.has(up(n)) && model.ltypes[up(n)]) ltypes[up(n)] = model.ltypes[up(n)];
    if (e.style && model.styles && model.styles[up(e.style)]) styles[up(e.style)] = model.styles[up(e.style)];
    const k = (e.type === 'insert' || e.type === 'dimension') && up(e.block), b = k && model.blocks[k];
    if (b && !blocks[k]) { blocks[k] = { ...b, entities: b.entities.map((c) => c && strip(c, z)) }; use(blocks[k].entities); }
  });
  use(ents);
  return { app: 'Linework', v: 1, format: model.format, units: model.units, dim: h.dimension || 2, ext, ents, blocks, layers: [...layers.values()], ltypes, styles };
}

export const clipText = (p) => CLIP_HEADER + '\n' + JSON.stringify(p);
/** Payload from clipboard text, or null when the text is not a Linework copy. */
export function parseClip(text) {
  if (typeof text !== 'string' || !text.startsWith(CLIP_HEADER)) return null;
  try { const p = JSON.parse(text.slice(CLIP_HEADER.length)); return p && p.v === 1 && Array.isArray(p.ents) ? p : null; } catch { return null; }
}

/** Unit factor source -> target: { k, note } (k = 1 when either is unknown). */
export function unitScale(from, to) {
  const a = from && from.code | 0, b = to && to.code | 0;
  if (a && b) return a === b ? { k: 1 } : { k: METRES[a] / METRES[b], note: `Scaled from ${from.abbr || from.name} to ${to.abbr || to.name}.` };
  if (!a && !b && (from && from.name) === (to && to.name)) return { k: 1 };
  return { k: 1, note: `Not scaled: the ${a ? 'target drawing' : 'copied items'} ha${a ? 's' : 've'} no known units.` };
}

/** DXF line type -> one of the 7 DGN line styles (dots, dashes, dash-dot), by its pattern. */
function dgnStyle(name, defs) {
  const n = up(name);
  if (/^DGN\d$/.test(n)) return n;
  const p = (defs[n] && defs[n].pattern) || [];
  if (n === 'CONTINUOUS' || !p.length) return 'CONTINUOUS';
  return p.length > 2 ? 'DGN4' : p.some((v) => v === 0) ? 'DGN1' : 'DGN2';
}

/**
 * Turn payload P into a paste for `target` (a model). opts.layer: level for items from a DXF when
 * the target is a DGN (DGN levels are numbers). Returns { ents (in-place coordinates, target
 * units), changes (layer / table changes to commit first), base (lower-left of the items: the
 * point that follows the cursor), notes }.
 */
export function preparePaste(P, target, opts = {}) {
  const toDgn = target.format === 'DGN', fromDgn = P.format === 'DGN';
  const notes = [], changes = [];
  const { k, note } = unitScale(P.units, target.units);
  if (note) notes.push(note);
  const srcL = new Map(P.layers.map((l) => [up(l.name), l]));
  const tL = new Map(target.layers.map((l) => [up(l.name), l]));
  const defs = { ...(target.ltypes || {}), ...P.ltypes };
  // ---- layers / levels
  const cur = opts.layer || 'Level 1';
  const layerFor = (n) => {
    const name = !fromDgn && toDgn ? cur : String(n ?? '0');
    if (!tL.has(up(name))) {
      const s = srcL.get(up(name)) || {};
      const rec = toDgn ? { name, color: 0xffffff, ltype: 'CONTINUOUS' }
        : fromDgn ? { name, color: FG, aci: 7, ltype: 'CONTINUOUS' }
          : { name, color: s.color ?? FG, aci: s.aci ?? 7, ltype: s.ltype || 'CONTINUOUS', lw: s.lw };
      tL.set(up(name), rec);
      changes.push({ layer: name, before: null, after: rec });
    }
    return tL.get(up(name)).name;
  };
  // ---- colours: DGN targets use their own colour table (nearest entry), DXF targets ACI or true colour
  const pal = toDgn ? (target.header && target.header.palette) || DGN_DEFAULT : null;
  const near = new Map();
  const ciOf = (rgb, ci) => {
    if (ci != null && pal[ci] === rgb) return ci;
    if (!near.has(rgb)) { let best = 0, bd = Infinity; for (let i = 0; i < 255; i++) { const c = pal[i], d = ((c >> 16) - (rgb >> 16)) ** 2 + (((c >> 8) & 255) - ((rgb >> 8) & 255)) ** 2 + ((c & 255) - (rgb & 255)) ** 2; if (d < bd) { bd = d; best = i; } } near.set(rgb, best); }
    return near.get(rgb);
  };
  const aciOf = new Map();
  for (let i = 255; i > 0; i--) if (i !== 7) aciOf.set(ACI[i], i);
  const th = target.header || {}, tz = toDgn && th.dimension === 3;
  const tuor = (th.subPerMaster || 1) * (th.uorPerSub || 1);
  let flat = 0, exploded = 0;
  /** One entity (and its parts) converted for the target: layer, colour, weight, line type, Z. */
  const conv = (e) => {
    const o = { ...e };
    o.layer = layerFor(e.layer);
    const L = tL.get(up(o.layer));
    if (toDgn) {
      const rgb = o.rgb != null && o.rgb !== FG ? o.rgb & 0xffffff : aciRgb(o.color);
      o.ci = ciOf(rgb, fromDgn ? o.ci : null); o.rgb = pal[o.ci]; o.color = 256;
      if (!fromDgn) { o.weight = lwToWeight(o.lw ?? -1); o.ltype = dgnStyle(o.ltype === 'BYLAYER' || !o.ltype ? (srcL.get(up(e.layer)) || {}).ltype || '' : o.ltype, defs); delete o.style; }
      delete o.lw;
    } else {
      if (o.rgb != null) {
        const c = o.rgb & 0xffffff;
        if (o.rgb === FG || c === 0xffffff || c === 0) { o.color = 7; o.rgb = null; } else if (aciOf.has(c)) { o.color = aciOf.get(c); o.rgb = null; }
      }
      if (o._bl && (o.rgb ?? (o.color === 7 ? FG : ACI[o.color])) === L.color) { o.color = 256; o.rgb = null; }
      if (fromDgn) { const lw = weightToLw(o.weight); if (lw >= 0) o.lw = lw; delete o.weight; delete o.font; delete o.just; }
      else if (o._bw && (L.lw ?? -3) === o.lw) delete o.lw;
      delete o.ci;
    }
    if (o.z != null) { if (tz) o.zr = Math.round((o.z * k + (th.oz || 0)) * tuor); else if (o.z) flat++; delete o.z; }
    else if (tz) o.zr = Math.round((th.oz || 0) * tuor);
    delete o._bl; delete o._bw;
    if (o.children) o.children = o.children.map((c) => c && conv(c));
    if (o.attribs) o.attribs = o.attribs.map((c) => c && conv(c));
    return o;
  };
  // ---- DXF blocks: exploded for DGN v7 (no blocks there); else copied in, renamed on a name clash
  let list = P.ents;
  if (toDgn && !fromDgn) {
    const out = [];
    for (const e of list) if (e.type === 'insert' || e.type === 'dimension') { exploded++; explode(e, IDENTITY, P, srcL, out, 0); } else out.push(e);
    list = out;
  }
  const ren = new Map();
  if (!toDgn) {
    const tb = target.blocks || {}, used = new Set([...Object.keys(tb), ...Object.keys(P.blocks)]);
    const refs = (l) => l.map((c) => (c && c.block && ren.has(up(c.block)) ? { ...c, block: ren.get(up(c.block)) } : c));
    const same = (b, t) => JSON.stringify([b.base, refs(b.entities)]) === JSON.stringify([t.base, t.entities.map((c) => c && strip(c))]);
    const fresh = (n) => {
      const m = /^(\*[A-Z]+)\d*$/i.exec(n);
      if (m) { let i = 0; for (const u of used) { const q = new RegExp('^\\' + m[1] + '(\\d+)$', 'i').exec(u); if (q) i = Math.max(i, +q[1]); } n = m[1] + (i + 1); }
      else { let i = 2; while (used.has(up(n + '_' + i))) i++; n = n + '_' + i; }
      used.add(up(n));
      return n;
    };
    for (let again = true; again;) {
      again = false;
      for (const [K, b] of Object.entries(P.blocks)) if (!ren.has(K) && tb[K] && !same(b, tb[K])) { ren.set(K, fresh(b.name)); again = true; }
    }
    for (const [K, b] of Object.entries(P.blocks)) {
      if (tb[K] && !ren.has(K)) continue; // the same block is already there
      const name = ren.get(K) || b.name;
      changes.push({ table: 'blocks', key: up(name), before: null, after: { ...b, name, entities: refs(b.entities) } });
      each(b.entities, (c) => layerFor(c.layer));
    }
    if (ren.size) notes.push(`Block${ren.size > 1 ? 's' : ''} renamed (a different block has that name here): ${[...ren].map(([a, b]) => `${P.blocks[a].name} → ${b}`).slice(0, 4).join(', ')}.`);
    for (const [n, d] of Object.entries(P.ltypes)) if (!(target.ltypes || {})[n]) changes.push({ table: 'ltypes', key: n, before: null, after: d });
    for (const [n, d] of Object.entries(P.styles || {})) if (!(target.styles || {})[n]) changes.push({ table: 'styles', key: n, before: null, after: d });
    list = list.map((e) => (e.block && ren.has(up(e.block)) ? { ...e, block: ren.get(up(e.block)) } : e));
  }
  const M = k !== 1 ? scale(k) : null;
  const ents = list.map((e) => { const o = conv(e); o.pasted = 1; return M ? transformEntity(o, M) : o; });
  if (exploded) notes.push(`${exploded} block${exploded === 1 ? ' was' : 's were'} exploded into separate items (DGN v7 has no blocks).`);
  if (toDgn && !fromDgn) notes.push(`Pasted on ${cur} (DGN levels have numbers, not names).`);
  if (flat) notes.push(`${flat} item${flat === 1 ? '' : 's'} from a 3D file flattened to Z = 0 (this drawing is 2D).`);
  return { ents, changes, base: [P.ext[0] * k, P.ext[1] * k], notes, k };
}

/** Block content of a DXF insert / dimension placed in the world (nested blocks too), ByBlock and layer 0 resolved. */
function explode(e, M0, P, srcL, out, depth) {
  const lay = (n) => srcL.get(up(n)) || {};
  const own = (c) => {
    const o = { ...c };
    if (String(o.layer ?? '0') === '0') o.layer = e.layer;
    if (o.rgb == null) {
      const n = o.color ?? 0;
      if (n === 0) { o.color = e.color; o.rgb = e.rgb; } else if (n === 256) { const l = lay(o.layer); if (l.color != null && l.color !== FG) o.rgb = l.color; else o.color = 7; }
    }
    const lw = o.lw ?? -1;
    o.lw = lw === -2 ? e.lw : lw === -1 ? lay(o.layer).lw ?? -3 : lw;
    const lt = up(o.ltype || 'BYLAYER');
    o.ltype = lt === 'BYBLOCK' ? e.ltype : lt === 'BYLAYER' ? lay(o.layer).ltype || 'CONTINUOUS' : lt;
    return o;
  };
  if (up(e.ltype || 'BYLAYER') === 'BYLAYER') e = { ...e, ltype: lay(e.layer).ltype || 'CONTINUOUS' };
  const blk = P.blocks[up(e.block)];
  const kids = blk && blk.entities.length ? blk.entities : e.type === 'dimension' ? e.fallback || [] : [];
  const Me = e.xf ? mul(M0, e.xf) : M0, mats = [];
  if (e.type === 'dimension') mats.push(e.mv ? mul(mul(M0, e.mv), e.xf || IDENTITY) : Me);
  else if (blk) {
    const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
    for (let r = 0; r < (e.rows || 1); r++) for (let q = 0; q < (e.cols || 1); q++) {
      const ox = q * (e.dc || 0), oy = r * (e.dr || 0);
      mats.push(mul(Me, insertMatrix(e.p[0] + c * ox - s * oy, e.p[1] + s * ox + c * oy, e.sx ?? 1, e.sy ?? 1, e.rot || 0, blk.base[0], blk.base[1])));
    }
  }
  for (const Mi of mats) for (const c of kids) {
    if (!c || c.invisible) continue;
    const o = own(c);
    if (o.type === 'insert' || o.type === 'dimension') { if (depth < 16) explode(o, Mi, P, srcL, out, depth + 1); } else out.push(transformEntity(o, Mi));
  }
  for (const a of e.attribs || []) if (a && !a.invisible) out.push(transformEntity(own(a), M0));
}

/** Paste for a duplicate inside the same drawing (same model, so nothing is converted). */
export const duplicate = (model, ids, ext, layer) => preparePaste(makePayload(model, ids, { ext }), model, { layer });
