// The Trace tool (View › Trace, J), loaded on first use: click a wire and its net lights up (every wire
// joined to it by shared ends, T-junctions and junction dots) with a panel: length, labels (wire numbers),
// ends (cell + pin, symbol, open end) to step through, Copy. Read-only. The graph (src/tools/trace.js) is
// built a slice at a time per drawing, and again after an edit.
import { buildNetGraphAsync, traceNet, pickWire, endText, netText, textQuad } from '../tools/trace.js';
import { addConic, addPoly } from '../view/renderer2d.js';
import { KIND } from '../scene.js';
import { fmtNum } from '../tools/measure.js';
import { $, toast, esc } from './ui.js';

const COL = { dark: '#ff4fd8', paper: '#c4007a' };
const CSS = `.tools-stack { position: absolute; top: calc(var(--hint-bottom, 0px) + 8px); right: 8px; z-index: 7; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-width: calc(100% - 16px); max-height: calc(100% - var(--hint-bottom, 0px) - 16px); pointer-events: none; }
.tools-stack > * { pointer-events: auto; }
.trace-card { --tr: ${COL.dark}; width: min(340px, 100%); min-height: 0; overflow: auto; padding: 8px 12px 10px; font-size: 13px; }
:root[data-theme="paper"] .trace-card { --tr: ${COL.paper}; }
.trace-card .mc-head i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--tr); margin-right: 6px; }
.tr-sum { margin: 6px 0; font-variant-numeric: tabular-nums; }
.tr-chips, .tr-acts { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 6px; }
.tr-chip { font: inherit; font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--tr); background: var(--bg-3); color: var(--text); cursor: pointer; }
.tr-h { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; }
.tr-h span { margin-right: auto; }
.tr-ends { margin: 2px 0 6px; padding-left: 22px; max-height: 32vh; overflow: auto; }
.tr-ends button { font: inherit; text-align: left; background: none; border: 0; padding: 2px 0; color: var(--text); cursor: pointer; }
.tr-ends .on button { color: var(--tr); font-weight: 600; }
.trace-card details { font-size: 12px; color: var(--muted); }
.trace-card label { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: var(--text); }
#tr-tol { width: 7em; min-height: 26px; padding: 2px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-3); color: var(--text); }
@media (max-width: 760px) { .tools-stack { left: 8px; align-items: stretch; } .tools-stack:has(> .trace-card:not([hidden])) { top: auto; bottom: 8px; } .trace-card { width: auto; max-height: 36vh; } }`;
const pl = (n, w) => `${fmtNum(n, 0)} ${w}${n === 1 ? '' : 's'}`;
const btn = (id, label, title, icon) => `<button type="button" class="btn sm${icon ? ' icon" aria-label="' + title : ''}" id="${id}" title="${title}">${label}</button>`;

