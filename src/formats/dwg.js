// DWG reader (R13 .. 2018) built on LibreDWG, the GNU project's free DWG library (GPL-3.0-or-later),
// compiled to WebAssembly and vendored in vendor/libredwg/ (provenance: vendor/libredwg/README.md).
//
// * The WebAssembly module is fetched only when the first DWG is opened (this file is imported
//   lazily by detect.js), then cached by the service worker. DXF/DGN users never download it.
// * It runs in the parse worker like the other readers. Nothing leaves the device.
// * Mapping: each LibreDWG object is translated to the DXF group codes it stands for and read by
//   the DXF reader's own entity logic (parseDxfPairs), so a DWG behaves exactly like the same
//   drawing saved as DXF (blocks, OCS, text alignment, dimensions, hatches...). If that mapping
//   fails, LibreDWG's own DXF writer is used as a fallback.
// * Every parse gets a fresh WebAssembly instance (the compiled module is reused), so a crash
//   (trap) or a huge drawing can never poison the next file.

import { FormatError, warn, createModel } from '../model.js';
import { parseDxf, readDxf } from './dxf.js';

export const UNREADABLE = 'This DWG could not be read; save it as DXF and open that.';
const VENDOR = '../../vendor/libredwg/';
/** Revision of the vendored reader: part of its URLs (they are cached for a year) and of the
 *  service worker's reader cache name (sw.js READER_CACHE). Bump both when vendor/libredwg changes. */
export const READER_REV = '0.7.16-2';
/** Size of vendor/libredwg/libredwg-web.wasm (download progress when the server compresses it). */
export const WASM_SIZE = 9389632;
/** Largest DWG we try to open (decoding needs many times the file size in memory). */
export const MAX_DWG_BYTES = 120 * 1024 * 1024;

const VERSIONS = {
  AC1012: ['R13', false], AC1014: ['R14', false], AC1015: ['R2000', false], AC1018: ['R2004', false],
  AC1021: ['R2007', true], AC1024: ['R2010', true], AC1027: ['R2013', true], AC1032: ['R2018', true],
};
/** Version magic of a DWG file: { magic, name, unicode, known }. */
export function dwgVersion(bytes) {
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  const v = VERSIONS[magic];
  if (v) return { magic, name: v[0], unicode: v[1], known: true };
  const pre = /^AC1\.|^AC10(0\d|1[01])$/.test(magic); // R2.x .. R12
  return { magic, name: pre ? 'R12 or older' : magic.replace(/[^\x20-\x7e]/g, '?'), unicode: false, known: false, old: pre };
}

// DWGCODEPAGE index -> WHATWG encoding label (pre-2007 files store text in this code page)
const CODEPAGES = {
  2: 'iso-8859-1', 3: 'iso-8859-2', 4: 'iso-8859-3', 5: 'iso-8859-4', 6: 'iso-8859-5', 7: 'iso-8859-6', 8: 'iso-8859-7',
  9: 'iso-8859-8', 10: 'iso-8859-9', 22: 'shift_jis', 23: 'macintosh', 24: 'big5', 25: 'euc-kr', 27: 'ibm866',
  28: 'windows-1250', 29: 'windows-1251', 30: 'windows-1252', 31: 'gbk', 32: 'windows-1253', 33: 'windows-1254',
  34: 'windows-1255', 35: 'windows-1256', 36: 'windows-1257', 37: 'windows-874', 38: 'shift_jis', 39: 'gbk',
  40: 'euc-kr', 41: 'big5', 43: 'utf-16le', 44: 'windows-1258',
};
const CODEPAGE_NAMES = { 28: 'ANSI_1250', 29: 'ANSI_1251', 30: 'ANSI_1252', 32: 'ANSI_1253', 33: 'ANSI_1254', 34: 'ANSI_1255', 35: 'ANSI_1256', 36: 'ANSI_1257', 37: 'ANSI_874', 38: 'ANSI_932', 39: 'ANSI_936', 40: 'ANSI_949', 41: 'ANSI_950', 44: 'ANSI_1258' };

// LibreDWG error bits (dwg.h): below 128 the file was read; from 128 on parts are missing
const ERR_CRITICAL = 128, ERR_OUTOFMEM = 8192;

// ------------------------------------------------------------------ loading the WebAssembly module
let libPromise = null; // { factory, module: WebAssembly.Module }

