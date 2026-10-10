// View › Compare (loaded on first use): another revision over this drawing (A) — only in A red,
// only in B green, the rest dimmed — with a panel that counts and steps through the changes.
import { describeScene, diffScenes, quantum } from '../tools/compare.js';
import { hashBytes } from '../worker.js';
import { addConic, addPoly, CAP_HEIGHT } from '../view/renderer2d.js';
import { KIND } from '../scene.js';
import { entityItems } from '../edit/live-scene.js';
import { $, toast, esc } from './ui.js';

const LIST_MAX = 2000;
const FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const K = 64 * CAP_HEIGHT;
const COLORS = { dark: ['#ff5c5c', '#3ddc84'], paper: ['#d4001a', '#08873a'] };
const KIND_LABEL = { moved: 'Moved', changed: 'Changed', removed: 'Only in A', added: 'Only in B' };
const family = (f) => (f === 'DGN' ? 'DGN' : 'CAD');
let C = null; // the compare session
let hooked = false;

/** Ask for the other drawing, read it, and show the comparison. */
export async function startCompare(app) {
  const file = await chooseFile();
  if (!file || !app.doc) return;
  let r;
  try { r = await app.readDrawing(file.name, await file.arrayBuffer()); } catch (e) {
    toast(`Could not compare with ${file.name}`, { kind: 'error', detail: e && e.message ? e.message : String(e) });
    return;
  }
  if (family(r.scene.format) !== family(app.scene.format)) {
    toast('Compare needs two drawings of the same kind', { kind: 'warn', detail: 'DGN with DGN, or DXF / DWG with DXF / DWG.' });
    return;
  }
  for (let t = 0; t < 600 && !(app.edit && app.edit.ready); t++) await new Promise((res) => setTimeout(res, 50));
  end(app);
  C = { app, name: file.name, b: r, show: { a: true, b: true, same: true }, cur: -1, timer: 0 };
  if (!hooked) {
    hooked = true;
    app.hooks.draw.push((ctx) => draw(ctx));
    app.hooks.open.push(() => end(app));
    app.hooks.history.push(() => { if (C) { clearTimeout(C.timer); C.timer = setTimeout(() => { if (C) { compute(); render(); } }, 300); } });
  }
  compute();
  panel();
  render();
  const n = C.r.changes.length;
  toast(n ? `${n} difference${n === 1 ? '' : 's'} found` : 'No differences found', { key: 'compare', timeout: 4000, detail: `${app.doc.name} (A) and ${file.name} (B).` });
}

function chooseFile() {
  const input = () => {
    let inp = $('#compare-input');
    if (!inp) {
      inp = Object.assign(document.createElement('input'), { type: 'file', id: 'compare-input', hidden: true, accept: '.dxf,.dgn,.dwg' });
      document.body.appendChild(inp);
    }
    return new Promise((res) => { inp.onchange = () => { const f = inp.files[0]; inp.value = ''; res(f || null); }; inp.click(); });
  };
  if (typeof window.showOpenFilePicker !== 'function') return input();
  return window.showOpenFilePicker({ id: 'linework-compare', types: [{ description: 'Drawings', accept: { 'application/octet-stream': ['.dxf', '.dwg', '.dgn'] } }] })
    .then((hs) => hs[0].getFile(), (e) => (e && e.name === 'AbortError' ? null : input()));
}

/** Byte hash of a DGN entity (only while it is still as read from the file). */
const bytesKey = (model, bytes, orig) => (bytes ? (i) => {
  const e = model.entities[i];
  return e && e.dgn && (!orig || e === orig[i]) ? hashBytes(bytes.subarray(e.dgn[0], e.dgn[1])) : null;
} : null);

