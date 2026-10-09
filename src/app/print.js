// PNG export and print / save-as-PDF. Everything is rendered locally into a canvas.
import { Viewport } from '../view/viewport.js';
import { $, esc } from './ui.js';

/** Render the current view (drawing + markups + measurements) to a PNG blob. */
export function exportPng(app, { scale = 2 } = {}) {
  const v = app.view;
  const dpr = Math.max(1, Math.min(scale, 8000 / Math.max(v.w, v.h)));
  const c = document.createElement('canvas');
  c.width = Math.round(v.w * dpr);
  c.height = Math.round(v.h * dpr);
  const ctx = c.getContext('2d');
  app.renderer.drawTo(ctx, v, app.renderOpts(), dpr, c.width, c.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  app.drawAnnotations(ctx, v, { theme: app.theme });
  return new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
}

const PAGE = { landscape: [281, 194], portrait: [194, 281] }; // printable mm (A4/Letter safe, 8 mm margins)
const STRIP_MM = 13;

/** Build the print sheet into #print-root. Returns the <img> (await img.decode() before printing). */
export function buildPrintSheet(app, o = {}) {
  const orient = o.orientation === 'portrait' ? 'portrait' : 'landscape';
  const [pw, ph] = PAGE[orient];
  const imgH = ph - STRIP_MM;
  const pxW = 2200;
  const pxH = Math.round((pxW * imgH) / pw);
  const v = new Viewport();
  v.setSize(pxW, pxH);
  v.setLimits(app.scene.extents);
  if (o.area === 'all') v.fit(app.scene.fitBox, 30);
  else {
    // keep the current view centre and show at least what is on screen
    const cur = app.view;
    const r = cur.visibleRect(0);
    v.fit(r, 0);
    v.cx = cur.cx; v.cy = cur.cy;
  }
  const c = document.createElement('canvas');
  c.width = pxW; c.height = pxH;
  const ctx = c.getContext('2d');
  const opts = { ...app.renderOpts(), theme: 'paper' };
  app.renderer.drawTo(ctx, v, opts, 1, pxW, pxH);
  if (o.markups !== false) { ctx.setTransform(1, 0, 0, 1, 0, 0); app.drawAnnotations(ctx, v, { theme: 'paper', fontScale: 1.6 }); }
  const url = c.toDataURL('image/png');
  const root = $('#print-root');
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  root.innerHTML = `<div class="print-sheet">
    <img alt="${esc(o.title || app.doc.name)}" src="${url}">
    <div class="title-strip">
      <div><small>Title</small><strong>${esc(o.title || app.doc.name)}</strong></div>
      <div><small>File</small>${esc(app.doc.name)}</div>
      <div><small>Printed</small>${esc(date)} · not to scale</div>
      <div><small>Author</small>${esc(o.author || '—')}</div>
    </div></div>`;
  let style = document.getElementById('page-style');
  if (!style) { style = document.createElement('style'); style.id = 'page-style'; document.head.appendChild(style); }
  style.textContent = `@page { size: ${orient}; margin: 8mm; } @media print { .print-sheet img { max-height: ${imgH}mm; } }`;
  return root.querySelector('img');
}

export function clearPrintSheet() {
  $('#print-root').innerHTML = '';
}
