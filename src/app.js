// Linework application shell: loading, view interaction, tools, markups, export.
// Everything runs locally; drawings are never sent anywhere.
import { APP_NAME, APP_VERSION } from './config.js';
import { Viewport, cssTransformBetween } from './view/viewport.js';
import { Canvas2DRenderer, primPath } from './view/renderer2d.js';
import { unpackTexts, TEXT_ID } from './scene.js';
import { findSnap, pickItem } from './tools/snap.js';
import { measure, describe, details, fmtNum } from './tools/measure.js';
import { createMarkup, rectCorners, moveMarkup } from './markup/model.js';
import { drawMarkup, markupScreenBox, markupHitDistance } from './markup/render.js';
import { serializeMarkups, parseMarkups, sidecarName } from './markup/sidecar.js';
import { History } from './markup/history.js';
import { smoothStroke } from './geom.js';
import { $, $$, toast, download, readFileAsArrayBuffer, storage, fmtBytes } from './app/ui.js';
import { LayersPanel, listedLayers } from './app/layers-panel.js';
import { exportPng, buildPrintSheet, clearPrintSheet } from './app/print.js';
import { initEdit, EDIT_TOOLS, EDIT_HINTS, TOUCH_HINTS } from './app/edit-ui.js';

const TOOL_GROUP = {
  pan: 'view', zoombox: 'view', trace: 'view', distance: 'measure', length: 'measure', area: 'measure',
  select: 'markup', pen: 'markup', line: 'markup', arrow: 'markup', rect: 'markup', ellipse: 'markup',
  cloud: 'markup', callout: 'markup', highlight: 'markup',
  eselect: 'edit', eline: 'edit', epoly: 'edit', erect: 'edit', ecircle: 'edit', etext: 'edit',
};
const MEASURE_TOOLS = new Set(['distance', 'length', 'area']);
const MARKUP_TOOLS = new Set(['pen', 'line', 'arrow', 'rect', 'ellipse', 'cloud', 'callout', 'highlight']);
const HINTS = {
  zoombox: 'Drag a box around the area to zoom into',
  trace: 'Click a wire to light up everything connected to it · drag pans · Esc clears',
  distance: 'Click two points to measure the distance between them',
  length: 'Click points along the path · double-click or Enter to finish',
  area: 'Click the corners of the shape · double-click, Enter or click the first point to finish',
  select: 'Click a markup to select it · drag to move · Delete to remove · double-click a callout to edit',
  pen: 'Draw freehand',
  line: 'Drag to draw a line',
  arrow: 'Drag from the tail to the tip',
  rect: 'Drag from corner to corner',
  ellipse: 'Drag from corner to corner',
  cloud: 'Drag a box to cloud it, or click corners and double-click to finish',
  callout: 'Press on the item, drag to where the note goes, release and type',
  highlight: 'Drag over the area to highlight',
  ...EDIT_HINTS,
};
/** Touch wording (no mouse clicks, Enter or Delete keys on a phone). */
const TOUCH_TOOL_HINTS = {
  distance: 'Tap two points to measure the distance between them',
  trace: 'Tap a wire to light up everything connected to it',
  length: 'Tap points along the path · Finish when done',
  area: 'Tap the corners of the shape · Finish (or tap the first point) when done',
  select: 'Tap a markup to select it · drag to move · double-tap a callout to edit',
  cloud: 'Drag a box to cloud it, or tap corners and then Finish',
  ...TOUCH_HINTS,
};
/** Tools that show what is under the cursor. */
const hovers = (t) => t === 'pan' || t === 'select' || t === 'trace';
const SNAP_LABEL = { endpoint: 'End', midpoint: 'Middle', center: 'Centre', intersection: 'Crossing', nearest: 'On line' };
const plural = (n, word) => `${fmtNum(n, 0)} ${word}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------ state
const app = {
  doc: null, // { name, size, format }
  scene: null,
  view: new Viewport(),
  renderer: null,
  theme: 'dark',
  tool: 'pan',
  prevTool: 'pan',
  snapOn: true,
  precision: 2,
  author: '',
  color: '#e5262b',
  width: 2,
  layerVisible: null,
  markups: [],
  history: new History(),
  selected: null,
  measures: [],
  mdraft: null, // { mode, pts: [] } world coords
  draft: null, // markup draft
  cursor: null, // { sx, sy, wx, wy (world abs), snap }
  hover: null,
  hoverPath: null,
  spaceDown: false,
  interacting: false,
  baseDirty: true,
  raf: 0,
  lastBaseMs: 0,
  lastBaseAt: 0,
  lastBaseView: null,
  stats: null,
  frames: 0,
  dpr: 1,
  loading: false,
  pendingCallout: null,
  editing: null,
};
window.__linework = app; // test/automation hook (read-only use)
let edit = null; // Edit mode controller (src/app/edit-ui.js), created at start-up
// modules loaded after start-up (files, compare) hook in here: a drawing opened, the history changed, the overlay is drawn
const hooks = app.hooks = { open: [], history: [], draw: [] };
const fire = (k, x) => { for (const f of hooks[k]) f(x); };

const stage = $('#stage');
const cvDrawing = $('#cv-drawing');
const cvOverlay = $('#cv-overlay');
const octx = cvOverlay.getContext('2d');
app.renderer = new Canvas2DRenderer(cvDrawing);
const layersPanel = new LayersPanel((vis) => { app.layerVisible = vis; app.hover = null; if (edit) edit.visibilityChanged(); invalidate(true); }, {
  label: (n) => app.layerLabel(n), names: (...a) => { if (app.doc) tools('names', ...a); },
});

// ------------------------------------------------------------------ coordinates
const origin = () => (app.scene ? app.scene.origin : [0, 0]);
/** world (absolute drawing coords) -> CSS px for a given view */
const toScreenFor = (view) => { const [ox, oy] = origin(); return (x, y) => view.toScreen(x - ox, y - oy); };
const screenToWorld = (sx, sy) => { const [x, y] = app.view.toWorld(sx, sy); const [ox, oy] = origin(); return [x + ox, y + oy]; };
app.worldToScreen = (x, y) => toScreenFor(app.view)(x, y);
app.screenToWorld = screenToWorld;

// ------------------------------------------------------------------ rendering
app.renderOpts = () => ({ theme: app.theme, layerVisible: app.layerVisible, showText: true });

function invalidate(base = false) {
  if (base) app.baseDirty = true;
  if (!app.raf) app.raf = requestAnimationFrame(frame);
}
app.invalidate = invalidate;
let settleTimer = 0;
function interact() {
  app.interacting = true;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { app.interacting = false; invalidate(true); }, 140);
}

function frame() {
  app.raf = 0;
  const now = performance.now();
  // Real frame cost includes GPU/raster time the CPU timer cannot see: if consecutive full
  // renders during a gesture leave long gaps between frames, treat the drawing as heavy.
  if (app.lastWasFull && app.interacting && app.lastFrameAt) {
    const dt = now - app.lastFrameAt;
    app.heavy = dt > 30 ? Math.min(4, (app.heavy || 0) + 1) : Math.max(0, (app.heavy || 0) - 1);
  }
  app.lastFrameAt = now;
  app.lastWasFull = false;
  if (app.baseDirty) {
    const heavy = app.lastBaseMs > 18 || app.heavy >= 2 || app.fullCost > 34;
    // heavy drawings: no full re-render until the gesture settles (avoids periodic hitches)
    if (app.scene && app.interacting && heavy && app.lastBaseView) {
      // heavy drawing: move the last full render with a CSS transform until the gesture settles
      cvDrawing.style.transform = cssTransformBetween(app.lastBaseView, app.view);
    } else {
      const r = app.renderer.render(app.view, { ...app.renderOpts(), budgetMs: 14 });
      app.stats = r;
      app.lastBaseMs = r.ms;
      app.lastBaseAt = now;
      app.lastBaseView = app.view.snapshot();
      cvDrawing.style.transform = '';
      app.baseDirty = !!r.incomplete; // geometry still being prepared: keep drawing next frame
      if (r.incomplete) invalidate(true);
      else if (!app.interacting) {
        // measure what a full frame really costs here (CPU + raster): time to the next frame
        const t1 = performance.now();
        requestAnimationFrame(() => { app.fullCost = performance.now() - t1; });
      }
      app.lastWasFull = true;
      $('#st-perf').textContent = app.scene ? `${r.ms.toFixed(1)} ms` : '';
    }
    updateZoomLabel();
  }
  drawOverlay();
  app.frames++;
}

function resize() {
  const r = stage.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  app.dpr = dpr;
  const oldW = app.view.w, oldH = app.view.h;
  app.view.setSize(r.width, r.height);
  app.renderer.resize(r.width, r.height, dpr);
  cvOverlay.width = Math.max(1, Math.round(r.width * dpr));
  cvOverlay.height = Math.max(1, Math.round(r.height * dpr));
  if (app.scene && app.fitPending) { app.view.fit(app.scene.fitBox); app.fitPending = false; }
  else if (app.scene && (oldW !== r.width || oldH !== r.height)) { /* keep centre and scale */ }
  app.lastBaseView = null;
  invalidate(true);
}
new ResizeObserver(resize).observe(stage);

function updateZoomLabel() {
  if (!app.scene) { $('#st-zoom').textContent = ''; return; }
  const fitV = new Viewport();
  fitV.setSize(app.view.w, app.view.h);
  fitV.fit(app.scene.fitBox);
  $('#st-zoom').textContent = `Zoom ${fmtNum((app.view.scale / fitV.scale) * 100, 0)}%`;
}

// ------------------------------------------------------------------ overlay (markups, measurements, snap)
const accent = () => (app.theme === 'paper' ? '#0062d6' : '#2bd1ff');
const snapColor = () => (app.theme === 'paper' ? '#d9480f' : '#ffd23f');

function drawOverlay() {
  const ctx = octx;
  const dpr = app.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cvOverlay.width, cvOverlay.height);
  if (!app.scene) return;
  // hover highlight (drawing primitive) in scene coordinates
  if (app.hover && hovers(app.tool) && !app.draft) {
    const M = app.view.matrix(dpr);
    ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    ctx.strokeStyle = accent();
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 3 / app.view.scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (app.hover.isText) {
      const b = app.scene.texts[app.hover.id - TEXT_ID].bbox;
      ctx.lineWidth = 1.5 / app.view.scale;
      ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
    } else {
      if (!app.hoverPath || app.hoverPath.id !== app.hover.id) app.hoverPath = { id: app.hover.id, path: primPath(app.scene, app.hover.id) };
      ctx.stroke(app.hoverPath.path);
    }
    ctx.globalAlpha = 1;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawAnnotations(ctx, app.view, { theme: app.theme, live: true });
  edit.drawOverlay(ctx);
  fire('draw', ctx);
  if (app.tools) app.tools.drawOverlay(ctx);
}

function drawAnnotations(ctx, view, opts = {}) {
  const toS = toScreenFor(view);
  const boxFill = opts.theme === 'paper' ? 'rgba(255,255,255,0.94)' : 'rgba(20,24,30,0.9)';
  for (const m of app.markups) drawMarkup(ctx, m, toS, view.scale, { boxFill });
  if (opts.live) {
    // selection outline
    const sel = app.markups.find((m) => m.id === app.selected);
    if (sel) {
      const b = markupScreenBox(ctx, sel, toS, view.scale);
      ctx.save();
      ctx.strokeStyle = accent();
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(b[0] - 3, b[1] - 3, b[2] - b[0] + 6, b[3] - b[1] + 6);
      ctx.restore();
    }
    const d = draftMarkup();
    if (d) drawMarkup(ctx, d, toS, view.scale, { boxFill });
  }
  // measurements
  const col = opts.theme === 'paper' ? '#0062d6' : '#2bd1ff';
  const fs = opts.fontScale || 1;
  for (const m of app.measures) drawMeasure(ctx, toS, m.mode, m.pts, col, fs, false);
  if (opts.live && app.mdraft && app.mdraft.pts.length) {
    const pts = app.mdraft.pts.slice();
    if (app.cursor) pts.push(app.cursor.wx, app.cursor.wy);
    drawMeasure(ctx, toS, app.mdraft.mode, pts, col, fs, true);
  }
  if (opts.live) {
    if (app.zoomBox) {
      const z = app.zoomBox;
      ctx.save();
      ctx.strokeStyle = accent();
      ctx.fillStyle = accent();
      ctx.globalAlpha = 0.12;
      ctx.fillRect(Math.min(z.x0, z.x1), Math.min(z.y0, z.y1), Math.abs(z.x1 - z.x0), Math.abs(z.y1 - z.y0));
      ctx.globalAlpha = 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(Math.min(z.x0, z.x1), Math.min(z.y0, z.y1), Math.abs(z.x1 - z.x0), Math.abs(z.y1 - z.y0));
      ctx.restore();
    }
    if (app.cursor && app.cursor.snap && MEASURE_TOOLS.has(app.tool)) drawSnapGlyph(ctx, app.cursor.sx, app.cursor.sy, app.cursor.snap.kind);
  }
}
app.drawAnnotations = drawAnnotations;

function drawMeasure(ctx, toS, mode, pts, col, fs, live) {
  const S = [];
  for (let i = 0; i < pts.length; i += 2) S.push(...toS(pts[i], pts[i + 1]));
  const n = S.length / 2;
  if (!n) return;
  ctx.save();
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  if (n >= 2) {
    ctx.beginPath();
    ctx.moveTo(S[0], S[1]);
    for (let i = 1; i < n; i++) ctx.lineTo(S[2 * i], S[2 * i + 1]);
    if (mode === 'area' && n >= 3) {
      ctx.closePath();
      ctx.globalAlpha = 0.14;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (live) ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (let i = 0; i < n; i++) {
    ctx.beginPath();
    ctx.arc(S[2 * i], S[2 * i + 1], 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  const r = measure(mode, pts);
  if (r) {
    const label = describe(r, app.precision, app.scene.units.abbr);
    let lx, ly;
    if (mode === 'area') { lx = 0; ly = 0; for (let i = 0; i < n; i++) { lx += S[2 * i]; ly += S[2 * i + 1]; } lx /= n; ly /= n; }
    else if (mode === 'distance') { lx = (S[0] + S[2]) / 2; ly = (S[1] + S[3]) / 2 - 14; }
    else { lx = S[2 * n - 2] + 12; ly = S[2 * n - 1] - 14; }
    pill(ctx, label, lx, ly, col, fs);
  }
  ctx.restore();
}

function pill(ctx, text, x, y, col, fs = 1) {
  ctx.save();
  ctx.font = `600 ${Math.round(13 * fs)}px system-ui, "Segoe UI", Roboto, Arial, sans-serif`;
  const w = ctx.measureText(text).width + 14 * fs, h = 22 * fs;
  ctx.fillStyle = col;
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2); else ctx.rect(x - w / 2, y - h / 2, w, h);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = col === '#2bd1ff' ? '#04212b' : '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

function drawSnapGlyph(ctx, x, y, kind) {
  ctx.save();
  ctx.strokeStyle = snapColor();
  ctx.fillStyle = snapColor();
  ctx.lineWidth = 2;
  const s = 7;
  ctx.beginPath();
  if (kind === 'endpoint') ctx.rect(x - s, y - s, 2 * s, 2 * s);
  else if (kind === 'midpoint') { ctx.moveTo(x, y - s - 1); ctx.lineTo(x + s + 1, y + s); ctx.lineTo(x - s - 1, y + s); ctx.closePath(); }
  else if (kind === 'center') ctx.arc(x, y, s, 0, Math.PI * 2);
  else if (kind === 'intersection') { ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s); ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s); }
  else { ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y - s); ctx.lineTo(x - s, y + s); ctx.lineTo(x + s, y + s); ctx.closePath(); }
  ctx.stroke();
  ctx.font = '600 11px system-ui, "Segoe UI", Arial, sans-serif';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 3;
  ctx.strokeStyle = app.theme === 'paper' ? '#fff' : '#000';
  ctx.strokeText(SNAP_LABEL[kind] || kind, x + 10, y + 8);
  ctx.fillText(SNAP_LABEL[kind] || kind, x + 10, y + 8);
  ctx.restore();
}

// ------------------------------------------------------------------ loading
let worker = null; // null: start one when needed; false: module workers unavailable (read on the main thread)
let jobSeq = 0;
const jobs = new Map();
const failJobs = (message, code) => {
  for (const [, job] of jobs) job.reject(Object.assign(new Error(message), { code }));
  jobs.clear();
  modelParts.clear();
  for (const [, w] of modelWaiters) w(null);
  modelWaiters.clear();
};
function getWorker() {
  if (worker === false) return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    // `started` settles true once the reader answers (it then gets the file's bytes without a copy),
    // false if it cannot run here
    let settle;
    w.started = new Promise((res) => { settle = res; });
    w.stop = () => settle('stopped');
    w.onmessage = (ev) => {
      w.alive = true;
      settle(true);
      const m = ev.data;
      if (m.type === 'pong') return;
      if (m.type === 'model-part' || m.type === 'model') { modelMessage(m); return; }
      const job = jobs.get(m.id);
      if (!job) return;
      if (m.type === 'progress') {
        job.progress(m.phase, m.fraction);
        // a DWG read blocks the worker: limit its time (a new worker starts next time)
        if (m.watch) job.timer = setTimeout(() => { worker?.terminate?.(); worker = null; jobs.clear(); job.reject(Object.assign(new Error('This DWG took too long to read; save it as DXF and open that.'), { code: 'dwg-timeout' })); }, app.readTimeLimitMs);
      } else { jobs.delete(m.id); clearTimeout(job.timer); if (m.type === 'done') job.resolve(Object.assign(unpackTexts(m.scene), { jobId: m.id })); else job.reject(Object.assign(new Error(m.message), { code: m.code })); }
    };
    w.onerror = (e) => {
      e.preventDefault?.();
      // never answered: this browser cannot run it, read on the main thread from now on; it crashed on
      // a file (e.g. out of memory): that file fails, the next one gets a fresh reader
      if (w.alive) failJobs('The reader stopped while opening this file. It may be damaged or too large for this device.', 'crash');
      else failJobs('The background reader failed to start.', 'worker');
      try { w.terminate(); } catch { /* ignore */ }
      if (worker === w) worker = w.alive ? null : false;
      settle(false);
    };
    w.postMessage({ type: 'ping' });
    worker = w;
  } catch {
    worker = false;
  }
  return worker || null;
}
/** Stop the reader (Cancel, or another file replaces the one opening): the next file starts a new one. */
function stopReader(message) {
  if (worker) { try { worker.terminate(); } catch { /* ignore */ } worker.stop(); worker = null; }
  failJobs(message, 'cancelled');
}

app.readTimeLimitMs = 120000;

// the drawing model (for editing/saving) follows the scene in pieces; see worker.js
const modelParts = new Map();
const modelWaiters = new Map(); // job -> callback: the model of a file read but not shown (compare, save over the original)
function modelMessage(m) {
  if (m.type === 'model-part') { if (!modelParts.has(m.id)) modelParts.set(m.id, []); modelParts.get(m.id).push(m.entities); return; }
  const parts = modelParts.get(m.id) || [];
  modelParts.delete(m.id);
  const entities = parts.length === 1 ? parts[0] : parts.flat(); // (no spread: thousands of parts)
  gotModel(m.id, { ...m.meta, entities, paperEntities: m.paperEntities || [] }, m.bytes ? new Uint8Array(m.bytes) : null);
}
function gotModel(id, model, bytes) {
  const w = modelWaiters.get(id);
  if (w) { modelWaiters.delete(id); w({ model, bytes }); } else if (app.scene && app.scene.jobId === id) edit.setModel(model, bytes);
}
/** Read a drawing without showing it: { scene, model, bytes } (bytes: DGN only). Cancel stops it. */
app.readDrawing = async (name, buffer) => {
  if (app.loading) throw new Error('Another drawing is still opening.');
  const my = ++loadSeq;
  app.loading = true;
  $('#btn-cancel-load').hidden = false;
  showProgress(`Reading ${name}…`, 0);
  try {
    const scene = await parseOffThread(name, buffer, null, (phase, f) => showProgress(`${phase} ${name}…`, f));
    const got = await new Promise((res) => modelWaiters.set(scene.jobId, res));
    if (!got) throw new Error('The reader stopped.');
    return { scene, ...got };
  } finally {
    if (my === loadSeq) { app.loading = false; hideProgress(); }
  }
};
/** Show a drawing read by readDrawing (src as for openDrawing; keep: true keeps the view, layers and markups). */
app.showDrawing = (r, name, src) => { setDocument(r.scene, name, r.scene.fileSize, 0, src); edit.setModel(r.model, r.bytes); };

async function parseOffThread(name, buffer, sample, progress, page) {
  const w = getWorker();
  const ok = w && (w.alive || (await w.started));
  if (ok === 'stopped') throw Object.assign(new Error('Opening was cancelled.'), { code: 'cancelled' });
  if (ok) {
    try {
      return await new Promise((resolve, reject) => {
        const id = ++jobSeq;
        jobs.set(id, { resolve, reject, progress });
        w.postMessage({ id, name, buffer, sample, page }, buffer ? [buffer] : []);
      });
    } catch (e) {
      if (e.code !== 'worker') throw e;
    }
  }
  // fallback: same code on the main thread (e.g. module workers unsupported); it cannot be cancelled
  $('#btn-cancel-load').hidden = true;
  const { loadInWorkerScope } = await import('./worker.js');
  progress('Reading', 0.1);
  await new Promise((r) => setTimeout(r, 30));
  const r = await loadInWorkerScope({ id: 0, name, buffer, sample, page }, () => {});
  const id = 'local-' + ++jobSeq;
  r.scene.jobId = id;
  setTimeout(() => gotModel(id, r.model, r.bytes), 0);
  return r.scene;
}

function showProgress(label, f) {
  $('#progress').hidden = false;
  $('#progress-label').textContent = label;
  $('#progress-fill').style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
}
const hideProgress = () => { $('#progress').hidden = true; };

/** Opening another drawing drops unsaved edits: ask first. */
function okToReplace() {
  return !(edit && edit.dirty) || window.confirm('The drawing has unsaved edits. Open another drawing anyway?');
}

let loadSeq = 0;
async function openDrawing(name, buffer, size, sample, src = {}) {
  if (app.loading) stopReader('Replaced by another file.'); // a new file replaces the one still opening
  if (buffer && !src.blob) src = { ...src, blob: new Blob([buffer]) }; // the file (a PDF's other pages are read from it)
  const my = ++loadSeq;
  app.loading = true;
  $('#btn-cancel-load').hidden = false;
  showProgress(`Opening ${name}…`, 0);
  const t0 = performance.now();
  try {
    const scene = await parseOffThread(name, buffer, sample, (phase, f) => { if (my === loadSeq) showProgress(`${phase} ${name}…`, f); }, src.page);
    if (my !== loadSeq) return;
    setDocument(scene, name, size ?? scene.fileSize, performance.now() - t0, src);
  } catch (e) {
    if (my !== loadSeq) return;
    if (e && e.code === 'cancelled') { toast(`Stopped opening ${name}`, { key: 'open', timeout: 2500 }); return; }
    const msg = e && e.message ? e.message : String(e);
    toast(msg, { kind: 'error' });
  } finally {
    if (my === loadSeq) { app.loading = false; hideProgress(); }
  }
}
app.openDrawing = openDrawing;
/** Cancel button on the progress card: stop reading, nothing changes. */
function cancelOpen() { if (app.loading) stopReader('Opening was cancelled.'); }
app.cancelOpen = cancelOpen;

/** src: { handle, dir } when the browser gave a file handle (Save can then write the file itself). */
async function openFile(file, src) {
  if (!file) return;
  if (/\.json$/i.test(file.name)) { await loadMarkupFile(file); return; }
  if (!okToReplace()) return;
  if (file.size > 400 * 1024 * 1024) { toast('This file is too large to open in the browser (over 400 MB).', { kind: 'error' }); return; }
  let buf;
  try { buf = await readFileAsArrayBuffer(file); } catch { toast(`Could not read ${file.name}`, { kind: 'error', detail: 'The file could not be read from this device (moved, locked or not allowed).' }); return; }
  await openDrawing(file.name, buf, file.size, undefined, { ...src, modified: src ? file.lastModified : undefined, blob: file });
}
app.openFile = openFile;
/** Open: the browser's file picker when there is one (it gives a handle), else the plain chooser. */
const pickFile = () => (app.files ? app.files.pick() : $('#file-input').click());

async function openSample(key) {
  if (!okToReplace()) return;
  if (key === 'stress') return openDrawing('stress-test-53k.dxf', null, null, 'stress', { sample: key });
  try {
    const res = await fetch(key);
    if (!res.ok) throw new Error(res.statusText);
    const buf = await res.arrayBuffer();
    return openDrawing(key.split('/').pop(), buf, buf.byteLength, undefined, { sample: key });
  } catch {
    toast('Could not load the sample. If you opened index.html directly from disk, run a local web server instead (see README).', { kind: 'error' });
  }
}
app.openSample = openSample;

/**
 * Show a drawing. src: where it came from ({ handle, dir, modified, sample }); src.keep: the same
 * drawing read again after Save wrote it (view, hidden layers and markups stay, no open notes).
 */
function setDocument(scene, name, size, ms, src = {}) {
  const keep = src.keep && app.scene ? { view: app.view.snapshot(), markups: app.markups, key: autosaveKey(), off: new Set(app.scene.layers.filter((l, i) => app.layerVisible && !app.layerVisible[i]).map((l) => l.name)) } : null;
  if (keep) for (const l of scene.layers) if (keep.off.has(l.name)) l.visible = false;
  const st = !keep && src.state; // a sheet of a set shown before (src/app/sheets.js): its view and hidden layers
  if (st) for (const l of scene.layers) l.visible = !st.off.includes(l.name);
  app.scene = scene;
  app.doc = { ...src, name, size, format: scene.format, hash: scene.hash || '', keep: !!keep };
  app.renderer.setScene(scene);
  app.layerVisible = Uint8Array.from(scene.layers.map((l) => (l.visible ? 1 : 0)));
  app.levelNames = loadLevelNames();
  layersPanel.setLayers(scene.layers, scene.format === 'DGN');
  const wide = window.innerWidth >= 1100;
  if (!keep) setLayersOpen(wide && scene.layers.filter((l) => l.count).length > 1);
  $('#empty').hidden = true;
  resize(); // layout may have changed (layers panel); fit to the real stage size
  app.view.setLimits(scene.extents);
  if (keep) app.view.restore(keep.view); else if (st) app.view.restore(st.view); else app.view.fit(scene.fitBox);
  app.heavy = 0;
  app.hover = null; app.hoverPath = null; app.selected = null;
  app.measures = []; app.mdraft = null; app.draft = null;
  app.history.clear();
  app.markups = keep ? keep.markups : [];
  edit.reset();
  if (app.tools) app.tools.docChanged();
  if (EDIT_TOOLS.has(app.tool)) setTool(app.tool);
  $('#empty').hidden = true;
  $('#docinfo').hidden = false;
  $('#doc-name').textContent = name;
  $('#doc-name').title = `${name} · ${fmtBytes(size)} · ${scene.format}${scene.version ? ' ' + scene.version : ''}`;
  $('#doc-units').textContent = scene.units.abbr || 'unitless';
  $('#doc-units').title = `Drawing units: ${scene.units.name}`;
  document.title = `${name} · ${APP_NAME}`;
  for (const b of ['#btn-export', '#btn-print']) $(b).disabled = false;
  const nLayers = listedLayers(scene.layers).length; // the same count as the Layers panel
  cvOverlay.setAttribute('aria-label', `Drawing ${name}: ${plural(nLayers, 'layer')}, ${plural(scene.n + scene.textCount, 'item')}. Use the toolbar to pan, zoom, measure and mark up.`);
  if (keep) { if (keep.key !== autosaveKey()) storage.del(keep.key); autosave(); } else restoreAutosave(); // markups follow the saved file
  updateUndoButtons();
  invalidate(true);
  fire('open', app.doc);
  if (keep) return;

  const items = scene.n + scene.textCount;
  const ns = Object.entries(scene.notShown);
  const nsCount = ns.reduce((s, [, v]) => s + v, 0);
  const notes = [...scene.warnings];
  for (const k of ['open', 'skipped']) for (const el of document.querySelectorAll(`#toasts [data-key="${k}"]`)) el.remove();
  const pg = scene.page;
  if (!src.sheet) toast(`Opened ${name}${pg && pg.count > 1 ? `, page ${pg.label || pg.n} of ${pg.count}` : ''}`, { key: 'open', detail: `${plural(items, 'item')} · ${plural(nLayers, scene.format === 'DGN' ? 'level' : 'layer')} · ${scene.units.abbr || 'no units'} · ${Math.round(ms)} ms`, timeout: 3500 });
  if (nsCount) {
    toast(`${fmtNum(nsCount, 0)} item${nsCount === 1 ? '' : 's'} not shown`, {
      key: 'skipped', kind: 'warn', detail: 'Everything else loaded normally.', listTitle: 'What was skipped',
      list: ns.sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).concat(notes),
    });
  } else if (notes.length) {
    toast(notes[0], { key: 'skipped', kind: 'warn', list: notes.slice(1) });
  }
  if (scene.fitBox.outliers) toast('A few items lie far away from the rest; Fit shows the main drawing.', { timeout: 6000 });
}

