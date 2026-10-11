// Editing tools, loaded the first time one is used (Ctrl+F, I, a typed key-in, Edit › More): find and
// replace text, precision key-ins (XY= DL= DI= AA=) for drawing and for moving / copying / rotating the
// selection, mirror, scale, array, select same, match attributes and the element information card.
// Every change goes through the Edit controller (one undo step each), so a DGN keeps its bytes.
import { findTexts, replaceChanges } from '../edit/find.js';
import { parseKeyin, keyinPoint, RAD } from '../edit/keyin.js';
import { mirrorEntity, scaleEntity, arrayCopies } from '../edit/xform.js';
import { rotateEntity, moveEntity, isText } from '../edit/ops.js';
import { ATTRS, keysOf, selectByKeys, valuesOf, matchStyle, entityInfo, colorOf, typeName } from '../edit/attrs.js';
import { entityBBox } from '../edit/live-scene.js';
import { PASTE_MAX } from '../edit/clipboard.js';
import { CHAR_W } from '../scene.js';
import { parseLevelNames, levelNamesCsv, cleanName } from '../edit/levels.js';
import { fmtNum } from '../tools/measure.js';
import { $, toast, esc, download } from './ui.js';

const CSS = `
.tools-stack { position: absolute; top: calc(var(--hint-bottom, 0px) + 8px); right: 8px; z-index: 7; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-width: calc(100% - 16px); max-height: calc(100% - var(--hint-bottom, 0px) - 16px); pointer-events: none; }
.tools-stack > * { pointer-events: auto; }
.findbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 6px; width: min(470px, 100%); flex: none; }
.findbar input { flex: 1 1 130px; min-width: 0; min-height: 30px; padding: 3px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-3); }
.findbar input:focus { border-color: var(--accent); }
.find-n { font-size: 12px; color: var(--muted); min-width: 5.5em; text-align: center; font-variant-numeric: tabular-nums; }
.findbar .opt[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.find-rep { display: flex; flex-wrap: wrap; gap: 4px; flex-basis: 100%; }
.info-card { width: min(330px, 100%); min-height: 0; overflow: auto; padding: 8px 12px 10px; font-size: 13px; }
.info-card dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 10px; margin: 6px 0 0; }
.info-card dt { color: var(--muted); }
.info-card dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.info-card .sw { vertical-align: -2px; margin-right: 6px; }
.info-card details { margin-top: 6px; font-size: 12px; }
.info-card ol { margin: 4px 0 0; padding-left: 20px; color: var(--muted); }
.info-card .none { color: var(--muted); margin: 6px 0 0; }
.tool-form select, .tool-form input[type="text"] { min-height: 32px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-3); }
.tool-form .row { display: grid; grid-template-columns: 8.5em minmax(0, 1fr); align-items: center; gap: 8px; }
.tool-form .pair { display: flex; gap: 8px; }
.tool-form .pair input { width: 8em; }
.dlg-foot .note { margin-right: auto; align-self: center; }
.menu button:disabled { opacity: .45; cursor: not-allowed; background: none; }
@media (max-width: 760px) { .tools-stack { left: 8px; align-items: stretch; } .findbar, .info-card { width: auto; } .info-card { max-height: 40vh; } }
`;
/** Corners (scene-local) of a drawn text with a little margin, rotated with it (widths as drawn when known). */
function textQuad(t) {
  const W = t.fit || (t.w != null ? t.w : CHAR_W * t.s.length);
  const u0 = t.align === 0 ? 0 : t.align === 1 ? -W / 2 : -W;
  const [a, b, c, d] = t.m;
  const P = (u, v) => [t.x + u * a + v * c, t.y + u * b + v * d];
  return [P(u0 - 0.15, -0.3), P(u0 + W + 0.15, -0.3), P(u0 + W + 0.15, 1.2), P(u0 - 0.15, 1.2)];
}
const ICON_CLOSE = '<svg class="ic" aria-hidden="true"><use href="#i-close"/></svg>';
const items = (n) => `${fmtNum(n, 0)} item${n === 1 ? '' : 's'}`;
const EDIT_TOOLS = new Set(['eselect', 'eline', 'epoly', 'erect', 'ecircle', 'etext']);
const ids = new WeakMap();
let idSeq = 0;
/** A number per object (entities are replaced, never changed, by edits): cheap change detection. */
const oid = (o) => { if (!o) return 0; let v = ids.get(o); if (!v) ids.set(o, (v = ++idSeq)); return v; };

