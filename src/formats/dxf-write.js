// ASCII DXF writer (R2000 / AC1015 structure), written from the public DXF reference.
// Writes the common model (see ../model.js): layers, line types, text styles, blocks and
// entities, with handles and owners so CAD programs can open it. The output is pure ASCII:
// non-ASCII characters are written as \U+XXXX escapes (valid in TEXT and MTEXT).
//
// What is written: LINE, LWPOLYLINE (bulges, closed flag), CIRCLE, ARC, ELLIPSE, POINT, TEXT,
// MTEXT, INSERT (+ ATTRIB), SOLID, HATCH, DIMENSION (via its block). Curves (SPLINE, DGN curves)
// are written as their polyline approximation; DGN cells are written as their components.
import { APP_NAME, APP_VERSION } from '../config.js';
import { ACI } from '../palettes.js';
import { FG } from '../model.js';
import { TAU } from '../geom.js';
import { transformEntity } from '../edit/ops.js';
import { weightToLw } from '../scene.js';

const R2D = 180 / Math.PI;

/** Shortest exact decimal for a number (DXF readers accept exponents). */
export const num = (v) => (Number.isFinite(v) ? (Number.isInteger(v) ? v.toFixed(1) : String(v)) : '0.0');
/** Integer group codes (flags, colours, counts, lineweights...) must be written without a decimal point. */
const isInt = (c) => (c >= 60 && c < 100) || (c >= 170 && c < 180) || (c >= 270 && c < 290) || (c >= 370 && c < 390) || (c >= 400 && c < 410) || (c >= 1060 && c < 1072);
const val = (c, v) => (typeof v !== 'number' ? String(v) : isInt(c) ? String(Math.round(v) || 0) : num(v));

/** Nearest ACI index (1..255) to an RGB colour; white/black map to 7 (foreground). */
export function nearestAci(rgb) {
  if (rgb === FG || rgb == null) return 7;
  rgb &= 0xffffff;
  if (rgb === 0xffffff || rgb === 0) return 7;
  let best = 7, bd = Infinity;
  const r = rgb >> 16, g = (rgb >> 8) & 255, b = rgb & 255;
  for (let i = 1; i < 256; i++) {
    if (i === 7) continue;
    const c = ACI[i];
    const d = ((c >> 16) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

const uesc = (code) => '\\U+' + code.toString(16).toUpperCase().padStart(4, '0');

/** TEXT value: single line, %% codes kept literal, non-ASCII and backslashes as \U+XXXX. */
export function encodeText(s) {
  let out = '';
  s = String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/%%/g, '%%%%%%');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 || c > 126) out += uesc(c);
    else if (c < 32) out += c === 9 ? ' ' : '';
    else out += s[i];
  }
  return out;
}

/** Raw stored TEXT/MTEXT string (already escaped by its author): only make it ASCII-safe. */
export function encodeRaw(s) {
  let out = '';
  s = String(s ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 126) out += uesc(c);
    else if (c < 32) out += c === 9 ? '^I' : ' ';
    else out += s[i];
  }
  return out;
}

/** MTEXT tokens for plain text: line breaks -> \P, \ { } escaped, non-ASCII -> \U+XXXX. */
export function mtextTokens(s) {
  const t = [];
  s = String(s ?? '').replace(/\r\n?/g, '\n').replace(/%%/g, '%%%%%%'); // literal %% (else read as %%c etc.)
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], c = s.charCodeAt(i);
    if (ch === '\n') t.push('\\P');
    else if (ch === '\\') t.push('\\\\');
    else if (ch === '{' || ch === '}') t.push('\\' + ch);
    else if (ch === '\t') t.push('^I');
    else if (ch === '^' || c > 126) t.push(uesc(c)); // a literal ^J would be read as a line break
    else if (c < 32) t.push(' ');
    else t.push(ch);
  }
  return t;
}

/** Split MTEXT into group-3 chunks (<= 250 chars) + the final group 1, never inside an escape. */
export function mtextChunks(tokens) {
  const chunks = [];
  let cur = '';
  for (const tk of tokens) {
    if (cur.length + tk.length > 250) { chunks.push(cur); cur = ''; }
    cur += tk;
  }
  chunks.push(cur);
  return chunks;
}
function rawTokens(s) { // split an escaped string so chunking never breaks \X...; sequences
  const out = [];
  const re = /\\[Uu]\+[0-9A-Fa-f]{4}|\\[ACFHQTWfhpacqtwS][^;\\]*;|\\./g;
  let last = 0, m;
  while ((m = re.exec(s))) { for (let i = last; i < m.index; i++) out.push(s[i]); out.push(m[0]); last = m.index + m[0].length; }
  for (let i = last; i < s.length; i++) out.push(s[i]);
  return out;
}

