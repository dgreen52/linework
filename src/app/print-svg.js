// Vector print to scale: the drawing as SVG on a real sheet ("Save as PDF" then writes a vector
// PDF). Layout, scales and the SVG writer are pure (unit tested); printSheet / initDialog use the page.
import { KIND, FLAG, DXF_LW, weightPx } from '../scene.js';
import { cssColor } from '../view/colors.js';
import { CAP_HEIGHT } from '../view/renderer2d.js';
import { Viewport } from '../view/viewport.js';
import { liveExtents } from '../edit/live-scene.js';
import { $, esc, storage } from './ui.js';

/** Sheets: [label, width mm, height mm] (portrait). */
export const SHEETS = {
  letter: ['Letter', 215.9, 279.4], legal: ['Legal', 215.9, 355.6], tabloid: ['Tabloid', 279.4, 431.8],
  ansic: ['ANSI C', 431.8, 558.8], ansid: ['ANSI D', 558.8, 863.6], a4: ['A4', 210, 297], a3: ['A3', 297, 420], a1: ['A1', 594, 841],
};
export const MARGIN = 8; // mm
export const STRIP = 9; // title line, mm
const MM_PER_PX = 0.13; // a screen pixel of markups on paper
const DASH_MM = 0.25; // a screen pixel of line type dashes on paper
const FONT = 'Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif';
const K = 64 * CAP_HEIGHT; // cap height of 64 px text (as the renderer)
/** Millimetres per drawing unit (DXF $INSUNITS codes); null = unitless. */
const UNIT_MM = { 1: 25.4, 2: 304.8, 3: 1609344, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 25.4e-6, 9: 0.0254, 10: 914.4, 11: 1e-7, 12: 1e-6, 13: 1e-3, 14: 100, 15: 1e4, 16: 1e5, 21: 1200000 / 3937, 22: 100000 / 3937, 23: 3600000 / 3937, 24: 6336000000 / 3937 };
export const unitMm = (units) => (units && UNIT_MM[units.code]) || null;

/** "Fit", "1:50", "1/50", "2:1", 1"=20', 1in=20ft, 1/4"=1'-0" -> { fit } | { ratio (paper / real), label } | null. */
export function parseScale(str) {
  const s = String(str ?? '').trim().toLowerCase().replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'").replace(/\s+/g, '');
  if (!s || s === 'fit') return { fit: true };
  const num = (t) => { const f = /^(\d+)\/(\d+)$/.exec(t); return f ? +f[1] / +f[2] : +t; };
  const ok = (ratio, label) => (ratio > 1e-7 && ratio < 1e4 ? { ratio, label } : null);
  let m = /^(\d*\.?\d+):(\d*\.?\d+)$/.exec(s);
  if (m) return ok(+m[1] / +m[2], `${+m[1]}:${+m[2]}`);
  m = /^1\/(\d*\.?\d+)$/.exec(s);
  if (m) return ok(1 / +m[1], `1:${+m[1]}`);
  m = /^(\d+\/\d+|\d*\.?\d+)(?:"|in)=(\d*\.?\d+)(?:'|ft)(?:-?(\d*\.?\d+)(?:"|in)?)?$/.exec(s);
  if (m) return ok(num(m[1]) / (+m[2] * 12 + (m[3] ? +m[3] : 0)), `${m[1]}"=${+m[2]}'${m[3] && +m[3] ? `-${+m[3]}"` : ''}`);
  return null;
}
const fmtN = (n) => (n >= 100 ? String(Math.round(n)) : String(+n.toFixed(n >= 10 ? 1 : 2)));
/** "1:37.2" for paper / real = r. */
export const ratioLabel = (r) => (r >= 1 ? `${fmtN(r)}:1` : `1:${fmtN(1 / r)}`);

/**
 * o: { sheet, orientation, scale, rect (scene-local area), units } -> { W, H, fw, fh (frame, mm),
 * s (paper mm per unit), win (scene-local rectangle on the frame), label, fits, need, name }.
 */