// ------------------------------------------------------------------ markups: storage
// Markups are kept in this browser per drawing: name + size + a hash of the file's content (two
// revisions of a drawing often have the same name and size).
const AUTOSAVE = 'linework:autosave:';
const autosaveKey = () => app.doc && `${AUTOSAVE}${app.doc.name}:${app.doc.size}:${app.doc.hash}`;
let persistAsked = false, autosaveWarned = false;
function autosave() {
  const k = autosaveKey();
  if (!k) return;
  if (!app.markups.length) { storage.del(k); return; }
  if (storage.set(k, serializeMarkups(docMeta(), app.markups))) {
    // ask once (never blocks) that the browser keeps this storage when space runs low
    if (!persistAsked && navigator.storage && navigator.storage.persist) { persistAsked = true; navigator.storage.persist().catch(() => {}); }
  } else if (!autosaveWarned) {
    autosaveWarned = true;
    toast('Markups could not be kept in this browser', { key: 'autosave', kind: 'warn', timeout: 10000, detail: 'Its storage is full or blocked. Use Markup › Save to keep them in a file.' });
  }
}
/** Remove every set of markups kept in this browser (Help › Clear stored markups). Returns how many. */
function clearStoredMarkups() {
  let n = 0;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith(AUTOSAVE)) { localStorage.removeItem(k); n++; } }
  } catch { /* storage blocked */ }
  return n;
}
app.clearStoredMarkups = clearStoredMarkups;
function restoreAutosave() {
  autosaveWarned = false;
  const k = autosaveKey();
  let s = k && storage.get(k);
  if (!s && k) { // kept by an older version, under name + size only: move it to the new key
    const old = `${AUTOSAVE}${app.doc.name}:${app.doc.size}`;
    s = storage.get(old);
    if (s) { storage.del(old); storage.set(k, s); }
  }
  if (!s) return;
  try {
    const r = parseMarkups(s);
    if (r.markups.length) {
      app.markups = r.markups;
      toast(`Restored ${r.markups.length} markup${r.markups.length === 1 ? '' : 's'} from your last session`, {
        detail: 'Kept in this browser only. Use Markup › Save to keep a file.',
        actions: [{ label: 'Discard', onClick: () => { app.history.record(app.markups); app.markups = []; autosave(); updateUndoButtons(); invalidate(); } }],
      });
    }
  } catch { storage.del(k); }
}
const docMeta = () => ({ name: app.doc?.name, size: app.doc?.size, format: app.doc?.format, units: app.scene?.units.abbr || '' });

