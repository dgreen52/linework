// Attributes of drawing items (pure): select by level / colour / weight / type, match attributes, and the
// element information panel.
import { restyle, isText } from './ops.js';
import { TYPE_NAMES } from '../formats/dgn.js';
import { fmtNum } from '../tools/measure.js';
import { bulgePolylineLength, bulgePolygonArea, polylineLength, TAU } from '../geom.js';
import { ACI } from '../palettes.js';

export const ATTRS = ['layer', 'color', 'weight', 'type'];
const dgnColor = (e) => (e.ci != null ? e : (e.children || []).find((k) => k && k.ci != null) || null);
/** A string equal for items that share the attribute. */
export function attrKey(e, attr, format) {
  if (!e) return '';
  if (attr === 'layer') return String(e.layer ?? '0');
  if (attr === 'weight') return String(format === 'DGN' ? e.weight | 0 : e.lw ?? -1);
  if (attr === 'type') return e.src || e.type;
  if (format === 'DGN') { const c = dgnColor(e); return c ? 'ci' + c.ci : 'ci0'; }
  return e.rgb != null ? 'rgb' + e.rgb : 'aci' + (e.color ?? 256);
}

/** Entities among `candidates` whose attributes `attrs` all take one of the values in `keys` ({ attr: Set }). */
export function selectByKeys(entities, candidates, keys, format) {
  const out = new Set();
  const want = ATTRS.filter((a) => keys[a]);
  if (!want.length) return out;
  for (const i of candidates) {
    const e = entities[i];
    if (e && want.every((a) => keys[a].has(attrKey(e, a, format)))) out.add(i);
  }
  return out;
}
/** Keys of the selection for attributes `attrs`: { attr: Set }. */
export function keysOf(entities, ids, attrs, format) {
  const k = {};
  for (const a of attrs) k[a] = new Set([...ids].map((i) => entities[i]).filter(Boolean).map((e) => attrKey(e, a, format)));
  return k;
}
/** Values present among `ids`: Map key -> { e (an example), n }. */
export function valuesOf(entities, ids, attr, format) {
  const m = new Map();
  for (const i of ids) {
    const e = entities[i];
    if (!e) continue;
    const k = attrKey(e, attr, format), v = m.get(k);
    if (v) v.n++; else m.set(k, { e, n: 1 });
  }
  return m;
}

/** Entity e restyled like `src`: level / layer, colour, weight and line style (cells: their components too). */
export function matchStyle(e, src, format) {
  if (!e || !src) return e;
  const c = format === 'DGN' ? dgnColor(src) : null;
  let o = restyle(e, { layer: src.layer ?? '0', weight: format === 'DGN' ? src.weight | 0 : src.lw ?? -1, color: c ? { ci: c.ci, rgb: c.rgb } : undefined }, format);
  const set = (x) => {
    const y = { ...x, ltype: src.ltype };
    if (format !== 'DGN') { y.color = src.color ?? 256; y.rgb = src.rgb ?? null; }
    if (x.children) y.children = x.children.map(set);
    return y;
  };
  o = set(o);
  if (!src.ltype) delete o.ltype;
  return o;
}

// ------------------------------------------------------------------ element information
const DGN_NUM = Object.fromEntries(Object.entries(TYPE_NAMES).map(([n, s]) => [s, +n]));
// text justification codes of DGN v7 text elements (as named by GDAL's dgnlib)
const JUST = ['Left top', 'Left centre', 'Left bottom', 'Left margin top', 'Left margin centre', 'Left margin bottom', 'Centre top', 'Centre centre',
  'Centre bottom', 'Right margin top', 'Right margin centre', 'Right margin bottom', 'Right top', 'Right centre', 'Right bottom'];
const HAL = ['Left', 'Centre', 'Right', 'Aligned', 'Middle', 'Fit'], VAL = ['Baseline', 'Bottom', 'Middle', 'Top'];
const STYLE = ['0 (solid)', '1 (dotted)', '2 (medium dash)', '3 (long dash)', '4 (dot dash)', '5 (short dash)', '6 (dash double-dot)', '7 (long dash short dash)'];
const NAME = { line: 'Line', polyline: 'Polyline', spline: 'Curve', circle: 'Circle', arc: 'Arc', ellipse: 'Ellipse', text: 'Text', mtext: 'Multiline text',
  insert: 'Block', point: 'Point', solid: 'Solid fill', hatch: 'Hatch', dimension: 'Dimension', cell: 'Cell' };