export function printLayout(o) {
  const sh = SHEETS[o.sheet] || SHEETS.a4;
  const land = o.orientation !== 'portrait';
  const W = land ? sh[2] : sh[1], H = land ? sh[1] : sh[2];
  const fw = W - 2 * MARGIN, fh = H - 2 * MARGIN - STRIP - 1;
  const r = o.rect, aw = Math.max(r[2] - r[0], 1e-9), ah = Math.max(r[3] - r[1], 1e-9);
  const sc = parseScale(o.scale) || { fit: true, bad: true };
  const um = unitMm(o.units);
  let s, label, fits = true;
  if (sc.fit) {
    s = Math.min(fw / aw, fh / ah);
    label = um ? `Fit (${ratioLabel(s / um)})` : 'Fit (no units)';
  } else {
    s = sc.ratio * (um || 1);
    label = sc.label + (um ? '' : ' (1 unit = 1 mm)');
    fits = aw * s <= fw * 1.001 && ah * s <= fh * 1.001;
  }
  const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, hw = fw / 2 / s, hh = fh / 2 / s;
  return { W, H, fw, fh, s, win: [cx - hw, cy - hh, cx + hw, cy + hh], label, fits, bad: !!sc.bad, need: [aw * s, ah * s], name: `${sh[0]} ${land ? 'landscape' : 'portrait'}` };
}

const r3 = (v) => Math.round(v * 1000) / 1000;
const r6 = (v) => +v.toPrecision(6);
/** Paper line width (mm): DXF lineweights as they are, DGN weights like the screen, 0.18 mm by default. */
export const widthMm = (w, format) => (!w ? 0.18 : format === 'DGN' ? 0.18 * weightPx(w, 'DGN') : Math.max(0.1, DXF_LW[w - 1] / 100));

/**
 * The frame as SVG (fw x fh mm). o: { mono, layerVisible, annotate(ctx, view): markups into a recorder,
 * theme: 'paper' (default) | 'dark' (colours for a dark background, which the caller paints), frame: false (no border) }
 */