function saveMarkups() {
  if (!app.doc) return;
  const json = serializeMarkups(docMeta(), app.markups);
  download(new Blob([json], { type: 'application/json' }), sidecarName(app.doc.name));
  toast(`Saved ${app.markups.length} markup${app.markups.length === 1 ? '' : 's'}`, { detail: `Keep ${sidecarName(app.doc.name)} next to the drawing.` });
}
app.saveMarkups = saveMarkups;

async function loadMarkupFile(file) {
  if (!app.doc) { toast('Open the drawing first, then load its markups.', { kind: 'warn' }); return; }
  try {
    const r = parseMarkups(await file.text());
    app.history.record(app.markups);
    const ids = new Set(app.markups.map((m) => m.id));
    const added = r.markups.filter((m) => !ids.has(m.id));
    app.markups = [...app.markups, ...added];
    autosave();
    updateUndoButtons();
    invalidate();
    const other = r.drawing.name && r.drawing.name !== app.doc.name;
    toast(`Loaded ${added.length} markup${added.length === 1 ? '' : 's'}`, {
      kind: other || r.warnings.length ? 'warn' : 'info',
      detail: other ? `These markups were made on “${r.drawing.name}”.` : undefined,
      list: r.warnings,
    });
  } catch (e) {
    toast(e.message || 'Could not read the markup file.', { kind: 'error' });
  }
}

