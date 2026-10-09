// ASCII DXF reader (R12 .. 2018 group-code structure), written from the public DXF reference.
// Produces the common model (see ../model.js). Never throws on bad content: unknown entities are
// skipped and counted in model.stats.notShown; truncated files keep whatever was read.

import { createModel, ensureLayer, countType, notShown, warn, FormatError, unitsFromCode, FG } from '../model.js';
import { ACI } from '../palettes.js';
import { ocsMatrix, tessBSpline, tessCatmullRom } from '../geom.js';

const D2R = Math.PI / 180;
const BINARY_SIGNATURE = 'AutoCAD Binary DXF'; // file signature, used only for detection

const CODEPAGES = {
  ANSI_874: 'windows-874', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5',
  ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258', DOS437: 'ibm866', ISO8859_1: 'iso-8859-1',
};

/** True if the bytes start with the binary-DXF signature. */
export function isBinaryDxf(bytes) {
  if (bytes.length < 22) return false;
  for (let i = 0; i < BINARY_SIGNATURE.length; i++) if (bytes[i] !== BINARY_SIGNATURE.charCodeAt(i)) return false;
  return true;
}

/**
 * Decode DXF bytes to text. R2007+ files are UTF-8; older files use $DWGCODEPAGE. Files that are
 * valid UTF-8 are always decoded as UTF-8 (generators often write UTF-8 regardless of the header).
 */
export function decodeDxfBytes(bytes) {
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3; // BOM
  const body = bytes.subarray(start);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' };
  } catch { /* not UTF-8: fall through to the declared code page */ }
  // sniff $DWGCODEPAGE from the first 64 KB (ASCII-safe)
  const head = new TextDecoder('latin1').decode(body.subarray(0, 65536));
  const m = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([A-Za-z0-9_]+)/.exec(head);
  const cp = m ? CODEPAGES[m[1].toUpperCase()] : null;
  let label = cp || 'windows-1252';
  try {
    return { text: new TextDecoder(label).decode(body), encoding: label };
  } catch {
    label = 'windows-1252';
    return { text: new TextDecoder(label).decode(body), encoding: label };
  }
}

// ------------------------------------------------------------------ group-pair reader
class PairReader {
  constructor(text, onProgress) {
    this.lines = text.indexOf('\n') >= 0 ? text.split('\n') : text.split('\r');
    this.i = 0;
    this.code = -1;
    this.value = '';
    this.errors = 0;
    this.onProgress = onProgress;
    this.step = Math.max(2000, (this.lines.length / 50) | 0);
    this.nextReport = this.step;
  }
  next() {
    const L = this.lines;
    while (this.i + 1 < L.length) {
      const code = parseInt(L[this.i], 10);
      if (Number.isNaN(code)) { this.i++; this.errors++; continue; } // resync on garbage
      let v = L[this.i + 1];
      if (v.length && v.charCodeAt(v.length - 1) === 13) v = v.slice(0, -1);
      this.i += 2;
      this.code = code;
      this.value = v;
      if (this.onProgress && this.i >= this.nextReport) {
        this.nextReport += this.step;
        this.onProgress(this.i / L.length);
      }
      return true;
    }
    this.code = -1;
    this.value = '';
    return false;
  }
}

/** Group access for one record. Lookups stop at an embedded object (code 101). */
class Groups {
  constructor(type, codes, vals) {
    this.type = type;
    this.codes = codes;
    this.vals = vals;
    let end = codes.indexOf(101);
    this.end = end < 0 ? codes.length : end;
  }
  idx(code) {
    const c = this.codes;
    for (let k = 0; k < this.end; k++) if (c[k] === code) return k;
    return -1;
  }
  has(code) { return this.idx(code) >= 0; }
  s(code, def = '') { const k = this.idx(code); return k < 0 ? def : this.vals[k]; }
  f(code, def = 0) { const k = this.idx(code); if (k < 0) return def; const v = parseFloat(this.vals[k]); return Number.isFinite(v) ? v : def; }
  i(code, def = 0) { const k = this.idx(code); if (k < 0) return def; const v = parseInt(this.vals[k], 10); return Number.isFinite(v) ? v : def; }
  all(code) { const out = []; for (let k = 0; k < this.end; k++) if (this.codes[k] === code) out.push(this.vals[k]); return out; }
}

