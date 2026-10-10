// Minimal DWG R2000 (AC1015) writer, used ONLY to make synthetic test fixtures from the repo's own
// synthetic DXF files (see tools/make_dwg_fixtures.mjs). It is not part of the app.
//
// Written from the publicly available "Open Design Specification for .dwg files" (bit codes,
// section layout, object encodings). It writes just enough for a reader to rebuild the drawing:
// file header, header variables, classes (none), tables (LTYPE, LAYER, STYLE, BLOCK_HEADER and
// the other control objects), a root dictionary, blocks and these entities: LINE, POINT, CIRCLE,
// ARC, ELLIPSE, LWPOLYLINE, POLYLINE (2D) + VERTEX, SPLINE, TEXT, MTEXT, ATTDEF, INSERT/MINSERT +
// ATTRIB, SOLID, TRACE, 3DFACE, HATCH, DIMENSION (all types, drawn from their block), LEADER.
//
// Input: a "raw DXF" document, see readRawDxf() in make_dwg_fixtures.mjs.

// ------------------------------------------------------------------ bit writer
class Bits {
  constructor(n = 512) { this.a = new Uint8Array(n); this.p = 0; }
  grow(bits) {
    const need = (this.p + bits + 7) >> 3;
    if (need > this.a.length) { const b = new Uint8Array(Math.max(need, this.a.length * 2)); b.set(this.a); this.a = b; }
  }
  B(v) { this.grow(1); if (v) this.a[this.p >> 3] |= 0x80 >> (this.p & 7); this.p++; }
  bits(v, n) { for (let i = n - 1; i >= 0; i--) this.B((v >>> i) & 1); }
  BB(v) { this.bits(v & 3, 2); }
  RC(v) { this.bits(v & 0xff, 8); }
  RS(v) { this.RC(v & 0xff); this.RC((v >>> 8) & 0xff); }
  RL(v) { v >>>= 0; this.RS(v & 0xffff); this.RS(v >>> 16); }
  RD(v) { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v, true); for (let i = 0; i < 8; i++) this.RC(dv.getUint8(i)); }
  BS(v) {
    v &= 0xffff;
    if (v === 0) this.BB(2);
    else if (v === 256) this.BB(3);
    else if (v < 256) { this.BB(1); this.RC(v); } else { this.BB(0); this.RS(v); }
  }
  BL(v) {
    v >>>= 0;
    if (v === 0) this.BB(2);
    else if (v < 256) { this.BB(1); this.RC(v); } else { this.BB(0); this.RL(v); }
  }
  BD(v) {
    if (v === 0) this.BB(2);
    else if (v === 1) this.BB(1);
    else { this.BB(0); this.RD(v); }
  }
  DD(v, def) { if (v === def) this.BB(0); else { this.BB(3); this.RD(v); } }
  BT(v) { if (!v) this.B(1); else { this.B(0); this.BD(v); } }
  BE(e) {
    const [x, y, z] = e || [0, 0, 1];
    if (x === 0 && y === 0 && z === 1) this.B(1); else { this.B(0); this.BD(x); this.BD(y); this.BD(z); }
  }
  BD2(p) { this.BD(p[0]); this.BD(p[1]); }
  BD3(p) { this.BD(p[0]); this.BD(p[1]); this.BD(p[2] || 0); }
  RD2(p) { this.RD(p[0]); this.RD(p[1]); }
  TV(bytes) {
    const nul = NUL_TERMINATED && bytes.length > 0; // CAD programs often store the terminating NUL
    this.BS(bytes.length + (nul ? 1 : 0));
    for (const b of bytes) this.RC(b);
    if (nul) this.RC(0);
  }
  H(code, value) {
    value = Math.max(0, Math.floor(value || 0));
    const out = [];
    while (value > 0) { out.unshift(value & 0xff); value = Math.floor(value / 256); }
    this.RC(((code & 15) << 4) | out.length);
    for (const b of out) this.RC(b);
  }
  CMC(index) { this.BS(index); } // R2000: colour index only
  setRL(pos, v) {
    const save = this.p;
    this.p = pos;
    for (let k = 0; k < 4; k++) {
      const byte = (v >>> (8 * k)) & 0xff;
      for (let i = 7; i >= 0; i--) {
        const idx = this.p >> 3, m = 0x80 >> (this.p & 7);
        if ((byte >> i) & 1) this.a[idx] |= m; else this.a[idx] &= ~m;
        this.p++;
      }
    }
    this.p = save;
  }
  bytes() { return this.a.slice(0, (this.p + 7) >> 3); }
}

// ------------------------------------------------------------------ CRC (CRC-16, reflected poly 0xA001)
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1; t[n] = c; }
  return t;
})();
export function crc16(seed, bytes, start = 0, end = bytes.length) {
  let c = seed & 0xffff;
  for (let i = start; i < end; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
  return c;
}

const hex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
const SENTINEL = {
  fileHeaderEnd: hex('95A04E2899821AE55E41E05F9D3A4D00'),
  varsBegin: hex('CF7B1F23FDDE38A95F7C68B84E6D335F'),
  varsEnd: hex('3084E0DC0221C756A0839747B192CCA0'),
  classesBegin: hex('8DA1C4B8C4A9F8C5C0DCF45FE7CFB68A'),
  classesEnd: hex('725E3B473B56073A3F230BA018304975'),
};

/** Modular short (object size). */
function MS(v) {
  const out = [];
  do {
    let chunk = v & 0x7fff;
    v = Math.floor(v / 0x8000);
    if (v > 0) chunk |= 0x8000;
    out.push(chunk & 0xff, chunk >>> 8);
  } while (v > 0);
  return out;
}
/** Unsigned modular char. */
function UMC(v) {
  const out = [];
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
  return out;
}
/** Signed modular char (sign in bit 0x40 of the last byte). */
function MC(v) {
  const neg = v < 0;
  let a = Math.abs(v);
  const out = [];
  while (a >= 0x40) { out.push((a & 0x7f) | 0x80); a = Math.floor(a / 128); }
  out.push(a | (neg ? 0x40 : 0));
  return out;
}

// ------------------------------------------------------------------ text
const CP1252_EXTRA = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
/** String -> code page 1252 bytes; characters outside it become \U+XXXX (as CAD programs do). */
export function cp1252(s) {
  const out = [];
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (CP1252_EXTRA[c]) out.push(CP1252_EXTRA[c]);
    else for (const b of `\\U+${c.toString(16).toUpperCase().padStart(4, '0')}`) out.push(b.charCodeAt(0));
  }
  return out;
}

// ------------------------------------------------------------------ object types (fixed)
const T = {
  TEXT: 1, ATTRIB: 2, ATTDEF: 3, BLOCK: 4, ENDBLK: 5, SEQEND: 6, INSERT: 7, MINSERT: 8, VERTEX_2D: 10, VERTEX_3D: 11,
  VERTEX_MESH: 12, VERTEX_PFACE: 13, VERTEX_PFACE_FACE: 14, POLYLINE_2D: 15, POLYLINE_3D: 16, POLYLINE_PFACE: 29, POLYLINE_MESH: 30,
  ARC: 17, CIRCLE: 18, LINE: 19, DIM_ORDINATE: 20, DIM_LINEAR: 21, DIM_ALIGNED: 22, DIM_ANG3PT: 23, DIM_ANG2LN: 24,
  DIM_RADIUS: 25, DIM_DIAMETER: 26, POINT: 27, FACE3D: 28, SOLID: 31, TRACE: 32, ELLIPSE: 35, SPLINE: 36, DICTIONARY: 42,
  MTEXT: 44, LEADER: 45, BLOCK_CONTROL: 48, BLOCK_HEADER: 49, LAYER_CONTROL: 50, LAYER: 51, STYLE_CONTROL: 52, STYLE: 53,
  LTYPE_CONTROL: 56, LTYPE: 57, VIEW_CONTROL: 60, UCS_CONTROL: 62, VPORT_CONTROL: 64, APPID_CONTROL: 66,
  DIMSTYLE_CONTROL: 68, VX_CONTROL: 70, LWPOLYLINE: 77, HATCH: 78,
};
const D2R = Math.PI / 180;