export function initTrace(app, api) {
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));
  let stack = $('#stage .tools-stack');
  if (!stack) $('#stage').appendChild((stack = Object.assign(document.createElement('div'), { className: 'tools-stack' })));
  const card = Object.assign(document.createElement('aside'), { className: 'trace-card card', id: 'trace-card', hidden: true });
  card.setAttribute('aria-label', 'Traced net');
  stack.prepend(card);
  const vis = (li) => !app.layerVisible || !!app.layerVisible[li];
  const visSig = () => (app.layerVisible ? app.layerVisible.join('') : '');
  const docSig = () => (app.edit && app.edit.doc ? app.edit.doc.cur : 0); // changes with every edit, undo and redo
  // G: the graph of `scene` (made for edit state `doc`); net: the traced net; seed: the clicked point (drawing coordinates)
  const T = { G: null, scene: null, doc: 0, building: null, gen: 0, net: null, seed: null, cur: -1, vis: '', opt: { crossings: false, throughPins: false, dim: true }, tol: 0, paths: null, timer: 0, info: '' };
  const st = (app.traceStats = { buildMs: 0, traceMs: 0 });

  /** The graph of the drawing on screen (null when the drawing changed while it was being made). */
  function graph() {
    if (T.scene === app.scene && T.doc === docSig() && (T.G || T.building)) return T.G ? Promise.resolve(T.G) : T.building;
    const scene = (T.scene = app.scene), gen = ++T.gen, t0 = performance.now();
    T.G = null; T.doc = docSig();
    const note = setTimeout(() => toast('Finding the wires…', { key: 'trace', timeout: 2500 }), 400);
    return (T.building = buildNetGraphAsync(scene, { tol: T.tol }, 12, () => gen !== T.gen || app.scene !== scene).then((G) => {
      clearTimeout(note);
      if (gen !== T.gen) return null;
      T.building = null; T.G = G;
      if (G) Object.assign(st, { buildMs: G.busy, buildWallMs: performance.now() - t0 });
      return G;
    }));
  }
  /** Trace the wire at screen point (sx, sy). */
  async function at(sx, sy, pointer) {
    if (!app.scene) return;
    const [x, y] = app.view.toWorld(sx, sy), [ox, oy] = app.scene.origin, G = await graph();
    if (!G) return;
    const w = pickWire(G, x, y, (pointer === 'touch' ? 16 : 7) / app.view.scale, vis);
    if (w < 0) { toast('No wire there', { key: 'trace', timeout: 2500, detail: 'Click on a line or a junction dot; Esc clears the trace.' }); return; }
    T.seed = { x: x + ox, y: y + oy, w };
    T.cur = -1;
    run(G, w);
  }
  function run(G, w) {
    const net = traceNet(G, w, { ...T.opt, isVisible: vis });
    if (!net.wires.length && !net.dots.length) { clear(); return; } // (its level was hidden)
    Object.assign(T, { net, vis: visSig(), paths: paths(net) });
    st.traceMs = net.ms;
    render(); dim(); api.invalidate();
  }
  /** Trace the wire that scene text k labels (its nearest wire, as the net's labels are found): the net, or null when no wire is next to it. */
  async function label(k) {
    const s = app.scene, t = s && s.texts[k];
    if (!t || t.dead) return null;
    const G = await graph(), w = G && app.scene === s ? G.textWire[k] : -1;
    if (w < 0 || !vis(s.layer[w])) return null;
    // the seed: the point of that wire nearest the text (an edit traces again from there)
    const cx = (t.bbox[0] + t.bbox[2]) / 2, cy = (t.bbox[1] + t.bbox[3]) / 2, S = G.seg, [ox, oy] = s.origin;
    let px = cx, py = cy, bd = Infinity;
    for (let j = 0; j < G.caps; j++) {
      if (G.capPrim[j] !== w) continue;
      const ax = S[4 * j], ay = S[4 * j + 1], dx = S[4 * j + 2] - ax, dy = S[4 * j + 3] - ay, L2 = dx * dx + dy * dy;
      const u = L2 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / L2)) : 0, x = ax + u * dx, y = ay + u * dy, d = Math.hypot(x - cx, y - cy);
      if (d < bd) { bd = d; px = x; py = y; }
    }
    T.seed = { x: px + ox, y: py + oy, w };
    T.cur = -1;
    run(G, w);
    return T.net;
  }
  /** The drawing changed (or the gap): build again, then trace from the same point if a wire is still there. */
  function again() {
    T.G = null; T.building = null; T.gen++;
    clearTimeout(T.timer);
    if (T.net) T.timer = setTimeout(async () => {
      const G = await graph(), s = T.seed;
      if (!G || !s) return;
      const [ox, oy] = app.scene.origin, w = G.role[s.w] && vis(app.scene.layer[s.w]) ? s.w : pickWire(G, s.x - ox, s.y - oy, 7 / app.view.scale, vis);
      if (w < 0) { clear(); toast('The traced wire is gone', { key: 'trace', timeout: 3000 }); } else run(G, w);
    }, 250);
  }
  function clear() {
    Object.assign(T, { net: null, seed: null, paths: null, cur: -1 });
    clearTimeout(T.timer);
    card.hidden = true;
    if (T.info && $('#st-info').textContent === T.info) $('#st-info').textContent = ''; // (only the trace's own line)
    T.info = '';
    dim(); api.invalidate();
  }
  function dim() { if (!app.compare) $('#cv-drawing').style.opacity = T.net && T.opt.dim ? '0.35' : ''; } // (compare dims it itself)

  // ---------------------------------------------------------------- drawing
  function paths(net) {
    const s = app.scene, P = { wires: new Path2D(), parts: new Path2D(), dots: new Path2D() };
    for (const k in P) for (const i of net[k]) (s.kind[i] === KIND.CONIC ? addConic : addPoly)(P[k], s, i);
    return P;
  }
  function draw(ctx) {
    if (!T.net || T.scene !== app.scene) return;
    if (T.vis !== visSig() && T.G) run(T.G, T.net.seed); // layers shown / hidden: trace again
    if (!T.net) return;
    const v = app.view, dpr = app.dpr, M = v.matrix(dpr), P = T.paths;
    ctx.save();
    ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = ctx.fillStyle = COL[app.theme] || COL.dark;
    ctx.globalAlpha = 0.3; ctx.lineWidth = 10 / v.scale; ctx.stroke(P.wires); ctx.stroke(P.dots); // halo
    ctx.globalAlpha = 1; ctx.lineWidth = 2.5 / v.scale; ctx.stroke(P.wires); ctx.fill(P.dots); ctx.stroke(P.dots);
    ctx.globalAlpha = 0.75; ctx.lineWidth = 1.5 / v.scale; ctx.stroke(P.parts); // cell lines the wires end on
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1.5;
    for (const l of T.net.labels) for (const t of l.texts) { // label boxes
      const q = textQuad(app.scene.texts[t]);
      ctx.beginPath();
      for (let k = 0; k < 8; k += 2) ctx.lineTo(...v.toScreen(q[k], q[k + 1]));
      ctx.closePath(); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    T.net.ends.forEach((e, k) => { // end rings, the current one larger
      const [x, y] = v.toScreen(e.x, e.y);
      ctx.lineWidth = k === T.cur ? 3 : 2;
      ctx.beginPath(); ctx.arc(x, y, k === T.cur ? 11 : 6, 0, Math.PI * 2); ctx.stroke();
    });
    ctx.restore();
  }

  // ---------------------------------------------------------------- panel
  card.innerHTML = `<div class="mc-head"><span><i></i><span id="tr-title">Net</span></span>${btn('tr-close', '<svg class="ic" aria-hidden="true"><use href="#i-close"/></svg>', 'Clear the trace (Esc)', 1)}</div>
    <div class="tr-sum" id="tr-sum" aria-live="polite"></div><div class="tr-chips" id="tr-labels"></div>
    <div class="tr-h"><span id="tr-nends"></span>${btn('tr-prev', '‹', 'Previous end', 1)}${btn('tr-next', '›', 'Next end', 1)}</div><ol class="tr-ends" id="tr-ends"></ol>
    <div class="tr-acts">${btn('tr-zoom', 'Zoom to net', 'Zoom to the whole net')}${btn('tr-copy', 'Copy', 'Copy the net as text: length, labels, ends')}${btn('tr-sheets', 'Find on other sheets', 'Look for its label on the other sheets of the set')}</div>
    <details><summary>Options</summary>
      <label title="Wires that cross without a junction dot are not connected in a schematic"><input type="checkbox" data-o="crossings"> Crossings connect</label>
      <label title="Go on through connectors and terminals: wires on the same pin text of a cell join"><input type="checkbox" data-o="throughPins"> Through pins</label>
      <label><input type="checkbox" data-o="dim" checked> Dim the rest</label>
      <label title="Ends closer than this (drawing units) touch">Gap <input type="text" id="tr-tol" inputmode="decimal" autocomplete="off" spellcheck="false"><span id="tr-unit"></span></label>
    </details>`;
  function render() {
    const net = T.net, s = app.scene, u = s.units.abbr ? ' ' + s.units.abbr : '', q = (id) => $(id, card);
    card.hidden = !net;
    if (!net) return;
    q('#tr-title').textContent = `Net${net.labels.length ? ' ' + net.labels[0].s : ''}`;
    q('#tr-sum').innerHTML = `<b>${esc(fmtNum(net.length, app.precision) + u)}</b> · ${pl(net.count, 'wire')} · ${pl(net.segments, 'segment')}${net.junctions ? ' · ' + pl(net.junctions, 'junction dot') : ''}`;
    q('#tr-labels').innerHTML = net.labels.map((l, k) => `<button type="button" class="tr-chip" data-l="${k}" title="Show it">${esc(l.s)}${l.texts.length > 1 ? ` ×${l.texts.length}` : ''}</button>`).join('') || '<small>No label next to these wires</small>';
    q('#tr-nends').textContent = `Ends (${net.ends.length})`;
    q('#tr-ends').innerHTML = net.ends.map((e, k) => `<li${k === T.cur ? ' class="on"' : ''}><button type="button" data-k="${k}">${esc(endText(e))}</button></li>`).join('');
    q('#tr-prev').disabled = q('#tr-next').disabled = !net.ends.length;
    q('#tr-sheets').hidden = !(app.sheets && app.sheets.active && net.labels.length); // (a sheet set is open)
    if (document.activeElement !== q('#tr-tol')) q('#tr-tol').value = fmtNum(T.G ? T.G.tol : T.tol, 6).replace(/\.?0+$/, '');
    q('#tr-unit').textContent = s.units.abbr || '';
    $('#st-info').textContent = T.info = `Net${net.labels.length ? ' ' + net.labels[0].s : ''} · ${fmtNum(net.length, app.precision)}${u} · ${pl(net.ends.length, 'end')}`;
  }
  const zoomBox = (b, p) => { const [ox, oy] = app.scene.origin; app.zoomToWorld(b[0] - p + ox, b[1] - p + oy, b[2] + p + ox, b[3] + p + oy); };
  function goEnd(k) {
    const n = T.net.ends.length, v = app.view, H = (T.G && T.G.H) || 0;
    if (!n) return;
    T.cur = ((k % n) + n) % n;
    if (H && H * v.scale < 14) v.scale = v.clampScale(18 / H); // pin texts readable
    v.cx = T.net.ends[T.cur].x; v.cy = T.net.ends[T.cur].y;
    render();
    api.invalidate(true);
    const on = card.querySelector('.tr-ends .on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }
  let lab = { k: -1, i: 0 };
  card.addEventListener('click', (e) => {
    const b = e.target.closest('button'), net = T.net, id = b && b.id;
    if (!b || !net) return;
    if (id === 'tr-close') clear();
    else if (id === 'tr-prev' || id === 'tr-next') goEnd(T.cur < 0 ? (id === 'tr-next' ? 0 : -1) : T.cur + (id === 'tr-next' ? 1 : -1));
    else if (id === 'tr-zoom') zoomBox(net.bbox, 0.06 * Math.max(net.bbox[2] - net.bbox[0], net.bbox[3] - net.bbox[1]) + ((T.G && T.G.H) || 0));
    else if (id === 'tr-copy') {
      navigator.clipboard.writeText(netText(net, { name: app.doc && app.doc.name, origin: app.scene.origin, dec: app.precision, abbr: app.scene.units.abbr, fmt: fmtNum }))
        .then(() => toast('Copied the net', { key: 'trace', timeout: 2000 }), () => toast('Copy is not available here.', { kind: 'warn' }));
    } else if (id === 'tr-sheets') app.loadTools('find', { q: net.labels[0].s, wholeWord: true, all: true }); // Find in all sheets: the matches listed by sheet
    else if (b.dataset.k) goEnd(+b.dataset.k);
    else if (b.dataset.l) { // a label: show (each copy in turn)
      const k = +b.dataset.l, l = net.labels[k];
      lab = { k, i: lab.k === k ? (lab.i + 1) % l.texts.length : 0 };
      const bb = app.scene.texts[l.texts[lab.i]].bbox;
      zoomBox(bb, 4 * (bb[3] - bb[1]));
    }
  });
  card.addEventListener('change', (e) => {
    const o = e.target.dataset.o;
    if (o) { T.opt[o] = e.target.checked; if (o === 'dim') { dim(); api.invalidate(); } else if (T.G && T.net) run(T.G, T.net.seed); }
    else if (e.target.id === 'tr-tol') { const v = Number(e.target.value.trim()); T.tol = v > 0 ? v : 0; again(); }
  });
  card.addEventListener('keydown', (e) => { // (shortcuts still work from the panel's buttons; the Gap box keeps its keys)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clear(); $('#stage').focus({ preventScroll: true }); }
    else if (e.target.id === 'tr-tol') { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); }
  });

  app.hooks.draw.push(draw);
  app.hooks.open.push(() => { clear(); T.G = null; T.building = null; T.gen++; T.tol = 0; });
  app.hooks.history.push(() => { if ((T.G || T.building) && T.doc !== docSig()) again(); }); // (not for markups)
  return {
    // 'at' (sx, sy, pointer): the wire at a screen point; 'label' (k): the wire scene text k labels (-> the net or null);
    // 'tool': the graph of the drawing (made once); 'clear'
    run: (cmd, ...a) => (cmd === 'at' ? at(...a) : cmd === 'label' ? label(...a) : cmd === 'tool' ? app.scene && graph() : cmd === 'clear' && clear()),
    clear,
    get net() { return T.net; },
    get cur() { return T.cur; },
    get graph() { return T.G; },
  };
}