export function buildSvg(scene, L, o = {}) {
  const { fw, fh, s, win } = L, [x0, y0, x1, y1] = win;
  const X = (x) => r3((x - x0) * s), Y = (y) => r3((y1 - y) * s);
  const vis = o.layerVisible, dead = scene.dead, bb = scene.bbox, co = scene.coords;
  const theme = o.theme === 'dark' ? 'dark' : 'paper', ink = theme === 'dark' ? '#fff' : '#000';
  const col = (c) => (o.mono ? ink : cssColor(c, theme));
  const groups = new Map(); // key -> { order, open (tag start), d: [] }
  const group = (key, order, open) => { let g = groups.get(key); if (!g) groups.set(key, g = { order, open, d: [] }); return g.d; };
  for (let i = 0; i < scene.n; i++) {
    if ((dead && dead[i]) || (vis && !vis[scene.layer[i]])) continue;
    const q = 4 * i;
    if (bb[q] > x1 || bb[q + 2] < x0 || bb[q + 1] > y1 || bb[q + 3] < y0) continue;
    const k = scene.kind[i], f = scene.flags[i], c = col(scene.color[i]);
    if (k === KIND.POINT) {
      const p = scene.start[i] * 2;
      group('o' + c, 3, `<path fill="${c}" d="`).push(`M${r3(X(co[p]) - 0.25)} ${Y(co[p + 1])}a.25 .25 0 1 0 .5 0a.25 .25 0 1 0-.5 0`);
      continue;
    }
    const d = k === KIND.CONIC ? conicD(scene, i, X, Y, s) : polyD(scene, i, X, Y);
    if (!d) continue;
    if (f & FLAG.FILL) group('f' + c + (f & FLAG.EVENODD), 0, `<path fill="${c}" fill-rule="${f & FLAG.EVENODD ? 'evenodd' : 'nonzero'}" d="`).push(d);
    else if (f & FLAG.PATTERN) group('p' + c, 1, `<path fill="${c}" fill-opacity=".22" fill-rule="evenodd" d="`).push(d);
    else {
      const w = r3(widthMm(scene.weight[i], scene.format)), lt = scene.ltypes[scene.style[i]], dash = lt && lt.dash ? lt.dash.map((v) => r3(v * DASH_MM)).join(' ') : '';
      group(`s${c}|${w}|${dash}`, 2, `<path stroke="${c}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''} d="`).push(d);
    }
  }
  const body = [...groups.values()].sort((a, b) => a.order - b.order).map((g) => g.open + g.d.join('') + '"/>');
  // a PDF page's pictures (o.picture: the image as a data URL), under everything
  const u = scene.underlay;
  if (u && o.picture) body.unshift(`<image href="${o.picture}" x="${X(u.box[0])}" y="${Y(u.box[3])}" width="${r3((u.box[2] - u.box[0]) * s)}" height="${r3((u.box[3] - u.box[1]) * s)}" preserveAspectRatio="none"/>`);
  // real text, placed as on screen
  const texts = new Map();
  for (const t of scene.texts) {
    const b = t.bbox, m = t.m;
    if (t.dead || (vis && !vis[t.layer]) || b[0] > x1 || b[2] < x0 || b[1] > y1 || b[3] < y0 || s * Math.hypot(m[2], m[3]) < 0.15) continue;
    const c = col(t.color);
    if (!texts.has(c)) texts.set(c, []);
    texts.get(c).push(`<text transform="matrix(${r6((s * m[0]) / K)} ${r6((-s * m[1]) / K)} ${r6((-s * m[2]) / K)} ${r6((s * m[3]) / K)} ${X(t.x)} ${Y(t.y)})"${t.align ? ` text-anchor="${t.align === 1 ? 'middle' : 'end'}"` : ''}${t.fit ? ` textLength="${r3(t.fit * K)}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(t.s)}</text>`);
  }
  for (const [c, list] of texts) body.push(`<g fill="${c}" font-size="64" font-family="${FONT}" style="white-space:pre">${list.join('')}</g>`);
  let notes = '';
  if (o.annotate) {
    const v = new Viewport(), k = MM_PER_PX;
    v.setSize(fw / k, fh / k);
    v.scale = s / k;
    v.cx = (x0 + x1) / 2; v.cy = (y0 + y1) / 2;
    const ctx = new SvgCtx(o.measure);
    o.annotate(ctx, v);
    if (ctx.out.length) notes = `<g transform="scale(${k})">${ctx.out.join('')}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r3(fw)}mm" height="${r3(fh)}mm" viewBox="0 0 ${r3(fw)} ${r3(fh)}">`
    + `<defs><clipPath id="lw-frame"><rect width="${r3(fw)}" height="${r3(fh)}"/></clipPath></defs>`
    + `<g clip-path="url(#lw-frame)" fill="none" stroke-linecap="round" stroke-linejoin="round">${body.join('')}${notes}</g>`
    + (o.frame === false ? '' : `<rect x=".15" y=".15" width="${r3(fw - 0.3)}" height="${r3(fh - 0.3)}" fill="none" stroke="${ink}" stroke-width=".3"/>`) + '</svg>';
}

function polyD(scene, i, X, Y) {
  const co = scene.coords, s = scene.start[i] * 2, e = s + scene.count[i] * 2, closed = scene.flags[i] & FLAG.CLOSED;
  let d = '', move = true;
  for (let k = s; k < e; k += 2) {
    const x = co[k];
    if (x !== x) { if (closed && !move) d += 'Z'; move = true; continue; }
    d += `${move ? 'M' : 'L'}${X(x)} ${Y(co[k + 1])}`;
    move = false;
  }
  return closed && !move ? d + 'Z' : d;
}
/** Conic as elliptical arcs of at most 90° (principal axes as in the renderer). */
function conicD(scene, i, X, Y, s) {
  const c = scene.conics, o = scene.start[i] * 8, cx = c[o], cy = c[o + 1];
  let ux = c[o + 2], uy = c[o + 3], vx = c[o + 4], vy = c[o + 5], shift = 0;
  const dot = ux * vx + uy * vy;
  if (Math.abs(dot) > 1e-12 * (ux * ux + uy * uy + vx * vx + vy * vy)) {
    const ts = 0.5 * Math.atan2(2 * dot, ux * ux + uy * uy - (vx * vx + vy * vy)), cs = Math.cos(ts), sn = Math.sin(ts);
    [ux, uy, vx, vy] = [ux * cs + vx * sn, uy * cs + vy * sn, -ux * sn + vx * cs, -uy * sn + vy * cs];
    shift = ts;
  }
  const a0 = c[o + 6] - shift, a1 = c[o + 7] - shift;
  const P = (t) => `${X(cx + ux * Math.cos(t) + vx * Math.sin(t))} ${Y(cy + uy * Math.cos(t) + vy * Math.sin(t))}`;
  const rx = Math.hypot(ux, uy) * s, ry = Math.hypot(vx, vy) * s;
  if (!(rx > 1e-6 && ry > 1e-6)) return `M${P(a0)}L${P(a1)}`;
  const head = `A${r3(rx)} ${r3(ry)} ${r3((Math.atan2(-uy, ux) * 180) / Math.PI)} 0 ${ux * vy - uy * vx < 0 ? 1 : 0} `;
  const n = Math.max(1, Math.ceil((a1 - a0) / (Math.PI / 2) - 1e-9));
  let d = 'M' + P(a0);
  for (let k = 1; k <= n; k++) d += head + P(a0 + ((a1 - a0) * k) / n);
  return scene.flags[i] & FLAG.FULL ? d + 'Z' : d;
}

/** Enough of a canvas 2D context to record markups and measurements as SVG. */
export class SvgCtx {
  constructor(measure) {
    this.out = []; this.stack = []; this.d = '';
    this.st = { strokeStyle: '#000', fillStyle: '#000', lineWidth: 1, globalAlpha: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter', dash: [] };
    this.measure = measure || defaultMeasure;
    for (const k of Object.keys(this.st)) if (k !== 'dash') Object.defineProperty(this, k, { get: () => this.st[k], set: (v) => { this.st[k] = v; } });
  }
  save() { this.stack.push({ ...this.st, dash: this.st.dash.slice() }); }
  restore() { if (this.stack.length) this.st = this.stack.pop(); }
  setTransform() {}
  setLineDash(a) { this.st.dash = (a || []).slice(); }
  beginPath() { this.d = ''; }
  moveTo(x, y) { this.d += `M${r3(x)} ${r3(y)}`; }
  lineTo(x, y) { this.d += `${this.d ? 'L' : 'M'}${r3(x)} ${r3(y)}`; }
  closePath() { if (this.d) this.d += 'Z'; }
  rect(x, y, w, h) { this.d += `M${r3(x)} ${r3(y)}h${r3(w)}v${r3(h)}h${r3(-w)}Z`; }
  roundRect(x, y, w, h, rr) {
    const r = Math.max(0, Math.min(+(Array.isArray(rr) ? rr[0] : rr) || 0, Math.abs(w) / 2, Math.abs(h) / 2));
    const a = `A${r3(r)} ${r3(r)} 0 0 1 `;
    this.d += `M${r3(x + r)} ${r3(y)}H${r3(x + w - r)}${a}${r3(x + w)} ${r3(y + r)}V${r3(y + h - r)}${a}${r3(x + w - r)} ${r3(y + h)}H${r3(x + r)}${a}${r3(x)} ${r3(y + h - r)}V${r3(y + r)}${a}${r3(x + r)} ${r3(y)}Z`;
  }
  arc(x, y, r, a0, a1, ccw) { this.ellipse(x, y, r, r, 0, a0, a1, ccw); }
  ellipse(x, y, rx, ry, rot, a0, a1, ccw) {
    const T = 2 * Math.PI;
    let span = ccw ? a0 - a1 : a1 - a0;
    if (span >= T) span = T; else { span %= T; if (span < 0) span += T; }
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const P = (t) => `${r3(x + rx * Math.cos(t) * cr - ry * Math.sin(t) * sr)} ${r3(y + rx * Math.cos(t) * sr + ry * Math.sin(t) * cr)}`;
    this.d += (this.d ? 'L' : 'M') + P(a0);
    const n = Math.max(1, Math.ceil(span / (Math.PI / 2) - 1e-9)), head = `A${r3(rx)} ${r3(ry)} ${r3((rot * 180) / Math.PI)} 0 ${ccw ? 0 : 1} `;
    for (let k = 1; k <= n; k++) this.d += head + P(a0 + ((ccw ? -span : span) * k) / n);
  }
  paint(d, fill) {
    const st = this.st, a = st.globalAlpha < 1 ? ` opacity="${r3(st.globalAlpha)}"` : '';
    if (fill) this.out.push(`<path d="${d}" fill="${esc(st.fillStyle)}"${a}/>`);
    else this.out.push(`<path d="${d}" fill="none" stroke="${esc(st.strokeStyle)}" stroke-width="${r3(st.lineWidth)}" stroke-linecap="${st.lineCap}" stroke-linejoin="${st.lineJoin}"${st.dash.length ? ` stroke-dasharray="${st.dash.map(r3).join(' ')}"` : ''}${a}/>`);
  }
  stroke() { if (this.d) this.paint(this.d, false); }
  fill() { if (this.d) this.paint(this.d, true); }
  strokeRect(x, y, w, h) { this.paint(`M${r3(x)} ${r3(y)}h${r3(w)}v${r3(h)}h${r3(-w)}Z`, false); }
  fillRect(x, y, w, h) { this.paint(`M${r3(x)} ${r3(y)}h${r3(w)}v${r3(h)}h${r3(-w)}Z`, true); }
  strokeText() {}
  measureText(t) { return { width: this.measure(this.st.font, String(t)) }; }
  fillText(t, x, y) {
    const st = this.st, f = /^(?:(\S+)\s+)?(\d*\.?\d+)px\s+(.*)$/.exec(st.font) || [];
    const anchor = { center: 'middle', right: 'end', end: 'end' }[st.textAlign];
    const base = { top: 'hanging', hanging: 'hanging', middle: 'central', bottom: 'text-after-edge' }[st.textBaseline];
    this.out.push(`<text x="${r3(x)}" y="${r3(y)}" font-size="${r3(+f[2] || 10)}"${f[1] ? ` font-weight="${esc(f[1])}"` : ''} font-family="${FONT}" fill="${esc(st.fillStyle)}"${anchor ? ` text-anchor="${anchor}"` : ''}${base ? ` dominant-baseline="${base}"` : ''}${st.globalAlpha < 1 ? ` opacity="${r3(st.globalAlpha)}"` : ''} style="white-space:pre">${esc(t)}</text>`);
  }
}
let mctx = null;
function defaultMeasure(font, text) {
  if (!mctx && typeof document !== 'undefined') mctx = document.createElement('canvas').getContext('2d');
  if (!mctx) return 0.55 * (parseFloat(/(\d*\.?\d+)px/.exec(font)?.[1]) || 10) * text.length;
  mctx.font = font;
  return mctx.measureText(text).width;
}

// ------------------------------------------------------------------ the page
/** The print area (scene-local): the view or the extents. */
function areaOf(app, area) {
  if (area !== 'all') return app.view.visibleRect(0);
  const e = liveExtents(app.scene), [ox, oy] = app.scene.origin;
  return e ? [e[0] - ox, e[1] - oy, e[2] - ox, e[3] - oy] : app.scene.extents;
}
const optionsOf = (form) => { const f = new FormData(form); const o = Object.fromEntries(f); o.markups = f.get('markups') === 'on'; o.mono = f.get('mono') === 'on'; o.orientation = o.orient; return o; };
export const layoutFor = (app, o) => printLayout({ ...o, rect: areaOf(app, o.area), units: app.scene.units });

/** Build the sheet into #print-root and size the page (o: the dialog's values). */
export function printSheet(app, o = optionsOf($('#print-form'))) {
  const L = layoutFor(app, o);
  const svg = buildSvg(app.scene, L, { mono: o.mono, layerVisible: app.layerVisible, picture: pictureUrl(app.scene.underlay), annotate: o.markups !== false ? (ctx, v) => app.drawAnnotations(ctx, v, { theme: 'paper', fontScale: 1.6 }) : null });
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const cell = (k, v) => `<div><small>${k}</small>${v}</div>`;
  $('#print-root').innerHTML = `<div class="vsheet">${svg}<div class="title-strip">${cell('Title', `<strong>${esc(o.title || app.doc.name)}</strong>`)}${cell('File', esc(app.doc.name))}`
    + `${cell('Scale', esc(L.label))}${cell('Sheet', esc(L.name))}${cell('Printed', esc(date))}${cell('Author', esc(o.author || '—'))}</div></div>`;
  let style = document.getElementById('page-style');
  if (!style) { style = document.createElement('style'); style.id = 'page-style'; document.head.appendChild(style); }
  style.textContent = `@page { size: ${L.W}mm ${L.H}mm; margin: 0; } @media print { .vsheet { width: ${L.W}mm; height: ${r3(L.H - 0.5)}mm; } }`;
  app.lastPrint = { sheet: L.name, W: L.W, H: L.H, s: L.s, label: L.label, fits: L.fits, win: L.win };
  return L;
}

/** A PDF page's pictures as a data URL for the sheet (made once per page). */
function pictureUrl(u) {
  if (!u) return null;
  if (!u.url) {
    const c = document.createElement('canvas');
    c.width = u.w; c.height = u.h;
    const g = c.getContext('2d');
    if (!u.dark) { g.fillStyle = '#fff'; g.fillRect(0, 0, u.w, u.h); } // JPEG has no transparency: paper white
    g.drawImage(u.image, 0, 0);
    u.url = c.toDataURL(u.dark ? 'image/png' : 'image/jpeg', 0.92); // greyscale scans: PNG (sharp); photos: JPEG
  }
  return u.url;
}

/** The dialog: sheet (remembered; Letter or A4 by language) and what will print. */
export function initDialog(app) {
  const form = $('#print-form');
  if (!form.dataset.ready) {
    form.dataset.ready = '1';
    $('#pr-sheet').value = storage.get('linework:sheet') || (/^(en-(US|CA|PH)|es-(MX|US)|fr-CA)$/i.test(navigator.language || '') ? 'letter' : 'a4');
    const upd = () => describe(app, form);
    form.addEventListener('input', upd);
    form.addEventListener('change', upd);
    form.addEventListener('submit', () => storage.set('linework:sheet', $('#pr-sheet').value));
  }
  describe(app, form);
}
function describe(app, form) {
  if (!app.scene) return;
  const o = optionsOf(form), L = layoutFor(app, o), inp = $('#pr-scale');
  const mm = (v) => `${Math.round(v)} mm`;
  inp.setCustomValidity(L.bad ? 'Use Fit, a ratio such as 1:50, or 1"=20\'' : '');
  $('#pr-info').textContent = L.bad ? 'Scale not understood: use Fit, a ratio such as 1:50, or 1"=20\'.'
    : L.fits ? `Prints at ${L.label} on ${L.name} (${mm(L.W)} × ${mm(L.H)}).`
      : `At ${L.label} this area is ${mm(L.need[0])} × ${mm(L.need[1])}: only its middle part fits on ${L.name} (${mm(L.fw)} × ${mm(L.fh)} for the drawing). Choose a larger sheet or Fit.`;
  $('#pr-info').classList.toggle('warn-note', !L.fits || L.bad);
}
