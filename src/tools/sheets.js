// Sheet sets (pure): the text index of a sheet (built in the parse worker), titles, search across
// sheets, references between sheets, an LRU. Used by src/app/sheets.js and the worker.

/** The drawing files a set takes: the ONE list (folder listing, pickers, drops). */
export const SHEET_EXTS = ['.dxf', '.dwg', '.dgn'];
const EXT_RE = new RegExp(`(${SHEET_EXTS.map((e) => e.replace('.', '\\.')).join('|')})$`, 'i');
/** A drawing of a set (not a backup copy written by Save over the original). */
export const isSheetName = (n) => EXT_RE.test(n) && !/\.bak\.[^.]+$/i.test(n) && !/^[.~]/.test(n.split('/').pop());
export const stemOf = (n) => n.split('/').pop().replace(/\.[^.]*$/, '');
/** Natural order (SH2 before SH10), case-insensitive. */
export const naturalCmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const TITLE_TAG = /^(DWG_?|DRAWING_?|SHEET_?)?TITLE\d?$/i;
const OWN_NUM = /\bSH(?:EET|T)?\.?\s*(?:NO\.?\s*)?(\d{1,4}[A-Z]?)\s*(?:OF|\/)\s*\d+/i;
const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toUpperCase();
/** "04" -> "4" (sheet numbers compare as numbers). */
const normNum = (s) => norm(s).replace(/^0+(?=\d)/, '');

/**
 * Text index of a parsed sheet (scene texts unpacked; model optional, for block attribute tags):
 * { format, n, s: [text], p: Float64Array [x, y, h] per text (centre in drawing coordinates, height),
 *   e: Int32Array (entity), sub: { k: path inside a cell / insert }, title, num (own sheet number), tb: [title block texts] }.
 */
export function indexSheet(scene, model = null) {
  const [ox, oy] = scene.origin, s = [], p = [], e = [], sub = {};
  for (const t of scene.texts || []) {
    if (!t || t.dead || !t.s || !t.s.trim()) continue;
    const b = t.bbox, k = s.length;
    s.push(t.s);
    p.push((b[0] + b[2]) / 2 + ox, (b[1] + b[3]) / 2 + oy, Math.hypot(t.m[2], t.m[3]) || 1);
    e.push(t.ent);
    if (t.sub) sub[k] = t.sub;
  }
  const idx = { format: scene.format, n: s.length, s, p: Float64Array.from(p), e: Int32Array.from(e), sub, title: '', num: '', tb: [] };
  // the title block: the lower right of the sheet (fit box: stray far-away items do not count)
  const f = scene.fitBox || scene.extents, X0 = f[0] + ox, Y0 = f[1] + oy, W = f[2] - f[0], H = f[3] - f[1];
  const inTb = (k) => idx.p[3 * k] >= X0 + 0.55 * W && idx.p[3 * k + 1] <= Y0 + 0.3 * H;
  let best = -1;
  for (let k = 0; k < s.length; k++) {
    if (!idx.num) { const m = OWN_NUM.exec(s[k]); if (m) idx.num = normNum(m[1]); }
    const a = /^a(\d+)$/.exec(sub[k] || ''), ins = a && model && model.entities[e[k]], at = ins && ins.attribs && ins.attribs[+a[1]];
    if (at && TITLE_TAG.test(at.tag || '') && best !== -2) { idx.title = s[k].trim().slice(0, 120); best = -2; } // a title attribute wins
    if (!inTb(k)) continue;
    if (idx.tb.length < 40) idx.tb.push(norm(s[k]));
    if (best === -2 || !/\p{L}/u.test(s[k]) || s[k].trim().length < 3 || OWN_NUM.test(s[k]) || /^REV\b/i.test(s[k].trim())) continue;
    if (best < 0 || idx.p[3 * k + 2] > idx.p[3 * best + 2] * 1.001 || (idx.p[3 * k + 2] >= idx.p[3 * best + 2] * 0.999 && s[k].length > s[best].length)) best = k;
  }
  if (best >= 0) idx.title = s[best].trim().slice(0, 120);
  return idx;
}

/** Approximate stored size of an index (bytes). */
export const indexBytes = (idx) => idx.p.byteLength + idx.e.byteLength + idx.s.reduce((n, x) => n + 2 * x.length + 16, 0);

/** Worker side of an index job: { id, type: 'indexed', index } or { id, type: 'error', message }. */
export async function indexJob(msg, load) {
  try {
    const { scene, model } = await load(msg, () => {});
    return { id: msg.id, type: 'indexed', index: { ...indexSheet(scene, model), hash: scene.hash } };
  } catch (e) {
    return { id: msg.id, type: 'error', code: e.code || 'error', message: String((e && e.message) || e) };
  }
}