// ------------------------------------------------------------------ text decoding
export function decodeTextCodes(s) {
  if (!s) return '';
  if (s.indexOf('%%') >= 0) {
    s = s.replace(/%%(\d{3}|[cCdDpP%uUoOkK])/g, (m, c) => {
      switch (c.toLowerCase()) {
        case 'c': return 'Ø';
        case 'd': return '°';
        case 'p': return '±';
        case '%': return '%';
        case 'u': case 'o': case 'k': return '';
        default: return String.fromCharCode(parseInt(c, 10));
      }
    });
  }
  if (s.indexOf('\\U+') >= 0 || s.indexOf('\\u+') >= 0) {
    s = s.replace(/\\[Uu]\+([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }
  if (s.indexOf('\\M+') >= 0) s = s.replace(/\\M\+[0-9A-Fa-f]{5}/g, '?');
  return s;
}

/** Strip MTEXT inline formatting, keep paragraph breaks as \n. */
export function mtextToPlain(s) {
  let out = '';
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < n) {
      const c = s[i + 1];
      switch (c) {
        case 'P': case 'N': out += '\n'; i++; break;
        case 'X': out += '\n'; i++; break;
        case '~': out += ' '; i++; break;
        case '\\': case '{': case '}': out += c; i++; break;
        case 'L': case 'l': case 'O': case 'o': case 'K': case 'k': i++; break;
        case 'U': case 'u':
          if (s[i + 2] === '+' && /^[0-9A-Fa-f]{4}$/.test(s.substr(i + 3, 4))) {
            out += String.fromCharCode(parseInt(s.substr(i + 3, 4), 16)); i += 6;
          } else { out += c; i++; }
          break;
        case 'S': { // stacked fraction  \S1/2;  \S1^2;  \S1#2;
          const end = s.indexOf(';', i + 2);
          const body = end < 0 ? s.slice(i + 2) : s.slice(i + 2, end);
          out += body.replace(/\^/, '/').replace(/#/, '/');
          i = end < 0 ? n : end;
          break;
        }
        case 'f': case 'F': case 'H': case 'h': case 'C': case 'c': case 'T': case 't':
        case 'Q': case 'q': case 'W': case 'w': case 'A': case 'a': case 'p': {
          const end = s.indexOf(';', i + 2);
          i = end < 0 ? n : end;
          break;
        }
        default: out += c; i++;
      }
    } else if (ch === '{' || ch === '}') {
      // grouping braces: ignore
    } else if (ch === '^' && s[i + 1] === 'I') { out += '    '; i++; }
    else if (ch === '^' && s[i + 1] === 'J') { out += '\n'; i++; }
    else out += ch;
  }
  return decodeTextCodes(out);
}

// ------------------------------------------------------------------ main entry
export function parseDxf(input, { onProgress } = {}) {
  let text, encoding = 'utf-16';
  if (typeof input === 'string') text = input;
  else {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (isBinaryDxf(bytes)) {
      throw new FormatError('binary-dxf', 'This is a binary DXF file. Binary DXF is not supported yet — please save it as ASCII DXF.');
    }
    ({ text, encoding } = decodeDxfBytes(bytes));
  }
  const model = createModel('DXF');
  model.header.encoding = encoding;
  const R = new PairReader(text, onProgress);
  const ctx = { model, R, styles: {}, dimasz: 0, dimscale: 1, dimtxt: 0 };
  ensureLayer(model, '0', FG);
  let sawSection = false;

  if (!R.next()) throw new FormatError('empty', 'The file is empty or is not a DXF file.');
  while (R.code !== -1) {
    if (R.code === 0 && R.value.trim() === 'SECTION') {
      sawSection = true;
      R.next();
      const name = R.code === 2 ? R.value.trim().toUpperCase() : '';
      if (R.code === 2) R.next();
      if (name === 'HEADER') readHeader(ctx);
      else if (name === 'TABLES') readTables(ctx);
      else if (name === 'BLOCKS') readBlocks(ctx);
      else if (name === 'ENTITIES') readEntitySection(ctx, model.entities, true);
      else skipSection(R);
      continue;
    }
    if (R.code === 0 && R.value.trim() === 'EOF') break;
    if (!R.next()) break;
  }
  if (!sawSection) throw new FormatError('not-dxf', 'This does not look like a DXF file (no SECTION found).');
  if (R.errors) warn(model, `Skipped ${R.errors} malformed line(s).`);
  if (R.code === -1) warn(model, 'The file ended early (no EOF marker); showing what was read.');

  // paper space: show only when model space is empty
  if (model.paperEntities.length) {
    if (!model.entities.length) {
      model.entities = model.paperEntities;
      model.paperEntities = [];
      warn(model, 'Model space is empty; showing the paper-space layout instead.');
    } else {
      notShown(model, 'Paper-space (layout) items', model.paperEntities.length);
    }
  }
  model.stats.entities = model.entities.length;
  return model;
}

function skipSection(R) {
  // R sits on the first group after the section name (which may already be ENDSEC: empty section)
  for (; R.code !== -1; R.next()) if (R.code === 0 && R.value.trim() === 'ENDSEC') { R.next(); return; }
}

// ------------------------------------------------------------------ HEADER
function readHeader(ctx) {
  const { R, model } = ctx;
  const H = {};
  let name = null;
  for (; R.code !== -1; R.next()) {
    if (R.code === 0) {
      if (R.value.trim() === 'ENDSEC') { R.next(); break; }
      if (R.value.trim() === 'SECTION' || R.value.trim() === 'EOF') break;
    }
    if (R.code === 9) { name = R.value.trim().toUpperCase(); H[name] = {}; continue; }
    if (name) H[name][R.code] = R.value;
  }
  const num = (v, c, d) => { const x = v && v[c] != null ? parseFloat(v[c]) : NaN; return Number.isFinite(x) ? x : d; };
  model.version = (H.$ACADVER && (H.$ACADVER[1] || '').trim()) || '';
  model.units = unitsFromCode(num(H.$INSUNITS, 70, 0));
  model.header.codepage = H.$DWGCODEPAGE ? (H.$DWGCODEPAGE[3] || '').trim() : '';
  model.header.measurement = num(H.$MEASUREMENT, 70, -1);
  if (H.$EXTMIN && H.$EXTMAX) {
    model.header.extents = [num(H.$EXTMIN, 10, 0), num(H.$EXTMIN, 20, 0), num(H.$EXTMAX, 10, 0), num(H.$EXTMAX, 20, 0)];
  }
  ctx.dimasz = num(H.$DIMASZ, 40, 0);
  ctx.dimscale = num(H.$DIMSCALE, 40, 1) || 1;
  ctx.dimtxt = num(H.$DIMTXT, 40, 0);
  model.header.ltscale = num(H.$LTSCALE, 40, 1) || 1;
}

// ------------------------------------------------------------------ records
/** Read code-0 delimited records until one of `stops`; cb(type, codes, vals). R must sit on a code 0. */
function readRecords(R, stops, cb) {
  while (R.code !== -1) {
    if (R.code !== 0) { R.next(); continue; }
    const type = R.value.trim().toUpperCase();
    if (stops.includes(type)) return type;
    const codes = [], vals = [];
    while (R.next() && R.code !== 0) { codes.push(R.code); vals.push(R.value); }
    cb(type, codes, vals);
  }
  return 'EOF';
}

// ------------------------------------------------------------------ TABLES
function readTables(ctx) {
  const { R, model } = ctx;
  while (R.code !== -1) {
    if (R.code === 0) {
      const v = R.value.trim();
      if (v === 'ENDSEC') { R.next(); return; }
      if (v === 'EOF' || v === 'SECTION') return;
      if (v === 'TABLE') {
        R.next();
        const table = R.code === 2 ? R.value.trim().toUpperCase() : '';
        // skip table header groups up to the first record
        while (R.next() && R.code !== 0);
        readRecords(R, ['ENDTAB', 'ENDSEC', 'EOF', 'SECTION'], (type, codes, vals) => {
          const g = new Groups(type, codes, vals);
          if (table === 'LAYER' && type === 'LAYER') tableLayer(model, g);
          else if (table === 'LTYPE' && type === 'LTYPE') tableLtype(model, g);
          else if (table === 'STYLE' && type === 'STYLE') tableStyle(ctx, g);
        });
        if (R.code === 0 && R.value.trim() === 'ENDTAB') R.next();
        continue;
      }
    }
    R.next();
  }
}

function aciToRgb(aci) {
  aci = Math.abs(aci | 0);
  if (aci === 7 || aci === 0 || aci === 256 || aci > 255) return FG;
  return ACI[aci];
}

function tableLayer(model, g) {
  const name = g.s(2, '0').trim() || '0';
  const aci = g.i(62, 7);
  const L = ensureLayer(model, name);
  L.aci = Math.abs(aci) || 7;
  L.color = g.has(420) ? g.i(420) & 0xffffff : aciToRgb(aci);
  if (g.has(420) && (L.color === 0xffffff || L.color === 0)) L.color = aciToRgb(aci); // keep FG semantics for white/black
  const flags = g.i(70, 0);
  L.frozen = !!(flags & 1);
  L.visible = aci >= 0 && !L.frozen;
  L.ltype = g.s(6, 'CONTINUOUS').trim().toUpperCase() || 'CONTINUOUS';
}

function tableLtype(model, g) {
  const name = g.s(2, '').trim().toUpperCase();
  if (!name) return;
  const pattern = g.all(49).map((v) => parseFloat(v)).filter(Number.isFinite);
  model.ltypes[name] = { name, desc: g.s(3, ''), pattern };
}

function tableStyle(ctx, g) {
  const name = g.s(2, '').trim().toUpperCase();
  if (!name) return;
  ctx.styles[name] = { h: g.f(40, 0), wf: g.f(41, 1) || 1, oblique: g.f(50, 0) * D2R, flags: g.i(71, 0), font: g.s(3, '') };
  ctx.model.styles[name] = ctx.styles[name];
}

// ------------------------------------------------------------------ BLOCKS
function readBlocks(ctx) {
  const { R, model } = ctx;
  while (R.code !== -1) {
    if (R.code === 0) {
      const v = R.value.trim();
      if (v === 'ENDSEC') { R.next(); return; }
      if (v === 'EOF' || v === 'SECTION') return;
      if (v === 'BLOCK') {
        const codes = [], vals = [];
        while (R.next() && R.code !== 0) { codes.push(R.code); vals.push(R.value); }
        const g = new Groups('BLOCK', codes, vals);
        const name = (g.s(2, '') || g.s(3, '')).trim();
        const flags = g.i(70, 0);
        const block = { name, base: [g.f(10), g.f(20)], entities: [], xref: !!(flags & 4), flags };
        const sink = [];
        readEntitySection(ctx, sink, false, ['ENDBLK']);
        block.entities = sink;
        if (R.code === 0 && R.value.trim() === 'ENDBLK') {
          while (R.next() && R.code !== 0); // ENDBLK groups
        }
        if (name) model.blocks[name.toUpperCase()] = block;
        continue;
      }
    }
    R.next();
  }
}

// ------------------------------------------------------------------ ENTITIES
function readEntitySection(ctx, out, topLevel, extraStops = []) {
  const { R, model } = ctx;
  let pending = null; // POLYLINE or INSERT waiting for VERTEX/ATTRIB/SEQEND
  const flush = () => {
    if (!pending) return;
    const ents = pending.finish();
    pending = null;
    for (const e of ents) emit(e);
  };
  const emit = (e) => {
    if (!e) return;
    if (e.paper && topLevel) model.paperEntities.push(e);
    else out.push(e);
  };
  const stops = ['ENDSEC', 'EOF', 'SECTION', ...extraStops];
  const end = readRecords(R, stops, (type, codes, vals) => {
    const g = new Groups(type, codes, vals);
    if (topLevel && type !== 'VERTEX' && type !== 'SEQEND' && type !== 'ATTRIB') countType(model, type);
    if (type === 'VERTEX' && pending && pending.kind === 'POLYLINE') { pending.vertex(g); return; }
    if ((type === 'ATTRIB') && pending && pending.kind === 'INSERT') { pending.attrib(g); return; }
    if (type === 'SEQEND') { flush(); return; }
    flush();
    if (type === 'POLYLINE') { pending = polylineBuilder(ctx, g); return; }
    if (type === 'INSERT') {
      pending = insertBuilder(ctx, g);
      if (!g.i(66, 0)) {
        // attributes may still follow without the 66 flag; INSERT is flushed by the next non-ATTRIB
      }
      return;
    }
    const e = convertEntity(ctx, g, topLevel);
    if (Array.isArray(e)) e.forEach(emit); else emit(e);
  });
  flush();
  if (end === 'ENDSEC') R.next();
}

function common(g, model) {
  const layer = (g.s(8, '0').trim() || '0');
  ensureLayer(model, layer);
  const e = {
    layer,
    color: Math.abs(g.i(62, 256)),
    rgb: g.has(420) ? g.i(420) & 0xffffff : null,
    ltype: g.s(6, 'BYLAYER').trim().toUpperCase() || 'BYLAYER',
    src: g.type,
  };
  if (g.i(67, 0) === 1) e.paper = true;
  if (g.i(60, 0) === 1) e.invisible = true;
  return e;
}

function ocsOf(g) {
  if (!g.has(210) && !g.has(230)) return null;
  return ocsMatrix(g.f(210, 0), g.f(220, 0), g.f(230, 1));
}
/** Set e.xf (OCS -> plan) and keep the extrusion vector (e.ext) so a saved file keeps it. */
function setOcs(e, g) {
  e.xf = ocsOf(g);
  if (e.xf) e.ext = [g.f(210, 0), g.f(220, 0), g.f(230, 1)];
  return e;
}

function textStyle(ctx, g) {
  return ctx.styles[(g.s(7, 'STANDARD').trim() || 'STANDARD').toUpperCase()] || null;
}

function convertEntity(ctx, g, topLevel) {
  const { model } = ctx;
  const type = g.type;
  switch (type) {
    case 'LINE': {
      const e = common(g, model);
      e.type = 'line';
      e.a = [g.f(10), g.f(20)];
      e.b = [g.f(11), g.f(21)];
      return e;
    }
    case 'POINT': {
      const e = common(g, model);
      e.type = 'point';
      e.p = [g.f(10), g.f(20)];
      return e;
    }
    case 'CIRCLE': {
      const e = common(g, model);
      e.type = 'circle';
      e.c = [g.f(10), g.f(20)];
      e.r = Math.abs(g.f(40));
      setOcs(e, g);
      return e;
    }
    case 'ARC': {
      const e = common(g, model);
      e.type = 'arc';
      e.c = [g.f(10), g.f(20)];
      e.r = Math.abs(g.f(40));
      e.a0 = g.f(50) * D2R;
      e.a1 = g.f(51) * D2R;
      setOcs(e, g);
      return e;
    }
    case 'ELLIPSE': {
      const e = common(g, model);
      e.type = 'ellipse';
      const mx = g.f(11), my = g.f(21), mz = g.f(31);
      const ratio = g.f(40, 1);
      const nx = g.f(210, 0), ny = g.f(220, 0), nz = g.f(230, 1);
      // minor = ratio * (N x major)
      const cx = ny * mz - nz * my, cy = nz * mx - nx * mz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      e.c = [g.f(10), g.f(20)];
      e.major = [mx, my];
      e.minor = [(cx / nl) * ratio, (cy / nl) * ratio];
      e.t0 = g.f(41, 0);
      e.t1 = g.f(42, Math.PI * 2);
      return e;
    }
    case 'LWPOLYLINE': {
      const e = common(g, model);
      e.type = 'polyline';
      const pts = [], bul = [];
      let anyBulge = false;
      const { codes, vals } = g;
      for (let k = 0; k < codes.length; k++) {
        const c = codes[k];
        if (c === 10) { pts.push(parseFloat(vals[k]), 0); bul.push(0); }
        else if (c === 20 && pts.length) pts[pts.length - 1] = parseFloat(vals[k]);
        else if (c === 42 && bul.length) { const b = parseFloat(vals[k]); bul[bul.length - 1] = Number.isFinite(b) ? b : 0; if (b) anyBulge = true; }
      }
      e.pts = pts;
      e.bulges = anyBulge ? bul : null;
      e.closed = !!(g.i(70, 0) & 1);
      setOcs(e, g);
      if (pts.length < 4) { if (pts.length === 2) return { ...e, type: 'point', p: pts.slice(0, 2) }; return null; }
      return e;
    }
    case 'SPLINE':
    case 'HELIX':
      return splineEntity(model, g);
    case 'TEXT':
      return textEntity(ctx, g, 73);
    case 'ATTDEF': {
      if (topLevel) { const t = textEntity(ctx, g, 74); if (t) { t.raw = g.s(2, ''); t.text = decodeTextCodes(t.raw); } return t; }
      if (g.i(70, 0) & 2) return textEntity(ctx, g, 74); // constant attribute: drawn from the definition
      return null;
    }
    case 'ATTRIB': {
      // stray ATTRIB (no owning INSERT)
      return (g.i(70, 0) & 1) ? null : textEntity(ctx, g, 74);
    }
    case 'MTEXT':
      return mtextEntity(ctx, g);
    case 'SOLID':
    case 'TRACE': {
      const e = common(g, model);
      e.type = 'solid';
      const p = [g.f(10), g.f(20), g.f(11), g.f(21), g.f(13, g.f(12)), g.f(23, g.f(22)), g.f(12), g.f(22)];
      e.pts = p;
      setOcs(e, g);
      return e;
    }
    case '3DFACE': {
      const e = common(g, model);
      e.type = 'polyline';
      e.pts = [g.f(10), g.f(20), g.f(11), g.f(21), g.f(12), g.f(22), g.f(13, g.f(12)), g.f(23, g.f(22))];
      e.bulges = null;
      e.closed = true;
      return e;
    }
    case 'HATCH':
      return hatchEntity(model, g);
    case 'DIMENSION':
    case 'ARC_DIMENSION':
    case 'LARGE_RADIAL_DIMENSION':
      return dimensionEntity(ctx, g);
    case 'LEADER':
      return leaderEntity(ctx, g);
    case 'ACAD_TABLE': {
      const e = common(g, model);
      e.type = 'insert';
      e.block = g.s(2, '').trim();
      e.p = [g.f(10), g.f(20)];
      e.sx = 1; e.sy = 1; e.rot = 0; e.cols = 1; e.rows = 1; e.dc = 0; e.dr = 0; e.attribs = [];
      if (!e.block) { notShown(model, type); return null; }
      return e;
    }
    case 'VIEWPORT':
    case 'SEQEND':
    case 'ENDBLK':
      return null;
    default:
      notShown(model, type);
      return null;
  }
}

function textEntity(ctx, g, valignCode) {
  const e = common(g, ctx.model);
  const st = textStyle(ctx, g);
  e.type = 'text';
  e.h = Math.abs(g.f(40, 0)) || (st && st.h) || 1;
  e.raw = g.s(1, '');
  e.text = decodeTextCodes(e.raw);
  const sty = g.s(7, '').trim();
  if (sty) e.style = sty;
  e.rot = g.f(50, 0) * D2R;
  e.wf = g.f(41, (st && st.wf) || 1) || 1;
  e.oblique = g.has(51) ? g.f(51) * D2R : (st ? st.oblique : 0);
  const gen = g.has(71) ? g.i(71) : (st ? st.flags : 0);
  e.mirrorX = !!(gen & 2);
  e.mirrorY = !!(gen & 4);
  e.halign = g.i(72, 0);
  e.valign = g.i(valignCode, 0);
  const p1 = [g.f(10), g.f(20)];
  const p2 = g.has(11) ? [g.f(11), g.f(21)] : null;
  if ((e.halign === 3 || e.halign === 5) && p2) { e.p = p1; e.p2 = p2; }
  else if ((e.halign || e.valign) && p2) e.p = p2;
  else e.p = p1;
  setOcs(e, g);
  if (!e.text) return null;
  return e;
}

function mtextEntity(ctx, g) {
  const e = common(g, ctx.model);
  const st = textStyle(ctx, g);
  e.type = 'mtext';
  e.p = [g.f(10), g.f(20)];
  e.h = Math.abs(g.f(40, 0)) || (st && st.h) || 1;
  e.width = Math.abs(g.f(41, 0));
  e.attach = g.i(71, 1) || 1;
  e.spacing = g.f(44, 1) || 1;
  e.wf = (st && st.wf) || 1;
  if (g.has(11)) e.rot = Math.atan2(g.f(21), g.f(11));
  else e.rot = g.f(50, 0); // radians for MTEXT
  const parts = g.all(3);
  parts.push(g.s(1, ''));
  e.raw = parts.join('');
  e.text = mtextToPlain(e.raw);
  const sty = g.s(7, '').trim();
  if (sty) e.style = sty;
  if (!e.text.trim()) return null;
  return e;
}

function splineEntity(model, g) {
  const e = common(g, model);
  e.type = 'spline';
  const { codes, vals } = g;
  const ctrl = [], fit = [], knots = [], weights = [];
  for (let k = 0; k < codes.length; k++) {
    const c = codes[k];
    if (c === 10) ctrl.push(parseFloat(vals[k]), 0);
    else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1] = parseFloat(vals[k]);
    else if (c === 11) fit.push(parseFloat(vals[k]), 0);
    else if (c === 21 && fit.length) fit[fit.length - 1] = parseFloat(vals[k]);
    else if (c === 40) knots.push(parseFloat(vals[k]));
    else if (c === 41) weights.push(parseFloat(vals[k]));
  }
  const flags = g.i(70, 0);
  const degree = g.i(71, 3);
  e.closed = !!(flags & 1);
  if (ctrl.length >= 4) {
    const n = ctrl.length / 2;
    e.pts = tessBSpline(ctrl, degree, knots, (flags & 4) ? weights : null, Math.min(600, Math.max(16, n * 12)));
  } else if (fit.length >= 4) {
    e.pts = tessCatmullRom(fit, 10, e.closed);
  } else {
    notShown(model, g.type + ' (no points)');
    return null;
  }
  return e;
}

function readHatchLoops(g) {
  const { codes, vals } = g;
  const n = codes.length;
  let k = 0;
  const num = (i) => parseFloat(vals[i]);
  const int = (i) => parseInt(vals[i], 10) | 0;
  const seek = (code, limit = n) => { while (k < limit && codes[k] !== code) k++; return k < limit; };
  const loops = [];
  if (!seek(91)) return loops;
  const nPaths = int(k); k++;
  for (let p = 0; p < nPaths; p++) {
    if (!seek(92)) break;
    const flags = int(k); k++;
    const pts = [];
    if (flags & 2) { // polyline boundary
      seek(72); const hasBulge = int(k); k++;
      seek(73); const closed = int(k); k++;
      seek(93); const nv = int(k); k++;
      const v = [], b = [];
      for (let i = 0; i < nv; i++) {
        if (!seek(10)) break; const x = num(k); k++;
        if (!seek(20)) break; const y = num(k); k++;
        let bb = 0;
        if (hasBulge && codes[k] === 42) { bb = num(k); k++; }
        v.push(x, y); b.push(bb);
      }
      loops.push({ pts: v, bulges: b.some((x) => x) ? b : null, closed: true || closed });
    } else {
      seek(93); const ne = int(k); k++;
      for (let i = 0; i < ne; i++) {
        if (!seek(72)) break;
        const et = int(k); k++;
        if (et === 1) {
          seek(10); const x1 = num(k); k++; seek(20); const y1 = num(k); k++;
          seek(11); const x2 = num(k); k++; seek(21); const y2 = num(k); k++;
          if (!pts.length) pts.push(x1, y1);
          pts.push(x2, y2);
        } else if (et === 2) {
          seek(10); const cx = num(k); k++; seek(20); const cy = num(k); k++;
          seek(40); const r = num(k); k++;
          seek(50); let a0 = num(k) * D2R; k++;
          seek(51); let a1 = num(k) * D2R; k++;
          seek(73); const ccw = int(k); k++;
          if (!ccw) { a0 = -a0; a1 = -a1; }
          let sw = a1 - a0;
          if (ccw) { while (sw <= 0) sw += Math.PI * 2; } else { while (sw >= 0) sw -= Math.PI * 2; }
          const segs = Math.max(4, Math.ceil(Math.abs(sw) / (Math.PI / 24)));
          for (let s = 0; s <= segs; s++) { const a = a0 + (sw * s) / segs; pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
        } else if (et === 3) {
          seek(10); const cx = num(k); k++; seek(20); const cy = num(k); k++;
          seek(11); const mx = num(k); k++; seek(21); const my = num(k); k++;
          seek(40); const ratio = num(k); k++;
          seek(50); let a0 = num(k) * D2R; k++;
          seek(51); let a1 = num(k) * D2R; k++;
          seek(73); const ccw = int(k); k++;
          if (!ccw) { a0 = -a0; a1 = -a1; }
          let sw = a1 - a0;
          if (ccw) { while (sw <= 0) sw += Math.PI * 2; } else { while (sw >= 0) sw -= Math.PI * 2; }
          const nx = -my * ratio, ny = mx * ratio;
          const segs = Math.max(8, Math.ceil(Math.abs(sw) / (Math.PI / 24)));
          for (let s = 0; s <= segs; s++) {
            const t = a0 + (sw * s) / segs;
            pts.push(cx + mx * Math.cos(t) + nx * Math.sin(t), cy + my * Math.cos(t) + ny * Math.sin(t));
          }
        } else if (et === 4) {
          seek(94); const deg = int(k); k++;
          seek(73); const rational = int(k); k++;
          seek(95); const nk = int(k); k++;
          seek(96); const nc = int(k); k++;
          const knots = [], ctrl = [], w = [];
          for (let i2 = 0; i2 < nk; i2++) { if (!seek(40)) break; knots.push(num(k)); k++; }
          for (let i2 = 0; i2 < nc; i2++) {
            if (!seek(10)) break; const x = num(k); k++;
            if (!seek(20)) break; const y = num(k); k++;
            ctrl.push(x, y);
            if (rational && codes[k] === 42) { w.push(num(k)); k++; }
          }
          if (codes[k] === 97) { const nf = int(k); k++; for (let i2 = 0; i2 < nf; i2++) { seek(11); k++; seek(21); k++; } }
          const sp = tessBSpline(ctrl, deg, knots, rational ? w : null, Math.max(16, nc * 8));
          for (let i2 = pts.length ? 2 : 0; i2 < sp.length; i2++) pts.push(sp[i2]);
        } else break;
      }
      if (pts.length >= 6) loops.push({ pts, bulges: null, closed: true });
    }
    // source boundary objects
    if (codes[k] === 97) { const ns = int(k); k++; for (let i = 0; i < ns && codes[k] === 330; i++) k++; }
  }
  loops.tail = k; // pattern definition + seed points follow; kept verbatim for saving
  return loops;
}

function hatchEntity(model, g) {
  const e = common(g, model);
  e.type = 'hatch';
  e.solid = g.i(70, 0) === 1 || /^SOLID$/i.test(g.s(2, '').trim());
  e.pattern = g.s(2, '').trim();
  try {
    e.loops = readHatchLoops(g);
    const k = e.loops.tail;
    if (k >= 0) {
      e.tail = [];
      for (let j = k; j < g.end; j++) { if (g.codes[j] >= 1000) break; e.tail.push([g.codes[j], g.vals[j]]); }
    }
    delete e.loops.tail;
  } catch {
    e.loops = [];
  }
  setOcs(e, g);
  if (!e.loops.length) { notShown(model, 'HATCH (unreadable boundary)'); return null; }
  return e;
}

function dimensionEntity(ctx, g) {
  const e = common(g, ctx.model);
  e.type = 'dimension';
  e.block = g.s(2, '').trim();
  e.p = [0, 0];
  const P = (c) => [g.f(c), g.f(c + 10)];
  e.dim = { flags: g.i(70, 0), p10: P(10), p11: P(11), p13: P(13), p14: P(14), p15: P(15), p16: P(16), angle: g.f(50, 0), text: g.s(1, ''), measure: g.f(42, NaN), style: g.s(3, '').trim() };
  setOcs(e, g);
  // fallback geometry if the block is missing (e.g. minimal generators)
  const fb = [];
  const dimType = g.i(70, 0) & 7;
  const tx = g.f(11), ty = g.f(21);
  let measure = g.f(42, NaN);
  let angle = 0;
  if (dimType === 0 || dimType === 1) {
    const x1 = g.f(13), y1 = g.f(23), x2 = g.f(14), y2 = g.f(24), dx = g.f(10), dy = g.f(20);
    let ux, uy;
    if (dimType === 1) { const L = Math.hypot(x2 - x1, y2 - y1) || 1; ux = (x2 - x1) / L; uy = (y2 - y1) / L; }
    else { const a = g.f(50, 0) * D2R; ux = Math.cos(a); uy = Math.sin(a); }
    const proj = (x, y) => { const t = (x - dx) * ux + (y - dy) * uy; return [dx + ux * t, dy + uy * t]; };
    const p1 = proj(x1, y1), p2 = proj(x2, y2);
    fb.push({ type: 'line', a: [x1, y1], b: p1 }, { type: 'line', a: [x2, y2], b: p2 }, { type: 'line', a: p1, b: p2 });
    if (!Number.isFinite(measure)) measure = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    angle = Math.atan2(uy, ux);
    if (angle > Math.PI / 2 + 1e-9 || angle <= -Math.PI / 2 + 1e-9) angle += Math.PI;
  }
  let txt = g.s(1, '');
  const mtxt = Number.isFinite(measure) ? String(Math.round(measure * 100) / 100) : '';
  if (!txt) txt = mtxt; else txt = txt.replace('<>', mtxt);
  txt = mtextToPlain(txt);
  const h = (ctx.dimtxt || 2.5) * ctx.dimscale;
  if (txt.trim()) fb.push({ type: 'text', p: [tx, ty], h, rot: angle, text: txt, halign: 1, valign: 2, wf: 1, oblique: 0 });
  e.fallback = fb;
  return e;
}

function leaderEntity(ctx, g) {
  const e = common(g, ctx.model);
  e.type = 'polyline';
  const pts = [];
  const { codes, vals } = g;
  for (let k = 0; k < codes.length; k++) {
    if (codes[k] === 10) pts.push(parseFloat(vals[k]), 0);
    else if (codes[k] === 20 && pts.length) pts[pts.length - 1] = parseFloat(vals[k]);
  }
  if (pts.length < 4) return null;
  e.pts = pts;
  e.bulges = null;
  e.closed = false;
  const out = [e];
  if (g.i(71, 1)) {
    const size = (ctx.dimasz || 2.5) * ctx.dimscale;
    const [x0, y0, x1, y1] = pts;
    const L = Math.hypot(x1 - x0, y1 - y0);
    if (L > 0) {
      const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
      const s = Math.min(size, L / 2), w = s / 6;
      const bx = x0 + ux * s, by = y0 + uy * s;
      out.push({ ...common(g, ctx.model), type: 'solid', pts: [x0, y0, bx - uy * w, by + ux * w, bx + uy * w, by - ux * w, bx + uy * w, by - ux * w] });
    }
  }
  return out;
}

// ------------------------------------------------------------------ POLYLINE / INSERT builders
function polylineBuilder(ctx, g) {
  const { model } = ctx;
  const base = common(g, model);
  const flags = g.i(70, 0);
  const verts = [];
  const xf = (flags & (8 | 16 | 64)) ? null : ocsOf(g);
  const ext = xf ? [g.f(210, 0), g.f(220, 0), g.f(230, 1)] : undefined;
  return {
    kind: 'POLYLINE',
    vertex(v) {
      verts.push({ x: v.f(10), y: v.f(20), b: v.f(42, 0), f: v.i(70, 0), i: [v.i(71, 0), v.i(72, 0), v.i(73, 0), v.i(74, 0)] });
    },
    finish() {
      if (flags & 64) { // polyface mesh
        const pos = verts.filter((v) => v.f & 64);
        const faces = verts.filter((v) => (v.f & 128) && !(v.f & 64));
        const out = [];
        for (const f of faces) {
          const idx = f.i.filter((x) => x !== 0);
          for (let k = 0; k < idx.length; k++) {
            const a = idx[k], b = idx[(k + 1) % idx.length];
            if (a < 0) continue; // invisible edge
            const A = pos[Math.abs(a) - 1], B = pos[Math.abs(b) - 1];
            if (A && B) out.push({ ...base, type: 'line', a: [A.x, A.y], b: [B.x, B.y] });
          }
        }
        return out;
      }
      if (flags & 16) { // polygon mesh M x N
        const M = g.i(71, 0), N = g.i(72, 0);
        const out = [];
        if (M * N > verts.length || M < 1 || N < 1) return out;
        const P = (i, j) => verts[i * N + j];
        for (let i = 0; i < M; i++) {
          const pts = [];
          for (let j = 0; j < N; j++) pts.push(P(i, j).x, P(i, j).y);
          out.push({ ...base, type: 'polyline', pts, bulges: null, closed: !!(flags & 32) });
        }
        for (let j = 0; j < N; j++) {
          const pts = [];
          for (let i = 0; i < M; i++) pts.push(P(i, j).x, P(i, j).y);
          out.push({ ...base, type: 'polyline', pts, bulges: null, closed: !!(flags & 1) });
        }
        return out;
      }
      const vs = verts.filter((v) => !(v.f & 16)); // drop spline frame control points
      if (!vs.length) return [];
      const pts = [], bul = [];
      let any = false;
      for (const v of vs) { pts.push(v.x, v.y); bul.push(v.b); if (v.b) any = true; }
      if (pts.length === 2) return [{ ...base, type: 'point', p: pts }];
      const e = { ...base, type: 'polyline', pts, bulges: any && !(flags & 8) ? bul : null, closed: !!(flags & 1), xf };
      if (ext) e.ext = ext;
      return [e];
    },
  };
}

function insertBuilder(ctx, g) {
  const { model } = ctx;
  const e = common(g, model);
  e.type = 'insert';
  e.block = g.s(2, '').trim();
  e.p = [g.f(10), g.f(20)];
  e.sx = g.f(41, 1);
  e.sy = g.f(42, 1);
  if (e.sx === 0) { e.sx = 1; warn(model, 'An INSERT had zero X scale; using 1.'); }
  if (e.sy === 0) { e.sy = 1; warn(model, 'An INSERT had zero Y scale; using 1.'); }
  e.rot = g.f(50, 0) * D2R;
  e.cols = Math.max(1, Math.min(10000, g.i(70, 1) || 1));
  e.rows = Math.max(1, Math.min(10000, g.i(71, 1) || 1));
  e.dc = g.f(44, 0);
  e.dr = g.f(45, 0);
  setOcs(e, g);
  e.attribs = [];
  return {
    kind: 'INSERT',
    attrib(a) {
      const t = textEntity(ctx, a, 74);
      if (!t) return;
      t.tag = a.s(2, '').trim();
      if (a.i(70, 0) & 1) t.invisible = true; // kept for saving, never drawn
      e.attribs.push(t);
    },
    finish() { return [e]; },
  };
}