// ------------------------------------------------------------------ markups: editing
function commit(fn) {
  app.history.record(app.markups);
  fn();
  autosave();
  updateUndoButtons();
  invalidate();
}
function addMarkup(m) { commit(() => { app.markups = [...app.markups, m]; }); }
function undo() {
  const prev = app.history.undo(app.markups);
  if (!prev) return;
  if (prev.kind === 'edit') { edit.revert(prev); updateUndoButtons(); return; }
  app.markups = prev;
  if (!prev.some((m) => m.id === app.selected)) app.selected = null;
  autosave(); updateUndoButtons(); invalidate();
}
function redo() {
  const next = app.history.redo(app.markups);
  if (!next) return;
  if (next.kind === 'edit') { edit.reapply(next); updateUndoButtons(); return; }
  app.markups = next;
  autosave(); updateUndoButtons(); invalidate();
}
app.undo = undo; app.redo = redo;
function updateUndoButtons() {
  for (const b of $$('[data-action="undo"]')) b.disabled = !app.history.canUndo();
  for (const b of $$('[data-action="redo"]')) b.disabled = !app.history.canRedo();
  fire('history');
}
function deleteSelected() {
  if (!app.selected) return false;
  const id = app.selected;
  commit(() => { app.markups = app.markups.filter((m) => m.id !== id); });
  app.selected = null;
  updateSelectionStatus();
  return true;
}
function restyleSelected(props) {
  const i = app.markups.findIndex((m) => m.id === app.selected);
  if (i < 0) return;
  commit(() => {
    const m = { ...app.markups[i], ...props, modified: new Date().toISOString() };
    if (props.width && m.type === 'highlight') m.width = Math.max(10, props.width * 6);
    app.markups = app.markups.map((x, k) => (k === i ? m : x));
  });
}

function markupProps(type) {
  const p = { color: app.color, width: app.width, author: app.author };
  if (type === 'highlight') {
    p.width = Math.max(10, app.width * 6);
    if (app.color === '#e5262b') p.color = '#ffd400';
  }
  return p;
}

function draftMarkup() {
  const d = app.draft;
  if (!d) {
    if (app.pendingCallout) return createMarkup('callout', app.pendingCallout.pts, { ...markupProps('callout'), text: $('#ta-callout').value || ' ', size: app.pendingCallout.size });
    return null;
  }
  const P = markupProps(d.type);
  switch (d.type) {
    case 'pen': case 'highlight': return d.pts.length >= 4 ? createMarkup(d.type, d.pts, P) : null;
    case 'line': case 'arrow': return createMarkup(d.type, [...d.a, ...d.b], P);
    case 'rect': return createMarkup('rect', rectCorners(d.a[0], d.a[1], d.b[0], d.b[1]), P);
    case 'ellipse': return createMarkup('ellipse', [...d.a, ...d.b], P);
    case 'cloud': return createMarkup('cloud', rectCorners(d.a[0], d.a[1], d.b[0], d.b[1]), { ...P, arc: 16 / app.view.scale });
    case 'cloud-poly': {
      const pts = d.pts.slice();
      if (app.cursor) pts.push(app.cursor.wx, app.cursor.wy);
      return pts.length >= 6 ? createMarkup('cloud', pts, { ...P, arc: 16 / app.view.scale }) : createMarkup('line', pts.length >= 4 ? pts : [...pts, ...pts], P);
    }
    case 'callout': return createMarkup('callout', [...d.a, ...d.b], { ...P, text: ' ', size: 14 / app.view.scale });
    default: return null;
  }
}