// ------------------------------------------------------------------ search
/** Hits sorted in reading order: rows from the top (by text height bands), then left to right. */
function readingOrder(hits) {
  if (hits.length < 2) return hits;
  const hs = hits.map((h) => h.h).sort((a, b) => a - b), band = hs[hs.length >> 1] * 1.5;
  const top = Math.max(...hits.map((h) => h.y));
  for (const h of hits) h.row = Math.floor((top - h.y) / band);
  hits.sort((a, b) => a.row - b.row || a.x - b.x || a.k - b.k);
  for (const h of hits) delete h.row;
  return hits;
}
/** Matches of `re` in one index: [{ k, text, x, y, h, ent, sub }] in reading order. */
export function searchIndex(idx, re) {
  const out = [];
  if (!idx || !re) return out;
  const r = new RegExp(re.source, re.flags.replace(/[gy]/g, ''));
  for (let k = 0; k < idx.n; k++) {
    if (!r.test(idx.s[k])) continue;
    out.push({ k, text: idx.s[k], x: idx.p[3 * k], y: idx.p[3 * k + 1], h: idx.p[3 * k + 2], ent: idx.e[k], sub: idx.sub[k] || '' });
  }
  return readingOrder(out);
}
/** Search every indexed sheet ({ id, name, idx }): [{ sheetId, name, hits }] for sheets with hits, in set order. */
export function searchSheets(sheets, re, max = 20000) {
  const out = [];
  let left = max;
  for (const sh of sheets) {
    if (!sh.idx || left <= 0) continue;
    const hits = searchIndex(sh.idx, re).slice(0, left);
    left -= hits.length;
    if (hits.length) out.push({ sheetId: sh.id, name: sh.name, hits });
  }
  return out;
}

// ------------------------------------------------------------------ cross-references
/** Default patterns (case-insensitive; group 1 = a sheet number or a drawing number): SHEET 12, SH 4, SHT. 3 (not "SHEET 1 OF 3"); SEE DWG 1234-56. */
export const XREF_DEFAULT = [
  '\\bSH(?:EET|T)?\\.?\\s*(?:NO\\.?\\s*)?#?\\s*(\\d{1,4}[A-Z]?)\\b(?!\\s*(?:OF|/)\\s*\\d)',
  '\\bSEE\\s+(?:DWG|DRAWING|DRG)\\.?\\s*(?:NO\\.?\\s*)?([A-Z0-9][A-Z0-9._/-]*[A-Z0-9])',
];
/** Compile pattern sources: { res, bad: [sources that are not valid] }. */
export function compilePatterns(list = XREF_DEFAULT) {
  const res = [], bad = [];
  for (const src of list) {
    if (!String(src).trim()) continue;
    try { res.push(new RegExp(src, 'iu')); } catch { bad.push(src); }
  }
  return { res, bad };
}

/** Lookup tables for resolving references in a set of sheets [{ id, name, idx? }]. */
export function xrefContext(sheets, patterns = compilePatterns()) {
  const add = (m, k, id) => { if (!k) return; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(id); };
  const C = { res: patterns.res, stem: new Map(), num: new Map(), trail: new Map(), tb: new Map() };
  for (const sh of sheets) {
    const st = norm(stemOf(sh.name));
    add(C.stem, st, sh.id);
    const t = /(\d+[A-Z]?)$/.exec(st);
    if (t) add(C.trail, normNum(t[1]), sh.id);
    if (sh.idx) { add(C.num, sh.idx.num, sh.id); for (const x of sh.idx.tb || []) add(C.tb, x, sh.id); }
  }
  return C;
}
/** The sheet a reference token points to (not `from`), or null when none or not exactly one. */
export function resolveRef(C, token, from) {
  const T = norm(token), n = normNum(token);
  for (const [m, key] of [[C.stem, T], [C.num, n], [C.trail, n], [C.tb, T]]) {
    const ids = [...(m.get(key) || [])].filter((id) => id !== from);
    if (ids.length === 1) return ids[0];
  }
  return null;
}
/** References in texts of sheet `from`: [{ k, to, token }] (k: index in `texts`). */
export function findXrefs(C, texts, from) {
  const out = [];
  texts.forEach((s, k) => {
    if (!s || !s.trim()) return;
    const whole = norm(s), self = C.stem.get(whole);
    if (self) { const to = [...self].filter((id) => id !== from); if (to.length === 1) { out.push({ k, to: to[0], token: whole }); return; } }
    for (const re of C.res) {
      const m = re.exec(s);
      const tok = m && (m[1] != null ? m[1] : m[0]);
      const to = tok && resolveRef(C, tok, from);
      if (to) { out.push({ k, to, token: tok }); return; }
    }
  });
  return out;
}

// ------------------------------------------------------------------ memory
/** Least recently used cache bounded by a count and by bytes (size(v) per value). */
export class LRU {
  constructor(max = 3, maxBytes = Infinity, size = () => 0) { Object.assign(this, { max, maxBytes, size, m: new Map(), bytes: 0 }); }
  get count() { return this.m.size; }
  get(k) { const v = this.m.get(k); if (v) { this.m.delete(k); this.m.set(k, v); } return v ? v.v : undefined; }
  set(k, v) {
    this.delete(k);
    const n = this.size(v) || 0;
    if (this.max < 1 || n > this.maxBytes) return this;
    this.m.set(k, { v, n });
    this.bytes += n;
    for (const [key] of this.m) { if (this.m.size <= this.max && this.bytes <= this.maxBytes) break; this.delete(key); }
    return this;
  }
  delete(k) { const e = this.m.get(k); if (e) { this.m.delete(k); this.bytes -= e.n; } return !!e; }
  clear() { this.m.clear(); this.bytes = 0; }
}
/** Rough memory of a shown drawing (typed arrays of the scene and its render batches, texts, model). */
export function sceneBytes(scene, model) {
  let n = 0;
  const views = (o) => { if (o) for (const v of Object.values(o)) if (ArrayBuffer.isView(v)) n += v.byteLength; };
  views(scene); views(scene.grid);
  for (const ch of scene.chunks || []) for (const b of ch.batches || []) views(b);
  n += (scene.texts ? scene.texts.length : 0) * 240 + (model && model.entities ? model.entities.length * 320 : 0);
  return n;
}
