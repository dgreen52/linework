// Minimal PDF writer for SYNTHETIC test fixtures (tools and tests only; not part of the app).
// Written from the public PDF 1.7 reference (ISO 32000-1): indirect objects, the cross-reference
// table, content streams, the standard 14 fonts (not embedded), image and form XObjects, optional
// content groups (layers), page labels and the standard security handler, revision 2 (RC4, 40-bit
// key) for the password tests. Output is deterministic (no dates, a fixed file ID).
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const ref = (n) => ({ ref: n });
export const str = (s) => ({ str: s });

// ------------------------------------------------------------------ RC4 security handler (R2)
const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
export function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; [S[i], S[j]] = [S[j], S[i]]; }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + S[i]) & 255; [S[i], S[j]] = [S[j], S[i]];
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}
const padPw = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
/** { O, U, P, key } of the standard security handler, revision 2 (algorithms 2, 3 and 4). */
export function securityR2(user, owner, id, P = -44) {
  const okey = md5(padPw(owner || user)).subarray(0, 5);
  const O = rc4(okey, padPw(user));
  const p = Buffer.alloc(4); p.writeInt32LE(P);
  const key = md5(padPw(user), O, p, id).subarray(0, 5);
  return { O, U: rc4(key, PAD), P, key };
}
const objKey = (key, n) => md5(key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])).subarray(0, Math.min(16, key.length + 5));

// ------------------------------------------------------------------ objects
const num = (v) => (Number.isInteger(v) ? String(v) : String(+v.toFixed(5)));
function ser(v, enc) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return num(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v; // names (/Name) and plain tokens
  if (Buffer.isBuffer(v)) return '<' + v.toString('hex') + '>';
  if (Array.isArray(v)) return '[' + v.map((x) => ser(x, enc)).join(' ') + ']';
  if ('ref' in v) return `${v.ref} 0 R`;
  if ('str' in v) {
    const b = Buffer.from(v.str, 'latin1');
    return enc ? '<' + enc(b).toString('hex') + '>' : '(' + v.str.replace(/[\\()]/g, (c) => '\\' + c) + ')';
  }
  return '<<' + Object.entries(v).map(([k, x]) => `/${k} ${ser(x, enc)}`).join(' ') + '>>';
}

/** Objects are { dict } or { dict, stream: Buffer|string, deflate } (numbered from 1). */
export class PdfWriter {
  constructor() { this.objs = []; }
  add(o) { this.objs.push(o); return ref(this.objs.length); }
  reserve() { this.objs.push(null); return ref(this.objs.length); }
  set(r, o) { this.objs[r.ref - 1] = o; }
  /** The whole file. trailer: { Root, Info? }; encrypt: { user, owner } (RC4 40-bit). */
  bytes(trailer, { encrypt, version = '1.7' } = {}) {
    const id = md5(Buffer.from(JSON.stringify(this.objs.map((o) => (o && o.dict ? Object.keys(o.dict) : 0)))), Buffer.from(String(this.objs.length)));
    let sec = null, encRef = null;
    if (encrypt) {
      sec = securityR2(encrypt.user || '', encrypt.owner || '', id);
      encRef = this.add({ dict: { Filter: '/Standard', V: 1, R: 2, O: sec.O, U: sec.U, P: sec.P }, plain: true });
    }
    const parts = [Buffer.from(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`, 'latin1')];
    let len = parts[0].length;
    const offsets = [];
    this.objs.forEach((o, i) => {
      const n = i + 1;
      offsets.push(len);
      const k = sec && !o.plain ? objKey(sec.key, n) : null;
      const enc = k ? (b) => rc4(k, b) : null;
      let body;
      if (o.stream != null) {
        let data = Buffer.isBuffer(o.stream) ? o.stream : Buffer.from(o.stream, 'latin1');
        const dict = { ...o.dict };
        if (o.deflate) { data = deflateSync(data, { level: 9 }); dict.Filter = '/FlateDecode'; }
        if (enc) data = enc(data);
        dict.Length = data.length;
        body = Buffer.concat([Buffer.from(`${n} 0 obj\n${ser(dict, enc)}\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
      } else body = Buffer.from(`${n} 0 obj\n${ser(o.dict, enc)}\nendobj\n`, 'latin1');
      parts.push(body);
      len += body.length;
    });
    const xref = [`xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    const tr = { Size: this.objs.length + 1, ...trailer, ID: [id, id] };
    if (encRef) tr.Encrypt = encRef;
    parts.push(Buffer.from(`${xref}trailer\n${ser(tr)}\nstartxref\n${len}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }
}

