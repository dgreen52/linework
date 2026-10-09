// Linework application shell: loading, view interaction, tools, markups, export.
// Everything runs locally; drawings are never sent anywhere.
import { APP_NAME, APP_VERSION } from './config.js';
import { Viewport, cssTransformBetween } from './view/viewport.js';
import { Canvas2DRenderer, primPath } from './view/renderer2d.js';
import { unpackTexts } from './scene.js';
import { findSnap, pickItem } from './tools/snap.js';
import { measure, describe, details, fmtNum } from './tools/measure.js';
import { createMarkup, rectCorners, moveMarkup } from './markup/model.js';
import { drawMarkup, markupScreenBox, markupHitDistance } from './markup/render.js';
import { serializeMarkups, parseMarkups, sidecarName } from './markup/sidecar.js';
import { History } from './markup/history.js';
import { smoothStroke } from './geom.js';
import { $, $$, toast, download, readFileAsArrayBuffer, storage, fmtBytes } from './app/ui.js';
import { LayersPanel } from './app/layers-panel.js';
import { exportPng, buildPrintSheet, clearPrintSheet } from './app/print.js';

const TOOL_GROUP = {
  pan: 'view', zoombox: 'view', distance: 'measure', length: 'measure', area: 'measure',
  select: 'markup', pen: 'markup', line: 'markup', arrow: 'markup', rect: 'markup', ellipse: 'markup',
  cloud: 'markup', callout: 'markup', highlight: 'markup',
};
const MEASURE_TOOLS = new Set(['distance', 'length', 'area']);
const MARKUP_TOOLS = new Set(['pen', 'line', 'arrow', 'rect', 'ellipse', 'cloud', 'callout', 'highlight']);
const HINTS = {
  zoombox: 'Drag a box around the area to zoom into',
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
};
const SNAP_LABEL = { endpoint: 'End', midpoint: 'Middle', center: 'Centre', intersection: 'Crossing', nearest: 'On line' };

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

const stage = $('#stage');
const cvDrawing = $('#cv-drawing');
const cvOverlay = $('#cv-overlay');
const octx = cvOverlay.getContext('2d');
app.renderer = new Canvas2DRenderer(cvDrawing);
const layersPanel = new LayersPanel((vis) => { app.layerVisible = vis; app.hover = null; invalidate(true); });

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
  if (app.hover && (app.tool === 'pan' || app.tool === 'select') && !app.draft) {
    const M = app.view.matrix(dpr);
    ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    ctx.strokeStyle = accent();
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 3 / app.view.scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (app.hover.isText) {
      const b = app.scene.texts[app.hover.id - app.scene.n].bbox;
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
let worker = null;
let jobSeq = 0;
const jobs = new Map();
function getWorker() {
  if (worker === false) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const m = ev.data;
      const job = jobs.get(m.id);
      if (!job) return;
      if (m.type === 'progress') job.progress(m.phase, m.fraction);
      else { jobs.delete(m.id); if (m.type === 'done') job.resolve(unpackTexts(m.scene)); else job.reject(Object.assign(new Error(m.message), { code: m.code })); }
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      for (const [, job] of jobs) job.reject(Object.assign(new Error('The background reader failed to start.'), { code: 'worker' }));
      jobs.clear();
      worker = false;
    };
  } catch {
    worker = false;
  }
  return worker || null;
}

async function parseOffThread(name, buffer, sample, progress) {
  const w = getWorker();
  if (w) {
    try {
      return await new Promise((resolve, reject) => {
        const id = ++jobSeq;
        jobs.set(id, { resolve, reject, progress });
        w.postMessage({ id, name, buffer, sample }, buffer ? [buffer] : []);
      });
    } catch (e) {
      if (e.code !== 'worker') throw e;
    }
  }
  // fallback: same code on the main thread (e.g. module workers unsupported)
  const { loadInWorkerScope } = await import('./worker.js');
  progress('Reading', 0.1);
  await new Promise((r) => setTimeout(r, 30));
  return loadInWorkerScope({ id: 0, name, buffer, sample }, () => {});
}

function showProgress(label, f) {
  $('#progress').hidden = false;
  $('#progress-label').textContent = label;
  $('#progress-fill').style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
}
const hideProgress = () => { $('#progress').hidden = true; };

async function openDrawing(name, buffer, size, sample) {
  if (app.loading) return;
  app.loading = true;
  showProgress(`Opening ${name}…`, 0);
  const t0 = performance.now();
  try {
    const scene = await parseOffThread(name, buffer, sample, (phase, f) => showProgress(`${phase} ${name}…`, f));
    setDocument(scene, name, size ?? scene.fileSize, performance.now() - t0);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    toast(msg, { kind: 'error', detail: e && e.code === 'dwg' ? 'DWG files are not opened in this version.' : undefined });
  } finally {
    app.loading = false;
    hideProgress();
  }
}
app.openDrawing = openDrawing;