const deg = (a) => { let d = (a * 180) / Math.PI; d = ((d % 360) + 360) % 360; return d; };

/** "Line string (type 4)" style name of an item. */
export function typeName(e, format) {
  let t = NAME[e.type] || e.type;
  if (e.type === 'polyline' && e.closed) t = 'Closed polyline';
  if (format === 'DGN') {
    const n = DGN_NUM[e.src];
    const s = e.src ? e.src.charAt(0) + e.src.slice(1).toLowerCase().replace(/_/g, ' ') : t;
    return n ? `${s} (type ${n})` : s;
  }
  return e.src && e.src !== t.toUpperCase() ? `${t} (${e.src})` : t;
}

/** Colour of an item for the panel: { label, rgb (null: the foreground colour) }. */
export function colorOf(e, format) {
  if (format === 'DGN') { const c = dgnColor(e); return c ? { label: `${c.ci}`, rgb: c.rgb } : { label: '0', rgb: null }; }
  if (e.rgb != null) return { label: '#' + (e.rgb & 0xffffff).toString(16).padStart(6, '0'), rgb: e.rgb };
  const c = e.color ?? 256;
  if (c === 256) return { label: 'ByLayer', rgb: undefined };
  if (c === 0) return { label: 'ByBlock', rgb: undefined };
  return { label: `${c}`, rgb: c === 7 ? null : ACI[c] };
}

/**
 * Rows for the element information panel: [[label, value, rgb?]] plus `parts` (a cell's components,
 * [{ depth, text }]). ctx: { format, bytes (original file, DGN), orig (the item as read; undefined = new),
 * abbr (units), dec, layerLabel(name) }.
 */