// ------------------------------------------------------------------ documents
/**
 * A whole document. o: { pages: [page], layers: [{ name, on }], labels (PageLabels /Nums array),
 * title, encrypt: { user, owner }, version }
 * page: { size: [w, h] pt | mediaBox: [x0, y0, x1, y1], rotate, content (operators), fonts: { F1: 'Helvetica' },
 *         images: { Im1: { w, h, data (8-bit grey, w*h bytes) } }, forms: { Fm1: { bbox, matrix, content } },
 *         props: { oc1: index into layers }, deflate }
 */
export function makePdf(o) {
  const w = new PdfWriter();
  const catalog = w.reserve(), pagesRef = w.reserve();
  const fontRefs = new Map();
  const font = (base) => {
    if (!fontRefs.has(base)) fontRefs.set(base, w.add({ dict: { Type: '/Font', Subtype: '/Type1', BaseFont: '/' + base, ...(/Symbol|Dingbats/.test(base) ? {} : { Encoding: '/WinAnsiEncoding' }) } }));
    return fontRefs.get(base);
  };
  const ocgs = (o.layers || []).map((L) => w.add({ dict: { Type: '/OCG', Name: str(L.name) } }));
  const kids = [];
  for (const p of o.pages) {
    const fonts = {};
    for (const [k, base] of Object.entries(p.fonts || {})) fonts[k] = font(base);
    const xobj = {};
    for (const [k, im] of Object.entries(p.images || {})) {
      xobj[k] = w.add({ dict: { Type: '/XObject', Subtype: '/Image', Width: im.w, Height: im.h, ColorSpace: im.rgb ? '/DeviceRGB' : '/DeviceGray', BitsPerComponent: 8 }, stream: Buffer.from(im.data), deflate: true });
    }
    const props = {};
    for (const [k, i] of Object.entries(p.props || {})) props[k] = ocgs[i];
    const res = { ProcSet: ['/PDF', '/Text', '/ImageB'] };
    if (Object.keys(fonts).length) res.Font = fonts;
    if (Object.keys(props).length) res.Properties = props;
    // spot colours: [/Separation name /DeviceRGB tint-transform] with a PostScript (type 4) function
    const cs = {};
    for (const [k, c] of Object.entries(p.colorSpaces || {})) {
      const fn = w.add({ dict: { FunctionType: 4, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1] }, stream: c.fn });
      cs[k] = ['/Separation', '/' + c.name, '/DeviceRGB', fn];
    }
    if (Object.keys(cs).length) res.ColorSpace = cs;
    for (const [k, f] of Object.entries(p.forms || {})) {
      const fr = { Font: fonts };
      if (Object.keys(props).length) fr.Properties = props;
      xobj[k] = w.add({ dict: { Type: '/XObject', Subtype: '/Form', BBox: f.bbox, Matrix: f.matrix || [1, 0, 0, 1, 0, 0], Resources: fr }, stream: f.content, deflate: p.deflate !== false });
    }
    if (Object.keys(xobj).length) res.XObject = xobj;
    const content = w.add({ dict: {}, stream: p.content, deflate: p.deflate !== false });
    const dict = { Type: '/Page', Parent: pagesRef, MediaBox: p.mediaBox || [0, 0, p.size[0], p.size[1]], Resources: res, Contents: content };
    if (p.cropBox) dict.CropBox = p.cropBox;
    if (p.rotate) dict.Rotate = p.rotate;
    // annotations (as a PDF viewer's markups): an appearance stream each
    if (p.annots && p.annots.length) {
      dict.Annots = p.annots.map((a) => {
        const ap = w.add({ dict: { Type: '/XObject', Subtype: '/Form', BBox: [0, 0, a.rect[2] - a.rect[0], a.rect[3] - a.rect[1]] }, stream: a.content, deflate: false });
        return w.add({ dict: { Type: '/Annot', Subtype: '/' + (a.subtype || 'Square'), Rect: a.rect, F: 4, AP: { N: ap }, ...(a.text ? { Contents: str(a.text) } : {}) } });
      });
    }
    kids.push(w.add({ dict }));
  }
  w.set(pagesRef, { dict: { Type: '/Pages', Kids: kids, Count: kids.length } });
  const cat = { Type: '/Catalog', Pages: pagesRef };
  if (ocgs.length) {
    cat.OCProperties = { OCGs: ocgs, D: { Order: ocgs, ON: ocgs.filter((r, i) => o.layers[i].on !== false), OFF: ocgs.filter((r, i) => o.layers[i].on === false) } };
  }
  if (o.labels) cat.PageLabels = { Nums: o.labels };
  w.set(catalog, { dict: cat });
  const trailer = { Root: catalog };
  if (o.title) trailer.Info = w.add({ dict: { Title: str(o.title), Producer: str('Linework test fixture writer') } });
  return w.bytes(trailer, { encrypt: o.encrypt, version: o.version });
}