// ------------------------------------------------------------------ the writer
/**
 * @param {object} dxf  raw DXF document: { header: {NAME: {code: value}}, layers, ltypes, styles: [G],
 *                      blocks: [{ g: G, entities: [G] }], entities: [G] } where G = group accessor
 * @returns {{ bytes: Uint8Array, notes: string[] }}
 */
let NUL_TERMINATED = false;
/**
 * opts (test variants): nulTerminated — strings include their terminating NUL;
 * unlinkModelSpace — the model space block header lists no entities (damaged-file case).
 */
export function writeDwgR2000(dxf, opts = {}) {
  NUL_TERMINATED = !!opts.nulTerminated;
  try { return write(dxf, opts); } finally { NUL_TERMINATED = false; }
}
function write(dxf, opts) {
  const notes = [];
  let nextHandle = 1;
  const alloc = () => nextHandle++;
  const objects = []; // { handle, encode: () => Uint8Array (object bytes without MS/CRC) }

  // ---------------------------------------------------------------- handles of fixed objects
  const H = {
    blockControl: alloc(), layerControl: alloc(), styleControl: alloc(), ltypeControl: alloc(), viewControl: alloc(),
    ucsControl: alloc(), vportControl: alloc(), appidControl: alloc(), dimstyleControl: alloc(), vxControl: alloc(),
    namedDict: alloc(),
  };

  // ---------------------------------------------------------------- line types
  const ltypes = new Map(); // NAME -> { handle, name, desc, dashes }
  const addLtype = (name, desc, dashes) => { const k = name.toUpperCase(); if (!ltypes.has(k)) ltypes.set(k, { handle: alloc(), name, desc, dashes }); return ltypes.get(k); };
  addLtype('ByBlock', '', []);
  addLtype('ByLayer', '', []);
  addLtype('Continuous', 'Solid line', []);
  for (const g of dxf.ltypes) {
    const name = g.s(2, '').trim();
    if (!name) continue;
    addLtype(name, g.s(3, ''), g.all(49).map(Number).filter(Number.isFinite));
  }

  // ---------------------------------------------------------------- layers
  const layers = new Map(); // NAME -> { handle, name, color, flags, ltype }
  const addLayer = (name, color = 7, flags = 0, ltype = 'Continuous') => {
    const k = name.toUpperCase();
    if (!layers.has(k)) layers.set(k, { handle: alloc(), name, color, flags, ltype });
    return layers.get(k);
  };
  addLayer('0');
  for (const g of dxf.layers) {
    const name = g.s(2, '').trim() || '0';
    const L = addLayer(name);
    L.color = g.i(62, 7) || 7;
    L.flags = g.i(70, 0);
    L.ltype = g.s(6, 'Continuous').trim() || 'Continuous';
    if (g.has(420)) notes.push(`Layer ${name}: true colour is not stored in DWG R2000 (colour index kept).`);
  }
  const layerOf = (g) => addLayer(g.s(8, '0').trim() || '0').handle;
  // layers used by entities but missing from the LAYER table (allowed in DXF) become table entries
  for (const g of [...dxf.blocks.flatMap((b) => b.entities), ...dxf.entities]) if (g.has(8)) layerOf(g);

  // ---------------------------------------------------------------- text styles
  const styles = new Map();
  const addStyle = (name, g) => { const k = name.toUpperCase(); if (!styles.has(k)) styles.set(k, { handle: alloc(), name, g }); return styles.get(k); };
  addStyle('Standard', null);
  for (const g of dxf.styles) { const name = g.s(2, '').trim(); if (name) addStyle(name, g); }
  const styleOf = (g) => { const n = (g.s(7, 'Standard').trim() || 'Standard').toUpperCase(); return (styles.get(n) || styles.get('STANDARD')).handle; };

  // ---------------------------------------------------------------- block headers
  const blocks = new Map(); // NAME -> { handle, name, g, entities: [G], blockEnt, endblk, items }
  const addBlock = (name, g, entities) => {
    const k = name.toUpperCase();
    if (!blocks.has(k)) blocks.set(k, { handle: 0, name, g, entities: entities || [] }); // handles: see below
    return blocks.get(k);
  };
  const ms = addBlock('*Model_Space', null, dxf.entities.filter((e) => e.i(67, 0) !== 1));
  const ps = addBlock('*Paper_Space', null, dxf.entities.filter((e) => e.i(67, 0) === 1));
  for (const b of dxf.blocks) {
    const name = (b.g.s(2, '') || b.g.s(3, '')).trim();
    if (!name) continue;
    const k = name.toUpperCase();
    if (k === '*MODEL_SPACE' || k === '$MODEL_SPACE') { ms.g = b.g; if (!ms.entities.length) ms.entities = b.entities; continue; }
    if (k === '*PAPER_SPACE' || k === '$PAPER_SPACE') { ps.g = b.g; if (!ps.entities.length) ps.entities = b.entities; continue; }
    addBlock(name, b.g, b.entities);
  }
  const blockHandle = (name) => { const b = blocks.get(String(name).trim().toUpperCase()); return b ? b.handle : 0; };

  // ---------------------------------------------------------------- object encoders
  /** Common object (non-entity) frame. */
  function object(type, handle, data, handles) {
    const w = new Bits();
    w.BS(type);
    const bsPos = w.p;
    w.RL(0);
    w.H(0, handle);
    w.BS(0); // no extended data
    w.BL(0); // reactors
    data(w);
    w.setRL(bsPos, w.p);
    handles(w);
    return w.bytes();
  }
  /** Common entity frame. owner: block handle when entmode 0. */
  function entity(type, handle, g, ctx, data, handles) {
    const w = new Bits();
    w.BS(type);
    const bsPos = w.p;
    w.RL(0);
    w.H(0, handle);
    w.BS(0); // no extended data
    w.B(0); // no graphics
    w.BB(ctx.entmode);
    w.BL(0); // reactors
    w.B(0); // links present
    let color = g ? g.i(62, 256) : 256;
    if (color < 0 || color > 256) color = Math.abs(color) % 257;
    w.CMC(color);
    w.BD(g ? g.f(48, 1) || 1 : 1);
    const lt = g ? (g.s(6, 'BYLAYER').trim() || 'BYLAYER').toUpperCase() : 'BYLAYER';
    let ltFlag = 0, ltHandle = 0;
    if (lt === 'BYBLOCK') ltFlag = 1;
    else if (lt === 'CONTINUOUS') ltFlag = 2;
    else if (lt !== 'BYLAYER') { const L = ltypes.get(lt); if (L) { ltFlag = 3; ltHandle = L.handle; } }
    w.BB(ltFlag);
    w.BB(0); // plot style by layer
    w.BS(g && g.i(60, 0) === 1 ? 1 : 0);
    w.RC(29); // lineweight: by layer
    data(w);
    w.setRL(bsPos, w.p);
    if (ctx.entmode === 0) w.H(4, ctx.owner);
    w.H(3, 0); // xdictionary
    w.H(4, ctx.prev || 0);
    w.H(4, ctx.next || 0);
    w.H(5, g ? layerOf(g) : layers.get('0').handle);
    if (ltFlag === 3) w.H(5, ltHandle);
    if (handles) handles(w);
    return w.bytes();
  }
  const push = (handle, bytes) => objects.push({ handle, bytes });

  // ---------------------------------------------------------------- entity encoders
  function textData(w, g, valignCode) {
    const elev = g.f(30, 0);
    const p1 = [g.f(10), g.f(20)];
    const halign = g.i(72, 0), valign = g.i(valignCode, 0);
    const p2 = g.has(11) ? [g.f(11), g.f(21)] : p1;
    const rot = g.f(50, 0) * D2R, obl = g.f(51, 0) * D2R, wf = g.f(41, 1) || 1, gen = g.i(71, 0);
    let df = 0;
    if (elev === 0) df |= 1;
    if (!g.has(11)) df |= 2; // (when omitted, readers take the alignment point as 0,0)
    if (obl === 0) df |= 4;
    if (rot === 0) df |= 8;
    if (wf === 1) df |= 0x10;
    if (gen === 0) df |= 0x20;
    if (halign === 0) df |= 0x40;
    if (valign === 0) df |= 0x80;
    w.RC(df);
    if (!(df & 1)) w.RD(elev);
    w.RD2(p1);
    if (!(df & 2)) { w.DD(p2[0], p1[0]); w.DD(p2[1], p1[1]); }
    w.BE(ext(g));
    w.BT(g.f(39, 0));
    if (!(df & 4)) w.RD(obl);
    if (!(df & 8)) w.RD(rot);
    w.RD(Math.abs(g.f(40, 1)) || 1);
    if (!(df & 0x10)) w.RD(wf);
    w.TV(cp1252(g.s(1, '')));
    if (!(df & 0x20)) w.BS(gen);
    if (!(df & 0x40)) w.BS(halign);
    if (!(df & 0x80)) w.BS(valign);
  }
  function ext(g) { return g.has(210) || g.has(230) ? [g.f(210, 0), g.f(220, 0), g.f(230, 1)] : [0, 0, 1]; }
  function attribData(w, g, isDef) {
    textData(w, g, 74);
    w.TV(cp1252(g.s(2, '')));
    w.BS(g.i(73, 0)); // field length
    w.RC(g.i(70, 0)); // flags
    if (isDef) w.TV(cp1252(g.s(3, '')));
  }

  const ENCODERS = {
    LINE(it, ctx) {
      const g = it.g;
      const a = [g.f(10), g.f(20), g.f(30)], b = [g.f(11), g.f(21), g.f(31)];
      push(it.handle, entity(T.LINE, it.handle, g, ctx, (w) => {
        const z0 = a[2] === 0 && b[2] === 0;
        w.B(z0);
        w.RD(a[0]); w.DD(b[0], a[0]);
        w.RD(a[1]); w.DD(b[1], a[1]);
        if (!z0) { w.RD(a[2]); w.DD(b[2], a[2]); }
        w.BT(g.f(39, 0));
        w.BE(ext(g));
      }));
    },
    POINT(it, ctx) {
      const g = it.g;
      push(it.handle, entity(T.POINT, it.handle, g, ctx, (w) => {
        w.BD(g.f(10)); w.BD(g.f(20)); w.BD(g.f(30));
        w.BT(g.f(39, 0)); w.BE(ext(g)); w.BD(g.f(50, 0) * D2R);
      }));
    },
    CIRCLE(it, ctx) {
      const g = it.g;
      push(it.handle, entity(T.CIRCLE, it.handle, g, ctx, (w) => {
        w.BD3([g.f(10), g.f(20), g.f(30)]); w.BD(g.f(40)); w.BT(g.f(39, 0)); w.BE(ext(g));
      }));
    },
    ARC(it, ctx) {
      const g = it.g;
      push(it.handle, entity(T.ARC, it.handle, g, ctx, (w) => {
        w.BD3([g.f(10), g.f(20), g.f(30)]); w.BD(g.f(40)); w.BT(g.f(39, 0)); w.BE(ext(g));
        w.BD(g.f(50) * D2R); w.BD(g.f(51) * D2R);
      }));
    },
    ELLIPSE(it, ctx) {
      const g = it.g;
      push(it.handle, entity(T.ELLIPSE, it.handle, g, ctx, (w) => {
        w.BD3([g.f(10), g.f(20), g.f(30)]); w.BD3([g.f(11), g.f(21), g.f(31)]); w.BD3(ext(g));
        w.BD(g.f(40, 1)); w.BD(g.f(41, 0)); w.BD(g.f(42, Math.PI * 2));
      }));
    },
    SOLID(it, ctx) { solid(it, ctx, T.SOLID); },
    TRACE(it, ctx) { solid(it, ctx, T.TRACE); },
    '3DFACE'(it, ctx) {
      const g = it.g;
      push(it.handle, entity(T.FACE3D, it.handle, g, ctx, (w) => {
        const P = (c) => [g.f(c), g.f(c + 10), g.f(c + 20)];
        const c1 = P(10), c2 = P(11), c3 = P(12), c4 = g.has(13) ? P(13) : c3;
        const flags = g.i(70, 0);
        const z0 = [c1, c2, c3, c4].every((p) => p[2] === 0);
        w.B(flags === 0); // no flags
        w.B(z0);
        w.RD(c1[0]); w.RD(c1[1]); if (!z0) w.RD(c1[2]);
        const dd3 = (p, d) => { w.DD(p[0], d[0]); w.DD(p[1], d[1]); w.DD(p[2], d[2]); };
        dd3(c2, c1); dd3(c3, c2); dd3(c4, c3);
        if (flags !== 0) w.BS(flags);
      }));
    },
    TEXT(it, ctx) {
      const g = it.g;
      push(it.handle, entity(T.TEXT, it.handle, g, ctx, (w) => textData(w, g, 73), (w) => w.H(5, styleOf(g))));
    },
    ATTDEF(it, ctx) {
      const g = it.g;
      push(it.handle, entity(T.ATTDEF, it.handle, g, ctx, (w) => attribData(w, g, true), (w) => w.H(5, styleOf(g))));
    },
    ATTRIB(it, ctx) {
      const g = it.g;
      push(it.handle, entity(T.ATTRIB, it.handle, g, ctx, (w) => attribData(w, g, false), (w) => w.H(5, styleOf(g))));
    },
    MTEXT(it, ctx) {
      const g = it.g;
      push(it.handle, entity(T.MTEXT, it.handle, g, ctx, (w) => {
        w.BD3([g.f(10), g.f(20), g.f(30)]);
        w.BD3(ext(g));
        let xd = [g.f(11, 1), g.f(21, 0), g.f(31, 0)];
        if (!g.has(11)) { const r = g.f(50, 0); xd = [Math.cos(r), Math.sin(r), 0]; }
        w.BD3(xd);
        w.BD(g.f(41, 0));
        w.BD(Math.abs(g.f(40, 1)) || 1);
        w.BS(g.i(71, 1) || 1);
        w.BS(g.i(72, 1) || 1);
        w.BD(g.f(43, 0)); // extents height
        w.BD(g.f(42, 0)); // extents width
        w.TV(cp1252([...g.all(3), g.s(1, '')].join('')));
        w.BS(g.i(73, 1) || 1);
        w.BD(g.f(44, 1) || 1);
        w.B(0);
      }, (w) => w.H(5, styleOf(g))));
    },
    INSERT(it, ctx) {
      const g = it.g;
      const cols = g.i(70, 1) || 1, rows = g.i(71, 1) || 1;
      const minsert = cols > 1 || rows > 1;
      const attribs = it.subs;
      push(it.handle, entity(minsert ? T.MINSERT : T.INSERT, it.handle, g, ctx, (w) => {
        w.BD3([g.f(10), g.f(20), g.f(30)]);
        const sx = g.f(41, 1), sy = g.f(42, 1), sz = g.f(43, 1);
        if (sx === 1 && sy === 1 && sz === 1) w.BB(3);
        else if (sx === sy && sx === sz) { w.BB(2); w.RD(sx); }
        else if (sx === 1) { w.BB(1); w.DD(sy, 1); w.DD(sz, 1); }
        else { w.BB(0); w.RD(sx); w.DD(sy, sx); w.DD(sz, sx); }
        w.BD(g.f(50, 0) * D2R);
        w.BD3(ext(g));
        w.B(attribs.length > 0);
        if (minsert) { w.BS(cols); w.BS(rows); w.BD(g.f(44, 0)); w.BD(g.f(45, 0)); }
      }, (w) => {
        w.H(5, blockHandle(g.s(2, '')));
        if (attribs.length) { w.H(4, attribs[0].handle); w.H(4, attribs[attribs.length - 1].handle); w.H(3, it.seqend); }
      }));
      attribs.forEach((a, k) => {
        const actx = { entmode: 0, owner: it.handle, prev: k ? attribs[k - 1].handle : 0, next: k + 1 < attribs.length ? attribs[k + 1].handle : 0 };
        ENCODERS.ATTRIB({ g: a.g, handle: a.handle }, actx);
      });
      if (attribs.length) push(it.seqend, entity(T.SEQEND, it.seqend, g, { entmode: 0, owner: it.handle }, () => {}));
    },
    LWPOLYLINE(it, ctx) {
      const g = it.g;
      const pts = [], bul = [], wid = [];
      let sw = 0, ew = 0;
      for (let k = 0; k < g.codes.length; k++) {
        const c = g.codes[k], v = parseFloat(g.vals[k]);
        if (c === 10) { pts.push([v, 0]); bul.push(0); wid.push([0, 0]); }
        else if (c === 20 && pts.length) pts[pts.length - 1][1] = v;
        else if (c === 42 && bul.length) bul[bul.length - 1] = v;
        else if (c === 40 && wid.length) { wid[wid.length - 1][0] = v; sw = sw || v; }
        else if (c === 41 && wid.length) { wid[wid.length - 1][1] = v; ew = ew || v; }
      }
      const dflags = g.i(70, 0);
      const hasBul = bul.some((b) => b !== 0), hasWid = (sw || ew) && !g.has(43);
      let flag = 0;
      const e = ext(g);
      const elev = g.f(38, 0), thick = g.f(39, 0), cw = g.f(43, 0);
      if (!(e[0] === 0 && e[1] === 0 && e[2] === 1)) flag |= 1;
      if (thick) flag |= 2;
      if (cw) flag |= 4;
      if (elev) flag |= 8;
      if (hasBul) flag |= 16;
      if (hasWid) flag |= 32;
      if (dflags & 128) flag |= 256;
      if (dflags & 1) flag |= 512;
      push(it.handle, entity(T.LWPOLYLINE, it.handle, g, ctx, (w) => {
        w.BS(flag);
        if (flag & 4) w.BD(cw);
        if (flag & 8) w.BD(elev);
        if (flag & 2) w.BD(thick);
        if (flag & 1) w.BD3(e);
        w.BL(pts.length);
        if (flag & 16) w.BL(bul.length);
        if (flag & 32) w.BL(wid.length);
        pts.forEach((p, k) => { if (k === 0) w.RD2(p); else { w.DD(p[0], pts[k - 1][0]); w.DD(p[1], pts[k - 1][1]); } });
        if (flag & 16) for (const b of bul) w.BD(b);
        if (flag & 32) for (const [a, b] of wid) { w.BD(a); w.BD(b); }
      }));
    },
    POLYLINE(it, ctx) {
      const g = it.g;
      const flags = g.i(70, 0);
      const verts = it.subs;
      const kind = flags & 64 ? 'pface' : flags & 16 ? 'mesh' : flags & 8 ? '3d' : '2d';
      const type = { pface: T.POLYLINE_PFACE, mesh: T.POLYLINE_MESH, '3d': T.POLYLINE_3D, '2d': T.POLYLINE_2D }[kind];
      push(it.handle, entity(type, it.handle, g, ctx, (w) => {
        if (kind === '2d') {
          w.BS(flags & 0xff);
          w.BS(g.i(75, 0));
          w.BD(g.f(40, 0)); w.BD(g.f(41, 0));
          w.BT(g.f(39, 0));
          w.BD(g.f(30, 0));
          w.BE(ext(g));
        } else if (kind === '3d') {
          w.RC(g.i(75, 0)); // curve type
          w.RC(flags & 1); // closed
        } else if (kind === 'pface') {
          w.BS(g.i(71, 0)); w.BS(g.i(72, 0)); // vertices, faces
        } else {
          w.BS(flags & 0xff); w.BS(g.i(75, 0)); w.BS(g.i(71, 0)); w.BS(g.i(72, 0)); w.BS(g.i(73, 0)); w.BS(g.i(74, 0));
        }
      }, (w) => {
        w.H(4, verts.length ? verts[0].handle : 0);
        w.H(4, verts.length ? verts[verts.length - 1].handle : 0);
        w.H(3, it.seqend);
      }));
      verts.forEach((v, k) => {
        const vg = v.g;
        const vf = vg.i(70, 0);
        const vctx = { entmode: 0, owner: it.handle, prev: k ? verts[k - 1].handle : 0, next: k + 1 < verts.length ? verts[k + 1].handle : 0 };
        const P3 = [vg.f(10), vg.f(20), vg.f(30)];
        if (kind === '2d') {
          push(v.handle, entity(T.VERTEX_2D, v.handle, vg, vctx, (w) => {
            w.RC(vf); w.BD3(P3); w.BD(vg.f(40, 0)); w.BD(vg.f(41, 0)); w.BD(vg.f(42, 0)); w.BD(vg.f(50, 0) * D2R);
          }));
        } else if (kind === 'pface' && !(vf & 64)) {
          push(v.handle, entity(T.VERTEX_PFACE_FACE, v.handle, vg, vctx, (w) => { for (const c of [71, 72, 73, 74]) w.BS(vg.i(c, 0)); }));
        } else {
          const vt = kind === '3d' ? T.VERTEX_3D : kind === 'mesh' ? T.VERTEX_MESH : T.VERTEX_PFACE;
          push(v.handle, entity(vt, v.handle, vg, vctx, (w) => { w.RC(vf); w.BD3(P3); }));
        }
      });
      push(it.seqend, entity(T.SEQEND, it.seqend, g, { entmode: 0, owner: it.handle }, () => {}));
    },
    SPLINE(it, ctx) {
      const g = it.g;
      const ctrl = [], fit = [], knots = [], weights = [];
      for (let k = 0; k < g.codes.length; k++) {
        const c = g.codes[k], v = parseFloat(g.vals[k]);
        if (c === 10) ctrl.push([v, 0, 0]); else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = v; else if (c === 30 && ctrl.length) ctrl[ctrl.length - 1][2] = v;
        else if (c === 11) fit.push([v, 0, 0]); else if (c === 21 && fit.length) fit[fit.length - 1][1] = v; else if (c === 31 && fit.length) fit[fit.length - 1][2] = v;
        else if (c === 40) knots.push(v); else if (c === 41) weights.push(v);
      }
      const flags = g.i(70, 0);
      const scenario = ctrl.length ? 1 : 2;
      push(it.handle, entity(T.SPLINE, it.handle, g, ctx, (w) => {
        w.BL(scenario);
        w.BL(g.i(71, 3));
        if (scenario === 2) {
          w.BD(g.f(44, 0));
          w.BD3([g.f(12), g.f(22), g.f(32)]);
          w.BD3([g.f(13), g.f(23), g.f(33)]);
          w.BL(fit.length);
        } else {
          w.B(flags & 4); w.B(flags & 1); w.B(flags & 2);
          w.BD(g.f(42, 1e-10)); w.BD(g.f(43, 1e-10));
          w.BL(knots.length); w.BL(ctrl.length);
          w.B(weights.length > 0);
        }
        if (scenario === 1) {
          for (const k of knots) w.BD(k);
          ctrl.forEach((p, k) => { w.BD3(p); if (weights.length) w.BD(weights[k] ?? 1); });
        } else for (const p of fit) w.BD3(p);
      }));
    },
    HATCH(it, ctx) {
      const g = it.g;
      push(it.handle, entity(T.HATCH, it.handle, g, ctx, (w) => hatchData(w, g)));
    },
    DIMENSION(it, ctx) {
      const g = it.g;
      const dt = g.i(70, 0) & 7;
      const type = [T.DIM_LINEAR, T.DIM_ALIGNED, T.DIM_ANG2LN, T.DIM_DIAMETER, T.DIM_RADIUS, T.DIM_ANG3PT, T.DIM_ORDINATE][dt] || T.DIM_LINEAR;
      const P3 = (c) => [g.f(c), g.f(c + 10), g.f(c + 20)];
      push(it.handle, entity(type, it.handle, g, ctx, (w) => {
        w.BD3(ext(g));
        w.RD2([g.f(11), g.f(21)]);
        w.BD(g.f(31, 0));
        const f70 = g.i(70, 0);
        let f1 = 0;
        if (!(f70 & 128)) f1 |= 1; // text at the default position
        if (f70 & 32) f1 |= 2;
        w.RC(f1);
        w.TV(cp1252(g.s(1, '')));
        w.BD(g.f(53, 0) * D2R);
        w.BD(g.f(51, 0) * D2R);
        w.BD3([1, 1, 1]);
        w.BD(0);
        w.BS(g.i(71, 5) || 5);
        w.BS(g.i(72, 1) || 1);
        w.BD(g.f(41, 1) || 1);
        w.BD(g.f(42, 0));
        w.RD2([g.f(12), g.f(22)]);
        if (type === T.DIM_LINEAR || type === T.DIM_ALIGNED) {
          w.BD3(P3(13)); w.BD3(P3(14)); w.BD3(P3(10)); w.BD(g.f(52, 0) * D2R);
          if (type === T.DIM_LINEAR) w.BD(g.f(50, 0) * D2R);
        } else if (type === T.DIM_ORDINATE) {
          w.BD3(P3(10)); w.BD3(P3(13)); w.BD3(P3(14)); w.RC(f70 & 64 ? 1 : 0);
        } else if (type === T.DIM_ANG3PT) {
          w.BD3(P3(10)); w.BD3(P3(13)); w.BD3(P3(14)); w.BD3(P3(15));
        } else if (type === T.DIM_ANG2LN) {
          w.RD2([g.f(16), g.f(26)]); w.BD3(P3(13)); w.BD3(P3(14)); w.BD3(P3(15)); w.BD3(P3(10));
        } else { // radius / diameter
          w.BD3(P3(10)); w.BD3(P3(15)); w.BD(g.f(40, 0));
        }
      }, (w) => { w.H(5, dimstyle); w.H(5, blockHandle(g.s(2, ''))); }));
    },
    LEADER(it, ctx) {
      const g = it.g;
      const pts = [];
      for (let k = 0; k < g.codes.length; k++) {
        const c = g.codes[k], v = parseFloat(g.vals[k]);
        if (c === 10) pts.push([v, 0, 0]); else if (c === 20 && pts.length) pts[pts.length - 1][1] = v; else if (c === 30 && pts.length) pts[pts.length - 1][2] = v;
      }
      push(it.handle, entity(T.LEADER, it.handle, g, ctx, (w) => {
        w.B(0);
        w.BS(g.i(73, 3)); // annotation type: none
        w.BS(g.i(72, 0)); // path type
        w.BL(pts.length);
        for (const p of pts) w.BD3(p);
        w.BD3([0, 0, 0]); // end point projection
        w.BD3(ext(g));
        w.BD3([g.f(211, 1), g.f(221, 0), g.f(231, 0)]);
        w.BD3([g.f(213, 0), g.f(223, 0), g.f(233, 0)]); // offset to block insertion point
        w.BD3([0, 0, 0]); // unknown (R2000+)
        w.BD(g.f(40, 0)); w.BD(g.f(41, 0));
        w.B(g.i(74, 0)); // hookline on x dir
        w.B(g.i(71, 1)); // arrowhead on
        w.BS(0); w.B(0); w.B(0);
      }, (w) => { w.H(5, 0); w.H(5, dimstyle); }));
    },
  };
  function solid(it, ctx, type) {
    const g = it.g;
    push(it.handle, entity(type, it.handle, g, ctx, (w) => {
      w.BT(g.f(39, 0));
      w.BD(g.f(30, 0));
      w.RD2([g.f(10), g.f(20)]); w.RD2([g.f(11), g.f(21)]); w.RD2([g.f(12), g.f(22)]); w.RD2([g.f(13, g.f(12)), g.f(23, g.f(22))]);
      w.BE(ext(g));
    }));
  }
  function hatchData(w, g) {
    const { codes, vals } = g;
    const n = codes.length;
    let k = 0;
    const num = () => parseFloat(vals[k++]);
    const int = () => parseInt(vals[k++], 10) | 0;
    const seek = (code) => { while (k < n && codes[k] !== code) k++; return k < n; };
    w.BD(g.f(30, 0));
    w.BD3(ext(g));
    w.TV(cp1252(g.s(2, 'SOLID')));
    const solidFill = g.i(70, 0) === 1;
    w.B(solidFill);
    w.B(g.i(71, 0));
    seek(91); const nPaths = int();
    w.BL(nPaths);
    for (let p = 0; p < nPaths; p++) {
      seek(92); const flags = int();
      w.BL(flags);
      if (!(flags & 2)) {
        seek(93); const ne = int();
        w.BL(ne);
        for (let i = 0; i < ne; i++) {
          seek(72); const et = int();
          w.RC(et);
          if (et === 1) {
            seek(10); const x1 = num(); seek(20); const y1 = num(); seek(11); const x2 = num(); seek(21); const y2 = num();
            w.RD2([x1, y1]); w.RD2([x2, y2]);
          } else if (et === 2) {
            seek(10); const cx = num(); seek(20); const cy = num(); seek(40); const r = num(); seek(50); const a0 = num(); seek(51); const a1 = num(); seek(73); const ccw = int();
            w.RD2([cx, cy]); w.BD(r); w.BD(a0 * D2R); w.BD(a1 * D2R); w.B(ccw);
          } else if (et === 3) {
            seek(10); const cx = num(); seek(20); const cy = num(); seek(11); const mx = num(); seek(21); const my = num(); seek(40); const ratio = num();
            seek(50); const a0 = num(); seek(51); const a1 = num(); seek(73); const ccw = int();
            w.RD2([cx, cy]); w.RD2([mx, my]); w.BD(ratio); w.BD(a0 * D2R); w.BD(a1 * D2R); w.B(ccw);
          } else if (et === 4) {
            seek(94); const deg = int(); seek(73); const rational = int(); seek(74); const periodic = int(); seek(95); const nk = int(); seek(96); const nc = int();
            w.BL(deg); w.B(rational); w.B(periodic); w.BL(nk); w.BL(nc);
            for (let j = 0; j < nk; j++) { seek(40); w.BD(num()); }
            for (let j = 0; j < nc; j++) { seek(10); const x = num(); seek(20); const y = num(); w.RD2([x, y]); if (rational) { seek(42); w.BD(num()); } }
          }
        }
      } else {
        seek(72); const hasBulge = int(); seek(73); const closed = int(); seek(93); const nv = int();
        w.B(hasBulge); w.B(closed); w.BL(nv);
        for (let i = 0; i < nv; i++) {
          seek(10); const x = num(); seek(20); const y = num();
          w.RD2([x, y]);
          if (hasBulge) { let b = 0; if (codes[k] === 42) b = num(); w.BD(b); }
        }
      }
      // source boundary objects: none written
      if (codes[k] === 97) { k++; while (k < n && codes[k] === 330) k++; }
      w.BL(0);
    }
    w.BS(g.i(75, 1)); // hatch style
    w.BS(g.i(76, 1)); // pattern type
    if (!solidFill) {
      w.BD(g.f(52, 0) * D2R);
      w.BD(g.f(41, 1) || 1);
      w.B(g.i(77, 0));
      // pattern definition lines
      const idx = codes.indexOf(78);
      const nl = idx >= 0 ? parseInt(vals[idx], 10) | 0 : 0;
      w.BS(nl);
      k = idx + 1;
      for (let i = 0; i < nl; i++) {
        seek(53); const ang = num(); seek(43); const bx = num(); seek(44); const by = num(); seek(45); const ox = num(); seek(46); const oy = num();
        seek(79); const nd = int();
        w.BD(ang * D2R); w.BD(bx); w.BD(by); w.BD(ox); w.BD(oy); w.BS(nd);
        for (let j = 0; j < nd; j++) { seek(49); w.BD(num()); }
      }
    }
    // no derived boundary => no pixel size
    const si = codes.indexOf(98);
    const ns = si >= 0 ? parseInt(vals[si], 10) | 0 : 0;
    w.BL(ns);
    k = si + 1;
    for (let i = 0; i < ns; i++) { seek(10); const x = num(); seek(20); const y = num(); w.RD2([x, y]); }
  }

  // ---------------------------------------------------------------- entity handles (grouped records)
  // Each block's entity list becomes items: { g, type, handle, subs: [{ g, handle }], seqend }.
  // POLYLINE owns the VERTEXes up to SEQEND; INSERT owns the ATTRIBs that follow it.
  // Handles are given out the way CAD programs do: each block header right before its BLOCK
  // entity, contents and ENDBLK; model/paper space contents last.
  for (const blk of [...blocks.values()].filter((b) => b !== ms && b !== ps).concat([ms, ps])) {
    const items = [];
    for (const g of blk.entities) {
      const type = g.type;
      const last = items[items.length - 1];
      if (last && last.open) {
        if (type === 'SEQEND') { last.open = false; continue; }
        if ((last.type === 'POLYLINE' && type === 'VERTEX') || (last.type === 'INSERT' && type === 'ATTRIB')) { last.subs.push({ g, handle: 0 }); continue; }
        last.open = false;
      }
      if (type === 'SEQEND' || type === 'VERTEX' || type === 'ATTRIB') continue;
      if (!ENCODERS[type]) { notes.push(`${type} is not written to DWG.`); continue; }
      items.push({ g, type, subs: [], open: type === 'POLYLINE' || type === 'INSERT' });
    }
    blk.items = items;
  }
  const allocItems = (items) => {
    for (const it of items) {
      it.handle = alloc();
      for (const s of it.subs) s.handle = alloc();
      if (it.type === 'POLYLINE' || (it.type === 'INSERT' && it.subs.length)) it.seqend = alloc();
    }
  };
  for (const blk of [ms, ps]) { blk.handle = alloc(); blk.blockEnt = alloc(); blk.endblk = alloc(); }
  for (const blk of blocks.values()) {
    if (blk === ms || blk === ps) continue;
    blk.handle = alloc(); blk.blockEnt = alloc(); allocItems(blk.items); blk.endblk = alloc();
  }
  allocItems(ms.items);
  allocItems(ps.items);
  const dimstyle = 0; // no DIMSTYLE table entries are written (dimensions are drawn from their blocks)

  // ---------------------------------------------------------------- tables
  const tableEntryHead = (w, name) => { w.TV(cp1252(name)); w.B(0); w.BS(0); w.B(0); };
  const tableHandles = (w, owner) => { w.H(4, owner); w.H(3, 0); w.H(5, 0); };

  const userLtypes = [...ltypes.values()].filter((l) => !/^(BYLAYER|BYBLOCK)$/i.test(l.name));
  push(H.ltypeControl, object(T.LTYPE_CONTROL, H.ltypeControl, (w) => w.BS(userLtypes.length), (w) => {
    w.H(4, 0); w.H(3, 0);
    for (const l of userLtypes) w.H(2, l.handle);
    w.H(3, ltypes.get('BYBLOCK').handle);
    w.H(3, ltypes.get('BYLAYER').handle);
  }));
  for (const l of ltypes.values()) {
    push(l.handle, object(T.LTYPE, l.handle, (w) => {
      tableEntryHead(w, l.name);
      w.TV(cp1252(l.desc));
      w.BD(l.dashes.reduce((s, d) => s + Math.abs(d), 0));
      w.RC(65); // 'A'
      w.RC(l.dashes.length);
      for (const d of l.dashes) { w.BD(d); w.BS(0); w.RD(0); w.RD(0); w.BD(1); w.BD(0); w.BS(0); }
      for (let i = 0; i < 256; i++) w.RC(0); // strings area
    }, (w) => { tableHandles(w, H.ltypeControl); for (let i = 0; i < l.dashes.length; i++) w.H(5, 0); }));
  }

  push(H.layerControl, object(T.LAYER_CONTROL, H.layerControl, (w) => w.BS(layers.size), (w) => {
    w.H(4, 0); w.H(3, 0);
    for (const L of layers.values()) w.H(2, L.handle);
  }));
  for (const L of layers.values()) {
    push(L.handle, object(T.LAYER, L.handle, (w) => {
      tableEntryHead(w, L.name);
      let f = 0;
      if (L.flags & 1) f |= 1; // frozen
      if (L.color < 0) f |= 2; // off
      if (L.flags & 2) f |= 4; // frozen in new viewports
      if (L.flags & 4) f |= 8; // locked
      f |= 16; // plot
      f |= 29 << 5; // lineweight: default
      w.BS(f);
      w.CMC(Math.abs(L.color) || 7);
    }, (w) => {
      tableHandles(w, H.layerControl);
      w.H(5, 0); // plot style
      const lt = ltypes.get(String(L.ltype).toUpperCase()) || ltypes.get('CONTINUOUS');
      w.H(5, lt.handle);
    }));
  }

  push(H.styleControl, object(T.STYLE_CONTROL, H.styleControl, (w) => w.BS(styles.size), (w) => {
    w.H(4, 0); w.H(3, 0);
    for (const s of styles.values()) w.H(2, s.handle);
  }));
  for (const s of styles.values()) {
    const g = s.g;
    push(s.handle, object(T.STYLE, s.handle, (w) => {
      tableEntryHead(w, s.name);
      const flags = g ? g.i(70, 0) : 0;
      w.B(flags & 4); w.B(flags & 1);
      w.BD(g ? g.f(40, 0) : 0);
      w.BD(g ? g.f(41, 1) || 1 : 1);
      w.BD(g ? g.f(50, 0) * D2R : 0);
      w.RC(g ? g.i(71, 0) : 0);
      w.BD(g ? g.f(42, 2.5) : 2.5);
      w.TV(cp1252(g ? g.s(3, 'txt') : 'txt'));
      w.TV(cp1252(g ? g.s(4, '') : ''));
    }, (w) => tableHandles(w, H.styleControl)));
  }

  const userBlocks = [...blocks.values()].filter((b) => b !== ms && b !== ps);
  push(H.blockControl, object(T.BLOCK_CONTROL, H.blockControl, (w) => w.BS(userBlocks.length), (w) => {
    w.H(4, 0); w.H(3, 0);
    for (const b of userBlocks) w.H(2, b.handle);
    w.H(3, ms.handle);
    w.H(3, ps.handle);
  }));
  for (const [ctl, type] of [[H.viewControl, T.VIEW_CONTROL], [H.ucsControl, T.UCS_CONTROL], [H.vportControl, T.VPORT_CONTROL], [H.appidControl, T.APPID_CONTROL], [H.vxControl, T.VX_CONTROL]]) {
    push(ctl, object(type, ctl, (w) => w.BS(0), (w) => { w.H(4, 0); w.H(3, 0); }));
  }
  push(H.dimstyleControl, object(T.DIMSTYLE_CONTROL, H.dimstyleControl, (w) => { w.BS(0); w.RC(0); }, (w) => { w.H(4, 0); w.H(3, 0); }));
  push(H.namedDict, object(T.DICTIONARY, H.namedDict, (w) => { w.BL(0); w.BS(0); w.RC(0); }, (w) => { w.H(4, 0); w.H(3, 0); }));

  // ---------------------------------------------------------------- blocks + entities
  for (const blk of blocks.values()) {
    const g = blk.g;
    const flags = g ? g.i(70, 0) : 0;
    const base = g ? [g.f(10), g.f(20), g.f(30)] : [0, 0, 0];
    const items = blk.items;
    push(blk.handle, object(T.BLOCK_HEADER, blk.handle, (w) => {
      tableEntryHead(w, blk.name);
      w.B(flags & 1); w.B(flags & 2); w.B(0); w.B(0);
      w.B(1); // loaded
      w.BD3(base);
      w.TV([]); // xref path
      w.RC(0); // no insert handles follow
      w.TV([]); // description
      w.BL(0); // no preview
    }, (w) => {
      tableHandles(w, H.blockControl);
      w.H(3, blk.blockEnt);
      const unlinked = opts.unlinkModelSpace && blk === ms;
      w.H(4, items.length && !unlinked ? items[0].handle : 0);
      w.H(4, items.length && !unlinked ? items[items.length - 1].handle : 0);
      w.H(3, blk.endblk);
      w.H(5, 0); // layout
    }));
    const inBlock = blk !== ms && blk !== ps;
    const entmode = inBlock ? 0 : blk === ps ? 1 : 2;
    const bctx = { entmode: 0, owner: blk.handle };
    push(blk.blockEnt, entity(T.BLOCK, blk.blockEnt, g && g.has(8) ? g : null, bctx, (w) => w.TV(cp1252(blk.name))));
    items.forEach((it, k) => {
      const ctx = { entmode, owner: blk.handle, prev: k ? items[k - 1].handle : 0, next: k + 1 < items.length ? items[k + 1].handle : 0 };
      ENCODERS[it.type](it, ctx);
    });
    push(blk.endblk, entity(T.ENDBLK, blk.endblk, null, bctx, () => {}));
  }

  // ---------------------------------------------------------------- header variables
  const hv = dxf.header;
  const num = (name, code, def) => { const v = hv[name] && hv[name][code] != null ? parseFloat(hv[name][code]) : NaN; return Number.isFinite(v) ? v : def; };
  const extmin = [num('$EXTMIN', 10, 0), num('$EXTMIN', 20, 0), num('$EXTMIN', 30, 0)];
  const extmax = [num('$EXTMAX', 10, 0), num('$EXTMAX', 20, 0), num('$EXTMAX', 30, 0)];
  function headerVars(w) {
    const Bs = (...v) => v.forEach((x) => w.B(x)), BSs = (...v) => v.forEach((x) => w.BS(x)), BDs = (...v) => v.forEach((x) => w.BD(x));
    BDs(412148564080.0, 1, 1, 1);
    for (let i = 0; i < 4; i++) w.TV([]);
    w.BL(24); w.BL(0);
    w.H(5, 0); // current viewport entity header
    Bs(1, 1); // DIMASO DIMSHO
    Bs(0, 0, 1, 1, 0, 1, 0); // PLINEGEN ORTHOMODE REGENMODE FILLMODE QTEXTMODE PSLTSCALE LIMCHECK
    Bs(1, 0, 0, 0); // USRTIMER SKPOLY ANGDIR SPLFRAME
    Bs(0, 1); // MIRRTEXT WORLDVIEW
    Bs(1, 0, 1); // TILEMODE PLIMCHECK VISRETAIN
    Bs(0, 0); // DISPSILH PELLIPSE
    w.BS(1); // PROXYGRAPHICS
    w.BS(3020); // TREEDEPTH
    BSs(2, 4, 0, 0); // LUNITS LUPREC AUNITS AUPREC
    w.BS(1); // ATTMODE
    w.BS(0); // PDMODE
    BSs(0, 0, 0, 0, 0); // USERI1-5
    BSs(8, 6, 6, 6, 6, 6, 6); // SPLINESEGS SURFU SURFV SURFTYPE SURFTAB1 SURFTAB2 SPLINETYPE
    BSs(3, 70, 0, 64, 4, 0, 50); // SHADEDGE SHADEDIF UNITMODE MAXACTVP ISOLINES CMLJUST TEXTQLTY
    w.BD(num('$LTSCALE', 40, 1) || 1); // LTSCALE
    BDs(2.5, 1, 1, 0, 0, 0, 0, 0); // TEXTSIZE TRACEWID SKETCHINC FILLETRAD THICKNESS ANGBASE PDSIZE PLINEWID
    BDs(0, 0, 0, 0, 0); // USERR1-5
    BDs(0, 0, 0, 0); // CHAMFERA-D
    BDs(0.5, 1, 1); // FACETRES CMLSCALE CELTSCALE
    w.TV(cp1252('acad')); // MENU
    w.BL(2461000); w.BL(0); w.BL(2461000); w.BL(0); // TDCREATE TDUPDATE
    w.BL(0); w.BL(0); w.BL(0); w.BL(0); // TDINDWG TDUSRTIMER
    w.CMC(256); // CECOLOR
    w.H(0, nextHandle); // HANDSEED
    w.H(5, layers.get('0').handle); // CLAYER
    w.H(5, styles.get('STANDARD').handle); // TEXTSTYLE
    w.H(5, ltypes.get('BYLAYER').handle); // CELTYPE
    w.H(5, dimstyle); // DIMSTYLE
    w.H(5, 0); // CMLSTYLE
    w.BD(0); // PSVPSCALE
    const ucsBlock = (ins, emin, emax) => {
      w.BD3(ins); w.BD3(emin); w.BD3(emax);
      w.RD2([0, 0]); w.RD2([420, 297]); // LIMMIN LIMMAX
      w.BD(0); // ELEVATION
      w.BD3([0, 0, 0]); w.BD3([1, 0, 0]); w.BD3([0, 1, 0]); // UCSORG UCSXDIR UCSYDIR
      w.H(5, 0); // UCSNAME
      w.H(5, 0); w.BS(0); w.H(5, 0); // UCSORTHOREF UCSORTHOVIEW UCSBASE
      for (let i = 0; i < 6; i++) w.BD3([0, 0, 0]); // UCSORG TOP..BACK
    };
    ucsBlock([0, 0, 0], [0, 0, 0], [0, 0, 0]); // paper space
    ucsBlock([0, 0, 0], extmin, extmax); // model space
    w.TV([]); w.TV([]); // DIMPOST DIMAPOST
    BDs(num('$DIMSCALE', 40, 1) || 1, num('$DIMASZ', 40, 2.5), 0.625, 3.75, 1.25, 0, 0, 0, 0); // DIMSCALE ASZ EXO DLI EXE RND DLE TP TM
    Bs(0, 0, 0, 0, 0, 0); // DIMTOL DIMLIM DIMTIH DIMTOH DIMSE1 DIMSE2
    BSs(1, 8, 0); // DIMTAD DIMZIN DIMAZIN
    BDs(num('$DIMTXT', 40, 2.5), 2.5, 0, 0.03937007874, 1, 0, 1, 0.625); // DIMTXT CEN TSZ ALTF LFAC TVP TFAC GAP
    w.BD(0); w.B(0); w.BS(3); w.B(1); w.B(0); w.B(0); w.B(0); // DIMALTRND DIMALT DIMALTD DIMTOFL DIMSAH DIMTIX DIMSOXD
    w.CMC(0); w.CMC(0); w.CMC(0); // DIMCLRD DIMCLRE DIMCLRT
    BSs(0, 2, 2, 2, 3, 0, 0, 2, 44, 0, 0); // DIMADEC DEC TDEC ALTU ALTTD AUNIT FRAC LUNIT DSEP TMOVE JUST
    Bs(0, 0); // DIMSD1 DIMSD2
    BSs(0, 8, 0, 0); // DIMTOLJ DIMTZIN DIMALTZ DIMALTTZ
    w.B(0); // DIMUPT
    w.BS(3); // DIMATFIT
    w.H(5, styles.get('STANDARD').handle); // DIMTXSTY
    w.H(5, 0); w.H(5, 0); w.H(5, 0); w.H(5, 0); // DIMLDRBLK DIMBLK DIMBLK1 DIMBLK2
    w.BS(-2); w.BS(-2); // DIMLWD DIMLWE
    for (const h of [H.blockControl, H.layerControl, H.styleControl, H.ltypeControl, H.viewControl, H.ucsControl, H.vportControl, H.appidControl, H.dimstyleControl, H.vxControl]) w.H(3, h);
    w.H(5, 0); w.H(5, 0); // ACAD_GROUP, ACAD_MLINESTYLE dictionaries
    w.H(3, H.namedDict);
    w.BS(1); w.BS(70); // TSTACKALIGN TSTACKSIZE
    w.TV([]); w.TV([]); // HYPERLINKBASE STYLESHEET
    w.H(5, 0); w.H(5, 0); w.H(5, 0); // LAYOUTS PLOTSETTINGS PLOTSTYLES dictionaries
    w.BL(0x081d | 0x200); // flags: CELWEIGHT by layer, EXTNAMES, lineweights not displayed
    w.BS(num('$INSUNITS', 70, 0)); // INSUNITS
    w.BS(0); // CEPSNTYPE
    w.TV(cp1252('{00000000-0000-0000-0000-000000000000}')); // FINGERPRINTGUID
    w.TV(cp1252('{00000000-0000-0000-0000-000000000000}')); // VERSIONGUID
    w.H(5, ps.handle); w.H(5, ms.handle); // BLOCK_RECORD_PSPACE / MSPACE
    w.H(5, ltypes.get('BYLAYER').handle); w.H(5, ltypes.get('BYBLOCK').handle); w.H(5, ltypes.get('CONTINUOUS').handle);
    w.BS(0); w.BS(0); w.BS(0); w.BS(0);
  }

  return { bytes: assemble(objects, headerVars), notes: [...new Set(notes)] };
}