async function openFile(file) {
  if (!file) return;
  if (/\.json$/i.test(file.name)) { await loadMarkupFile(file); return; }
  if (file.size > 400 * 1024 * 1024) { toast('This file is too large to open in the browser (over 400 MB).', { kind: 'error' }); return; }
  const buf = await readFileAsArrayBuffer(file);
  await openDrawing(file.name, buf, file.size);
}

async function openSample(key) {
  if (key === 'stress') return openDrawing('stress-test-53k.dxf', null, null, 'stress');
  try {
    const res = await fetch(key);
    if (!res.ok) throw new Error(res.statusText);
    const buf = await res.arrayBuffer();
    return openDrawing(key.split('/').pop(), buf, buf.byteLength);
  } catch {
    toast('Could not load the sample. If you opened index.html directly from disk, run a local web server instead (see README).', { kind: 'error' });
  }
}
app.openSample = openSample;

function setDocument(scene, name, size, ms) {
  app.scene = scene;
  app.doc = { name, size, format: scene.format };
  app.renderer.setScene(scene);
  app.layerVisible = Uint8Array.from(scene.layers.map((l) => (l.visible ? 1 : 0)));
  layersPanel.setLayers(scene.layers);
  const wide = window.innerWidth >= 1100;
  setLayersOpen(wide && scene.layers.filter((l) => l.count).length > 1);
  $('#empty').hidden = true;
  resize(); // layout may have changed (layers panel); fit to the real stage size
  app.view.setLimits(scene.extents);
  app.view.fit(scene.fitBox);
  app.heavy = 0;
  app.hover = null; app.hoverPath = null; app.selected = null;
  app.measures = []; app.mdraft = null; app.draft = null;
  app.history.clear();
  app.markups = [];
  $('#empty').hidden = true;
  $('#docinfo').hidden = false;
  $('#doc-name').textContent = name;
  $('#doc-name').title = `${name} · ${fmtBytes(size)} · ${scene.format}${scene.version ? ' ' + scene.version : ''}`;
  $('#doc-units').textContent = scene.units.abbr || 'unitless';
  $('#doc-units').title = `Drawing units: ${scene.units.name}`;
  document.title = `${name} · ${APP_NAME}`;
  for (const b of ['#btn-export', '#btn-print']) $(b).disabled = false;
  cvOverlay.setAttribute('aria-label', `Drawing ${name}: ${scene.layers.length} layers, ${scene.n + scene.textCount} items. Use the toolbar to pan, zoom, measure and mark up.`);
  restoreAutosave();
  updateUndoButtons();
  invalidate(true);

  const items = scene.n + scene.textCount;
  const ns = Object.entries(scene.notShown);
  const nsCount = ns.reduce((s, [, v]) => s + v, 0);
  const notes = [...scene.warnings];
  for (const k of ['open', 'skipped']) for (const el of document.querySelectorAll(`#toasts [data-key="${k}"]`)) el.remove();
  toast(`Opened ${name}`, { key: 'open', detail: `${fmtNum(items, 0)} items · ${scene.layers.length} layers · ${scene.units.abbr || 'no units'} · ${Math.round(ms)} ms`, timeout: 3500 });
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
const autosaveKey = () => app.doc && `linework:autosave:${app.doc.name}:${app.doc.size}`;
function autosave() {
  const k = autosaveKey();
  if (!k) return;
  if (!app.markups.length) storage.del(k);
  else storage.set(k, serializeMarkups(docMeta(), app.markups));
}
function restoreAutosave() {
  const k = autosaveKey();
  const s = k && storage.get(k);
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
  app.markups = prev;
  if (!prev.some((m) => m.id === app.selected)) app.selected = null;
  autosave(); updateUndoButtons(); invalidate();
}
function redo() {
  const next = app.history.redo(app.markups);
  if (!next) return;
  app.markups = next;
  autosave(); updateUndoButtons(); invalidate();
}
app.undo = undo; app.redo = redo;
function updateUndoButtons() {
  $('#btn-undo').disabled = !app.history.canUndo();
  $('#btn-redo').disabled = !app.history.canRedo();
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
  cvOverlay.className = t === 'pan' ? '' : t === 'select' ? 'pointer' : 'crosshair';
  const hint = $('#tool-hint');
  hint.hidden = !HINTS[t] || !app.scene;
  hint.textContent = HINTS[t] || '';
  updateMeasureCard();
  updateFinishBar();
  updateSelectionStatus();
  invalidate();
}
app.setTool = setTool;

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
  const active = (app.mdraft && app.mdraft.mode !== 'distance' && app.mdraft.pts.length > 0) || (app.draft && app.draft.type === 'cloud-poly');
  $('#finish-bar').hidden = !active;
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
  if (!app.scene || !(app.tool === 'pan' || app.tool === 'select')) { app.hover = null; return; }
  const [lx, ly] = app.view.toWorld(sx, sy);
  const h = pickItem(app.scene, lx, ly, 5 / app.view.scale, (li) => !app.layerVisible || app.layerVisible[li]);
  app.hover = h;
  if (app.tool === 'select' && app.selected) return;
  const s = app.scene;
  if (!h) { $('#st-info').textContent = ''; return; }
  if (h.isText) {
    const t = s.texts[h.id - s.n];
    $('#st-info').textContent = `Text “${t.s.slice(0, 60)}” · Layer ${s.layers[t.layer].name}${t.blk ? ' · Block ' + s.blockNames[t.blk] : ''}`;
  } else {
    const type = (s.srcNames[s.src[h.id]] || '').replace(/_/g, ' ');
    $('#st-info').textContent = `${type.charAt(0) + type.slice(1).toLowerCase()} · Layer ${s.layers[s.layer[h.id]].name}${s.blk[h.id] ? ' · Block ' + s.blockNames[s.blk[h.id]] : ''}`;
  }
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
  if (MEASURE_TOOLS.has(t)) { if (app.mdraft && app.mdraft.pts.length) updateMeasureCard(); invalidate(); return; }
  if (!pressed) {
    if (t === 'pan' || t === 'select') updateHover(sx, sy);
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

function toolUp(sx, sy) {
  const t = app.tool;
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
  if (finishDraft()) return;
  if (app.tool === 'select') {
    const m = hitMarkup(sx, sy, 7);
    if (m && m.type === 'callout') openTextEditor({ editId: m.id, pts: m.pts.slice(), size: m.size, text: m.text });
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
  const text = $('#ta-callout').value.replace(/\s+$/, '');
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
    if (gesture && gesture.type === 'tool') { app.draft = null; app.zoomBox = null; if (app.drag) { app.drag = null; } }
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    interact();
    return;
  }
  if (pointers.size > 2) return;
  const pan = e.button === 1 || (e.button === 0 && (app.tool === 'pan' || app.spaceDown));
  if (pan) {
    e.preventDefault();
    gesture = { type: 'pan', x: p.x, y: p.y, moved: false };
    cvOverlay.classList.add('dragging');
    return;
  }
  if (e.button === 2) { finishDraft(); return; }
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
  if (gesture && gesture.type === 'pan') { gesture = null; cvOverlay.classList.remove('dragging'); return; }
  if (gesture && gesture.type === 'tool') { gesture = null; if (e.type === 'pointerup') toolUp(p.x, p.y, e); else { app.draft = null; app.zoomBox = null; invalidate(); } }
}
cvOverlay.addEventListener('pointerup', endPointer);
cvOverlay.addEventListener('pointercancel', endPointer);
cvOverlay.addEventListener('pointerleave', () => { if (!pointers.size) { app.hover = null; app.cursor = app.cursor && MEASURE_TOOLS.has(app.tool) ? app.cursor : null; invalidate(); } });
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
const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
const KEY_TOOLS = { h: 'pan', z: 'zoombox', d: 'distance', g: 'length', a: 'area', v: 'select', p: 'pen', n: 'line', w: 'arrow', r: 'rect', o: 'ellipse', c: 'cloud', t: 'callout', k: 'highlight' };
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const typing = isTyping(e.target);
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod) {
    if (k === 'o') { e.preventDefault(); $('#file-input').click(); return; }
    if (typing) return;
    if (k === 's') { e.preventDefault(); if (app.doc) saveMarkups(); return; }
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
    if (k === 'p') { e.preventDefault(); if (app.doc) openPrintDialog(); return; }
    return;
  }
  if (typing || e.altKey) return;
  if (e.key === ' ') { if (!app.spaceDown) { app.spaceDown = true; cvOverlay.classList.add('dragging'); } e.preventDefault(); return; }
  if (e.key === 'Escape') {
    if (app.mdraft && app.mdraft.pts.length) { app.mdraft.pts = []; updateMeasureCard(); updateFinishBar(); invalidate(); return; }
    if (app.draft) { app.draft = null; updateFinishBar(); invalidate(); return; }
    if (app.selected) { app.selected = null; updateSelectionStatus(); invalidate(); return; }
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
  if (KEY_TOOLS[k]) { setTool(KEY_TOOLS[k]); }
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
  $('#btn-snap').setAttribute('aria-pressed', String(app.snapOn));
  storage.set('linework:snap', app.snapOn ? '1' : '0');
  toast(app.snapOn ? 'Snap on' : 'Snap off', { timeout: 1200 });
}
function setLayersOpen(open) {
  $('#layers-panel').hidden = !open;
  $('#btn-layers').setAttribute('aria-pressed', String(open));
}
function toggleLayers() { setLayersOpen($('#layers-panel').hidden); }

for (const b of $$('.tool[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
for (const tab of $$('[role="tab"]')) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  tab.addEventListener('keydown', (e) => {
    const tabs = $$('[role="tab"]');
    const i = tabs.indexOf(tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); const n = tabs[(i + 1) % tabs.length]; n.focus(); selectTab(n.dataset.tab); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); const n = tabs[(i + tabs.length - 1) % tabs.length]; n.focus(); selectTab(n.dataset.tab); }
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
};
for (const b of $$('[data-action]')) b.addEventListener('click', () => { $('#menu-more').hidden = true; actions[b.dataset.action]?.(); });

$('#btn-open').addEventListener('click', () => $('#file-input').click());
$('#btn-open-empty').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; await openFile(f); });
$('#markup-input').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await loadMarkupFile(f); });
for (const b of $$('.sample')) b.addEventListener('click', () => openSample(b.dataset.sample));
$('#btn-close-layers').addEventListener('click', () => setLayersOpen(false));
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
$('#btn-finish').addEventListener('click', () => finishDraft());
$('#btn-undo-point').addEventListener('click', () => undoPoint());
$('#btn-cancel-draft').addEventListener('click', () => { if (app.mdraft) app.mdraft.pts = []; app.draft = null; updateFinishBar(); updateMeasureCard(); invalidate(); });
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