// ------------------------------------------------------------------ content stream helpers
/** Content operators built up in order: c.line(...), c.text(...), ... then String(c). */
export class Content {
  constructor() { this.ops = []; }
  op(s) { this.ops.push(s); return this; }
  toString() { return this.ops.join('\n') + '\n'; }
  q() { return this.op('q'); }
  Q() { return this.op('Q'); }
  cm(a, b, c, d, e, f) { return this.op(`${[a, b, c, d, e, f].map(num).join(' ')} cm`); }
  width(w) { return this.op(`${num(w)} w`); }
  stroke(r, g, b) { return this.op(`${num(r)} ${num(g)} ${num(b)} RG`); }
  fill(r, g, b) { return this.op(`${num(r)} ${num(g)} ${num(b)} rg`); }
  gray(v, fillToo = true) { this.op(`${num(v)} G`); return fillToo ? this.op(`${num(v)} g`) : this; }
  dash(arr, phase = 0) { return this.op(`[${arr.map(num).join(' ')}] ${num(phase)} d`); }
  line(x0, y0, x1, y1) { return this.op(`${num(x0)} ${num(y0)} m ${num(x1)} ${num(y1)} l S`); }
  poly(pts, close = false, paint = 'S') { let s = `${num(pts[0])} ${num(pts[1])} m`; for (let i = 2; i < pts.length; i += 2) s += ` ${num(pts[i])} ${num(pts[i + 1])} l`; return this.op(`${s}${close ? ' h' : ''} ${paint}`); }
  rect(x, y, w, h, paint = 'S') { return this.op(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re ${paint}`); }
  /** Circle as four cubic Béziers (the usual 0.5523 approximation), as PDF producers write it. */
  circle(cx, cy, r, paint = 'S') {
    const k = 0.5522847498 * r;
    const P = (x, y) => `${num(cx + x)} ${num(cy + y)}`;
    return this.op(`${P(r, 0)} m ${P(r, k)} ${P(k, r)} ${P(0, r)} c ${P(-k, r)} ${P(-r, k)} ${P(-r, 0)} c ${P(-r, -k)} ${P(-k, -r)} ${P(0, -r)} c ${P(k, -r)} ${P(r, -k)} ${P(r, 0)} c h ${paint}`);
  }
  /** Arc of radius r from angle a0 to a1 (degrees, CCW, at most 90° per Bézier). */
  arc(cx, cy, r, a0, a1) {
    const n = Math.max(1, Math.ceil((a1 - a0) / 90 - 1e-9)), step = ((a1 - a0) / n) * Math.PI / 180;
    let t = (a0 * Math.PI) / 180;
    const P = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    let s = `${P(t).map(num).join(' ')} m`;
    for (let i = 0; i < n; i++) {
      const k = (4 / 3) * Math.tan(step / 4) * r, a = P(t), b = P(t + step);
      s += ` ${num(a[0] - k * Math.sin(t))} ${num(a[1] + k * Math.cos(t))} ${num(b[0] + k * Math.sin(t + step))} ${num(b[1] - k * Math.cos(t + step))} ${num(b[0])} ${num(b[1])} c`;
      t += step;
    }
    return this.op(s + ' S');
  }
  /** Text at (x, y) in font F, size pt; rot degrees; mode: text rendering mode (3 = invisible). */
  text(s, x, y, { font = 'F1', size = 10, rot = 0, mode = 0 } = {}) {
    const a = (rot * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    const esc = String(s).replace(/[\\()]/g, (ch) => '\\' + ch);
    return this.op(`BT /${font} ${num(size)} Tf ${mode ? mode + ' Tr ' : ''}${[c, sn, -sn, c, x, y].map(num).join(' ')} Tm (${esc}) Tj ET`);
  }
  /** Optional content: the operators of fn() belong to the layer named `tag` in the page's props. */
  layer(tag, fn) { this.op(`/OC /${tag} BDC`); fn(this); return this.op('EMC'); }
  image(name, x, y, w, h) { return this.op(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /${name} Do Q`); }
  form(name) { return this.op(`/${name} Do`); }
}

/** Points per millimetre. */
export const MM = 72 / 25.4;