function compute() {
  const app = C.app, sa = app.scene, sb = C.b.scene, d = app.edit && app.edit.doc;
  const q = quantum(sa, sb), dgn = sa.format === 'DGN';
  if (!C.B) C.B = describeScene(sb, { q, bytesKey: dgn ? bytesKey(C.b.model, C.b.bytes, null) : null });
  C.A = describeScene(sa, { q, bytesKey: dgn && d ? bytesKey(d.model, d.bytes, d.orig) : null });
  C.r = diffScenes(C.A, C.B);
  C.pa = paths(sa, C.r.onlyA.map((k) => C.A[k].ent));
  C.pb = paths(sb, C.r.onlyB.map((k) => C.B[k].ent));
  if (C.cur >= C.r.changes.length) C.cur = -1;
  app.compare = { a: C.r.onlyA.length, b: C.r.onlyB.length, same: C.r.same, sameBytes: C.r.sameBytes, changes: C.r.changes.map((c) => c.kind), cur: C.cur, show: C.show };
}
/** Overlay paths (in their scene's coordinates) and texts of these entities. */
function paths(scene, ents) {
  const list = [], texts = [];
  let p = null, n = 0;
  for (const i of ents) {
    const it = entityItems(scene, i);
    for (const id of it.prims) {
      if (scene.dead && scene.dead[id]) continue;
      if (!p || n++ > 1500) { p = new Path2D(); list.push(p); n = 0; }
      if (scene.kind[id] === KIND.CONIC) addConic(p, scene, id);
      else if (scene.kind[id] === KIND.POINT) { const s = scene.start[id] * 2; p.moveTo(scene.coords[s], scene.coords[s + 1]); p.lineTo(scene.coords[s], scene.coords[s + 1]); }
      else addPoly(p, scene, id);
    }
    for (const t of it.texts) if (!scene.texts[t].dead) texts.push(scene.texts[t]);
  }
  return { list, texts };
}

function draw(ctx) {
  if (!C || !C.app.scene) return;
  const app = C.app, v = app.view, dpr = app.dpr, M = v.matrix(dpr), [ca, cb] = COLORS[app.theme] || COLORS.dark;
  const [ax, ay] = app.scene.origin, [bx, by] = C.b.scene.origin;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const layer = (P, color, dx, dy) => {
    const e = M[4] + M[0] * dx, f = M[5] + M[3] * dy;
    ctx.setTransform(M[0], 0, 0, M[3], e, f);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2 / v.scale;
    for (const p of P.list) ctx.stroke(p);
    ctx.fillStyle = color;
    ctx.font = `64px ${FONT}`;
    ctx.textBaseline = 'alphabetic';
    for (const t of P.texts) {
      const m = t.m;
      if (Math.hypot(m[2], m[3]) * v.scale < 3) { // tiny: a bar where the text is
        ctx.setTransform(M[0], 0, 0, M[3], e, f);
        const b = t.bbox;
        ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
        continue;
      }
      ctx.textAlign = t.align === 0 ? 'left' : t.align === 1 ? 'center' : 'right';
      const fx = t.fit ? (t.fit * K) / (ctx.measureText(t.s).width || 1) : 1;
      ctx.setTransform((M[0] * m[0] * fx) / K, (M[3] * m[1] * fx) / K, (-M[0] * m[2]) / K, (-M[3] * m[3]) / K, M[0] * t.x + e, M[3] * t.y + f);
      ctx.fillText(t.s, 0, 0);
    }
  };
  if (C.show.a) layer(C.pa, ca, 0, 0);
  if (C.show.b) layer(C.pb, cb, bx - ax, by - ay);
  const ch = C.r.changes[C.cur];
  if (ch) { // the change being looked at
    const [x0, y0] = app.worldToScreen(ch.bbox[0], ch.bbox[1]), [x1, y1] = app.worldToScreen(ch.bbox[2], ch.bbox[3]);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = app.theme === 'paper' ? '#0062d6' : '#2bd1ff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(Math.min(x0, x1) - 8, Math.min(y0, y1) - 8, Math.abs(x1 - x0) + 16, Math.abs(y1 - y0) + 16);
  }
  ctx.restore();
}