// ------------------------------------------------------------------ tools
function setTool(t) {
  if (!TOOL_GROUP[t]) return;
  cancelDrafts();
  if (t !== 'zoombox') app.prevTool = t;
  app.tool = t;
  for (const b of $$('.tool[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  selectTab(TOOL_GROUP[t]);
  if (!MARKUP_TOOLS.has(t) && t !== 'select') app.selected = null;
  cvOverlay.className = t === 'pan' ? '' : t === 'select' || t === 'eselect' ? 'pointer' : 'crosshair';
  restoreHint();
  edit.toolChanged(t);
  if (t === 'trace') trace('tool'); // (loads the tool and finds the wires before the first click)
  if (app.tools) app.tools.toolChanged();
  updateMeasureCard();
  updateFinishBar();
  updateSelectionStatus();
  invalidate();
}
app.setTool = setTool;

function restoreHint() {
  const hint = $('#tool-hint');
  const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  const text = (touch && TOUCH_TOOL_HINTS[app.tool]) || HINTS[app.tool] || '';
  hint.hidden = !text || !app.scene;
  hint.textContent = text;
}

// toasts sit below the tool hint, which wraps to several lines on a phone (app.css: --hint-bottom)
{
  const h = $('#tool-hint');
  const place = () => stage.style.setProperty('--hint-bottom', h.hidden ? '0px' : `${Math.round(h.offsetTop + h.offsetHeight)}px`);
  new ResizeObserver(place).observe(h);
  new MutationObserver(place).observe(h, { attributes: true, attributeFilter: ['hidden'] });
}

function selectTab(name) {
  for (const tab of $$('[role="tab"]')) {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  for (const p of $$('[role="tabpanel"]')) p.hidden = p.dataset.panel !== name;
}

function cancelDrafts() {
  app.draft = null;
  app.mdraft = null;
  app.zoomBox = null;
  if (app.pendingCallout) closeTextEditor(false);
  updateFinishBar();
}

function updateFinishBar() {
  const active = (app.mdraft && app.mdraft.mode !== 'distance' && app.mdraft.pts.length > 0) || (app.draft && app.draft.type === 'cloud-poly') || (edit && edit.draftActive);
  $('#finish-bar').hidden = !active;
  const placing = !!(edit && edit.placing); // pasted / duplicated items following the cursor
  $('#btn-undo-point').hidden = placing;
  $('#btn-finish').lastChild.textContent = placing ? 'Place' : 'Finish';
}

function updateMeasureCard() {
  const card = $('#measure-card');
  const isMeasure = MEASURE_TOOLS.has(app.tool);
  if (!app.scene || (!isMeasure && !app.measures.length)) { card.hidden = true; return; }
  card.hidden = false;
  const abbr = app.scene.units.abbr;
  let r = null, live = false;
  if (isMeasure && app.mdraft && app.mdraft.pts.length) {
    const pts = app.mdraft.pts.slice();
    if (app.cursor) pts.push(app.cursor.wx, app.cursor.wy);
    r = measure(app.mdraft.mode, pts);
    live = true;
  }
  if (!r && app.measures.length) { const m = app.measures[app.measures.length - 1]; r = measure(m.mode, m.pts); }
  const mode = r ? r.mode : app.tool;
  $('#mc-title').textContent = (live ? 'Measuring ' : '') + ({ distance: 'Distance', length: 'Length', area: 'Area' }[mode] || 'Measure');
  $('#mc-value').textContent = r ? describe(r, app.precision, abbr) : '—';
  $('#mc-detail').textContent = r ? details(r, app.precision, abbr) : '';
  $('#mc-hint').textContent = !abbr ? 'This drawing has no units set; values are in drawing units.' : '';
  $('#btn-copy-measure').disabled = !r;
}

function finishMeasure() {
  const d = app.mdraft;
  if (!d) return false;
  const need = d.mode === 'area' ? 6 : 4;
  if (d.pts.length < need) return false;
  app.measures.push({ mode: d.mode, pts: d.pts.slice() });
  d.pts = [];
  updateMeasureCard();
  updateFinishBar();
  invalidate();
  return true;
}

function finishCloudPoly() {
  const d = app.draft;
  if (!d || d.type !== 'cloud-poly') return false;
  if (d.pts.length >= 6) addMarkup(createMarkup('cloud', d.pts, { ...markupProps('cloud'), arc: 16 / app.view.scale }));
  app.draft = null;
  updateFinishBar();
  invalidate();
  return true;
}

function finishDraft() { return finishMeasure() || finishCloudPoly(); }
function undoPoint() {
  if (app.mdraft && app.mdraft.pts.length) { app.mdraft.pts.length -= 2; updateMeasureCard(); updateFinishBar(); invalidate(); return true; }
  if (app.draft && app.draft.type === 'cloud-poly') { app.draft.pts.length -= 2; if (!app.draft.pts.length) app.draft = null; updateFinishBar(); invalidate(); return true; }
  return false;
}

/** Snap-aware cursor update. sx, sy in CSS px. */
function updateCursor(sx, sy, pointerType) {
  if (!app.scene) return;
  const [lx, ly] = app.view.toWorld(sx, sy);
  const [ox, oy] = origin();
  let snap = null;
  if (MEASURE_TOOLS.has(app.tool) && app.snapOn) {
    const tolPx = pointerType === 'touch' ? 24 : 12;
    snap = findSnap(app.scene, lx, ly, tolPx / app.view.scale, { isVisible: (li) => !app.layerVisible || app.layerVisible[li] });
  }
  const wx = (snap ? snap.x : lx) + ox, wy = (snap ? snap.y : ly) + oy;
  const [csx, csy] = snap ? app.view.toScreen(snap.x, snap.y) : [sx, sy];
  app.cursor = { sx: csx, sy: csy, wx, wy, snap };
  const d = app.precision;
  $('#st-coords').textContent = `X ${fmtNum(wx, d)}   Y ${fmtNum(wy, d)}${app.scene.units.abbr ? ' ' + app.scene.units.abbr : ''}`;
  $('#st-snap').textContent = snap ? `Snap: ${SNAP_LABEL[snap.kind]}` : '';
}

function updateHover(sx, sy) {
  if (!app.scene || !hovers(app.tool)) { app.hover = null; return; }
  const [lx, ly] = app.view.toWorld(sx, sy);
  const h = pickItem(app.scene, lx, ly, 5 / app.view.scale, (li) => !app.layerVisible || app.layerVisible[li]);
  app.hover = h;
  if (app.tool === 'select' && app.selected) return;
  const s = app.scene;
  if (!h) { $('#st-info').textContent = ''; return; }
  if (h.isText) {
    const t = s.texts[h.id - TEXT_ID];
    $('#st-info').textContent = `Text “${t.s.slice(0, 60)}” · Layer ${app.layerLabel(s.layers[t.layer].name)}${t.blk ? ' · Block ' + s.blockNames[t.blk] : ''}`;
  } else {
    const type = (s.srcNames[s.src[h.id]] || '').replace(/_/g, ' ');
    $('#st-info').textContent = `${type.charAt(0) + type.slice(1).toLowerCase()} · Layer ${app.layerLabel(s.layers[s.layer[h.id]].name)}${s.blk[h.id] ? ' · Block ' + s.blockNames[s.blk[h.id]] : ''}`;
  }
  if (app.tools) app.tools.selChanged();
}

function updateSelectionStatus() {
  const m = app.markups.find((x) => x.id === app.selected);
  if (!m) { if (app.tool === 'select') $('#st-info').textContent = ''; return; }
  const when = new Date(m.modified || m.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  $('#st-info').textContent = `${m.type.charAt(0).toUpperCase() + m.type.slice(1)} · by ${m.author || 'unknown'} · ${when}`;
}

function hitMarkup(sx, sy, tol) {
  const toS = toScreenFor(app.view);
  for (let i = app.markups.length - 1; i >= 0; i--) {
    const m = app.markups[i];
    if (markupHitDistance(octx, m, toS, app.view.scale, sx, sy) <= tol) return m;
  }
  return null;
}

// tool pointer handlers (sx, sy in CSS px)
function toolDown(sx, sy, e) {
  if (EDIT_TOOLS.has(app.tool)) { edit.down(sx, sy, e); return; }
  const [wx, wy] = screenToWorld(sx, sy);
  const t = app.tool;
  if (t === 'zoombox') { app.zoomBox = { x0: sx, y0: sy, x1: sx, y1: sy }; return; }
  if (MEASURE_TOOLS.has(t)) {
    updateCursor(sx, sy, e.pointerType);
    const c = app.cursor;
    if (!app.mdraft || app.mdraft.mode !== t) app.mdraft = { mode: t, pts: [] };
    const d = app.mdraft;
    const n = d.pts.length / 2;
    if (n) { // ignore a repeated click on the same spot (double-click)
      const [px, py] = toScreenFor(app.view)(d.pts[2 * n - 2], d.pts[2 * n - 1]);
      if (Math.hypot(px - c.sx, py - c.sy) < 3) return;
    }
    if (t === 'area' && n >= 3) {
      const [fx, fy] = toScreenFor(app.view)(d.pts[0], d.pts[1]);
      if (Math.hypot(fx - c.sx, fy - c.sy) < 10) { finishMeasure(); return; }
    }
    d.pts.push(c.wx, c.wy);
    if (t === 'distance' && d.pts.length >= 4) finishMeasure();
    updateMeasureCard();
    updateFinishBar();
    invalidate();
    return;
  }
  if (t === 'select') {
    const m = hitMarkup(sx, sy, e.pointerType === 'touch' ? 14 : 7);
    app.selected = m ? m.id : null;
    app.drag = m ? { sx, sy, w0: [wx, wy], orig: m, moved: false } : null;
    if (m) cvOverlay.classList.add('move');
    updateSelectionStatus();
    invalidate();
    return;
  }
  if (!MARKUP_TOOLS.has(t)) return;
  if (app.draft && app.draft.type === 'cloud-poly') {
    const d = app.draft;
    const n = d.pts.length / 2;
    const toS = toScreenFor(app.view);
    const [lx, ly] = toS(d.pts[2 * n - 2], d.pts[2 * n - 1]);
    if (Math.hypot(lx - sx, ly - sy) < 3) return;
    const [fx, fy] = toS(d.pts[0], d.pts[1]);
    if (n >= 3 && Math.hypot(fx - sx, fy - sy) < 10) { finishCloudPoly(); return; }
    d.pts.push(wx, wy);
    updateFinishBar();
    invalidate();
    return;
  }
  if (t === 'pen' || t === 'highlight') app.draft = { type: t, pts: [wx, wy], last: [sx, sy] };
  else app.draft = { type: t, a: [wx, wy], b: [wx, wy], s0: [sx, sy] };
  invalidate();
}

function toolMove(sx, sy, e, pressed) {
  updateCursor(sx, sy, e.pointerType);
  const t = app.tool;
  if (EDIT_TOOLS.has(t)) { edit.move(sx, sy, e, pressed); return; }
  if (MEASURE_TOOLS.has(t)) { if (app.mdraft && app.mdraft.pts.length) updateMeasureCard(); invalidate(); return; }
  if (!pressed) {
    if (hovers(t)) updateHover(sx, sy);
    if (app.draft && app.draft.type === 'cloud-poly') invalidate();
    invalidate();
    return;
  }
  const [wx, wy] = screenToWorld(sx, sy);
  if (t === 'zoombox' && app.zoomBox) { app.zoomBox.x1 = sx; app.zoomBox.y1 = sy; invalidate(); return; }
  if (t === 'select' && app.drag) {
    const g = app.drag;
    if (!g.moved && Math.hypot(sx - g.sx, sy - g.sy) < 3) return;
    if (!g.moved) { app.history.record(app.markups); g.moved = true; }
    const moved = moveMarkup(g.orig, wx - g.w0[0], wy - g.w0[1]);
    app.markups = app.markups.map((m) => (m.id === g.orig.id ? moved : m));
    invalidate();
    return;
  }
  const d = app.draft;
  if (!d) return;
  if (d.type === 'pen' || d.type === 'highlight') {
    if (Math.hypot(sx - d.last[0], sy - d.last[1]) < 1.5) return;
    if (e.shiftKey && d.type === 'highlight') { d.pts = [d.pts[0], d.pts[1], wx, wy]; }
    else d.pts.push(wx, wy);
    d.last = [sx, sy];
  } else if (d.type !== 'cloud-poly') d.b = [wx, wy];
  invalidate();
}

function toolUp(sx, sy, e) {
  const t = app.tool;
  if (EDIT_TOOLS.has(t)) { edit.up(sx, sy, e); return; }
  if (t === 'zoombox' && app.zoomBox) {
    const z = app.zoomBox;
    app.zoomBox = null;
    if (Math.abs(z.x1 - z.x0) > 6 && Math.abs(z.y1 - z.y0) > 6) {
      const [ax, ay] = app.view.toWorld(Math.min(z.x0, z.x1), Math.max(z.y0, z.y1));
      const [bx, by] = app.view.toWorld(Math.max(z.x0, z.x1), Math.min(z.y0, z.y1));
      app.view.fit([ax, ay, bx, by], 0);
      invalidate(true);
    }
    setTool(app.prevTool || 'pan');
    return;
  }
  if (t === 'select') {
    if (app.drag && app.drag.moved) { autosave(); updateUndoButtons(); }
    app.drag = null;
    cvOverlay.classList.remove('move');
    return;
  }
  const d = app.draft;
  if (!d || d.type === 'cloud-poly') return;
  const scale = app.view.scale;
  const dragPx = d.s0 ? Math.hypot(sx - d.s0[0], sy - d.s0[1]) : 0;
  app.draft = null;
  const P = markupProps(d.type);
  switch (d.type) {
    case 'pen': case 'highlight': {
      if (d.pts.length < 4) break;
      const pts = d.type === 'highlight' && d.pts.length === 4 ? d.pts : smoothStroke(d.pts, 0.8 / scale);
      addMarkup(createMarkup(d.type, pts, P));
      break;
    }
    case 'line': case 'arrow':
      if (dragPx >= 4) addMarkup(createMarkup(d.type, [...d.a, ...d.b], P));
      break;
    case 'rect':
      if (dragPx >= 4) addMarkup(createMarkup('rect', rectCorners(d.a[0], d.a[1], d.b[0], d.b[1]), P));
      break;
    case 'ellipse':
      if (dragPx >= 4) addMarkup(createMarkup('ellipse', [...d.a, ...d.b], P));
      break;
    case 'cloud':
      if (dragPx >= 8) addMarkup(createMarkup('cloud', rectCorners(d.a[0], d.a[1], d.b[0], d.b[1]), { ...P, arc: 16 / scale }));
      else { app.draft = { type: 'cloud-poly', pts: [...d.a] }; updateFinishBar(); }
      break;
    case 'callout': {
      let b = d.b;
      if (dragPx < 6) b = [d.a[0] + 48 / scale, d.a[1] + 36 / scale];
      openTextEditor({ pts: [...d.a, ...b], size: 14 / scale });
      break;
    }
    default:
  }
  invalidate();
}

function toolDouble(sx, sy) {
  if (EDIT_TOOLS.has(app.tool)) { edit.dbl(sx, sy); return; }
  if (finishDraft()) return;
  if (app.tool === 'select') {
    const m = hitMarkup(sx, sy, 7);
    if (m && m.type === 'callout') { openTextEditor({ editId: m.id, pts: m.pts.slice(), size: m.size, text: m.text }); return; }
  }
  if ((app.tool === 'pan' || app.tool === 'select') && app.scene) {
    // double-clicking drawing text outside Edit mode: point the way
    const [lx, ly] = app.view.toWorld(sx, sy);
    const h = pickItem(app.scene, lx, ly, 6 / app.view.scale, (li) => !app.layerVisible || app.layerVisible[li]);
    if (h && h.isText) {
      toast('Switch to Edit to change the drawing', {
        key: 'edit-hint', timeout: 6000, detail: 'View and Markup never change the drawing itself.',
        actions: [{ label: 'Edit this text', onClick: () => {
          const t = app.scene.texts[h.id - TEXT_ID]; // a text inside a cell/insert carries its path
          setTool('eselect');
          if (edit.ready) edit.editEntity(h.ent, null, null, t && t.sub);
        } }],
      });
    }
  }
}

// ------------------------------------------------------------------ callout text editor
function openTextEditor(opts) {
  app.pendingCallout = opts;
  const ed = $('#text-editor');
  const ta = $('#ta-callout');
  ta.value = opts.text || '';
  ed.hidden = false;
  const [ax, ay] = toScreenFor(app.view)(opts.pts[2], opts.pts[3]);
  const r = stage.getBoundingClientRect();
  const w = ed.offsetWidth || 260, h = ed.offsetHeight || 110;
  ed.style.left = `${Math.max(8, Math.min(r.width - w - 8, ax + 8))}px`;
  ed.style.top = `${Math.max(8, Math.min(r.height - h - 8, ay - h / 2))}px`;
  ta.focus();
  invalidate();
}
function closeTextEditor(commitIt) {
  const p = app.pendingCallout;
  app.pendingCallout = null;
  $('#text-editor').hidden = true;
  const text = $('#ta-callout').value.trimEnd();
  if (commitIt && p && text) {
    if (p.editId) {
      const i = app.markups.findIndex((m) => m.id === p.editId);
      if (i >= 0) commit(() => { app.markups = app.markups.map((m, k) => (k === i ? { ...m, text, modified: new Date().toISOString() } : m)); });
    } else {
      addMarkup(createMarkup('callout', p.pts, { ...markupProps('callout'), text, size: p.size }));
    }
  }
  invalidate();
  cvOverlay.focus?.();
}
$('#ta-callout').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeTextEditor(true); }
  else if (e.key === 'Escape') { e.preventDefault(); closeTextEditor(false); }
  e.stopPropagation();
});
$('#ta-callout').addEventListener('input', () => invalidate());
$('#btn-te-ok').addEventListener('click', () => closeTextEditor(true));

// ------------------------------------------------------------------ pointer input
const pointers = new Map();
let gesture = null;
const local = (e) => { const r = cvOverlay.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

cvOverlay.addEventListener('pointerdown', (e) => {
  if (!app.scene) return;
  if (app.pendingCallout) { closeTextEditor(true); return; }
  try { cvOverlay.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  const p = local(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 2) {
    if (gesture && gesture.type === 'tool') { app.draft = null; app.zoomBox = null; if (app.drag) { app.drag = null; } edit.cancelGesture(); }
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    interact();
    return;
  }
  if (pointers.size > 2) return;
  const pan = e.button === 1 || (e.button === 0 && (app.tool === 'pan' || app.tool === 'trace' || app.spaceDown));
  if (pan) {
    e.preventDefault();
    gesture = { type: 'pan', x: p.x, y: p.y, moved: false, x0: p.x, y0: p.y, tap: app.tool === 'trace' && e.button === 0 && !app.spaceDown && e.pointerType };
    cvOverlay.classList.add('dragging');
    return;
  }
  if (e.button === 2) {
    if (EDIT_TOOLS.has(app.tool)) { if (!edit.context(p.x, p.y)) edit.finishDraft(); return; }
    finishDraft();
    return;
  }
  if (e.button !== 0) return;
  gesture = { type: 'tool' };
  toolDown(p.x, p.y, e);
});

cvOverlay.addEventListener('pointermove', (e) => {
  if (!app.scene) return;
  const p = local(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
  if (gesture && gesture.type === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    app.view.panBy(mx - gesture.mx, my - gesture.my);
    app.view.zoomAt(mx, my, d / gesture.d);
    gesture.d = d; gesture.mx = mx; gesture.my = my;
    interact();
    invalidate(true);
    return;
  }
  if (gesture && gesture.type === 'pan') {
    const dx = p.x - gesture.x, dy = p.y - gesture.y;
    if (dx || dy) {
      app.view.panBy(dx, dy);
      gesture.x = p.x; gesture.y = p.y; gesture.moved = true;
      interact();
      invalidate(true);
    }
    updateCursor(p.x, p.y, e.pointerType);
    return;
  }
  toolMove(p.x, p.y, e, !!(gesture && gesture.type === 'tool'));
});

function endPointer(e) {
  const had = pointers.delete(e.pointerId);
  if (!had) return;
  const p = local(e);
  if (gesture && gesture.type === 'pinch') { if (pointers.size === 0) gesture = null; return; }
  if (gesture && gesture.type === 'pan') {
    const g = gesture;
    gesture = null; cvOverlay.classList.remove('dragging');
    if (g.tap && e.type === 'pointerup' && Math.hypot(p.x - g.x0, p.y - g.y0) < 6) trace('at', p.x, p.y, g.tap); // Trace: a click / tap, not a drag
    return;
  }
  if (gesture && gesture.type === 'tool') { gesture = null; if (e.type === 'pointerup') toolUp(p.x, p.y, e); else { app.draft = null; app.zoomBox = null; edit.cancelGesture(); invalidate(); } }
}
cvOverlay.addEventListener('pointerup', endPointer);
cvOverlay.addEventListener('pointercancel', endPointer);
cvOverlay.addEventListener('pointerleave', () => { if (!pointers.size) { app.hover = null; if (app.edit) app.edit.hover = -1; app.cursor = app.cursor && MEASURE_TOOLS.has(app.tool) ? app.cursor : null; invalidate(); } });
cvOverlay.addEventListener('dblclick', (e) => { const p = local(e); toolDouble(p.x, p.y); });
cvOverlay.addEventListener('contextmenu', (e) => e.preventDefault());
cvOverlay.addEventListener('wheel', (e) => {
  if (!app.scene) return;
  e.preventDefault();
  const p = local(e);
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 120;
  const k = e.ctrlKey ? 0.01 : 0.0022;
  const f = Math.exp(-Math.max(-600, Math.min(600, dy)) * k);
  app.view.zoomAt(p.x, p.y, f);
  interact();
  updateCursor(p.x, p.y, 'mouse');
  invalidate(true);
}, { passive: false });

app.zoomToWorld = (x0, y0, x1, y1) => { const [ox, oy] = origin(); app.view.fit([x0 - ox, y0 - oy, x1 - ox, y1 - oy], 10); invalidate(true); };
function zoomBy(f) { app.view.zoomAt(app.view.w / 2, app.view.h / 2, f); invalidate(true); }
function fit() { if (app.scene) { app.view.fit(app.scene.fitBox); invalidate(true); } }
app.fit = fit;

// ------------------------------------------------------------------ keyboard
const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'range', 'file', 'image']);
/** Typing into a text field? (Shortcuts stay off there; a checkbox or a button is not typing.) */
const isTyping = (el) => !!el && ((el.tagName === 'INPUT' && !NOT_TEXT.has(el.type)) || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
/** A focused control that Space / Enter activate (a button, checkbox, tab, menu item...). */
const isControl = (el) => !!el && el !== document.body && !!el.closest && !!el.closest('button, a[href], input, select, textarea, summary, [role="tab"], [role^="menuitem"]');
const KEY_TOOLS = { h: 'pan', z: 'zoombox', j: 'trace', d: 'distance', g: 'length', a: 'area', v: 'select', p: 'pen', n: 'line', w: 'arrow', r: 'rect', o: 'ellipse', c: 'cloud', t: 'callout', k: 'highlight' };
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const typing = isTyping(e.target);
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod) {
    if (k === 'o') { e.preventDefault(); if (e.shiftKey) openFolder(); else pickFile(); return; }
    if (k === 'f' && !e.shiftKey) { e.preventDefault(); if (app.scene) tools('find'); return; }
    if (typing) return;
    if (k === 's') {
      e.preventDefault();
      if (!app.doc) return;
      if (e.shiftKey) edit.openSaveAs();
      else if (TOOL_GROUP[app.tool] === 'edit' || $('#tab-edit').getAttribute('aria-selected') === 'true') edit.quickSave();
      else saveMarkups();
      return;
    }
    // Ctrl+A / Ctrl+D never reach the browser (select the page's text / bookmark dialog)
    if (k === 'a') { e.preventDefault(); if (EDIT_TOOLS.has(app.tool)) edit.selectAll(); return; }
    if (k === 'd') { e.preventDefault(); if (EDIT_TOOLS.has(app.tool)) edit.duplicate(); return; }
    if (k === 'v' && app.scene) { edit.pasteKey(e.shiftKey); return; } // the paste event follows (Ctrl+C: the copy event)
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
    if (k === 'p') { e.preventDefault(); if (app.doc) openPrintDialog(); return; }
    return;
  }
  if (e.key === 'F3' && app.tools && app.tools.find.open) { e.preventDefault(); app.tools.findStep(e.shiftKey ? -1 : 1); return; }
  if (typing || e.altKey) return;
  // Space / Enter on a focused button or checkbox press it, unless something is being drawn
  if (e.key === ' ' && isControl(e.target)) return;
  if (e.key === 'Enter' && isControl(e.target) && !(edit.draftActive || app.draft || (app.mdraft && app.mdraft.pts.length))) return;
  if (edit.key(e)) return;
  if (e.key === ' ') { if (!app.spaceDown) { app.spaceDown = true; cvOverlay.classList.add('dragging'); } e.preventDefault(); return; }
  if (e.key === 'Escape') {
    if (app.mdraft && app.mdraft.pts.length) { app.mdraft.pts = []; updateMeasureCard(); updateFinishBar(); invalidate(); return; }
    if (app.draft) { app.draft = null; updateFinishBar(); invalidate(); return; }
    if (app.selected) { app.selected = null; updateSelectionStatus(); invalidate(); return; }
    if (app.trace && app.trace.net) { app.trace.clear(); return; }
    if (app.tool !== 'pan') setTool('pan');
    return;
  }
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) { $('#dlg-help').showModal(); return; }
  if (!app.scene) return;
  if (e.key === 'Enter') { if (finishDraft()) e.preventDefault(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (!undoPoint() && deleteSelected()) e.preventDefault(); else e.preventDefault(); return; }
  if (e.key === '+' || e.key === '=') { zoomBy(1.4); return; }
  if (e.key === '-' || e.key === '_') { zoomBy(1 / 1.4); return; }
  const arrows = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] };
  if (arrows[e.key]) {
    const t = e.target;
    if (t !== document.body && !(t.closest && t.closest('#stage'))) return; // arrows belong to the focused control
    e.preventDefault(); app.view.panBy(...arrows[e.key]); invalidate(true); return;
  }
  if (k === 'f') { fit(); return; }
  if (k === 'l') { toggleLayers(); return; }
  if (k === 'b') { toggleTheme(); return; }
  if (k === 's') { toggleSnap(); return; }
  if (k === 'e') { setTool('eselect'); return; }
  if (k === 'i' && !e.shiftKey) { tools('info'); return; }
  if (KEY_TOOLS[k]) { setTool(KEY_TOOLS[k]); }
});
// copy / paste of drawing items (Edit mode): plain text on the system clipboard, no permission needed
document.addEventListener('copy', (e) => {
  if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
  const t = edit.copy();
  if (t == null) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', t);
});
document.addEventListener('paste', (e) => {
  if (isTyping(e.target) || document.querySelector('dialog[open]') || !app.scene) return;
  e.preventDefault();
  edit.pasteText(e.clipboardData ? e.clipboardData.getData('text/plain') : '');
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') { app.spaceDown = false; if (!gesture) cvOverlay.classList.remove('dragging'); } });

// ------------------------------------------------------------------ toolbar wiring
function toggleTheme() {
  app.theme = app.theme === 'dark' ? 'paper' : 'dark';
  document.documentElement.dataset.theme = app.theme;
  $('#theme-label').textContent = app.theme === 'dark' ? 'Paper' : 'Dark';
  $('#btn-theme').title = app.theme === 'dark' ? 'Switch to white paper (B)' : 'Switch to the dark CAD background (B)';
  document.querySelector('meta[name="theme-color"]').content = app.theme === 'dark' ? '#16191e' : '#f4f5f7';
  storage.set('linework:theme', app.theme);
  invalidate(true);
}
app.toggleTheme = toggleTheme;
function toggleSnap() {
  app.snapOn = !app.snapOn;
  for (const b of $$('[data-action="snap"]')) b.setAttribute('aria-pressed', String(app.snapOn));
  storage.set('linework:snap', app.snapOn ? '1' : '0');
  toast(app.snapOn ? 'Snap on' : 'Snap off', { timeout: 1200 });
}
function setLayersOpen(open) {
  $('#layers-panel').hidden = !open;
  $('#btn-layers').setAttribute('aria-pressed', String(open));
}
function toggleLayers() { setLayersOpen($('#layers-panel').hidden); }

for (const b of $$('.tool[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
/** A ribbon tab chosen by the user: the Edit tab starts Edit mode with Select; leaving it ends Edit mode. */
function activateTab(name) {
  if (name === 'edit') { if (!EDIT_TOOLS.has(app.tool)) setTool('eselect'); else selectTab(name); return; }
  if (EDIT_TOOLS.has(app.tool)) setTool('pan');
  selectTab(name);
}
for (const tab of $$('[role="tab"]')) {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  tab.addEventListener('keydown', (e) => {
    const tabs = $$('[role="tab"]');
    const i = tabs.indexOf(tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); const n = tabs[(i + 1) % tabs.length]; n.focus(); activateTab(n.dataset.tab); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); const n = tabs[(i + tabs.length - 1) % tabs.length]; n.focus(); activateTab(n.dataset.tab); }
  });
}
const actions = {
  fit, layers: toggleLayers, theme: toggleTheme, snap: toggleSnap,
  'clear-measure': () => { app.measures = []; if (app.mdraft) app.mdraft.pts = []; updateMeasureCard(); updateFinishBar(); invalidate(); },
  undo, redo,
  'save-markup': () => { if (app.doc) saveMarkups(); else toast('Open a drawing first.', { kind: 'warn' }); },
  'load-markup': () => { if (app.doc) $('#markup-input').click(); else toast('Open the drawing first, then load its markups.', { kind: 'warn' }); },
  export: () => doExport(),
  print: () => openPrintDialog(),
  compare: () => { if (!app.doc) { toast('Open a drawing first, then compare it with another revision.', { kind: 'warn' }); return; } import('./app/compare.js').then((m) => m.startCompare(app), () => toast('Compare is not available offline yet.', { kind: 'warn' })); },
  'e-delete': () => edit.deleteSel(),
  'e-copy': () => edit.copyButton(),
  'e-paste': () => edit.paste(),
  'e-dup': () => edit.duplicate(),
  'e-save': () => edit.quickSave(),
  'e-saveas': () => edit.openSaveAs(),
  find: () => { if (app.scene) tools('find'); else toast('Open a drawing first.', { kind: 'warn' }); },
  'e-tools': () => { if (app.scene) tools('menu'); },
  'open-folder': () => openFolder(),
};
for (const b of $$('[data-action]')) b.addEventListener('click', () => { $('#menu-more').hidden = true; actions[b.dataset.action]?.(); });

$('#btn-open').addEventListener('click', pickFile);
$('#btn-open-empty').addEventListener('click', pickFile);
$('#file-input').addEventListener('change', async (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.filter((f) => !/\.json$/i.test(f.name)).length > 1) sheets().then((S) => S.openFiles(fs)); else await openFile(fs[0]); });
$('#markup-input').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await loadMarkupFile(f); });
for (const b of $$('.sample')) b.addEventListener('click', () => openSample(b.dataset.sample));
$('#btn-close-layers').addEventListener('click', () => setLayersOpen(false));
$('#btn-cancel-load').addEventListener('click', cancelOpen);
$('#btn-clear-stored').addEventListener('click', () => {
  const n = clearStoredMarkups();
  toast(n ? `Cleared ${plural(n, 'set')} of stored markups` : 'No markups are stored in this browser', { key: 'cleared', timeout: 3000, detail: n && app.markups.length ? 'The markups on screen stay until you close the drawing.' : undefined });
});
$('#btn-help').addEventListener('click', () => $('#dlg-help').showModal());
$('#btn-export').addEventListener('click', () => doExport());
$('#btn-print').addEventListener('click', () => openPrintDialog());
$('#btn-more').addEventListener('click', (e) => {
  const m = $('#menu-more');
  m.hidden = !m.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!m.hidden));
  for (const b of m.querySelectorAll('button')) b.disabled = !app.doc;
  if (!m.hidden) m.querySelector('button').focus();
});
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#menu-more, #btn-more')) $('#menu-more').hidden = true; });
$('#btn-erotate').addEventListener('click', (e) => edit.rotateSel(e.shiftKey ? -Math.PI / 2 : Math.PI / 2));
$('#btn-finish').addEventListener('click', () => { if (edit.draftActive) edit.finishDraft(); else finishDraft(); });
$('#btn-undo-point').addEventListener('click', () => { if (!edit.undoDraftPoint()) undoPoint(); });
$('#btn-cancel-draft').addEventListener('click', () => { edit.cancelDraft(); if (app.mdraft) app.mdraft.pts = []; app.draft = null; updateFinishBar(); updateMeasureCard(); invalidate(); });
$('#btn-copy-measure').addEventListener('click', async () => {
  const v = $('#mc-value').textContent;
  try { await navigator.clipboard.writeText(v); toast(`Copied ${v}`, { timeout: 1500 }); } catch { toast('Copy is not available here.', { kind: 'warn' }); }
});
$('#sel-precision').addEventListener('change', (e) => { app.precision = Number(e.target.value); storage.set('linework:precision', String(app.precision)); updateMeasureCard(); invalidate(); e.target.blur(); });
$('#sel-width').addEventListener('change', (e) => { app.width = Number(e.target.value); if (app.selected) restyleSelected({ width: app.width }); e.target.blur(); });
$('#inp-author').addEventListener('change', (e) => { app.author = e.target.value.trim(); storage.set('linework:author', app.author); });
function setColor(c) {
  app.color = c;
  for (const s of $$('.swatch[data-color]')) s.setAttribute('aria-checked', String(s.dataset.color === c));
  $('#inp-color').value = c;
  if (app.selected) restyleSelected({ color: c });
}
for (const s of $$('.swatch[data-color]')) { s.style.setProperty('--c', s.dataset.color); s.addEventListener('click', () => setColor(s.dataset.color)); }
$('#inp-color').addEventListener('input', (e) => setColor(e.target.value));