function openPrintDialog() {
  if (!app.doc) return;
  $('#pr-title').value = $('#pr-title').value || app.doc.name;
  $('#pr-author').value = $('#pr-author').value || app.author;
  $('#dlg-print').showModal();
}
$('#dlg-print').addEventListener('close', async () => {
  if ($('#dlg-print').returnValue !== 'print') return;
  const f = new FormData($('#print-form'));
  const img = buildPrintSheet(app, { title: f.get('title'), author: f.get('author'), orientation: f.get('orient'), area: f.get('area'), markups: f.get('markups') === 'on' });
  try { await img.decode(); } catch { /* print anyway */ }
  window.print();
});
app.buildPrintSheet = (o) => buildPrintSheet(app, o);
window.addEventListener('beforeprint', () => { if (app.doc && !$('#print-root').firstChild) buildPrintSheet(app, { title: app.doc.name, author: app.author }); });
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
  const files = [...e.dataTransfer.files];
  const drawing = files.find((f) => !/\.json$/i.test(f.name));
  const markups = files.find((f) => /\.json$/i.test(f.name));
  if (drawing) await openFile(drawing);
  if (markups) await loadMarkupFile(markups);
});

// open files passed by the OS (installed PWA file handler)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    for (const h of params.files || []) { const f = await h.getFile(); await openFile(f); break; }
  });
}

