// Common drawing model shared by every format reader.
//
// model = {
//   format: 'DXF' | 'DGN', version, units: {code, name, abbr},
//   layers: [{ name, color (0xRRGGBB | FG), visible, frozen, ltype }],
//   ltypes: { NAME: { name, desc, pattern: [dash, gap, ...] (drawing units; 0 = dot) } },
//   blocks: { KEY: { name, base: [x, y], entities: [] } },   // KEY = upper-case name
//   entities: [ ... ], paperEntities: [ ... ],
//   stats: { entities, byType: {}, notShown: {TYPE: n}, warnings: [] },
//   header: { ... }
// }
//
// Entity shapes (all coordinates in drawing units; optional `xf` = OCS affine):
//   { type:'line', a:[x,y], b:[x,y] }
//   { type:'polyline', pts:[x,y,...], bulges:[...]|null, closed }
//   { type:'circle', c:[x,y], r }
//   { type:'arc', c:[x,y], r, a0, a1 }                      radians, CCW from a0 to a1
//   { type:'ellipse', c:[x,y], major:[x,y], minor:[x,y], t0, t1 }
//   { type:'spline', pts:[x,y,...], closed }                already approximated
//   { type:'text', p:[x,y], h, rot, text, halign, valign, wf, oblique, mirrorX, mirrorY, p2?:[x,y] }
//   { type:'mtext', p:[x,y], h, rot, text, attach, width, spacing }
//   { type:'insert', block, p:[x,y], sx, sy, rot, cols, rows, dc, dr, attribs:[text...] }
//   { type:'point', p:[x,y] }
//   { type:'solid', pts:[x,y,...] }                           filled
//   { type:'hatch', loops:[[x,y,...], ...], solid }
//   { type:'dimension', block, p:[x,y], text, fallback:[entities], dim:{...raw definition points} }
//   { type:'cell', name, origin:[x,y], children:[entities] }   DGN cell: children already placed
// Common props: layer (name), color (ACI 0..256; 0=BYBLOCK 256=BYLAYER), rgb (true colour or null),
//               ltype (name | 'BYLAYER' | 'BYBLOCK'), lts (its line type scale), weight (0..31 screen weight), group (cell id)
// Write-back props (readers keep them so a saved file loses as little as possible):
//   DXF: ext (OCS extrusion [x,y,z]), style (text style name), raw (TEXT/MTEXT string as stored),
//        tag (ATTRIB tag); DGN: dgn ([start, end) byte range of the element(s)), ci (colour index)

/** Colour flag meaning "foreground": white on dark backgrounds, black on paper (ACI 7). */
export const FG = 0x1000000;

export const UNITS = [
  ['Unitless', ''], ['Inches', 'in'], ['Feet', 'ft'], ['Miles', 'mi'], ['Millimeters', 'mm'],
  ['Centimeters', 'cm'], ['Meters', 'm'], ['Kilometers', 'km'], ['Microinches', 'µin'], ['Mils', 'mil'],
  ['Yards', 'yd'], ['Angstroms', 'Å'], ['Nanometers', 'nm'], ['Microns', 'µm'], ['Decimeters', 'dm'],
  ['Decameters', 'dam'], ['Hectometers', 'hm'], ['Gigameters', 'Gm'], ['Astronomical units', 'AU'],
  ['Light years', 'ly'], ['Parsecs', 'pc'], ['US Survey Feet', 'ft'], ['US Survey Inches', 'in'],
  ['US Survey Yards', 'yd'], ['US Survey Miles', 'mi'],
];

export function unitsFromCode(code) {
  const u = UNITS[code | 0] || UNITS[0];
  return { code: code | 0, name: u[0], abbr: u[1] };
}

/** Best-effort match of a short unit label (e.g. DGN master unit "ft", "m", "mm"). */
export function unitsFromLabel(label) {
  const l = String(label || '').trim().toLowerCase().replace(/[^a-zµ']/g, '');
  const map = { in: 1, ie: 1, inch: 1, '"': 1, ft: 2, fe: 2, ff: 2, "'": 2, mi: 3, mm: 4, cm: 5, m: 6, me: 6, km: 7, yd: 10, um: 13, 'µm': 13, dm: 14 };
  if (l in map) return unitsFromCode(map[l]);
  return { code: 0, name: label ? String(label).trim() : 'Unitless', abbr: label ? String(label).trim() : '' };
}

export function createModel(format) {
  return {
    format,
    version: '',
    units: unitsFromCode(0),
    layers: [],
    layerIndex: new Map(),
    ltypes: {},
    styles: {},
    blocks: {},
    entities: [],
    paperEntities: [],
    stats: { entities: 0, byType: {}, notShown: {}, warnings: [] },
    header: {},
  };
}

export function ensureLayer(model, name, color = FG) {
  const key = String(name ?? '0');
  let L = model.layerIndex.get(key.toUpperCase());
  if (!L) {
    L = { name: key, color, visible: true, frozen: false, ltype: 'CONTINUOUS' };
    model.layerIndex.set(key.toUpperCase(), L);
    model.layers.push(L);
  }
  return L;
}

export function countType(model, type) {
  model.stats.byType[type] = (model.stats.byType[type] || 0) + 1;
}

export function notShown(model, type, n = 1) {
  model.stats.notShown[type] = (model.stats.notShown[type] || 0) + n;
}

export function warn(model, msg) {
  if (model.stats.warnings.length < 50 && !model.stats.warnings.includes(msg)) model.stats.warnings.push(msg);
}

/** Entities with DGN cells expanded into their components (depth first). */
export function flatEntities(list, out = []) {
  for (const e of list) {
    if (!e) continue;
    if (e.type === 'cell') flatEntities(e.children || [], out); else out.push(e);
  }
  return out;
}

/** Error with a user-facing message and a machine code (e.g. 'binary-dxf', 'dwg'). */
export class FormatError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** JSON-safe summary of a model (strips the Map). */
export function modelSummary(model) {
  return {
    format: model.format,
    version: model.version,
    units: model.units,
    layers: model.layers.map((l) => ({ ...l })),
    stats: model.stats,
    blockCount: Object.keys(model.blocks).length,
  };
}