async function doExport() {
  if (!app.doc) return;
  const blob = await exportPng(app);
  download(blob, app.doc.name.replace(/\.[^.]+$/, '') + '.png');
  toast('Saved a PNG of the current view', { timeout: 2500 });
}
app.exportPng = () => exportPng(app);

// Print: a vector sheet to scale (src/app/print-svg.js, loaded with the dialog or soon after a drawing
// opens). The image print is kept for the browser's own Print menu used before that module is here.
let printMod = null;
const loadPrint = () => import('./app/print-svg.js').then((m) => (printMod = m));
function openPrintDialog() {
  if (!app.doc) return;
  $('#pr-title').value = $('#pr-title').value || app.doc.name;
  $('#pr-author').value = $('#pr-author').value || app.author;
  loadPrint().then((m) => m.initDialog(app), () => {});
  $('#dlg-print').showModal();
}
$('#dlg-print').addEventListener('close', async () => {
  if ($('#dlg-print').returnValue !== 'print') return;
  try { (printMod || await loadPrint()).printSheet(app); } catch (e) { toast('Could not prepare the print', { kind: 'error', detail: String(e && e.message ? e.message : e) }); return; }
  window.print();
});
app.buildPrintSheet = (o) => buildPrintSheet(app, o);
app.printSheet = (o) => loadPrint().then((m) => m.printSheet(app, o));
window.addEventListener('beforeprint', () => {
  if (!app.doc || $('#print-root').firstChild) return;
  if (printMod) printMod.printSheet(app); else buildPrintSheet(app, { title: app.doc.name, author: app.author });
});
hooks.open.push(() => setTimeout(() => loadPrint().catch(() => {}), 1500));
// PDF pages (picker, Page Up / Down, app.pages): loaded with the first PDF
hooks.open.push(() => { if (app.scene.page && !app.pages) import('./app/pdf-ui.js').then((m) => m.initPages(app), () => {}); });
window.addEventListener('afterprint', () => clearPrintSheet());