window.addEventListener('beforeunload', (e) => {
  // markups are auto-kept in this browser; only warn while a callout is being typed
  if (app.pendingCallout && $('#ta-callout').value) { e.preventDefault(); e.returnValue = ''; }
});

// ------------------------------------------------------------------ start-up
function init() {
  for (const el of $$('[data-app-name]')) el.textContent = APP_NAME;
  $('#about-line').textContent = `${APP_NAME} ${APP_VERSION} · free and open source (GPL-3.0) · runs entirely in your browser.`;
  if (storage.get('linework:theme') === 'paper') toggleTheme();
  app.snapOn = storage.get('linework:snap') !== '0';
  $('#btn-snap').setAttribute('aria-pressed', String(app.snapOn));
  app.precision = Number(storage.get('linework:precision', '2')) || 0;
  $('#sel-precision').value = String(app.precision);
  app.author = storage.get('linework:author', '') || '';
  $('#inp-author').value = app.author;
  setTool('pan');
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !new URLSearchParams(location.search).has('nosw')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support unavailable */ });
  }
  if (location.protocol === 'file:') {
    toast('Opened from disk: samples and offline mode need a local web server (see README). Opening your own files still works.', { kind: 'warn', timeout: 10000 });
  }
  const q = new URLSearchParams(location.search).get('sample');
  if (q) openSample(q === 'stress' ? 'stress' : `samples/${q.replace(/[^a-z0-9.-]/gi, '')}`);
}
init();