const BAD_NAME = /[<>/\\":;?*|=`\u0000-\u001f]/g;
/** Table names (layers, blocks, styles): DXF-safe, never empty. Anonymous blocks keep the leading *. */
export function safeName(s, allowStar = false) {
  s = String(s ?? '').trim();
  const star = allowStar && s.startsWith('*');
  let body = (star ? s.slice(1) : s).replace(BAD_NAME, '_');
  body = encodeText(body).replace(/\\/g, '_');
  if (!body) body = '0';
  return (star ? '*' : '') + body;
}

/** Ellipse in DXF form: centre, major axis, ratio <= 1, CCW parameters (handles any U, V). */
export function ellipseParams(e) {
  let [ux, uy] = e.major, [vx, vy] = e.minor;
  let t0 = e.t0 ?? 0, t1 = e.t1 ?? TAU;
  const full = Math.abs(t1 - t0) >= TAU - 1e-9 || (t0 === 0 && t1 === 0);
  if (full) { t0 = 0; t1 = TAU; } else while (t1 <= t0) t1 += TAU;
  const dot = ux * vx + uy * vy;
  if (Math.abs(dot) > 1e-12 * (ux * ux + uy * uy + vx * vx + vy * vy)) { // make the axes orthogonal
    const ts = 0.5 * Math.atan2(2 * dot, ux * ux + uy * uy - (vx * vx + vy * vy));
    const c = Math.cos(ts), s = Math.sin(ts);
    [ux, uy, vx, vy] = [ux * c + vx * s, uy * c + vy * s, -ux * s + vx * c, -uy * s + vy * c];
    t0 -= ts; t1 -= ts;
  }
  if (Math.hypot(vx, vy) > Math.hypot(ux, uy)) { [ux, uy, vx, vy] = [vx, vy, -ux, -uy]; t0 -= Math.PI / 2; t1 -= Math.PI / 2; }
  if (ux * vy - uy * vx < 0) { vx = -vx; vy = -vy; [t0, t1] = [-t1, -t0]; }
  const L = Math.hypot(ux, uy) || 1;
  const ratio = Math.min(1, Math.hypot(vx, vy) / L);
  if (full) return { c: e.c, major: [ux, uy], ratio, t0: 0, t1: TAU };
  const norm = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };
  return { c: e.c, major: [ux, uy], ratio, t0: norm(t0), t1: norm(t1) }; // end < start: wraps past 0
}

/**
 * Serialise a model. opts: { extents: [x0,y0,x1,y1] } (world; computed roughly when absent).
 * Returns { text, notes: [..], written: { entities, splines, cellsFlattened } }.
 */