// ------------------------------------------------------------------ drag and drop anywhere
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; });
window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').hidden = true; });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  // file handles (where the browser gives them) must be asked for before anything is awaited
  const asked = [...e.dataTransfer.items].map((it) => (it.kind === 'file' && it.getAsFileSystemHandle ? it.getAsFileSystemHandle().catch(() => null) : null));
  const entries = [...e.dataTransfer.items].map((it) => (it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
  const files = [...e.dataTransfer.files];
  // several drawings or a folder: a sheet set
  if (files.filter((f) => !/\.json$/i.test(f.name)).length > 1 || entries.some((x) => x && x.isDirectory)) { const S = await sheets(); S.dropped(files, await Promise.all(asked), entries); return; }
  const drawing = files.find((f) => !/\.json$/i.test(f.name));
  const markups = files.find((f) => /\.json$/i.test(f.name));
  const handle = drawing && (await Promise.all(asked)).find((h) => h && h.kind === 'file' && h.name === drawing.name);
  if (drawing) await openFile(drawing, handle ? { handle } : undefined);
  if (markups) await loadMarkupFile(markups);
});

// open files passed by the OS (installed PWA file handler)
// (the manifest asks for one window per file; a browser that still hands over several opens the first)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    const files = params.files || [];
    if (!files.length) return;
    if (files.length > 1) toast(`Opened the first of ${files.length} files`, { key: 'launch', kind: 'warn', timeout: 8000, detail: `Linework shows one drawing per window: open the other ${files.length === 2 ? 'one' : files.length - 1} separately.` });
    try { await openFile(await files[0].getFile(), { handle: files[0] }); } catch { toast('Could not read that file.', { kind: 'error' }); }
  });
}