export function entityInfo(e, ctx = {}) {
  const { format = 'DXF', dec = 2, abbr = '' } = ctx;
  const n = (v) => fmtNum(v, dec), L = (v) => n(v) + (abbr ? ' ' + abbr : ''), P = (p) => `${n(p[0])}, ${n(p[1])}`;
  const rows = [['Type', typeName(e, format)]];
  const dgn = format === 'DGN';
  rows.push([dgn ? 'Level' : 'Layer', ctx.layerLabel ? ctx.layerLabel(String(e.layer ?? '0')) : String(e.layer ?? '0')]);
  const c = colorOf(e, format);
  rows.push(['Colour', c.label, c.rgb]);
  rows.push(['Weight', dgn ? String(e.weight | 0) : e.lw >= 0 ? (e.lw / 100).toFixed(2) + ' mm' : ['ByLayer', 'ByBlock', 'Default'][-1 - (e.lw ?? -1)] || 'Default']);
  const lt = e.ltype || (dgn ? 'CONTINUOUS' : 'BYLAYER');
  const m = /^DGN(\d)$/.exec(lt);
  rows.push(['Line style', dgn ? STYLE[m ? +m[1] : 0] : lt]);
  if (e.type === 'cell') rows.push(['Cell', e.name || '(no name)']);
  if (e.type === 'insert' || e.type === 'dimension') rows.push(['Block', e.block || '']);
  switch (e.type) {
    case 'line': {
      const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1];
      rows.push(['Start', P(e.a)], ['End', P(e.b)], ['Length', L(Math.hypot(dx, dy))], ['Angle', fmtNum(deg(Math.atan2(dy, dx)), 2) + '°']);
      break;
    }
    case 'polyline': {
      rows.push(['Vertices', String(e.pts.length / 2)], ['First vertex', P(e.pts)]);
      rows.push([e.closed ? 'Perimeter' : 'Length', L(bulgePolylineLength(e.pts, e.bulges, !!e.closed))]);
      if (e.closed) rows.push(['Area', n(Math.abs(bulgePolygonArea(e.pts, e.bulges))) + (abbr ? ` ${abbr}²` : '')]);
      break;
    }
    case 'spline': case 'solid': rows.push(['Points', String(e.pts.length / 2)], ['Length', L(polylineLength(e.pts, !!e.closed))]); break;
    case 'circle': rows.push(['Centre', P(e.c)], ['Radius', L(e.r)], ['Diameter', L(2 * e.r)], ['Circumference', L(TAU * e.r)], ['Area', n(Math.PI * e.r * e.r) + (abbr ? ` ${abbr}²` : '')]); break;
    case 'arc': {
      let sw = e.a1 - e.a0; while (sw <= 0) sw += TAU;
      rows.push(['Centre', P(e.c)], ['Radius', L(e.r)], ['Start angle', fmtNum(deg(e.a0), 2) + '°'], ['Sweep', fmtNum((sw * 180) / Math.PI, 2) + '°'], ['Length', L(e.r * sw)]);
      break;
    }
    case 'ellipse': rows.push(['Centre', P(e.c)], ['Axes', `${L(2 * Math.hypot(...e.major))} × ${L(2 * Math.hypot(...e.minor))}`], ['Rotation', fmtNum(deg(Math.atan2(e.major[1], e.major[0])), 2) + '°']); break;
    case 'point': rows.push(['Position', P(e.p)]); break;
    case 'insert': rows.push(['Insertion point', P(e.p)], ['Scale', `${n(e.sx ?? 1)} × ${n(e.sy ?? 1)}`], ['Rotation', fmtNum(deg(e.rot || 0), 2) + '°']); if (e.attribs && e.attribs.length) rows.push(['Attributes', String(e.attribs.length)]); break;
    case 'cell':
      if (e.origin) rows.push(['Origin', P(e.origin)]);
      if (e.xscale != null) rows.push(['Scale', `${n(e.xscale)} × ${n(e.yscale)}`], ['Rotation', fmtNum(deg(e.rotation || 0), 2) + '°']);
      rows.push(['Components', String((e.children || []).length)]);
      break;
    default:
  }
  if (isText(e)) textRows(e, rows, ctx, L, P);
  if (dgn) {
    const b = ctx.bytes;
    if (e.dgn && b && e.dgn[0] + 1 < b.length) {
      const o = e.dgn[0];
      rows.push(['Element', `type ${b[o + 1] & 0x7f} · ${fmtNum(e.dgn[1] - o, 0)} bytes`]);
      rows.push(['File offset', `${fmtNum(o, 0)} (0x${o.toString(16).toUpperCase()})`]);
      rows.push(['Saved as', e.pasted ? 'a copy of those bytes, added at the end' : ctx.orig === e ? 'in the file, unchanged' : 'rebuilt from those bytes (edited)']);
    } else rows.push(['Saved as', 'a new element, added at the end']);
  }
  const parts = [];
  const walk = (list, depth) => {
    for (const k of list || []) {
      if (!k || parts.length >= 200) continue;
      parts.push({ depth, text: `${typeName(k, format)}${isText(k) ? ` “${String(k.text).slice(0, 40)}”` : ''}${k.type === 'cell' ? ` ${k.name || ''}` : ''} · ${k.layer ?? '0'} · colour ${colorOf(k, format).label}` });
      if (k.children) walk(k.children, depth + 1);
    }
  };
  if (e.type === 'cell') walk(e.children, 0);
  if (e.type === 'insert') walk(e.attribs, 0);
  return { rows, parts };
}

function textRows(e, rows, ctx, L, P) {
  rows.push(['Text', String(e.text).replace(/\n/g, ' ⏎ ')], ['Origin', P(e.p)], ['Height', L(e.h)]);
  if (e.wf && Math.abs(e.wf - 1) > 1e-9) rows.push(['Width factor', fmtNum(e.wf, 3)]);
  rows.push(['Angle', fmtNum(deg(e.rot || 0), 2) + '°']);
  if (ctx.format === 'DGN') {
    if (e.font != null) rows.push(['Font', String(e.font)]);
    if (e.just != null) rows.push(['Justification', `${JUST[e.just] || 'Code'} (${e.just})`]);
  } else {
    if (e.style) rows.push(['Text style', e.style]);
    rows.push(['Justification', e.type === 'mtext' ? `Attachment ${e.attach || 1}` : `${HAL[e.halign | 0] || 'Left'} / ${VAL[e.valign | 0] || 'Baseline'}`]);
  }
}