function panel() {
  if ($('#compare-panel')) return;
  $('.workspace').insertAdjacentHTML('beforeend', `<aside class="panel compare-panel" id="compare-panel" aria-labelledby="cmp-title">
    <div class="panel-head"><h2 id="cmp-title">Compare</h2><button type="button" class="btn icon sm" id="cmp-close" aria-label="Close compare" title="Close: the drawing is shown as before"><svg class="ic" aria-hidden="true"><use href="#i-close"/></svg></button></div>
    <div class="cmp-files" id="cmp-files"></div>
    <div class="cmp-toggles">
      <label class="layer"><input type="checkbox" data-show="a" checked><i class="sw cmp-a"></i><span class="lname">Only in A</span><span class="ln-count" id="cmp-na"></span></label>
      <label class="layer"><input type="checkbox" data-show="b" checked><i class="sw cmp-b"></i><span class="lname">Only in B</span><span class="ln-count" id="cmp-nb"></span></label>
      <label class="layer"><input type="checkbox" data-show="same" checked><i class="sw"></i><span class="lname">Unchanged (dimmed)</span><span class="ln-count" id="cmp-ns"></span></label>
    </div>
    <div class="cmp-nav"><button type="button" class="btn sm" id="cmp-prev" title="Previous change">‹ Previous</button><span id="cmp-pos" aria-live="polite"></span><button type="button" class="btn sm" id="cmp-next" title="Next change">Next ›</button></div>
    <ul class="layer-list cmp-list" id="cmp-list" aria-label="Changes"></ul>
  </aside>`);
  $('#cmp-close').addEventListener('click', () => end(C && C.app));
  $('#compare-panel').addEventListener('change', (e) => {
    const k = e.target.dataset.show;
    if (!k || !C) return;
    C.show[k] = e.target.checked;
    dim();
    C.app.invalidate();
  });
  $('#cmp-prev').addEventListener('click', () => step(-1));
  $('#cmp-next').addEventListener('click', () => step(1));
  $('#cmp-list').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) go(Number(b.dataset.k)); });
}
const label = (c) => `${KIND_LABEL[c.kind]} · ${c.type ? c.type.charAt(0) + c.type.slice(1).toLowerCase().replace(/_/g, ' ') : 'Item'}${c.text != null ? ` “${c.text}”${c.text2 != null ? ` → “${c.text2}”` : ''}` : ''} · ${c.layer}`;
function render() {
  if (!C || !$('#compare-panel')) return;
  const { r, app } = C, ch = r.changes;
  $('#cmp-files').innerHTML = `<div><i class="sw cmp-a"></i><b>A</b> ${esc(app.doc.name)} <small>(open)</small></div><div><i class="sw cmp-b"></i><b>B</b> ${esc(C.name)}</div>`
    + (app.scene.units.abbr !== C.b.scene.units.abbr ? `<p class="warn-note">The units differ (${esc(app.scene.units.abbr || 'none')} / ${esc(C.b.scene.units.abbr || 'none')}): coordinates are compared as they are.</p>` : '');
  $('#cmp-na').textContent = r.onlyA.length;
  $('#cmp-nb').textContent = r.onlyB.length;
  $('#cmp-ns').textContent = r.same;
  $('#cmp-list').innerHTML = ch.slice(0, LIST_MAX).map((c, k) => `<li><button type="button" class="cmp-item${k === C.cur ? ' on' : ''}" data-k="${k}"><i class="sw ${c.kind === 'added' ? 'cmp-b' : c.kind === 'removed' ? 'cmp-a' : 'cmp-ab'}"></i>${esc(label(c))}</button></li>`).join('')
    + (ch.length > LIST_MAX ? `<li class="note">… and ${ch.length - LIST_MAX} more</li>` : '') + (ch.length ? '' : '<li class="note">No differences: the drawings show the same items.</li>');
  $('#cmp-pos').textContent = ch.length ? `${C.cur >= 0 ? C.cur + 1 : '–'} / ${ch.length}` : '0';
  $('#cmp-prev').disabled = $('#cmp-next').disabled = !ch.length;
  dim();
  app.invalidate();
}
function dim() { $('#cv-drawing').style.opacity = C && C.show.same ? '0.32' : C ? '0' : ''; }
function step(d) {
  const n = C ? C.r.changes.length : 0;
  if (n) go(C.cur < 0 ? (d > 0 ? 0 : n - 1) : (C.cur + d + n) % n);
}
function go(k) {
  const c = C && C.r.changes[k];
  if (!c) return;
  C.cur = k;
  C.app.compare.cur = k;
  const b = c.bbox, e = C.app.scene.extents, pad = Math.max(0.15 * Math.max(b[2] - b[0], b[3] - b[1]), 0.03 * Math.hypot(e[2] - e[0], e[3] - e[1]));
  C.app.zoomToWorld(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad);
  for (const el of document.querySelectorAll('#cmp-list .cmp-item')) el.classList.toggle('on', Number(el.dataset.k) === k);
  const on = document.querySelector('#cmp-list .cmp-item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
  $('#cmp-pos').textContent = `${k + 1} / ${C.r.changes.length}`;
}
/** Leave compare: the drawing as before. */
export function end(app) {
  if (!C) return;
  clearTimeout(C.timer);
  C = null;
  const p = $('#compare-panel');
  if (p) p.remove();
  dim();
  if (app) { app.compare = null; app.invalidate(); }
}