window.addEventListener('beforeunload', (e) => {
  // markups are auto-kept in this browser; only warn while a callout is being typed
  if (app.pendingCallout && $('#ta-callout').value) { e.preventDefault(); e.returnValue = ''; }
});

// ------------------------------------------------------------------ edit mode
/** After every edit, undo and redo: new layers and item counts in the Layers panel (visibility kept). */
function layersChanged() {
  if (!app.scene) return;
  app.layerVisible = layersPanel.refresh();
}
// ------------------------------------------------------------------ editing tools (loaded on first use)
// Find / replace (Ctrl+F), key-ins, mirror / scale / array, select same, match attributes and element
// info (I) live in src/app/tools-ui.js, fetched the first time one of them is used.
let toolsP = null;
function tools(cmd, ...args) {
  if (!app.tools && cmd === 'keyin' && args[0] == null) return;
  if (!toolsP) {
    toolsP = import('./app/tools-ui.js').then((m) => (app.tools = m.initTools(app, { edit, invalidate, setTool, accent, layersPanel })));
    toolsP.catch(() => { toolsP = null; toast('This tool could not be loaded. Check the connection and try again.', { kind: 'error' }); });
  }
  return toolsP.then((T) => T.run(cmd, ...args));
}
app.loadTools = tools;
// Trace (View › Trace, J): src/app/trace-ui.js, fetched the first time the tool is picked.
let traceP = null;
function trace(cmd, ...args) {
  if (!traceP) {
    traceP = import('./app/trace-ui.js').then((m) => (app.trace = m.initTrace(app, { invalidate })));
    traceP.catch(() => { traceP = null; toast('This tool could not be loaded. Check the connection and try again.', { kind: 'error' }); });
  }
  return traceP.then((T) => T.run(cmd, ...args));
}

// Sheet sets (src/app/sheets.js, loaded on first use): a folder or several drawings open as one set.
let sheetsP = null;
function sheets() {
  if (!sheetsP) {
    sheetsP = import('./app/sheets.js').then((m) => m.initSheets(app, { okToReplace }));
    sheetsP.catch(() => { sheetsP = null; toast('Sheet sets could not be loaded. Check the connection and try again.', { kind: 'error' }); });
  }
  return sheetsP;
}
app.loadSheets = sheets;
const openFolder = () => sheets().then((S) => S.pickFolder());

// Level names (DGN v7 has none): kept in this browser per drawing name, never written into the file.
const LEVELS = 'linework:levels:';
function loadLevelNames() {
  const m = new Map();
  if (!app.doc || app.doc.format !== 'DGN') return m;
  try { for (const [k, v] of Object.entries(JSON.parse(storage.get(LEVELS + app.doc.name, '{}')))) if (+k >= 1 && +k <= 63 && typeof v === 'string' && v.trim()) m.set(+k, v.trim().slice(0, 64)); } catch { /* damaged: none */ }
  return m;
}
/** "Level 5" -> "Level 5 · Power" when level 5 has a name. */
app.layerLabel = (n) => { const m = app.levelNames && app.levelNames.size && /^Level (\d+)$/.exec(n); const v = m && app.levelNames.get(+m[1]); return v ? `${n} · ${v}` : n; };
/** New level names: kept, and shown in the Layers panel, the Level box and the status bar. */
app.setLevelNames = (names) => {
  app.levelNames = names;
  if (app.doc) { if (names.size) storage.set(LEVELS + app.doc.name, JSON.stringify(Object.fromEntries(names))); else storage.del(LEVELS + app.doc.name); }
  layersPanel.render();
  edit.refreshLayers();
};
edit = initEdit(app, {
  invalidate, setTool, accent, drawSnapGlyph, updateUndoButtons, updateFinishBar, layersChanged, restoreHint, tools,
  showLayers: (indices) => layersPanel.show(indices),
  setInfo: (t) => { $('#st-info').textContent = t; },
  setCursor: (c) => { if (!cvOverlay.classList.contains('dragging')) cvOverlay.className = c === 'grab' ? '' : c; },
  focusStage: () => stage.focus({ preventScroll: true }),
});

// ------------------------------------------------------------------ start-up
function init() {
  for (const el of $$('[data-app-name]')) el.textContent = APP_NAME;
  $('#about-line').textContent = `${APP_NAME} ${APP_VERSION} · free and open source (GPL-3.0) · runs entirely in your browser.`;
  if (storage.get('linework:theme') === 'paper') toggleTheme();
  app.snapOn = storage.get('linework:snap') !== '0';
  for (const b of $$('[data-action="snap"]')) b.setAttribute('aria-pressed', String(app.snapOn));
  app.precision = Number(storage.get('linework:precision', '2')) || 0;
  $('#sel-precision').value = String(app.precision);
  app.author = storage.get('linework:author', '') || '';
  $('#inp-author').value = app.author;
  setTool('pan');
  // file access (Open with a file handle, recent drawings, Save over the original, unsaved-edit recovery):
  // loaded after start-up; until then (or offline before it was cached) Open and Save work as before
  import('./app/files.js').then((m) => {
    app.files = m.initFiles(app, { openFile, openSample, save: (...a) => edit.save(...a), commit: (l, c) => edit.commit(l, c), readDrawing: app.readDrawing, showDrawing: app.showDrawing });
    hooks.open.push(app.files.opened);
    hooks.history.push(app.files.history);
    if (app.doc) app.files.opened(app.doc);
  }, () => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !new URLSearchParams(location.search).has('nosw')) {
    // A new version installs in the background and takes over this page (skipWaiting + claim). The page
    // itself is still the old code, so reload: straight away when nothing is open, otherwise ask.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      if (!app.scene && !(edit && edit.dirty)) { reloading = true; location.reload(); return; }
      toast('Linework was updated.', { key: 'update', timeout: 0, detail: 'Reload to use the new version.', actions: [{ label: 'Reload', onClick: () => { if (!(edit && edit.dirty) || window.confirm(app.journalState === 'kept' ? 'Reload now? The unsaved edits stay in this browser: open the drawing again to get them back.' : 'The drawing has unsaved edits. Reload anyway?')) { reloading = true; location.reload(); } } }] });
    });
    // updateViaCache 'none': the version (src/version.js, imported by sw.js) is always checked fresh
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* offline support unavailable */ });
  }
  if (location.protocol === 'file:') {
    toast('Opened from disk: samples and offline mode need a local web server (see README). Opening your own files still works.', { kind: 'warn', timeout: 10000 });
  }
  const q = new URLSearchParams(location.search).get('sample');
  if (q) openSample(q === 'stress' ? 'stress' : `samples/${q.replace(/[^a-z0-9.-]/gi, '')}`);
}
init();