// ------------------------------------------------------------------ file assembly
function assemble(objects, headerVars) {
  // header variables section
  const hw = new Bits(4096);
  headerVars(hw);
  const hvData = hw.bytes();
  const hvSec = sectionWithSize(SENTINEL.varsBegin, hvData, SENTINEL.varsEnd);
  const clSec = sectionWithSize(SENTINEL.classesBegin, new Uint8Array(0), SENTINEL.classesEnd);

  const N = 3;
  const headerLen = 0x19 + 9 * N + 2 + 16;
  const out = [];
  let pos = headerLen;
  const hvAt = pos; pos += hvSec.length;
  const clAt = pos; pos += clSec.length;
  // objects, in handle order
  objects.sort((a, b) => a.handle - b.handle);
  const objBytes = [];
  const map = [];
  for (const o of objects) {
    const ms = MS(o.bytes.length);
    const body = new Uint8Array(ms.length + o.bytes.length + 2);
    body.set(ms, 0);
    body.set(o.bytes, ms.length);
    const c = crc16(0xc0c1, body, 0, ms.length + o.bytes.length);
    body[body.length - 2] = c & 0xff;
    body[body.length - 1] = c >>> 8;
    map.push([o.handle, pos]);
    objBytes.push(body);
    pos += body.length;
  }
  // object map: sections of at most 2032 bytes; handle/offset deltas restart in each section
  const mapAt = pos;
  const mapBytes = [];
  let i = 0;
  for (;;) {
    const sec = [0, 0];
    let lastH = 0, lastO = 0;
    while (i < map.length) {
      const [h, o] = map[i];
      const ent = [...UMC(h - lastH), ...MC(o - lastO)];
      if (sec.length + ent.length > 2032) break;
      sec.push(...ent);
      lastH = h; lastO = o;
      i++;
    }
    const empty = sec.length === 2;
    sec[0] = (sec.length >>> 8) & 0xff; sec[1] = sec.length & 0xff; // big-endian size, includes itself
    const c = crc16(0xc0c1, Uint8Array.from(sec));
    sec.push((c >>> 8) & 0xff, c & 0xff); // big-endian CRC
    mapBytes.push(...sec);
    if (empty) break; // the closing (empty) section
  }
  pos += mapBytes.length;

  // file header
  const fh = new Uint8Array(headerLen);
  fh.set([0x41, 0x43, 0x31, 0x30, 0x31, 0x35], 0); // AC1015
  fh.set([0, 0, 0, 0, 0, 0, 1], 6);
  const dv = new DataView(fh.buffer);
  dv.setUint32(0x0d, 0, true); // no preview image
  fh[0x11] = 0x1f; fh[0x12] = 0;
  dv.setUint16(0x13, 30, true); // ANSI_1252
  dv.setUint32(0x15, N, true);
  const recs = [[0, hvAt, hvSec.length], [1, clAt, clSec.length], [2, mapAt, mapBytes.length]];
  recs.forEach(([n, at, size], k) => { const o = 0x19 + 9 * k; fh[o] = n; dv.setUint32(o + 1, at, true); dv.setUint32(o + 5, size, true); });
  const crcAt = 0x19 + 9 * N;
  const xor = { 3: 0xa598, 4: 0x8101, 5: 0x3cc4, 6: 0x8461 }[N];
  dv.setUint16(crcAt, crc16(0, fh, 0, crcAt) ^ xor, true);
  fh.set(SENTINEL.fileHeaderEnd, crcAt + 2);

  out.push(fh, hvSec, clSec, ...objBytes, Uint8Array.from(mapBytes));
  const total = out.reduce((s, b) => s + b.length, 0);
  const file = new Uint8Array(total);
  let o = 0;
  for (const b of out) { file.set(b, o); o += b.length; }
  return file;
}

/** sentinel + RL size + data + RS CRC (over size + data, seed 0xC0C1) + end sentinel. */
function sectionWithSize(begin, data, end) {
  const out = new Uint8Array(16 + 4 + data.length + 2 + 16);
  out.set(begin, 0);
  new DataView(out.buffer).setUint32(16, data.length, true);
  out.set(data, 20);
  const c = crc16(0xc0c1, out, 16, 20 + data.length);
  out[20 + data.length] = c & 0xff;
  out[21 + data.length] = c >>> 8;
  out.set(end, 22 + data.length);
  return out;
}