async function download(onProgress) {
  const res = await fetch(new URL(`${VENDOR}libredwg-web.wasm?v=${READER_REV}`, import.meta.url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body || !res.body.getReader) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onProgress) onProgress(Math.min(1, got / WASM_SIZE));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Load (once) and compile LibreDWG. opts.wasmBytes supplies the module bytes directly (tests, Node);
 * otherwise vendor/libredwg/libredwg-web.wasm is fetched from the app's own origin.
 */
export function loadLibreDwg({ wasmBytes, onProgress } = {}) {
  if (!libPromise) {
    libPromise = (async () => {
      const [{ default: factory }, bytes] = await Promise.all([
        import(`${VENDOR}libredwg-web.js?v=${READER_REV}`),
        wasmBytes ? Promise.resolve(wasmBytes) : download(onProgress),
      ]);
      const module = await WebAssembly.compile(bytes);
      return { factory, module };
    })();
    libPromise.catch(() => { libPromise = null; }); // allow a retry (e.g. after going back online)
  }
  return libPromise;
}

async function newInstance(lib) {
  const messages = [];
  const log = (s) => { if (messages.length < 40) messages.push(String(s)); };
  let fail;
  const failed = new Promise((_, reject) => { fail = reject; });
  failed.catch(() => {}); // later aborts surface as exceptions from the call that aborted
  const M = await Promise.race([
    lib.factory({
      // the glue awaits this: resolve to the exports that receive() returns
      instantiateWasm(imports, receive) {
        const p = WebAssembly.instantiate(lib.module, imports).then((inst) => receive(inst, lib.module));
        p.catch(fail);
        return p;
      },
      print: log,
      printErr: log,
      onAbort: (what) => fail(new Error(`LibreDWG stopped: ${what}`)),
    }),
    failed,
  ]);
  return { M, messages };
}

// ------------------------------------------------------------------ main entry
/**
 * Read a DWG into the common model (format 'DWG'). Async: the WebAssembly module may need loading.
 * opts: { onProgress(f), onPhase(label, f, watch), wasmBytes,
 *         mode: 'auto' (default) | 'direct' (object mapping only) | 'dxf' (LibreDWG's DXF writer only) }
 */
export async function parseDwg(bytes, opts = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ver = dwgVersion(b);
  if (ver.old) throw new FormatError('dwg-version', `This DWG is from an old version (${ver.name}) that cannot be opened. Save it as DXF and open that.`);
  if (b.length > MAX_DWG_BYTES) throw new FormatError('dwg-too-large', 'This DWG is too large to open in the browser. Save it as DXF (or split it) and open that.');
  const phase = opts.onPhase || (() => {});
  let lib;
  try {
    lib = await loadLibreDwg({ wasmBytes: opts.wasmBytes, onProgress: (f) => phase('Loading the DWG reader for', f) });
  } catch (e) {
    throw new FormatError('dwg-reader', `The DWG reader could not be loaded (${e && e.message ? e.message : e}). Check the connection and try again, or save the drawing as DXF.`);
  }
  phase('Reading', 0, true); // one blocking call: the page watches the time
  const { M, messages } = await newInstance(lib);
  let r;
  try {
    M.FS.writeFile('/in.dwg', b);
    r = M.dwg_read_file('/in.dwg');
    M.FS.unlink('/in.dwg');
  } catch (e) {
    throw unreadable(e);
  }
  const err = (r && r.error) | 0;
  const dwg = r && r.data;
  if (err & ERR_OUTOFMEM) throw new FormatError('dwg-too-large', 'This DWG needs more memory than the browser allows. Save it as DXF (or split it) and open that.');
  let n = 0;
  try { n = dwg ? M.dwg_get_num_objects(dwg) : 0; } catch (e) { throw unreadable(e); }
  if (!dwg || !n) throw new FormatError('dwg-unreadable', UNREADABLE);

  const mode = opts.mode || 'auto';
  const progress = opts.onProgress || (() => {});
  let model = null, firstError = null;
  if (mode !== 'dxf') {
    try {
      const { codes, vals } = new DwgMapper(M, dwg, ver, n).run((f) => progress(0.1 + 0.6 * f));
      model = parseDxfPairs(codes, vals, { format: 'DWG', onProgress: (f) => progress(0.7 + 0.3 * f) });
    } catch (e) {
      if (isTrap(e) || mode === 'direct') throw unreadable(e);
      firstError = e;
    }
  }
  if (mode === 'dxf' || (mode === 'auto' && (!model || (!model.entities.length && !Object.keys(model.blocks).length)))) {
    // fallback: LibreDWG's own DXF writer (slower, but independent of the mapping above)
    try {
      M.FS.writeFile('/in.dwg', b);
      const rc = M.dwg_write_dxf('/in.dwg', '/out.dxf');
      const dxf = M.FS.readFile('/out.dxf');
      if (rc === 0 || dxf.length) {
        const viaDxf = parseDxf(dxf);
        if (model && !viaDxf.entities.length) throw new Error('no entities');
        // LibreDWG's DXF writer marks the layers of R13-R2000 files as off: use the decoded flags
        const states = new DwgMapper(M, dwg, ver, n).layerStates();
        for (const L of viaDxf.layers) {
          const st = states.get(L.name.toUpperCase());
          if (st) { L.frozen = st.frozen; L.visible = !st.off && !st.frozen; }
        }
        model = viaDxf;
        if (mode === 'auto') warn(model, 'This DWG was read through LibreDWG’s DXF conversion.');
      }
    } catch (e) {
      if (!model) throw unreadable(firstError || e);
    }
  }
  if (!model) throw unreadable(firstError);
  model.format = 'DWG';
  model.version = ver.magic;
  model.header.dwgVersion = ver.name;
  if (err >= ERR_CRITICAL) warn(model, 'Parts of this DWG could not be read (the file may be damaged or use features the DWG reader does not support); showing what was read.');
  if (err >= ERR_CRITICAL && messages.length) model.header.readerMessages = messages.slice(0, 10);
  return model;
}

/** DXF group pairs already in memory (codes: numbers, vals: strings), read like a DXF file. */
class ArrayPairReader {
  constructor(codes, vals, onProgress) {
    this.codes = codes; this.vals = vals; this.i = 0; this.code = -1; this.value = ''; this.errors = 0;
    this.onProgress = onProgress;
    this.step = Math.max(4000, (codes.length / 50) | 0);
    this.nextReport = this.step;
  }
  next() {
    if (this.i >= this.codes.length) { this.code = -1; this.value = ''; return false; }
    this.code = this.codes[this.i];
    this.value = this.vals[this.i];
    this.i++;
    if (this.onProgress && this.i >= this.nextReport) { this.nextReport += this.step; this.onProgress(this.i / this.codes.length); }
    return true;
  }
}
/** Read DXF group pairs with exactly the DXF reader's semantics (blocks, OCS, text, dimensions...). */
export function parseDxfPairs(codes, vals, { format = 'DXF', onProgress } = {}) {
  return readDxf(new ArrayPairReader(codes, vals, onProgress), createModel(format));
}

const isTrap = (e) => e instanceof WebAssembly.RuntimeError || e instanceof RangeError || /out of bounds|unreachable|memory/i.test(String(e && e.message));
function unreadable(e) {
  const tooBig = e instanceof RangeError || /memory|Cannot enlarge/i.test(String(e && e.message));
  const err = tooBig
    ? new FormatError('dwg-too-large', 'This DWG needs more memory than the browser allows. Save it as DXF (or split it) and open that.')
    : new FormatError('dwg-unreadable', UNREADABLE);
  if (e) err.cause = e; // for diagnostics; the message stays friendly
  return err;
}

// ------------------------------------------------------------------ DWG objects -> DXF groups
// Fixed object types (DWG_TYPE_* in LibreDWG's dwg.h)
const T = {
  TEXT: 1, ATTRIB: 2, ATTDEF: 3, BLOCK: 4, ENDBLK: 5, SEQEND: 6, INSERT: 7, MINSERT: 8, VERTEX_2D: 10, VERTEX_3D: 11,
  VERTEX_MESH: 12, VERTEX_PFACE: 13, VERTEX_PFACE_FACE: 14, POLYLINE_2D: 15, POLYLINE_3D: 16, ARC: 17, CIRCLE: 18,
  LINE: 19, DIM_ORDINATE: 20, DIM_LINEAR: 21, DIM_ALIGNED: 22, DIM_ANG3PT: 23, DIM_ANG2LN: 24, DIM_RADIUS: 25,
  DIM_DIAMETER: 26, POINT: 27, FACE3D: 28, POLYLINE_PFACE: 29, POLYLINE_MESH: 30, SOLID: 31, TRACE: 32, VIEWPORT: 34,
  ELLIPSE: 35, SPLINE: 36, MTEXT: 44, LEADER: 45, BLOCK_HEADER: 49, LAYER: 51, STYLE: 53, LTYPE: 57, DIMSTYLE: 69,
  LWPOLYLINE: 77, HATCH: 78,
};
const SUB = new Set([T.ATTRIB, T.BLOCK, T.ENDBLK, T.SEQEND, T.VERTEX_2D, T.VERTEX_3D, T.VERTEX_MESH, T.VERTEX_PFACE, T.VERTEX_PFACE_FACE]);
const DIM_TYPE = { [T.DIM_LINEAR]: 0, [T.DIM_ALIGNED]: 1, [T.DIM_ANG2LN]: 2, [T.DIM_DIAMETER]: 3, [T.DIM_RADIUS]: 4, [T.DIM_ANG3PT]: 5, [T.DIM_ORDINATE]: 6 };
const DEG = 180 / Math.PI;
const num = (x) => (typeof x === 'bigint' ? Number(x) : Number(x) || 0);

/**
 * LibreDWG colour { index, rgb, method } -> DXF groups [[62, aci], [420, rgb]]. R13-R2000 store
 * an index (0 BYBLOCK .. 256 BYLAYER); R2004+ a method byte (0xc0 BYLAYER, 0xc1 BYBLOCK,
 * 0xc2 true colour, 0xc3 index in the low byte, 0xc8 none), also found in the top byte of rgb.
 */
export function dwgColorGroups(c) {
  if (!c) return [];
  const rgb = num(c.rgb), idx = num(c.index);
  const method = num(c.method) || (rgb >>> 24);
  if (method === 0xc2) return idx >= 1 && idx <= 255 ? [[62, idx], [420, rgb & 0xffffff]] : [[420, rgb & 0xffffff]];
  if (method === 0xc3) return [[62, rgb & 0xff]];
  if (method === 0xc1) return [[62, 0]];
  if (method === 0xc0 || method === 0xc8) return [];
  return idx >= 0 && idx < 256 ? [[62, idx]] : [];
}
const arr = (x) => (Array.isArray(x) ? x : x && Array.isArray(x.data) ? x.data : []);

class DwgMapper {
  constructor(M, dwg, ver, n) {
    this.M = M; this.dwg = dwg; this.n = n; this.ver = ver;
    let cp = 30;
    try { cp = M.dwg_get_codepage(dwg); } catch { /* default */ }
    this.codepage = cp;
    this.decoder = null;
    if (!ver.unicode) { try { this.decoder = new TextDecoder(CODEPAGES[cp] || 'windows-1252'); } catch { this.decoder = new TextDecoder('windows-1252'); } }
    this.codes = []; this.vals = [];
    this.names = { layer: new Map(), ltype: new Map(), style: new Map(), block: new Map(), dimstyle: new Map() };
    this.byOwner = new Map(); // owner handle -> entity objects (fallback when the block's links are broken)
    this.loose = { 1: [], 2: [] }; // paper / model space entities by their entity mode (same purpose)
    this.emitted = new Set();
  }

  // -------------------------------------------------------------- low-level helpers
  p(code, v) { this.codes.push(code); this.vals.push(typeof v === 'string' ? v : String(v)); }
  val(tio, f) {
    const r = this.M.dwg_dynapi_entity_value(tio, f);
    return r && r.success ? r.data : undefined;
  }
  n0(tio, f, def = 0) { const v = this.val(tio, f); return typeof v === 'number' || typeof v === 'bigint' ? num(v) : def; }
  str(tio, f) {
    const r = this.M.dwg_dynapi_entity_value(tio, f);
    if (!r || !r.success) return '';
    let s;
    if (this.decoder && r.bin && typeof r.bin === 'object') s = this.decoder.decode(Uint8Array.from(r.bin.length !== undefined ? r.bin : Object.values(r.bin)));
    else s = r.data == null ? '' : String(r.data);
    const z = s.indexOf('\0'); // text stored with its terminating NUL
    return z < 0 ? s : s.slice(0, z);
  }
  pt(tio, f) { const v = this.val(tio, f); return v && typeof v === 'object' ? [num(v.x), num(v.y), num(v.z)] : [0, 0, 0]; }
  ref(tio, f) {
    const p = this.val(tio, f);
    if (!p) return 0;
    try { return num(this.M.dwg_ref_get_absref(p)); } catch { return 0; }
  }
  handleOf(o) { try { return num(this.M.dwg_object_get_handle_object(o).value); } catch { return 0; } }
  hv(name) { try { const r = this.M.dwg_dynapi_header_value(this.dwg, name); return r && r.success ? r.data : undefined; } catch { return undefined; } }
  xyz(c, p) { this.p(c, p[0]); this.p(c + 10, p[1]); this.p(c + 20, p[2] || 0); }
  ext(tio) {
    const e = this.val(tio, 'extrusion');
    if (e && typeof e === 'object' && !(num(e.x) === 0 && num(e.y) === 0 && (num(e.z) === 1 || e.z === undefined))) { this.p(210, num(e.x)); this.p(220, num(e.y)); this.p(230, num(e.z)); }
  }

  // -------------------------------------------------------------- driver
  run(onProgress) {
    const { M, dwg, n } = this;
    const ms = M.dwg_model_space_object(dwg), ps = M.dwg_paper_space_object(dwg);
    const layers = [], ltypes = [], styles = [], headers = [];
    for (let i = 0; i < n; i++) {
      const o = M.dwg_get_object(dwg, i);
      if (!o) continue;
      let t;
      try { t = M.dwg_object_get_fixedtype(o); } catch { continue; }
      if (t === T.LAYER || t === T.LTYPE || t === T.STYLE || t === T.BLOCK_HEADER || t === T.DIMSTYLE) {
        const tio = M.dwg_object_to_object_tio(o);
        if (!tio) continue;
        const h = this.handleOf(o);
        const name = this.str(tio, 'name');
        if (t === T.LAYER) { this.names.layer.set(h, name || '0'); layers.push(tio); }
        else if (t === T.LTYPE) { this.names.ltype.set(h, name); ltypes.push(tio); }
        else if (t === T.STYLE) { this.names.style.set(h, name); styles.push(tio); }
        else if (t === T.DIMSTYLE) this.names.dimstyle.set(h, name);
        else { this.names.block.set(h, this.blockName(tio, name)); headers.push({ o, tio, h }); }
      } else if (M.dwg_object_get_supertype(o) === 0 && !SUB.has(t)) {
        try {
          const owner = num(M.dwg_object_entity_get_ownerhandle_object(M.dwg_object_to_entity(o)).absolute_ref);
          if (owner) { if (!this.byOwner.has(owner)) this.byOwner.set(owner, []); this.byOwner.get(owner).push(o); }
          else {
            const em = M.dwg_dynapi_common_value(M.dwg_object_to_entity_tio(o), 'entmode');
            if (em && em.success && this.loose[em.data]) this.loose[em.data].push(o);
          }
        } catch { /* no owner */ }
      }
    }
    this.header();
    this.p(0, 'SECTION'); this.p(2, 'TABLES');
    this.table('LTYPE', ltypes, (tio) => this.ltype(tio));
    this.table('LAYER', layers, (tio) => this.layer(tio));
    this.table('STYLE', styles, (tio) => this.style(tio));
    this.p(0, 'ENDSEC');

    const total = Math.max(1, n);
    let done = 0;
    const tick = () => { if (++done % 500 === 0) onProgress(Math.min(1, done / total)); };
    this.p(0, 'SECTION'); this.p(2, 'BLOCKS');
    for (const { o, tio, h } of headers) {
      if (o === ms || o === ps) continue;
      const base = this.pt(tio, 'base_pt');
      this.p(0, 'BLOCK'); this.p(8, '0'); this.p(2, this.names.block.get(h)); this.p(70, this.n0(tio, 'flag'));
      this.xyz(10, base);
      for (const e of this.owned(o, h)) { this.entity(e, false); tick(); }
      this.p(0, 'ENDBLK'); this.p(8, '0');
    }
    this.p(0, 'ENDSEC');
    this.p(0, 'SECTION'); this.p(2, 'ENTITIES');
    for (const [space, paper] of [[ms, false], [ps, true]]) {
      if (!space) continue;
      for (const e of this.owned(space, this.handleOf(space))) { this.entity(e, paper); tick(); }
    }
    // model/paper space entities that the block links did not reach (damaged files)
    for (const [mode, paper] of [[2, false], [1, true]]) for (const e of this.loose[mode]) if (!this.emitted.has(e)) this.entity(e, paper);
    this.p(0, 'ENDSEC');
    this.p(0, 'EOF');
    onProgress(1);
    return { codes: this.codes, vals: this.vals };
  }

  /** Decoded layer states: NAME -> { off, frozen }. */
  layerStates() {
    const out = new Map();
    for (let i = 0; i < this.n; i++) {
      try {
        const o = this.M.dwg_get_object(this.dwg, i);
        if (!o || this.M.dwg_object_get_fixedtype(o) !== T.LAYER) continue;
        const tio = this.M.dwg_object_to_object_tio(o);
        const name = (this.str(tio, 'name') || '0').toUpperCase();
        const c = this.val(tio, 'color');
        let ci = c ? num(c.index) : 7;
        if (ci > 32767) ci -= 65536;
        out.set(name, { off: !!(this.n0(tio, 'off') || ci < 0), frozen: !!(this.n0(tio, 'frozen') || (this.n0(tio, 'flag') & 1)) });
      } catch { /* skip */ }
    }
    return out;
  }

  /** Full block name (anonymous blocks keep their number only on the BLOCK entity). */
  blockName(tio, name) {
    try {
      const p = this.val(tio, 'block_entity');
      const bo = p && this.M.dwg_ref_get_object(p);
      const bt = bo && this.M.dwg_object_to_entity_tio(bo);
      const full = bt && this.str(bt, 'name');
      if (full && (!name || full.length >= name.length)) return full;
    } catch { /* keep the header name */ }
    return name;
  }

  /** Entities of a block in stored order; falls back to owner handles when the links are broken. */
  owned(hdr, h) {
    const { M } = this;
    const out = [], seen = new Set();
    try {
      let e = M.get_first_owned_entity(hdr);
      while (e && !seen.has(e) && out.length < this.n) {
        seen.add(e);
        out.push(e);
        e = M.get_next_owned_entity(hdr, e);
      }
    } catch { /* use the fallback */ }
    const extra = this.byOwner.get(h);
    if (extra) for (const e of extra) if (!seen.has(e)) { seen.add(e); out.push(e); }
    return out.filter((e) => { try { return !SUB.has(M.dwg_object_get_fixedtype(e)); } catch { return false; } });
  }

  // -------------------------------------------------------------- header + tables
  header() {
    const P = (name, code, v) => { if (v !== undefined && v !== null && v === v) { this.p(9, name); this.p(code, v); } };
    const P3 = (name, v) => { if (v && typeof v === 'object') { this.p(9, name); this.p(10, num(v.x)); this.p(20, num(v.y)); this.p(30, num(v.z)); } };
    this.p(0, 'SECTION'); this.p(2, 'HEADER');
    P('$ACADVER', 1, this.ver.magic);
    if (CODEPAGE_NAMES[this.codepage]) P('$DWGCODEPAGE', 3, CODEPAGE_NAMES[this.codepage]);
    const iu = this.hv('INSUNITS');
    if (typeof iu === 'number') P('$INSUNITS', 70, iu);
    const emin = this.hv('EXTMIN'), emax = this.hv('EXTMAX');
    if (emin && emax && Math.abs(num(emin.x)) < 1e19 && num(emax.x) >= num(emin.x)) { P3('$EXTMIN', emin); P3('$EXTMAX', emax); }
    for (const v of ['LTSCALE', 'DIMSCALE', 'DIMASZ', 'DIMTXT']) { const x = this.hv(v); if (typeof x === 'number' && Number.isFinite(x)) P('$' + v, 40, x); }
    this.p(0, 'ENDSEC');
  }
  table(name, list, fn) {
    this.p(0, 'TABLE'); this.p(2, name); this.p(70, list.length);
    for (const tio of list) { try { fn(tio); } catch { /* skip a broken table entry */ } }
    this.p(0, 'ENDTAB');
  }
  ltype(tio) {
    const name = this.str(tio, 'name');
    if (!name) return;
    const nd = this.n0(tio, 'numdashes');
    let dashes = [];
    if (nd > 0) { try { dashes = arr(this.M.dwg_ptr_to_ltype_dash_array(this.val(tio, 'dashes'), nd)); } catch { dashes = []; } }
    this.p(0, 'LTYPE'); this.p(2, name); this.p(70, 0); this.p(3, this.str(tio, 'description')); this.p(72, 65);
    this.p(73, dashes.length); this.p(40, this.n0(tio, 'pattern_len'));
    for (const d of dashes) { this.p(49, num(d.length)); this.p(74, 0); }
  }
  layer(tio) {
    const name = this.str(tio, 'name') || '0';
    const col = this.val(tio, 'color');
    const groups = dwgColorGroups(col);
    const g62 = groups.find((g) => g[0] === 62), g420 = groups.find((g) => g[0] === 420);
    let aci = g62 ? Math.abs(g62[1]) : 7;
    if (!(aci >= 1 && aci <= 255)) aci = 7;
    let ci = col ? num(col.index) : 7;
    if (ci > 32767) ci -= 65536; // a negative index (stored as 16 bits) means "layer off"
    if (ci < 0) aci = Math.min(255, -ci) || 7;
    const off = this.n0(tio, 'off') || (this.n0(tio, 'on', 1) === 0 ? 1 : 0) || (ci < 0 ? 1 : 0);
    const frozen = this.n0(tio, 'frozen') || (this.n0(tio, 'flag') & 1);
    const locked = this.n0(tio, 'locked');
    this.p(0, 'LAYER'); this.p(2, name); this.p(70, (frozen ? 1 : 0) | (locked ? 4 : 0));
    this.p(62, off ? -aci : aci);
    if (g420) this.p(420, g420[1]);
    const lt = this.names.ltype.get(this.ref(tio, 'ltype'));
    this.p(6, lt || 'Continuous');
  }
  style(tio) {
    const name = this.str(tio, 'name');
    if (!name) return;
    this.p(0, 'STYLE'); this.p(2, name); this.p(70, this.n0(tio, 'flag'));
    this.p(40, this.n0(tio, 'text_size')); this.p(41, this.n0(tio, 'width_factor', 1) || 1);
    this.p(50, this.n0(tio, 'oblique_angle') * DEG); this.p(71, this.n0(tio, 'generation'));
    this.p(42, this.n0(tio, 'last_height')); this.p(3, this.str(tio, 'font_file')); this.p(4, this.str(tio, 'bigfont_file'));
  }

  // -------------------------------------------------------------- entities
  common(o, type, paper) {
    const { M } = this;
    const ent = M.dwg_object_to_entity(o);
    this.p(0, type);
    let layer = '0';
    try { layer = this.names.layer.get(num(M.dwg_object_entity_get_layer_object_ref(ent).absolute_ref)) || '0'; } catch { /* layer 0 */ }
    this.p(8, layer);
    try { for (const [c, v] of dwgColorGroups(M.dwg_object_entity_get_color_object(ent))) this.p(c, v); } catch { /* by layer */ }
    try {
      const lf = M.dwg_object_entity_get_ltype_flags(ent);
      if (lf === 1) this.p(6, 'BYBLOCK');
      else if (lf === 2) this.p(6, 'CONTINUOUS');
      else if (lf === 3) { const n = this.names.ltype.get(num(M.dwg_object_entity_get_ltype_object_ref(ent).absolute_ref)); if (n) this.p(6, n); }
    } catch { /* by layer */ }
    try { if (M.dwg_object_entity_get_invisible(ent)) this.p(60, 1); } catch { /* visible */ }
    try { const s = M.dwg_object_entity_get_ltype_scale(ent); if (s > 0 && s !== 1) this.p(48, s); } catch { /* 1 */ }
    if (paper) this.p(67, 1);
  }

  entity(o, paper) {
    if (this.emitted.has(o)) return; // never twice (e.g. a block reached twice through broken links)
    this.emitted.add(o);
    let t, tio;
    try { t = this.M.dwg_object_get_fixedtype(o); tio = this.M.dwg_object_to_entity_tio(o); } catch { return; }
    if (!tio) return;
    const mark = this.codes.length;
    try {
      this.emit(o, t, tio, paper);
    } catch (e) {
      if (isTrap(e)) throw e;
      // a broken entity: drop what was written for it and report it as not shown
      this.codes.length = mark; this.vals.length = mark;
      let name = 'DWG object';
      try { name = this.M.dwg_object_get_dxfname(o) || name; } catch { /* generic */ }
      this.p(0, `${name} (unreadable)`); this.p(8, '0');
    }
  }

  emit(o, t, tio, paper) {
    const P = (c, v) => this.p(c, v);
    switch (t) {
      case T.LINE:
        this.common(o, 'LINE', paper);
        this.xyz(10, this.pt(tio, 'start')); this.xyz(11, this.pt(tio, 'end'));
        P(39, this.n0(tio, 'thickness')); this.ext(tio);
        return;
      case T.POINT:
        this.common(o, 'POINT', paper);
        this.xyz(10, [this.n0(tio, 'x'), this.n0(tio, 'y'), this.n0(tio, 'z')]); this.ext(tio);
        return;
      case T.CIRCLE:
        this.common(o, 'CIRCLE', paper);
        this.xyz(10, this.pt(tio, 'center')); P(40, this.n0(tio, 'radius')); this.ext(tio);
        return;
      case T.ARC:
        this.common(o, 'ARC', paper);
        this.xyz(10, this.pt(tio, 'center')); P(40, this.n0(tio, 'radius'));
        P(50, this.n0(tio, 'start_angle') * DEG); P(51, this.n0(tio, 'end_angle') * DEG); this.ext(tio);
        return;
      case T.ELLIPSE:
        this.common(o, 'ELLIPSE', paper);
        this.xyz(10, this.pt(tio, 'center')); this.xyz(11, this.pt(tio, 'sm_axis'));
        P(40, this.n0(tio, 'axis_ratio', 1)); P(41, this.n0(tio, 'start_angle')); P(42, this.n0(tio, 'end_angle', Math.PI * 2)); this.ext(tio);
        return;
      case T.LWPOLYLINE: return this.lwpolyline(o, tio, paper);
      case T.POLYLINE_2D: case T.POLYLINE_3D: case T.POLYLINE_PFACE: case T.POLYLINE_MESH: return this.polyline(o, t, tio, paper);
      case T.SPLINE: return this.spline(o, tio, paper);
      case T.TEXT: this.common(o, 'TEXT', paper); this.text(tio, 73); return;
      case T.ATTDEF: this.common(o, 'ATTDEF', paper); this.text(tio, 74, 'default_value'); P(2, this.str(tio, 'tag')); P(3, this.str(tio, 'prompt')); P(70, this.n0(tio, 'flags')); return;
      case T.MTEXT: return this.mtext(o, tio, paper);
      case T.INSERT: case T.MINSERT: return this.insert(o, t, tio, paper);
      case T.SOLID: case T.TRACE: {
        this.common(o, t === T.SOLID ? 'SOLID' : 'TRACE', paper);
        const z = this.n0(tio, 'elevation');
        for (let k = 0; k < 4; k++) { const c = this.pt(tio, `corner${k + 1}`); P(10 + k, c[0]); P(20 + k, c[1]); P(30 + k, z); }
        P(39, this.n0(tio, 'thickness')); this.ext(tio);
        return;
      }
      case T.FACE3D: {
        this.common(o, '3DFACE', paper);
        for (let k = 0; k < 4; k++) this.xyz(10 + k, this.pt(tio, `corner${k + 1}`));
        P(70, this.n0(tio, 'invis_flags'));
        return;
      }
      case T.HATCH: return this.hatch(o, tio, paper);
      case T.LEADER: return this.leader(o, tio, paper);
      case T.VIEWPORT: return; // layout viewports are not drawn (as in the DXF reader)
      default:
        if (t in DIM_TYPE) return this.dimension(o, t, tio, paper);
        return this.other(o, tio, paper);
    }
  }

  /** Anything else: tables become their block; the rest is reported as "not shown" by the DXF logic. */
  other(o, tio, paper) {
    let name = 'UNKNOWN';
    try { name = this.M.dwg_object_get_dxfname(o) || name; } catch { /* generic */ }
    if (name === 'ACAD_TABLE') {
      const blk = this.names.block.get(this.ref(tio, 'block_header'));
      if (blk) {
        this.common(o, 'INSERT', paper);
        this.p(2, blk); this.xyz(10, this.pt(tio, 'ins_pt'));
        const s = this.pt(tio, 'scale');
        if (s[0] || s[1]) { this.p(41, s[0] || 1); this.p(42, s[1] || 1); this.p(43, s[2] || 1); }
        this.p(50, this.n0(tio, 'rotation') * DEG); this.ext(tio);
        return;
      }
    }
    this.common(o, name, paper);
  }

  text(tio, valignCode, valueField = 'text_value') {
    const P = (c, v) => this.p(c, v);
    const ins = this.pt(tio, 'ins_pt'), al = this.pt(tio, 'alignment_pt'), z = this.n0(tio, 'elevation');
    P(10, ins[0]); P(20, ins[1]); P(30, z);
    P(40, this.n0(tio, 'height', 1));
    P(1, this.str(tio, valueField));
    P(50, this.n0(tio, 'rotation') * DEG);
    P(41, this.n0(tio, 'width_factor', 1) || 1);
    P(51, this.n0(tio, 'oblique_angle') * DEG);
    const st = this.names.style.get(this.ref(tio, 'style'));
    if (st) P(7, st);
    P(71, this.n0(tio, 'generation'));
    P(72, this.n0(tio, 'horiz_alignment'));
    P(11, al[0]); P(21, al[1]); P(31, z);
    P(39, this.n0(tio, 'thickness'));
    this.ext(tio);
    P(valignCode, this.n0(tio, 'vert_alignment'));
  }

  mtext(o, tio, paper) {
    const P = (c, v) => this.p(c, v);
    this.common(o, 'MTEXT', paper);
    this.xyz(10, this.pt(tio, 'ins_pt'));
    P(40, this.n0(tio, 'text_height', 1));
    P(41, this.n0(tio, 'rect_width'));
    P(71, this.n0(tio, 'attachment', 1) || 1);
    P(72, this.n0(tio, 'flow_dir', 1) || 1);
    P(1, this.str(tio, 'text'));
    const st = this.names.style.get(this.ref(tio, 'style'));
    if (st) P(7, st);
    this.xyz(11, this.pt(tio, 'x_axis_dir'));
    P(44, this.n0(tio, 'linespace_factor', 1) || 1);
    P(73, this.n0(tio, 'linespace_style', 1) || 1);
    this.ext(tio);
  }

  insert(o, t, tio, paper) {
    const { M } = this;
    const P = (c, v) => this.p(c, v);
    let attribs = [];
    try { attribs = arr(M.dwg_entity_insert_get_attribs(tio)); } catch { attribs = []; }
    this.common(o, 'INSERT', paper);
    if (attribs.length) P(66, 1);
    P(2, this.names.block.get(this.ref(tio, 'block_header')) || '');
    this.xyz(10, this.pt(tio, 'ins_pt'));
    const s = this.pt(tio, 'scale');
    P(41, s[0]); P(42, s[1]); P(43, s[2]);
    P(50, this.n0(tio, 'rotation') * DEG);
    if (t === T.MINSERT) { P(70, this.n0(tio, 'num_cols', 1)); P(71, this.n0(tio, 'num_rows', 1)); P(44, this.n0(tio, 'col_spacing')); P(45, this.n0(tio, 'row_spacing')); }
    this.ext(tio);
    if (!attribs.length) return;
    for (const a of attribs) {
      const at = M.dwg_object_to_entity_tio(a);
      if (!at) continue;
      this.common(a, 'ATTRIB', paper);
      this.text(at, 74);
      P(2, this.str(at, 'tag'));
      P(70, this.n0(at, 'flags'));
    }
    this.p(0, 'SEQEND'); this.p(8, '0');
  }

  lwpolyline(o, tio, paper) {
    const { M } = this;
    const P = (c, v) => this.p(c, v);
    const flag = this.n0(tio, 'flag');
    const np = this.n0(tio, 'num_points'), nb = this.n0(tio, 'num_bulges');
    const pts = np ? arr(M.dwg_ptr_to_point2d_array(this.val(tio, 'points'), np)) : [];
    const bul = nb ? arr(M.dwg_ptr_to_double_array(this.val(tio, 'bulges'), nb)) : [];
    this.common(o, 'LWPOLYLINE', paper);
    P(90, pts.length);
    P(70, (flag & 512 ? 1 : 0) | (flag & 256 ? 128 : 0));
    if (flag & 4) P(43, this.n0(tio, 'const_width'));
    if (flag & 8) P(38, this.n0(tio, 'elevation'));
    if (flag & 2) P(39, this.n0(tio, 'thickness'));
    pts.forEach((q, k) => { P(10, num(q.x)); P(20, num(q.y)); const b = num(bul[k]); if (b) P(42, b); });
    this.ext(tio);
  }

  polyline(o, t, tio, paper) {
    const { M } = this;
    const P = (c, v) => this.p(c, v);
    let flag = this.n0(tio, 'flag');
    if (t === T.POLYLINE_3D) flag |= 8;
    else if (t === T.POLYLINE_PFACE) flag |= 64;
    else if (t === T.POLYLINE_MESH) flag |= 16;
    // walk the owned VERTEX sub-entities (LibreDWG's vertex-list helper misses the last vertex of
    // R13-R2000 polylines)
    const verts = [];
    const seen = new Set();
    let v = M.get_first_owned_subentity(o);
    while (v && !seen.has(v) && seen.size < this.n) {
      seen.add(v);
      const vt = M.dwg_object_get_fixedtype(v), vtio = M.dwg_object_to_entity_tio(v);
      if (vt === T.VERTEX_2D) verts.push({ p: this.pt(vtio, 'point'), b: this.n0(vtio, 'bulge'), f: this.n0(vtio, 'flag') });
      else if (vt === T.VERTEX_3D) verts.push({ p: this.pt(vtio, 'point'), b: 0, f: this.n0(vtio, 'flag') | 32 });
      else if (vt === T.VERTEX_PFACE_FACE) {
        // vertind is a fixed array of 4 signed shorts that the value API does not convert: read it in place
        const off = M.dwg_dynapi_entity_field_offset(vtio, 'vertind');
        const ind = off >= 0 ? arr(M.dwg_ptr_to_int16_t_array(vtio + off, 4)).map(num) : [];
        verts.push({ p: [0, 0, 0], b: 0, f: 128, i: ind });
      } else if (vt === T.VERTEX_PFACE || vt === T.VERTEX_MESH) verts.push({ p: this.pt(vtio, 'point'), b: 0, f: vt === T.VERTEX_PFACE ? 192 : 64 });
      v = M.get_next_owned_subentity(o, v);
    }
    if (!verts.length && (t === T.POLYLINE_2D || t === T.POLYLINE_3D)) {
      const list = t === T.POLYLINE_2D ? M.dwg_entity_polyline_2d_get_vertices(o) : M.dwg_entity_polyline_3d_get_vertices(o);
      for (const x of arr(list)) verts.push({ p: [num(x.point && x.point.x), num(x.point && x.point.y), num(x.point && x.point.z)], b: num(x.bulge), f: num(x.flag) | (t === T.POLYLINE_3D ? 32 : 0) });
    }
    this.common(o, 'POLYLINE', paper);
    P(66, 1);
    P(10, 0); P(20, 0); P(30, t === T.POLYLINE_2D ? this.n0(tio, 'elevation') : 0);
    P(70, flag);
    if (t === T.POLYLINE_MESH) { P(71, this.n0(tio, 'num_m_verts')); P(72, this.n0(tio, 'num_n_verts')); }
    if (t === T.POLYLINE_PFACE) { P(71, this.n0(tio, 'numverts')); P(72, this.n0(tio, 'numfaces')); }
    this.ext(tio);
    const layer = this.vals[this.codes.lastIndexOf(8)];
    for (const v of verts) {
      P(0, 'VERTEX'); P(8, layer);
      this.xyz(10, v.p);
      if (v.b) P(42, v.b);
      P(70, v.f);
      if (v.i) v.i.forEach((x, k) => P(71 + k, x));
    }
    P(0, 'SEQEND'); P(8, layer);
  }

  spline(o, tio, paper) {
    const { M } = this;
    const P = (c, v) => this.p(c, v);
    const nk = this.n0(tio, 'num_knots'), nc = this.n0(tio, 'num_ctrl_pts'), nf = this.n0(tio, 'num_fit_pts');
    const knots = nk ? arr(M.dwg_ptr_to_double_array(this.val(tio, 'knots'), nk)).map(num) : [];
    const ctrl = nc ? arr(M.dwg_ptr_to_point4d_array(this.val(tio, 'ctrl_pts'), nc)) : [];
    const fit = nf ? arr(M.dwg_ptr_to_point3d_array(this.val(tio, 'fit_pts'), nf)) : [];
    const weighted = this.n0(tio, 'weighted') || this.n0(tio, 'rational');
    this.common(o, 'SPLINE', paper);
    P(70, (this.n0(tio, 'closed_b') ? 1 : 0) | (this.n0(tio, 'periodic') ? 2 : 0) | (weighted ? 4 : 0) | 8);
    P(71, this.n0(tio, 'degree', 3));
    P(72, knots.length); P(73, ctrl.length); P(74, fit.length);
    for (const k of knots) P(40, k);
    for (const c of ctrl) { this.xyz(10, [num(c.x), num(c.y), num(c.z)]); if (weighted) P(41, c.w === undefined ? 1 : num(c.w)); }
    for (const f of fit) this.xyz(11, [num(f.x), num(f.y), num(f.z)]);
  }

  hatch(o, tio, paper) {
    const { M } = this;
    const P = (c, v) => this.p(c, v);
    const np = this.n0(tio, 'num_paths');
    const paths = np ? arr(M.dwg_ptr_to_hatch_path_array(this.val(tio, 'paths'), np)) : [];
    const solid = this.n0(tio, 'is_solid_fill');
    this.common(o, 'HATCH', paper);
    P(10, 0); P(20, 0); P(30, this.n0(tio, 'elevation'));
    this.ext(tio);
    P(2, this.str(tio, 'name') || (solid ? 'SOLID' : 'USER'));
    P(70, solid ? 1 : 0);
    P(71, this.n0(tio, 'is_associative'));
    P(91, paths.length);
    for (const path of paths) {
      const flag = num(path.flag);
      P(92, flag);
      if (flag & 2) {
        const pts = arr(path.polyline_paths);
        const bulges = !!num(path.bulges_present);
        P(72, bulges ? 1 : 0); P(73, num(path.closed) ? 1 : 0); P(93, pts.length);
        for (const v of pts) { P(10, num(v.point && v.point.x)); P(20, num(v.point && v.point.y)); if (bulges) P(42, num(v.bulge)); }
      } else {
        const segs = arr(path.segs);
        P(93, segs.length);
        for (const s of segs) {
          const ct = num(s.curve_type);
          P(72, ct);
          const xy = (c, q) => { P(c, num(q && q.x)); P(c + 10, num(q && q.y)); };
          if (ct === 1) { xy(10, s.first_endpoint); xy(11, s.second_endpoint); }
          else if (ct === 2) { xy(10, s.center); P(40, num(s.radius)); P(50, num(s.start_angle) * DEG); P(51, num(s.end_angle) * DEG); P(73, num(s.is_ccw) ? 1 : 0); }
          else if (ct === 3) { xy(10, s.center); xy(11, s.endpoint); P(40, num(s.minor_major_ratio)); P(50, num(s.start_angle) * DEG); P(51, num(s.end_angle) * DEG); P(73, num(s.is_ccw) ? 1 : 0); }
          else if (ct === 4) {
            const kn = arr(s.knots), cp = arr(s.control_points);
            const rational = !!num(s.is_rational);
            P(94, num(s.degree)); P(73, rational ? 1 : 0); P(74, num(s.is_periodic) ? 1 : 0); P(95, kn.length); P(96, cp.length);
            for (const k of kn) P(40, num(k));
            for (const c of cp) { xy(10, c.point || c); if (rational) P(42, c.w === undefined ? 1 : num(c.w)); }
          }
        }
      }
      P(97, 0);
    }
    P(75, this.n0(tio, 'style'));
    P(76, this.n0(tio, 'pattern_type', 1));
    if (!solid) {
      P(52, this.n0(tio, 'angle') * DEG);
      P(41, this.n0(tio, 'scale_spacing', 1) || 1);
      P(77, this.n0(tio, 'double_flag'));
      const nd = this.n0(tio, 'num_deflines');
      const lines = nd ? arr(M.dwg_ptr_to_hatch_defline_array(this.val(tio, 'deflines'), nd)) : [];
      P(78, lines.length);
      for (const l of lines) {
        const dashes = arr(l.dashes);
        P(53, num(l.angle) * DEG); P(43, num(l.pt0 && l.pt0.x)); P(44, num(l.pt0 && l.pt0.y)); P(45, num(l.offset && l.offset.x)); P(46, num(l.offset && l.offset.y));
        P(79, dashes.length);
        for (const d of dashes) P(49, num(d));
      }
    }
    const ns = this.n0(tio, 'num_seeds');
    const seeds = ns ? arr(M.dwg_ptr_to_point2d_array(this.val(tio, 'seeds'), ns)) : [];
    P(98, seeds.length);
    for (const s of seeds) { P(10, num(s.x)); P(20, num(s.y)); }
  }

  dimension(o, t, tio, paper) {
    const P = (c, v) => this.p(c, v);
    this.common(o, 'DIMENSION', paper);
    P(2, this.names.block.get(this.ref(tio, 'block')) || '');
    const ds = this.names.dimstyle.get(this.ref(tio, 'dimstyle'));
    if (ds) P(3, ds);
    const z = this.n0(tio, 'elevation');
    const has = (f) => { const v = this.val(tio, f); return v && typeof v === 'object'; };
    if (has('def_pt')) this.xyz(10, this.pt(tio, 'def_pt'));
    const mid = this.pt(tio, 'text_midpt');
    P(11, mid[0]); P(21, mid[1]); P(31, z);
    const clone = this.pt(tio, 'clone_ins_pt');
    P(12, clone[0]); P(22, clone[1]); P(32, 0);
    const flag1 = this.n0(tio, 'flag1');
    let f70 = DIM_TYPE[t] | 32;
    if (!(flag1 & 1)) f70 |= 128;
    if (t === T.DIM_ORDINATE && (this.n0(tio, 'flag2') & 1)) f70 |= 64;
    P(70, f70);
    P(1, this.str(tio, 'user_text'));
    P(53, this.n0(tio, 'text_rotation') * DEG);
    P(51, this.n0(tio, 'horiz_dir') * DEG);
    P(71, this.n0(tio, 'attachment', 5) || 5);
    const am = this.n0(tio, 'act_measurement');
    if (am) P(42, am);
    const pts = {
      [T.DIM_LINEAR]: [[13, 'xline1_pt'], [14, 'xline2_pt']], [T.DIM_ALIGNED]: [[13, 'xline1_pt'], [14, 'xline2_pt']],
      [T.DIM_ANG3PT]: [[13, 'xline1_pt'], [14, 'xline2_pt'], [15, 'center_pt']],
      [T.DIM_ANG2LN]: [[13, 'xline1start_pt'], [14, 'xline1end_pt'], [15, 'xline2start_pt'], [16, 'first_arc_pt']],
      [T.DIM_RADIUS]: [[15, 'first_arc_pt']], [T.DIM_DIAMETER]: [[15, 'first_arc_pt']],
      [T.DIM_ORDINATE]: [[13, 'feature_location_pt'], [14, 'leader_endpt']],
    }[t] || [];
    for (const [c, f] of pts) if (has(f)) this.xyz(c, this.pt(tio, f));
    if (t === T.DIM_LINEAR) { P(50, this.n0(tio, 'dim_rotation') * DEG); P(52, this.n0(tio, 'oblique_angle') * DEG); }
    if (t === T.DIM_ALIGNED) P(52, this.n0(tio, 'oblique_angle') * DEG);
    if (t === T.DIM_RADIUS || t === T.DIM_DIAMETER) P(40, this.n0(tio, 'leader_len'));
    this.ext(tio);
  }

  leader(o, tio, paper) {
    const P = (c, v) => this.p(c, v);
    const n = this.n0(tio, 'num_points');
    const pts = n ? arr(this.M.dwg_ptr_to_point3d_array(this.val(tio, 'points'), n)) : [];
    this.common(o, 'LEADER', paper);
    const ds = this.names.dimstyle.get(this.ref(tio, 'dimstyle'));
    if (ds) P(3, ds);
    P(71, this.n0(tio, 'arrowhead_on'));
    P(72, this.n0(tio, 'path_type'));
    P(73, this.n0(tio, 'annot_type', 3));
    P(76, pts.length);
    for (const q of pts) this.xyz(10, [num(q.x), num(q.y), num(q.z)]);
    this.ext(tio);
  }
}