export function writeDxf(model, opts = {}) {
  let handle = 0x20;
  const H = () => (handle++).toString(16).toUpperCase();
  const out = [];
  const P = (c, v) => { out.push(String(c), val(c, v)); };
  const stats = { entities: 0, splines: 0, cellsFlattened: 0, dimsMoved: 0, degenerate: 0, fills: 0 };
  const isDgn = model.format === 'DGN';

  // ---- names
  const layerName = (n) => safeName(n == null ? '0' : n);
  const blockName = (n) => safeName(n, true);
  const usedLtypes = new Set();
  const usedStyles = new Set(['STANDARD']);
  const ltypeName = (n) => { const u = String(n || 'BYLAYER').toUpperCase(); if (!['BYLAYER', 'BYBLOCK', 'CONTINUOUS'].includes(u)) usedLtypes.add(u); return safeName(u); };

  // blocks to write: every model block except the layout blocks we generate ourselves
  const blocks = Object.values(model.blocks || {}).filter((b) => b && b.name && !/^\*(MODEL|PAPER)_SPACE/i.test(b.name));
  const extraBlocks = []; // copies made for moved dimensions
  let dimSeq = 0;
  for (const b of blocks) { const m = /^\*D(\d+)$/i.exec(b.name); if (m) dimSeq = Math.max(dimSeq, +m[1]); }

  // ---- entity writer (into a separate buffer so tables can list everything that was used)
  const body = [];
  const E = (c, v) => { body.push(String(c), val(c, v)); };
  const xyz = (c, p) => { E(c, p[0]); E(c + 10, p[1]); E(c + 20, 0); };
  const colorGroups = (e) => {
    if (e.rgb != null) {
      const aci = nearestAci(e.rgb);
      E(62, aci);
      if (!(aci === 7 && ((e.rgb & 0xffffff) === 0xffffff || (e.rgb & 0xffffff) === 0)) && (ACI[aci] !== (e.rgb & 0xffffff))) E(420, e.rgb & 0xffffff);
    } else if (e.color != null && e.color !== 256) E(62, e.color | 0);
  };
  const common = (type, e, owner, paper, sub) => {
    E(0, type); E(5, H()); E(330, owner); E(100, 'AcDbEntity');
    if (paper) E(67, 1);
    E(8, layerName(e.layer));
    if (e.ltype && e.ltype !== 'BYLAYER') E(6, ltypeName(e.ltype));
    colorGroups(e);
    const lw = isDgn ? weightToLw(e.weight) : e.lw ?? -1; // DGN weights: see weightToLw (scene.js)
    if (lw !== -1) E(370, lw);
    if (e.lts > 0 && e.lts !== 1) E(48, e.lts);
    if (e.invisible) E(60, 1);
    if (sub) E(100, sub);
    stats.entities++;
  };
  const extrusion = (e) => { if (e.ext && e.xf) { E(210, e.ext[0]); E(220, e.ext[1]); E(230, e.ext[2]); } };
  const textGroups = (e, valignCode) => {
    xyz(10, e.p); E(40, e.h > 0 ? e.h : 1);
    E(1, e.raw != null ? encodeRaw(e.raw) : encodeText(e.text));
    if (e.rot) E(50, (e.rot * R2D) % 360);
    if (e.wf && e.wf !== 1) E(41, e.wf);
    if (e.oblique) E(51, e.oblique * R2D);
    if (e.style) { const s = safeName(e.style); usedStyles.add(s.toUpperCase()); E(7, s); }
    const gen = (e.mirrorX ? 2 : 0) | (e.mirrorY ? 4 : 0);
    if (gen) E(71, gen);
    const ha = e.halign | 0, va = e.valign | 0;
    if (ha) E(72, ha);
    if ((ha === 3 || ha === 5) && e.p2) xyz(11, e.p2);
    else if (ha || va) xyz(11, e.p);
    extrusion(e);
    return { va, valignCode };
  };

  /** A DGN fill (shape / ellipse with a fill linkage) as a solid HATCH under its outline. */
  function dgnFill(e, owner, paper) {
    let loop = null;
    if (e.type === 'polyline' && e.closed && e.pts.length >= 6) loop = { pts: e.pts, bulges: e.bulges };
    else if (e.type === 'circle' && e.r > 0) { const [x, y] = e.c, r = e.r, q = Math.tan(Math.PI / 8); loop = { pts: [x + r, y, x, y + r, x - r, y, x, y - r], bulges: [q, q, q, q] }; }
    else if (e.type === 'ellipse') {
      const pts = [];
      for (let k = 0; k < 72; k++) { const t = (k / 72) * 2 * Math.PI; pts.push(e.c[0] + e.major[0] * Math.cos(t) + e.minor[0] * Math.sin(t), e.c[1] + e.major[1] * Math.cos(t) + e.minor[1] * Math.sin(t)); }
      loop = { pts, bulges: null };
    }
    if (loop) { stats.fills++; entity({ type: 'hatch', layer: e.layer, color: 256, rgb: e.fill, weight: e.weight, solid: true, loops: [loop] }, owner, paper); }
  }

  function entity(e, owner, paper = false) {
    if (!e) return;
    if (e.fill != null && e.type !== 'hatch') dgnFill(e, owner, paper); // a DGN fill (also on items pasted from a DGN)
    switch (e.type) {
      case 'line': common('LINE', e, owner, paper, 'AcDbLine'); xyz(10, e.a); xyz(11, e.b); break;
      case 'point': common('POINT', e, owner, paper, 'AcDbPoint'); xyz(10, e.p); break;
      case 'polyline': case 'spline': {
        if (e.type === 'spline') stats.splines++;
        const n = e.pts.length / 2;
        if (n < 2) { if (n === 1) entity({ ...e, type: 'point', p: e.pts.slice(0, 2) }, owner, paper); break; }
        common('LWPOLYLINE', e, owner, paper, 'AcDbPolyline');
        E(90, n); E(70, e.closed ? 1 : 0);
        for (let k = 0; k < n; k++) {
          E(10, e.pts[2 * k]); E(20, e.pts[2 * k + 1]);
          const b = e.bulges ? e.bulges[k] : 0;
          if (b) E(42, b);
        }
        extrusion(e);
        break;
      }
      case 'circle': common('CIRCLE', e, owner, paper, 'AcDbCircle'); xyz(10, e.c); E(40, e.r); extrusion(e); break;
      case 'arc': {
        common('ARC', e, owner, paper, 'AcDbCircle'); xyz(10, e.c); E(40, e.r); extrusion(e);
        E(100, 'AcDbArc');
        const d = (a) => { a = (a * R2D) % 360; return a < 0 ? a + 360 : a; };
        E(50, d(e.a0)); E(51, d(e.a1));
        break;
      }
      case 'ellipse': {
        const q = ellipseParams(e);
        if (!(Math.hypot(...q.major) > 0)) { stats.degenerate++; break; } // zero-size ellipse: invalid in DXF
        common('ELLIPSE', e, owner, paper, 'AcDbEllipse');
        xyz(10, q.c); xyz(11, q.major); E(210, 0); E(220, 0); E(230, 1);
        E(40, q.ratio); E(41, q.t0); E(42, q.t1);
        break;
      }
      case 'text': {
        common('TEXT', e, owner, paper, 'AcDbText');
        textGroups(e);
        E(100, 'AcDbText');
        if (e.valign) E(73, e.valign | 0);
        break;
      }
      case 'mtext': {
        common('MTEXT', e, owner, paper, 'AcDbMText');
        xyz(10, e.p); E(40, e.h > 0 ? e.h : 1); E(41, e.width || 0); E(71, e.attach || 1); E(72, 1);
        const chunks = mtextChunks(e.raw != null ? rawTokens(encodeRaw(e.raw)) : mtextTokens(e.text));
        for (let k = 0; k < chunks.length - 1; k++) E(3, chunks[k]);
        E(1, chunks[chunks.length - 1]);
        if (e.style) { const s = safeName(e.style); usedStyles.add(s.toUpperCase()); E(7, s); }
        const r = e.rot || 0;
        E(11, Math.cos(r)); E(21, Math.sin(r)); E(31, 0);
        if (e.spacing && e.spacing !== 1) { E(73, 1); E(44, e.spacing); }
        break;
      }
      case 'solid': {
        common('SOLID', e, owner, paper, 'AcDbTrace');
        const p = e.pts;
        const pt = (k) => [p[2 * k], p[2 * k + 1]];
        const n = p.length / 2;
        xyz(10, pt(0)); xyz(11, pt(1));
        if (n >= 4) { xyz(12, pt(3)); xyz(13, pt(2)); } else { xyz(12, pt(2)); xyz(13, pt(2)); }
        extrusion(e);
        break;
      }
      case 'hatch': {
        const loops = (e.loops || []).filter((L) => L.pts && L.pts.length >= 6);
        if (!loops.length) break;
        common('HATCH', e, owner, paper, 'AcDbHatch');
        E(10, 0); E(20, 0); E(30, 0);
        const x = e.ext && e.xf ? e.ext : [0, 0, 1];
        E(210, x[0]); E(220, x[1]); E(230, x[2]);
        E(2, safeName(e.pattern || (e.solid ? 'SOLID' : 'ANSI31')));
        E(70, e.solid ? 1 : 0); E(71, 0); E(91, loops.length);
        for (const L of loops) {
          const hasB = !!(L.bulges && L.bulges.some((b) => b));
          E(92, 2); E(72, hasB ? 1 : 0); E(73, 1); E(93, L.pts.length / 2);
          for (let k = 0; k < L.pts.length / 2; k++) { E(10, L.pts[2 * k]); E(20, L.pts[2 * k + 1]); if (hasB) E(42, L.bulges[k] || 0); }
          E(97, 0);
        }
        if (e.tail && e.tail.length && e.tail[0][0] === 75) for (const [c, v] of e.tail) E(c, v);
        else {
          E(75, 1); E(76, 1);
          if (!e.solid) { E(52, 0); E(41, 1); E(77, 0); E(78, 1); E(53, 45); E(43, 0); E(44, 0); E(45, -0.088388); E(46, 0.088388); E(79, 0); }
          E(98, 0);
        }
        break;
      }
      case 'insert': {
        const attribs = (e.attribs || []).filter(Boolean);
        common('INSERT', e, owner, paper, 'AcDbBlockReference');
        const me = handle - 1;
        if (attribs.length) E(66, 1);
        E(2, blockName(e.block)); xyz(10, e.p);
        if ((e.sx ?? 1) !== 1) E(41, e.sx);
        if ((e.sy ?? 1) !== 1) E(42, e.sy);
        if (e.rot) E(50, (e.rot * R2D) % 360);
        if ((e.cols || 1) > 1) { E(70, e.cols); E(44, e.dc || 0); }
        if ((e.rows || 1) > 1) { E(71, e.rows); E(45, e.dr || 0); }
        extrusion(e);
        if (attribs.length) {
          const ownerH = me.toString(16).toUpperCase();
          attribs.forEach((a, k) => {
            common('ATTRIB', a, ownerH, paper, 'AcDbText');
            textGroups(a);
            E(100, 'AcDbAttribute');
            E(2, safeName(a.tag || 'ATT' + (k + 1)).replace(/\s+/g, '_'));
            E(70, a.invisible ? 1 : 0);
            if (a.valign) E(74, a.valign | 0);
          });
          E(0, 'SEQEND'); E(5, H()); E(330, ownerH); E(100, 'AcDbEntity'); E(8, layerName(e.layer));
        }
        break;
      }
      case 'dimension': {
        const key = String(e.block || '').toUpperCase();
        const blk = key && model.blocks ? model.blocks[key] : null;
        const M = e.mv || null;
        if (!blk || !blk.entities.length) { // no block: write what is drawn
          for (const c of e.fallback || []) entity(M ? transformEntity({ ...c, layer: c.layer ?? e.layer }, M) : { ...c, layer: c.layer ?? e.layer }, owner, paper);
          break;
        }
        let name = blk.name;
        const d = e.dim || {};
        const T = (p) => (p && M ? [M[0] * p[0] + M[2] * p[1] + M[4], M[1] * p[0] + M[3] * p[1] + M[5]] : p || [0, 0]);
        let ang = d.angle || 0;
        if (M) { // moved/rotated: the dimension gets its own copy of the block, transformed
          name = `*D${++dimSeq}`;
          extraBlocks.push({ name, base: [0, 0], flags: 1, entities: blk.entities.map((c) => transformEntity(c, M)) });
          ang += Math.atan2(M[1], M[0]) * R2D;
          stats.dimsMoved++;
        }
        common('DIMENSION', e, owner, paper, 'AcDbDimension');
        E(2, blockName(name)); xyz(10, T(d.p10)); xyz(11, T(d.p11));
        const type = (d.flags ?? 0) & 7;
        E(70, (d.flags ?? 0) | 32);
        E(1, d.text ? encodeRaw(d.text) : '');
        if (d.style) E(3, safeName(d.style));
        if (type === 0 || type === 1) {
          E(100, 'AcDbAlignedDimension'); xyz(13, T(d.p13)); xyz(14, T(d.p14));
          if (type === 0) { E(50, ang); E(100, 'AcDbRotatedDimension'); }
        } else if (type === 2) { E(100, 'AcDb2LineAngularDimension'); xyz(13, T(d.p13)); xyz(14, T(d.p14)); xyz(15, T(d.p15)); xyz(16, T(d.p16)); }
        else if (type === 3) { E(100, 'AcDbDiametricDimension'); xyz(15, T(d.p15)); E(40, 0); }
        else if (type === 4) { E(100, 'AcDbRadialDimension'); xyz(15, T(d.p15)); E(40, 0); }
        else if (type === 5) { E(100, 'AcDb3PointAngularDimension'); xyz(13, T(d.p13)); xyz(14, T(d.p14)); xyz(15, T(d.p15)); }
        else if (type === 6) { E(100, 'AcDbOrdinateDimension'); xyz(13, T(d.p13)); xyz(14, T(d.p14)); }
        if (e.ext && e.xf) extrusion(e);
        break;
      }
      case 'cell':
        stats.cellsFlattened++;
        for (const c of e.children || []) entity(c, owner, paper);
        break;
      default:
        break;
    }
  }

  // ---- handles for the fixed objects
  const hDict = H(), hGroupDict = H();
  const hTbl = {};
  for (const t of ['VPORT', 'LTYPE', 'LAYER', 'STYLE', 'VIEW', 'UCS', 'APPID', 'DIMSTYLE', 'BLOCK_RECORD']) hTbl[t] = H();
  const hMS = H(), hPS = H();
  const brHandle = new Map(); // block name (upper) -> block record handle
  const allBlocks = () => [...blocks, ...extraBlocks];

  // inserts of blocks the file did not define get an empty definition (keeps the file valid)
  const known = new Set(blocks.map((b) => blockName(b.name).toUpperCase()));
  const needBlocks = (list) => {
    for (const e of list) {
      if (!e) continue;
      if (e.type === 'insert' && e.block && !known.has(blockName(e.block).toUpperCase())) { known.add(blockName(e.block).toUpperCase()); extraBlocks.push({ name: e.block, base: [0, 0], flags: 0, entities: [] }); }
      if (e.children) needBlocks(e.children);
    }
  };
  needBlocks(model.entities); needBlocks(model.paperEntities || []);
  for (const b of blocks) needBlocks(b.entities || []);
  // entities first (they may create moved-dimension blocks)
  for (const e of model.entities) if (e) entity(e, hMS);
  for (const e of model.paperEntities || []) if (e) entity(e, hPS, true);
  const ents = body.splice(0, body.length); // (never push(...big): it overflows the call stack)
  // blocks (entities owned by their block record)
  const blockBodies = [];
  for (const b of allBlocks()) {
    const br = H();
    brHandle.set(blockName(b.name).toUpperCase(), br);
    for (const e of b.entities || []) entity(e, br);
    blockBodies.push({ b, br, text: body.splice(0, body.length) });
  }

  // ---- HEADER
  let ext = opts.extents;
  if (!ext || !(ext[0] <= ext[2])) ext = [0, 0, 1, 1];
  P(999, `${APP_NAME} ${APP_VERSION}`);
  P(0, 'SECTION'); P(2, 'HEADER');
  P(9, '$ACADVER'); P(1, 'AC1015');
  P(9, '$DWGCODEPAGE'); P(3, 'ANSI_1252');
  P(9, '$INSBASE'); P(10, 0); P(20, 0); P(30, 0);
  P(9, '$EXTMIN'); P(10, ext[0]); P(20, ext[1]); P(30, 0);
  P(9, '$EXTMAX'); P(10, ext[2]); P(20, ext[3]); P(30, 0);
  P(9, '$INSUNITS'); P(70, model.units ? model.units.code | 0 : 0);
  const hd = model.header || {};
  if (hd.ltscale > 0 && hd.ltscale !== 1) { P(9, '$LTSCALE'); P(40, hd.ltscale); }
  if (hd.psltscale === 0) { P(9, '$PSLTSCALE'); P(70, 0); }
  const seedAt = out.length;
  P(9, '$HANDSEED'); P(5, 'FFFF');
  P(0, 'ENDSEC');
  P(0, 'SECTION'); P(2, 'CLASSES'); P(0, 'ENDSEC');

  // ---- TABLES
  P(0, 'SECTION'); P(2, 'TABLES');
  const table = (name, count, fn, extra) => {
    P(0, 'TABLE'); P(2, name); P(5, hTbl[name]); P(330, 0); P(100, 'AcDbSymbolTable'); P(70, count);
    if (extra) extra();
    fn();
    P(0, 'ENDTAB');
  };
  const rec = (type, sub, name, owner, flags = 0) => { P(0, type); P(5, H()); P(330, owner); P(100, 'AcDbSymbolTableRecord'); P(100, sub); P(2, name); P(70, flags); };
  table('VPORT', 1, () => {
    rec('VPORT', 'AcDbViewportTableRecord', '*ACTIVE', hTbl.VPORT);
    const w = Math.max(ext[2] - ext[0], 1e-9), h = Math.max(ext[3] - ext[1], 1e-9);
    P(10, 0); P(20, 0); P(11, 1); P(21, 1); P(12, (ext[0] + ext[2]) / 2); P(22, (ext[1] + ext[3]) / 2);
    P(13, 0); P(23, 0); P(14, 1); P(24, 1); P(15, 0); P(25, 0); P(16, 0); P(26, 0); P(36, 1); P(17, 0); P(27, 0); P(37, 0);
    P(40, h * 1.1); P(41, w / h); P(42, 50); P(43, 0); P(44, 0); P(50, 0); P(51, 0);
    P(71, 0); P(72, 100); P(73, 1); P(74, 3); P(75, 0); P(76, 0); P(77, 0); P(78, 0);
  });
  // layers: every model layer (+ any name used by an entity but missing from the table)
  const layers = [];
  const seen = new Set();
  const addLayer = (L) => { const n = layerName(L.name); if (seen.has(n.toUpperCase())) return; seen.add(n.toUpperCase()); layers.push({ ...L, out: n }); };
  addLayer({ name: '0', color: FG });
  for (const L of model.layers || []) addLayer(L);
  const scanLayers = (list) => { for (const e of list) { if (!e) continue; if (!seen.has(layerName(e.layer).toUpperCase())) addLayer({ name: e.layer ?? '0', color: FG }); if (e.children) scanLayers(e.children); if (e.attribs) scanLayers(e.attribs); } };
  scanLayers(model.entities); scanLayers(model.paperEntities || []);
  for (const b of allBlocks()) scanLayers(b.entities || []);
  const layerLt = (L) => (L.ltype && !String(L.ltype).toUpperCase().startsWith('DGN') ? String(L.ltype).toUpperCase() : 'CONTINUOUS');
  for (const L of layers) ltypeName(layerLt(L));
  // line types: the standard three + every one used
  const ltDefs = [];
  for (const name of usedLtypes) {
    const def = model.ltypes ? model.ltypes[name] : null;
    let pattern = def && def.pattern && def.pattern.length ? def.pattern : null;
    if (!pattern && def && def.px) { // DGN line style: screen dashes -> drawing units (~1% of the drawing)
      const u = Math.max(ext[2] - ext[0], ext[3] - ext[1], 1e-9) / 400;
      pattern = def.px.map((v, i) => (i % 2 ? -v : v) * u);
    }
    ltDefs.push({ name: safeName(name), desc: def ? def.desc || name : name, pattern: pattern || [] });
  }
  table('LTYPE', 3 + ltDefs.length, () => {
    for (const [n, d] of [['BYBLOCK', ''], ['BYLAYER', ''], ['CONTINUOUS', 'Solid line']]) { rec('LTYPE', 'AcDbLinetypeTableRecord', n, hTbl.LTYPE); P(3, d); P(72, 65); P(73, 0); P(40, 0); }
    for (const lt of ltDefs) {
      rec('LTYPE', 'AcDbLinetypeTableRecord', lt.name, hTbl.LTYPE);
      P(3, encodeText(lt.desc)); P(72, 65); P(73, lt.pattern.length); P(40, lt.pattern.reduce((s, v) => s + Math.abs(v), 0));
      for (const v of lt.pattern) { P(49, v); P(74, 0); }
    }
  });
  table('LAYER', layers.length, () => {
    for (const L of layers) {
      rec('LAYER', 'AcDbLayerTableRecord', L.out, hTbl.LAYER, L.frozen ? 1 : 0);
      const aci = L.aci && !(isDgn) ? L.aci : nearestAci(L.color);
      P(62, L.visible === false ? -aci : aci);
      P(6, safeName(layerLt(L)));
      if (L.color !== FG && L.color != null && (L.color & 0xffffff) !== ACI[aci] && !isDgn) P(420, L.color & 0xffffff);
      P(370, isDgn ? -3 : L.lw ?? -3);
    }
  });
  // text styles
  const styles = [];
  for (const s of usedStyles) styles.push(s);
  for (const k of Object.keys(model.styles || {})) if (!usedStyles.has(safeName(k).toUpperCase())) styles.push(safeName(k).toUpperCase());
  table('STYLE', styles.length, () => {
    for (const name of styles) {
      const st = (model.styles || {})[name] || {};
      rec('STYLE', 'AcDbTextStyleTableRecord', name, hTbl.STYLE);
      P(40, st.h || 0); P(41, st.wf || 1); P(50, (st.oblique || 0) * R2D); P(71, 0); P(42, 2.5); P(3, encodeText(st.font || 'txt')); P(4, '');
    }
  });
  table('VIEW', 0, () => {});
  table('UCS', 0, () => {});
  table('APPID', 1, () => { rec('APPID', 'AcDbRegAppTableRecord', 'ACAD', hTbl.APPID); });
  table('DIMSTYLE', 1, () => {
    P(0, 'DIMSTYLE'); P(105, H()); P(330, hTbl.DIMSTYLE); P(100, 'AcDbSymbolTableRecord'); P(100, 'AcDbDimStyleTableRecord'); P(2, 'STANDARD'); P(70, 0);
  }, () => { P(100, 'AcDbDimStyleTable'); });
  const allB = allBlocks();
  table('BLOCK_RECORD', 2 + allB.length, () => {
    const br = (name, h) => { P(0, 'BLOCK_RECORD'); P(5, h); P(330, hTbl.BLOCK_RECORD); P(100, 'AcDbSymbolTableRecord'); P(100, 'AcDbBlockTableRecord'); P(2, name); };
    br('*Model_Space', hMS); br('*Paper_Space', hPS);
    for (const b of allB) br(blockName(b.name), brHandle.get(blockName(b.name).toUpperCase()));
  });
  P(0, 'ENDSEC');

  // ---- BLOCKS
  P(0, 'SECTION'); P(2, 'BLOCKS');
  const block = (name, owner, base, flags, text, paper) => {
    P(0, 'BLOCK'); P(5, H()); P(330, owner); P(100, 'AcDbEntity'); if (paper) P(67, 1); P(8, '0'); P(100, 'AcDbBlockBegin');
    P(2, name); P(70, flags); P(10, base[0]); P(20, base[1]); P(30, 0); P(3, name); P(1, '');
    for (const l of text) out.push(l);
    P(0, 'ENDBLK'); P(5, H()); P(330, owner); P(100, 'AcDbEntity'); if (paper) P(67, 1); P(8, '0'); P(100, 'AcDbBlockEnd');
  };
  block('*Model_Space', hMS, [0, 0], 0, []);
  block('*Paper_Space', hPS, [0, 0], 0, [], true);
  for (const { b, br, text } of blockBodies) block(blockName(b.name), br, b.base || [0, 0], (b.flags | 0) & ~4 & ~8, text);
  P(0, 'ENDSEC');

  // ---- ENTITIES
  P(0, 'SECTION'); P(2, 'ENTITIES');
  for (const l of ents) out.push(l);
  P(0, 'ENDSEC');

  // ---- OBJECTS: root dictionary + group dictionary
  P(0, 'SECTION'); P(2, 'OBJECTS');
  P(0, 'DICTIONARY'); P(5, hDict); P(330, 0); P(100, 'AcDbDictionary'); P(281, 1); P(3, 'ACAD_GROUP'); P(350, hGroupDict);
  P(0, 'DICTIONARY'); P(5, hGroupDict); P(330, hDict); P(100, 'AcDbDictionary'); P(281, 1);
  P(0, 'ENDSEC');
  P(0, 'EOF');
  out[seedAt + 3] = handle.toString(16).toUpperCase();

  const notes = [];
  if (stats.splines) notes.push(`${stats.splines} curve${stats.splines === 1 ? ' was' : 's were'} saved as polylines (their on-screen approximation).`);
  if (stats.cellsFlattened) notes.push(`${stats.cellsFlattened} cell${stats.cellsFlattened === 1 ? '' : 's'} saved as separate items (DXF has no cells).`);
  if (stats.fills) notes.push(`${stats.fills} ${model.format === 'PDF' ? 'filled shape' : 'DGN fill'}${stats.fills === 1 ? ' was' : 's were'} saved as solid hatch${stats.fills === 1 ? '' : 'es'} under the outline.`);
  if (stats.degenerate) notes.push(`${stats.degenerate} zero-size ellipse${stats.degenerate === 1 ? ' was' : 's were'} left out (not valid in DXF).`);
  if (stats.dimsMoved) notes.push(`${stats.dimsMoved} moved dimension${stats.dimsMoved === 1 ? '' : 's'} got a copy of their block.`);
  return { text: out.join('\r\n') + '\r\n', notes, written: stats };
}