export function initTools(app, api) {
  const edit = api.edit, X = edit.x, E = app.edit;
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));
  let stack = $('#stage .tools-stack'); // (the Trace panel may have made it)
  if (!stack) { stack = Object.assign(document.createElement('div'), { className: 'tools-stack' }); $('#stage').appendChild(stack); }
  const inEdit = () => EDIT_TOOLS.has(app.tool);
  const vis = (li) => !app.layerVisible || !!app.layerVisible[li];
  const N = (v) => fmtNum(v, app.precision);
  const U = () => (app.scene && app.scene.units.abbr ? ' ' + app.scene.units.abbr : '');
  const ready = () => { if (E.ready) return true; toast('Preparing the drawing for editing…', { key: 'prep', timeout: 2500 }); return false; };
  const model = () => X.model();

  // ---------------------------------------------------------------- find and replace
  const F = { open: false, q: '', o: { matchCase: false, wholeWord: false, vis: true }, hits: [], k: -1, sig: '' };
  const bar = document.createElement('div');
  bar.className = 'findbar card';
  bar.setAttribute('role', 'search');
  bar.hidden = true;
  bar.innerHTML = `<input type="search" id="find-q" placeholder="Find text" aria-label="Find text" spellcheck="false" autocomplete="off">
    <span class="find-n" id="find-n" aria-live="polite"></span>
    <button type="button" class="btn icon sm" id="find-prev" title="Previous (Shift+Enter, Shift+F3)" aria-label="Previous match">↑</button>
    <button type="button" class="btn icon sm" id="find-next" title="Next (Enter, F3)" aria-label="Next match">↓</button>
    <button type="button" class="btn sm opt" data-o="matchCase" aria-pressed="false" title="Match case">Aa</button>
    <button type="button" class="btn sm opt" data-o="wholeWord" aria-pressed="false" title="Whole words only">Word</button>
    <button type="button" class="btn sm opt" data-o="vis" aria-pressed="true" title="Only levels / layers that are shown">Visible</button>
    <button type="button" class="btn icon sm" id="find-close" aria-label="Close find" title="Close (Esc)">${ICON_CLOSE}</button>
    <div class="find-rep" id="find-rep" hidden>
      <input type="text" id="find-r" placeholder="Replace with" aria-label="Replace with" spellcheck="false" autocomplete="off">
      <button type="button" class="btn sm" id="find-one" title="Replace in this text, then go to the next one">Replace</button>
      <button type="button" class="btn sm" id="find-all" title="Replace every match (one undo step)">Replace all</button>
    </div>`;
  stack.appendChild(bar);
  const qIn = $('#find-q', bar);
  /** Signature of what the hits depend on (texts added / retyped, layers shown). */
  function sig() {
    const s = app.scene;
    let v = 0;
    if (app.layerVisible) for (let i = 0; i < app.layerVisible.length; i++) v = (v * 31 + (app.layerVisible[i] ? i + 1 : 0)) | 0;
    return `${s ? s.texts.length : 0}:${v}`;
  }
  function search(keep) {
    const cur = F.hits[F.k];
    F.hits = findTexts(app.scene, F.q, { ...F.o, isVisible: F.o.vis ? vis : null });
    F.sig = sig();
    F.k = keep && cur ? F.hits.findIndex((h) => h.ent === cur.ent && h.sub === cur.sub) : -1;
    count();
  }
  function count() {
    const n = F.hits.length;
    $('#find-n', bar).textContent = !F.q ? '' : !n ? 'No matches' : F.k >= 0 ? `${F.k + 1} of ${n}` : `${n} match${n === 1 ? '' : 'es'}`;
    for (const id of ['#find-prev', '#find-next']) $(id, bar).disabled = !n;
  }
  function openFind() {
    if (!app.scene) return;
    F.open = true;
    bar.hidden = false;
    toolChanged();
    qIn.focus();
    qIn.select();
    if (F.q) search(true);
    api.invalidate();
  }
  function closeFind() {
    F.open = false; F.hits = []; F.k = -1;
    bar.hidden = true;
    api.invalidate();
    $('#stage').focus({ preventScroll: true });
  }
  /** Next (d = 1) or previous (-1) match: zoom to it, and in Edit select its item. */
  function findStep(d = 1) {
    if (!F.open) return;
    if (F.sig !== sig()) search(true);
    const n = F.hits.length;
    if (!n) { count(); return; }
    F.k = F.k < 0 ? (d > 0 ? 0 : n - 1) : (F.k + d + n) % n;
    count();
    goTo(F.hits[F.k]);
  }
  function goTo(h) {
    const v = app.view, q = textQuad(app.scene.texts[h.t]);
    const b = [Math.min(...q.map((p) => p[0])), Math.min(...q.map((p) => p[1])), Math.max(...q.map((p) => p[0])), Math.max(...q.map((p) => p[1]))];
    const [x0, y0] = v.toScreen(b[0], b[3]), [x1, y1] = v.toScreen(b[2], b[1]);
    const px = h.h * v.scale, fits = px >= 18 && px <= Math.min(64, v.h / 4);
    // zoom so that the text reads well (about 28 px high, the whole text in view), else just bring it into view
    if (!fits) v.scale = v.clampScale(Math.min(28 / h.h, (v.w * 0.7) / Math.max(1e-12, b[2] - b[0])));
    if (!fits || x0 < 30 || y0 < 90 || x1 > v.w - 30 || y1 > v.h - 30) { v.cx = (b[0] + b[2]) / 2; v.cy = (b[1] + b[3]) / 2; }
    if (inEdit() && E.ready && X.entity(h.ent)) X.setSel([h.ent]);
    api.invalidate(true);
  }
  function replace(all) {
    if (!inEdit() || !ready() || !F.q) return;
    if (F.sig !== sig()) search(true);
    if (!F.hits.length) { count(); return; }
    if (!all && F.k < 0) { findStep(1); return; } // the first press shows the first match
    const rep = $('#find-r', bar).value;
    const hits = all ? F.hits : [F.hits[F.k]];
    const r = replaceChanges(model().entities, hits, F.q, rep, F.o);
    const notes = [];
    if (r.shared) notes.push(`${r.shared} in block definitions shared by every copy (not changed here)`);
    if (r.blank) notes.push(`${r.blank} that would become empty (left as they are)`);
    if (!r.changes.length) {
      toast(all ? 'Nothing was replaced' : 'This text cannot be replaced here', { kind: 'warn', list: notes, timeout: 5000 });
      if (!all) findStep(1);
      return;
    }
    const k = F.k;
    X.commit(all ? `Replace ${r.texts} text${r.texts === 1 ? '' : 's'}` : 'Replace text', r.changes, r.changes.map((c) => c.i));
    if (all) toast(`Replaced ${r.texts} text${r.texts === 1 ? '' : 's'}`, { detail: 'One undo step (Ctrl+Z).', list: notes, listTitle: 'Not replaced' });
    const was = hits[0];
    search(false);
    if (all || !F.hits.length) { count(); return; }
    const same = F.hits.findIndex((h) => h.ent === was.ent && h.sub === was.sub);
    F.k = (same >= 0 ? same + 1 : Math.min(k, F.hits.length - 1)) % F.hits.length;
    count();
    goTo(F.hits[F.k]);
  }
  qIn.addEventListener('input', () => { F.q = qIn.value; search(false); api.invalidate(); });
  const keys = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    else if (e.key === 'Enter' && e.target === qIn) { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Enter' && e.target.id === 'find-r') { e.preventDefault(); replace(e.ctrlKey || e.metaKey); }
    else if (e.key === 'F3') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); qIn.focus(); qIn.select(); }
  };
  bar.addEventListener('keydown', keys);
  $('#find-prev', bar).addEventListener('click', () => findStep(-1));
  $('#find-next', bar).addEventListener('click', () => findStep(1));
  $('#find-close', bar).addEventListener('click', closeFind);
  $('#find-one', bar).addEventListener('click', () => replace(false));
  $('#find-all', bar).addEventListener('click', () => replace(true));
  for (const b of bar.querySelectorAll('.opt')) {
    b.addEventListener('click', () => {
      F.o[b.dataset.o] = !F.o[b.dataset.o];
      b.setAttribute('aria-pressed', String(F.o[b.dataset.o]));
      search(true); api.invalidate();
    });
  }

  // ---------------------------------------------------------------- overlay: find hits, key-in preview
  let KP = null; // the key-in being typed: { pt, from } | { dx, dy } | { rot, c }
  function drawOverlay(ctx) {
    if (!app.scene) return;
    const acc = api.accent(), v = app.view, dpr = app.dpr;
    ctx.save();
    if (F.open && F.q) {
      if (F.sig !== sig() || F.hits.some((h) => app.scene.texts[h.t].dead)) search(true);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = ctx.fillStyle = acc;
      ctx.lineJoin = 'round';
      F.hits.forEach((h, k) => {
        const b = h.bbox, [x0, y0] = v.toScreen(b[0], b[3]), [x1, y1] = v.toScreen(b[2], b[1]);
        if (x1 < -200 || y1 < -200 || x0 > v.w + 200 || y0 > v.h + 200) return;
        const q = textQuad(app.scene.texts[h.t]).map(([x, y]) => v.toScreen(x, y));
        ctx.beginPath();
        q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        const cur = k === F.k;
        if (cur) { ctx.globalAlpha = 0.2; ctx.fill(); }
        ctx.globalAlpha = cur ? 1 : 0.65;
        ctx.lineWidth = cur ? 2.5 : 1.5;
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    }
    if (KP && edit.ready) {
      const M = v.matrix(dpr), [ox, oy] = app.scene.origin;
      if (KP.pt) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const [x, y] = app.worldToScreen(KP.pt[0], KP.pt[1]);
        ctx.strokeStyle = acc; ctx.lineWidth = 2;
        if (KP.from) { const [fx, fy] = app.worldToScreen(KP.from[0], KP.from[1]); ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]); }
        ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
      } else if (KP.dx != null || KP.rot != null) {
        ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
        if (KP.rot != null) { const cx = KP.c[0] - ox, cy = KP.c[1] - oy; ctx.translate(cx, cy); ctx.rotate(KP.rot); ctx.translate(-cx, -cy); }
        else ctx.translate(KP.dx, KP.dy);
        ctx.strokeStyle = acc; ctx.lineWidth = 2 / v.scale; ctx.setLineDash([7 / v.scale, 4 / v.scale]);
        for (const p of X.selPath()) ctx.stroke(p);
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- key-ins
  /** What a key-in would do: { msg, apply(), and a preview: pt/from | dx/dy | rot/c } or { error }. */
  function plan(text, copy) {
    const k = parseKeyin(text);
    if (k.error) return { error: k.error };
    const t = app.tool, sel = E.sel.size, onSel = t === 'eselect' && sel && !E.place && !E.pick, u = U();
    if (k.kind === 'aa') {
      const a = k.v[0];
      if (onSel) { const c = X.selCentre(); return { msg: `Rotate ${items(sel)} by ${fmtNum(a, 2)}° about their centre`, rot: a * RAD, c, apply: () => rotateSel(a * RAD, c) }; }
      return { msg: `Active angle ${fmtNum(a, 2)}°: new text is placed at this angle`, apply: () => { E.aa = a * RAD; X.hint(`Active angle ${fmtNum(a, 2)}° (new text)`, 4000); } };
    }
    if (k.kind === 'len') {
      const L = k.v[0], d = E.draft, c = E.cursor;
      if (d && (d.tool === 'eline' || d.tool === 'epoly' || d.tool === 'ecircle') && L > 0) {
        const a = d.tool === 'ecircle' ? d.pts.slice(0, 2) : d.pts.slice(-2);
        let dx = c ? c.x - a[0] : 1, dy = c ? c.y - a[1] : 0;
        const n = Math.hypot(dx, dy);
        if (n < 1e-12) { dx = 1; dy = 0; } else { dx /= n; dy /= n; }
        const p = [a[0] + dx * L, a[1] + dy * L];
        return { msg: `${d.tool === 'ecircle' ? 'Radius' : 'Length'} ${N(L)}${u}, towards the cursor`, pt: p, from: a, apply: () => X.keyPoint(p) };
      }
      return { error: 'A plain number is a length while drawing a line or polyline, or a circle’s radius. Otherwise use XY=, DL=, DI= or AA=.' };
    }
    if (onSel) { // move or copy the selection
      const ext = X.extOf(E.sel);
      const d = k.kind === 'xy' ? [k.v[0] - ext[0], k.v[1] - ext[1]] : keyinPoint(k, [0, 0]);
      return { msg: `${copy ? 'Copy' : 'Move'} ${items(sel)} by ΔX ${N(d[0])}  ΔY ${N(d[1])}${u}${k.kind === 'xy' ? ' (lower-left corner to that point)' : ''}`, dx: d[0], dy: d[1], apply: () => moveSel(d, copy) };
    }
    if (t === 'eselect' && !E.place && !E.pick) return { error: 'Select items first (to move, copy or rotate them), or pick a draw tool' };
    const last = X.lastPoint(), p = keyinPoint(k, last);
    if (!p) return { error: 'DL= and DI= start from the last point: click one or type XY= first' };
    const rel = last ? `  · ${N(Math.hypot(p[0] - last[0], p[1] - last[1]))}${u} from the last point` : '';
    return { msg: `${E.place ? 'Place at' : 'Point'} X ${N(p[0])}  Y ${N(p[1])}${u}${rel}`, pt: p, from: last, apply: () => X.keyPoint(p) };
  }
  function previewKeyin(text) {
    const out = $('#len-prev');
    if (text == null || !app.scene) { KP = null; api.invalidate(); return; }
    const P = text.trim() ? plan(text, $('#len-copy').checked) : null;
    KP = P && !P.error ? P : null;
    out.textContent = P ? P.error || P.msg : 'XY=x,y · DL=dx,dy · DI=distance,angle · AA=angle';
    out.classList.toggle('bad', !!(P && P.error));
    X.placeLen();
    api.invalidate();
  }
  function applyKeyin(text, copy) {
    KP = null;
    const P = plan(text, copy);
    if (P.error) { edit.openKeyin(text, copy); return false; }
    P.apply();
    api.invalidate();
    return true;
  }
  function moveSel(d, copy) {
    const ids = [...E.sel];
    if (copy) { X.pasteNow(X.dupPrep(), d, 'Copy'); return; }
    X.commit(ids.length > 1 ? `Move ${ids.length} items` : 'Move', ids.map((i) => ({ i, before: X.entity(i), after: moveEntity(X.entity(i), d[0], d[1]) })), ids);
  }
  function rotateSel(a, c) {
    const ids = [...E.sel];
    X.commit('Rotate', ids.map((i) => ({ i, before: X.entity(i), after: rotateEntity(X.entity(i), a, c[0], c[1]) })), ids);
  }

  // ---------------------------------------------------------------- mirror, scale, array
  function mirror(axis, c = X.selCentre()) {
    const ids = [...E.sel], s = app.scene, [ox, oy] = s.origin;
    if (!ids.length) return;
    let moved = 0;
    const changes = ids.map((i) => {
      const e = X.entity(i);
      let centre;
      if (isText(e)) { const b = entityBBox(s, i); if (b) centre = [(b[0] + b[2]) / 2 + ox, (b[1] + b[3]) / 2 + oy]; } else if (e.dgn) moved++;
      return { i, before: e, after: mirrorEntity(e, axis, c[0], c[1], { centre }) };
    });
    X.commit(axis === 'v' ? 'Mirror up / down' : 'Mirror left / right', changes, ids);
    if (moved && X.isDgn()) toast('Mirrored', { key: 'mirror', timeout: 6000, detail: 'A DGN element cannot be mirrored in place: Save writes mirrored items from what Linework shows (the save notes list them). Texts stay readable and only move.' });
  }
  function pickPoint(hint, fn) {
    if (app.tool !== 'eselect') api.setTool('eselect');
    X.startPick({ hint, fn: (c, sx, sy) => { X.endPick(); fn([c.x, c.y], sx, sy); } });
  }
  function mirrorAtPoint() {
    const ids = [...E.sel];
    pickPoint('Click the point to mirror about (snaps on) · or type XY=x,y · Esc cancels', (p, sx, sy) => {
      setTimeout(() => X.openMenu(sx, sy, [
        { label: 'Mirror left ↔ right here', act: () => { X.setSel(ids); mirror('h', p); } },
        { label: 'Mirror up ↕ down here', act: () => { X.setSel(ids); mirror('v', p); } },
      ]), 0);
    });
  }
  function scaleSel(f, c) {
    const ids = [...E.sel];
    X.commit(`Scale ×${fmtNum(f, 4).replace(/\.?0+$/, '')}`, ids.map((i) => ({ i, before: X.entity(i), after: scaleEntity(X.entity(i), f, c[0], c[1]) })), ids);
  }
  function arraySel(n, dx, dy) {
    const r = X.dupPrep();
    if (!r.ents.length) return;
    if (n * r.ents.length > PASTE_MAX) { toast('That is too many copies for one array', { kind: 'warn', detail: `Up to ${fmtNum(PASTE_MAX, 0)} items at a time.` }); return; }
    const ents = arrayCopies(r.ents, n, dx, dy), i0 = X.newIdx();
    X.commit(`Array: ${n} cop${n === 1 ? 'y' : 'ies'}`, [...r.changes, ...ents.map((e, k) => ({ i: i0 + k, before: null, after: e }))], ents.map((_, k) => i0 + k));
    toast(`Array: ${n} cop${n === 1 ? 'y' : 'ies'} of ${items(r.ents.length)}`, { timeout: 4000, detail: 'One undo step (Ctrl+Z). The copies are selected.', list: r.notes });
  }

  // a small dialog for the tools that take values
  const dlg = document.createElement('dialog');
  dlg.setAttribute('aria-labelledby', 'tool-title');
  dlg.innerHTML = `<form method="dialog" class="dlg"><div class="dlg-head"><h2 id="tool-title"></h2><button class="btn icon sm" value="cancel" aria-label="Close">${ICON_CLOSE}</button></div>
    <div class="dlg-body form-grid tool-form" id="tool-body"></div>
    <div class="dlg-foot"><span class="note" id="tool-note" aria-live="polite"></span><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok" id="tool-ok">OK</button></div></form>`;
  document.body.appendChild(dlg);
  /** Open the tool dialog: body html, onInput(form) -> note text (or { note, bad }), onOk(form). */
  function dialog(title, ok, html, onInput, onOk) {
    $('#tool-title', dlg).textContent = title;
    $('#tool-ok', dlg).textContent = ok;
    const body = $('#tool-body', dlg);
    body.innerHTML = html;
    const form = dlg.querySelector('form');
    const check = (e) => { const r = onInput ? onInput(form, e) : ''; const bad = r && r.bad; $('#tool-note', dlg).textContent = (r && r.note) || r || ''; $('#tool-ok', dlg).disabled = !!bad; };
    body.oninput = check; body.onchange = check;
    check();
    dlg.returnValue = '';
    dlg.onclose = () => { if (dlg.returnValue === 'ok') onOk(form); };
    dlg.showModal();
    const f = body.querySelector('input[type="text"], select');
    if (f) { f.focus(); if (f.select) f.select(); }
  }
  const num = (form, name) => { const v = String(form.elements[name].value).trim(); return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v) ? Number(v) : NaN; };
  function openScale() {
    dialog('Scale the selection', 'Scale', `<label class="row">Factor<input type="text" name="f" inputmode="decimal" value="2" autocomplete="off"></label>
      <fieldset><legend>About</legend><label class="radio"><input type="radio" name="at" value="c" checked> The selection’s centre</label><label class="radio"><input type="radio" name="at" value="p"> A point I click</label></fieldset>`,
    (f) => { const v = num(f, 'f'); return v > 0 && v !== 1 ? `${items(E.sel.size)} × ${fmtNum(v, 4).replace(/\.?0+$/, '')}` : { note: 'A factor above 0 (0.5 halves, 2 doubles)', bad: true }; },
    (f) => {
      const v = num(f, 'f');
      if (f.elements.at.value === 'c') scaleSel(v, X.selCentre());
      else { const ids = [...E.sel]; pickPoint('Click the base point of the scale (snaps on) · or type XY=x,y · Esc cancels', (p) => { X.setSel(ids); scaleSel(v, p); }); }
    });
  }
  function openArray() {
    const b = X.extOf(E.sel), w = b[2] - b[0];
    const nice = (v) => Number(v.toPrecision(3));
    dialog('Array: copies at an offset', 'Make copies', `<label class="row">Copies<input type="text" name="n" inputmode="numeric" value="2" autocomplete="off"></label>
      <div class="row"><span>Offset X, Y${U() ? ` (${esc(U().trim())})` : ''}</span><span class="pair"><input type="text" name="dx" inputmode="decimal" aria-label="Offset X" value="${nice(w > 0 ? w * 1.2 : 1)}" autocomplete="off"><input type="text" name="dy" inputmode="decimal" aria-label="Offset Y" value="0" autocomplete="off"></span></div>`,
    (f) => { const n = num(f, 'n'), dx = num(f, 'dx'), dy = num(f, 'dy'); return Number.isInteger(n) && n >= 1 && n <= 1000 && Number.isFinite(dx) && Number.isFinite(dy) && (dx || dy) ? `${n} cop${n === 1 ? 'y' : 'ies'} of ${items(E.sel.size)}, one undo step` : { note: 'Copies 1–1000 and an offset that is not 0, 0', bad: true }; },
    (f) => arraySel(num(f, 'n'), num(f, 'dx'), num(f, 'dy')));
  }

  // ---------------------------------------------------------------- select same, match attributes
  const attrName = (a) => ({ layer: X.isDgn() ? 'Level' : 'Layer', color: 'Colour', weight: 'Weight', type: 'Type' }[a]);
  function valueLabel(e, a, f) {
    if (a === 'layer') return app.layerLabel(String(e.layer ?? '0'));
    if (a === 'type') return typeName(e, f);
    if (a === 'weight') return f === 'DGN' ? `Weight ${e.weight | 0}` : e.lw >= 0 ? (e.lw / 100).toFixed(2) + ' mm' : ['ByLayer', 'ByBlock', 'Default'][-1 - (e.lw ?? -1)] || 'Default';
    const c = colorOf(e, f);
    return (f === 'DGN' ? `Colour ${c.label}` : /^\d+$/.test(c.label) ? `Colour ${c.label}` : c.label) + (c.rgb != null && f === 'DGN' ? ` (#${(c.rgb & 0xffffff).toString(16).padStart(6, '0')})` : '');
  }
  let sameChecks = { layer: true };
  function openSelectSame() {
    if (!ready()) return;
    if (!inEdit()) api.setTool('eselect');
    const f = X.fmt(), ents = model().entities, cand = [...X.visibleEnts()].filter((i) => ents[i]);
    const sel = [...E.sel];
    const rows = ATTRS.map((a) => {
      const vals = [...valuesOf(ents, cand, a, f)].map(([k, v]) => ({ k, label: valueLabel(v.e, a, f), n: v.n })).sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }));
      const opts = (sel.length ? [`<option value="__sel">Same as the selection</option>`] : []).concat(vals.map((v) => `<option value="${esc(v.k)}">${esc(v.label)} (${v.n})</option>`));
      return `<div class="row"><label class="check"><input type="checkbox" name="on-${a}" ${sameChecks[a] && sel.length ? 'checked' : ''}> ${attrName(a)}</label><select name="v-${a}" aria-label="${attrName(a)}">${opts.join('')}</select></div>`;
    }).join('');
    let found = new Set();
    dialog('Select same', 'Select', `${rows}<p class="note">Only items on shown ${X.isDgn() ? 'levels' : 'layers'} are selected.</p>`, (form, e) => {
      if (e && e.target.tagName === 'SELECT') form.elements['on-' + e.target.name.slice(2)].checked = true; // a value picked: use it
      const keys = {};
      for (const a of ATTRS) {
        if (!form.elements[`on-${a}`].checked) continue;
        const v = form.elements[`v-${a}`].value;
        keys[a] = v === '__sel' ? keysOf(ents, sel, [a], f)[a] : new Set([v]);
      }
      found = selectByKeys(ents, cand, keys, f);
      return Object.keys(keys).length ? { note: `${items(found.size)} match`, bad: !found.size } : { note: 'Tick at least one attribute', bad: true };
    }, (form) => {
      sameChecks = Object.fromEntries(ATTRS.map((a) => [a, form.elements[`on-${a}`].checked]));
      X.setSel(found);
      toast(`Selected ${items(found.size)}`, { timeout: 2500 });
    });
  }
  function startMatch() {
    if (!ready()) return;
    if (app.tool !== 'eselect') api.setTool('eselect');
    const sel = [...E.sel], f = X.fmt();
    const apply = (ids, src, si) => {
      ids = ids.filter((j) => j !== si && X.entity(j));
      if (ids.length) X.commit(ids.length > 1 ? `Match attributes (${ids.length} items)` : 'Match attributes', ids.map((j) => ({ i: j, before: X.entity(j), after: matchStyle(X.entity(j), src, f) })), ids);
      return ids.length;
    };
    X.startPick({ hover: true, hint: 'Match attributes: click the item to copy its level, colour, weight and line style from · Esc cancels', fn: (c, sx, sy) => {
      const si = X.pickEnt(sx, sy);
      if (si < 0) return;
      const src = X.entity(si);
      const what = `${valueLabel(src, 'layer', f)} · ${valueLabel(src, 'color', f)} · ${valueLabel(src, 'weight', f)}`;
      if (sel.length) { const n = apply(sel, src, si); if (n) toast(`Matched ${items(n)}`, { timeout: 3000, detail: what }); }
      X.startPick({ hover: true, hint: `Click items to give them ${what} · Esc when done`, fn: (c2, sx2, sy2) => { const j = X.pickEnt(sx2, sy2); if (j >= 0) apply([j], src, si); } });
    } });
  }

  // ---------------------------------------------------------------- element information
  const card = document.createElement('aside');
  card.className = 'info-card card';
  card.setAttribute('aria-label', 'Element information');
  card.hidden = true;
  stack.appendChild(card);
  let info = false, infoKey = null;
  card.addEventListener('click', (e) => { if (e.target.closest('#info-close')) toggleInfo(false); });
  function toggleInfo(on = !info) { info = on; infoKey = null; renderInfo(); }
  function infoTarget() {
    if (!E.ready) return null;
    if (inEdit() && E.sel.size) return { ids: [...E.sel] };
    if (inEdit() && E.hover >= 0) return { ids: [E.hover], hover: true };
    if (!inEdit() && app.hover && app.hover.ent != null && X.entity(app.hover.ent)) return { ids: [app.hover.ent], hover: true };
    return null;
  }
  const sw = (rgb) => (rgb === undefined ? '' : `<i class="sw ${rgb === null || (rgb & 0xffffff) === 0xffffff ? 'fg' : ''}" style="--c:#${((rgb || 0) & 0xffffff).toString(16).padStart(6, '0')}"></i>`);
  function renderInfo() {
    card.hidden = !info || !app.scene;
    if (card.hidden) return;
    const T = infoTarget(), f = X.fmt ? X.fmt() : 'DXF';
    const sig = (list) => list.map((i) => `${i}:${oid(X.entity(i))}`).join(',');
    const key = !T ? (E.ready ? 'none' : 'wait') : `${T.hover ? 'h' : 's'}${app.precision}:${T.ids.length > 200 ? `${T.ids.length}:${sig([T.ids[0], T.ids[T.ids.length - 1]])}:${oid(model())}` : sig(T.ids)}`;
    if (key === infoKey) return;
    infoKey = key;
    let title = 'Element info', body;
    if (!T) body = `<p class="none">${E.ready ? 'Point at an item, or select items in Edit, to see their details.' : 'Preparing the drawing…'}</p>`;
    else if (T.ids.length === 1) {
      const i = T.ids[0], e = X.entity(i);
      title = T.hover ? 'Under the cursor' : 'Selected item';
      const r = entityInfo(e, { format: f, bytes: E.doc.bytes, orig: E.doc.orig[i], abbr: app.scene.units.abbr, dec: app.precision, layerLabel: app.layerLabel });
      body = `<dl>${r.rows.map(([k, v, rgb]) => `<dt>${esc(k)}</dt><dd>${sw(rgb)}${esc(v)}</dd>`).join('')}</dl>`
        + (r.parts.length ? `<details><summary>${r.parts.length} component${r.parts.length === 1 ? '' : 's'}</summary><ol>${r.parts.map((p) => `<li style="margin-left:${p.depth * 12}px">${esc(p.text)}</li>`).join('')}</ol></details>` : '');
    } else {
      title = `${items(T.ids.length)} selected`;
      const ents = model().entities, rows = [];
      for (const a of ATTRS) {
        const vals = [...valuesOf(ents, T.ids, a, f)].sort((x, y) => y[1].n - x[1].n);
        rows.push([a === 'type' ? 'Types' : attrName(a), vals.slice(0, 4).map(([, v]) => `${valueLabel(v.e, a, f)}${vals.length > 1 ? ` (${v.n})` : ''}`).join(', ') + (vals.length > 4 ? `, +${vals.length - 4} more` : '')]);
      }
      const b = X.extOf(T.ids);
      rows.push(['Extents', `${N(b[2] - b[0])} × ${N(b[3] - b[1])}${U()}`], ['Lower left', `${N(b[0])}, ${N(b[1])}`]);
      body = `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    }
    card.innerHTML = `<div class="mc-head"><span>${esc(title)}</span><button type="button" class="btn icon sm" id="info-close" aria-label="Close element info" title="Close (I)">${ICON_CLOSE}</button></div>${body}`;
  }

  // ---------------------------------------------------------------- Edit › More menu
  function openMenu() {
    if (!inEdit()) api.setTool('eselect');
    if (!ready()) return;
    const sel = E.sel.size > 0, b = $('#btn-etools'), st = $('#stage').getBoundingClientRect(), r = b.getBoundingClientRect();
    const need = sel ? undefined : 'Select items first';
    X.openMenu(Math.max(4, r.left - st.left), 4, [
      { label: 'Find and replace text…', act: openFind, title: 'Ctrl+F' },
      { label: 'Key-in a point (XY= DL= DI= AA=)…', act: () => edit.openKeyin(''), title: 'In a draw tool: exact points. With a selection: move, copy or rotate it' },
      { label: 'Move by a distance…', disabled: !sel, title: need, act: () => edit.openKeyin('DL=') },
      { label: 'Copy by a distance…', disabled: !sel, title: need, act: () => edit.openKeyin('DL=', true) },
      { label: 'Rotate by an angle…', disabled: !sel, title: need, act: () => edit.openKeyin('AA=') },
      { label: 'Mirror left ↔ right', disabled: !sel, title: need || 'About the selection’s centre', act: () => mirror('h') },
      { label: 'Mirror up ↕ down', disabled: !sel, title: need || 'About the selection’s centre', act: () => mirror('v') },
      { label: 'Mirror about a point…', disabled: !sel, title: need, act: mirrorAtPoint },
      { label: 'Scale…', disabled: !sel, title: need, act: openScale },
      { label: 'Array (copies at an offset)…', disabled: !sel, title: need, act: openArray },
      { label: 'Select same…', act: openSelectSame, title: 'Level, colour, weight or type of the selection, or picked from lists' },
      { label: 'Match attributes', act: startMatch, title: 'Copy level, colour, weight and style from one item to others' },
      { label: `${info ? 'Hide' : 'Show'} element info`, act: () => toggleInfo(), title: 'I' },
    ]);
  }

  // ---------------------------------------------------------------- level names (DGN): kept in this browser, never in the file
  async function levelNames(cmd, a, b) {
    const names = app.levelNames;
    if (cmd === 'rename') renameRow(a, b);
    else if (cmd === 'export') {
      if (!names.size) { toast('No level names to export yet', { timeout: 3000, detail: 'Name levels with the pen in the Layers panel, or import a names file.' }); return; }
      download(new Blob([levelNamesCsv(names)], { type: 'text/csv' }), app.doc.name.replace(/\.[^.]+$/, '') + '-levels.csv');
    } else if (cmd === 'clear') {
      if (!names.size) return;
      app.setLevelNames(new Map());
      toast('Level names cleared', { timeout: 6000, actions: [{ label: 'Undo', onClick: () => app.setLevelNames(names) }] });
    } else if (cmd === 'import') {
      const r = parseLevelNames(await a.text());
      if (!r.names.size) { toast('No level names found in that file', { kind: 'warn', detail: 'One level per line: number, name (for example “5,Power”).' }); return; }
      app.setLevelNames(new Map([...names, ...r.names]));
      toast(`Imported ${r.names.size} level name${r.names.size === 1 ? '' : 's'}`, { detail: 'Kept in this browser for this drawing; the file is not changed.', list: r.skipped.length ? [`Lines skipped: ${r.skipped.slice(0, 20).join(', ')}${r.skipped.length > 20 ? '…' : ''}`] : undefined });
    }
  }
  /** Type a name for level `lv` in its Layers panel row (Enter or leaving the box keeps it, Esc cancels). */
  function renameRow(li, lv) {
    const span = li && li.querySelector('.lname');
    if (!span || span.querySelector('input')) return;
    const cur = app.levelNames.get(lv) || '';
    span.innerHTML = `Level ${lv} <input class="lvin" maxlength="64" aria-label="Name of level ${lv}" placeholder="Name">`;
    const inp = span.querySelector('input');
    inp.value = cur;
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const v = cleanName(inp.value);
      if (!keep || v === cur) { api.layersPanel.render(); return; }
      const m = new Map(app.levelNames);
      if (v) m.set(lv, v); else m.delete(lv);
      app.setLevelNames(m);
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('click', (e) => e.preventDefault()); // (inside the row's label: keep the checkbox as it is)
    inp.focus();
  }

  // ---------------------------------------------------------------- hooks
  function toolChanged() {
    $('#find-rep', bar).hidden = !inEdit();
    infoKey = null;
    if (info) renderInfo();
  }
  function docChanged() {
    if (F.open) closeFind();
    KP = null; infoKey = null;
    renderInfo();
  }
  const run = (cmd, ...a) => ({
    find: openFind, menu: openMenu, same: openSelectSame, match: startMatch,
    info: () => toggleInfo(a[0] === true ? true : undefined), keyin: () => previewKeyin(a[0]), apply: () => applyKeyin(a[0], a[1]),
    names: () => levelNames(...a),
  }[cmd] || (() => {}))();
  return {
    run, drawOverlay, findStep, toolChanged, docChanged,
    selChanged: () => { if (info) renderInfo(); },
    // (for tests and automation)
    get find() { return { open: F.open, hits: F.hits.length, k: F.k }; },
    mirror, scaleSel, arraySel, rotateSel, moveSel, startMatch, openSelectSame,
  };
}
