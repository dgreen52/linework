// The markup list (Markup › List), loaded on first use: every markup of the drawing (of this page, for a PDF),
// newest last, with its type, text, author and date. Filter by any of them; click a row to select the markup
// and zoom to it; × deletes it (one undo step). It follows undo / redo, selection and a new drawing.
import { markupBBox } from '../markup/model.js';
import { $, esc } from './ui.js';

const CSS = `.tools-stack { position: absolute; top: calc(var(--hint-bottom, 0px) + 8px); right: 8px; z-index: 7; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-width: calc(100% - 16px); max-height: calc(100% - var(--hint-bottom, 0px) - 16px); pointer-events: none; }
.tools-stack > * { pointer-events: auto; }
.ml-card { width: min(320px, 100%); min-height: 0; max-height: min(60vh, 520px); display: flex; flex-direction: column; padding: 8px 10px 8px; font-size: 13px; }
.ml-card input[type="search"] { width: 100%; margin: 6px 0; }
.ml-list { list-style: none; margin: 0; padding: 0; overflow: auto; min-height: 0; }
.ml-list li { display: flex; align-items: center; gap: 4px; border-top: 1px solid var(--line); }
.ml-list li.on { background: var(--bg-3); }
.ml-row { flex: 1; min-width: 0; font: inherit; text-align: left; background: none; border: 0; padding: 5px 2px; color: var(--text); cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
.ml-row i { width: 10px; height: 10px; border-radius: 2px; flex: none; align-self: center; }
.ml-row b { font-weight: 600; flex: none; }
.ml-row span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.ml-none { color: var(--muted); padding: 6px 2px; }
@media (max-width: 760px) { .tools-stack { left: 8px; align-items: stretch; } .tools-stack:has(> .ml-card:not([hidden])) { top: auto; bottom: 8px; } .ml-card { width: auto; max-height: 40vh; } }`;
const NAMES = { pen: 'Pen', line: 'Line', arrow: 'Arrow', rect: 'Box', ellipse: 'Ellipse', cloud: 'Cloud', callout: 'Callout', highlight: 'Highlight' };

/** The words a markup is found by (type, text, author, date), lower case. */
export const markupWords = (m) => `${NAMES[m.type] || m.type} ${m.text || ''} ${m.author || ''} ${(m.modified || m.created || '').slice(0, 10)}`.toLowerCase();

/** api: { select(id), remove(id), narrow() (a phone-sized screen), hideLayers() } (app.js). */
export function initMarkupList(app, api) {
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));
  let stack = $('#stage .tools-stack');
  if (!stack) $('#stage').appendChild((stack = Object.assign(document.createElement('div'), { className: 'tools-stack' })));
  const card = Object.assign(document.createElement('aside'), { className: 'ml-card card', id: 'markup-list', hidden: true });
  card.setAttribute('aria-label', 'Markups');
  card.innerHTML = `<div class="mc-head"><span id="ml-title">Markups</span><button type="button" class="btn icon sm" id="ml-close" title="Close the list" aria-label="Close the list"><svg class="ic" aria-hidden="true"><use href="#i-close"/></svg></button></div>
    <input type="search" id="ml-filter" placeholder="Filter: type, text, name, date" aria-label="Filter the markups" autocomplete="off" spellcheck="false">
    <ul class="ml-list" id="ml-list"></ul>`;
  stack.appendChild(card);
  const list = $('#ml-list', card), filter = $('#ml-filter', card);
  const when = (m) => { const d = new Date(m.modified || m.created); return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };

  function render() {
    if (card.hidden) return;
    const q = filter.value.trim().toLowerCase(), all = app.markups || [];
    const shown = all.filter((m) => !q || q.split(/\s+/).every((w) => markupWords(m).includes(w)));
    $('#ml-title', card).textContent = `Markups (${q ? shown.length + ' of ' : ''}${all.length})`;
    list.innerHTML = shown.map((m) => `<li data-id="${esc(m.id)}"${m.id === app.selected ? ' class="on"' : ''}><button type="button" class="ml-row" data-go="${esc(m.id)}" title="Select it and zoom to it"><i style="background:${esc(m.color || '#e5262b')}"></i><b>${esc(NAMES[m.type] || m.type)}</b><span>${esc((m.type === 'callout' && m.text ? m.text.trim() + ' · ' : '') + (m.author || 'unknown') + ' · ' + when(m))}</span></button><button type="button" class="btn icon sm" data-del="${esc(m.id)}" title="Delete this markup" aria-label="Delete this markup"><svg class="ic" aria-hidden="true"><use href="#i-close"/></svg></button></li>`).join('')
      || `<li class="ml-none">${all.length ? 'Nothing matches the filter.' : 'No markups yet. Draw one with the tools on the left.'}</li>`;
    const on = list.querySelector('li.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }
  function go(id) {
    const m = (app.markups || []).find((x) => x.id === id);
    if (!m) return;
    api.select(id);
    const b = markupBBox(m), pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.6 + (m.size || 0) * 4 + 1e-6;
    app.zoomToWorld(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad);
    render();
  }
  card.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'ml-close') { hide(); return; }
    if (b.dataset.go) go(b.dataset.go);
    else if (b.dataset.del) { api.remove(b.dataset.del); render(); }
  });
  filter.addEventListener('input', render);
  filter.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { if (filter.value) { filter.value = ''; render(); } else hide(); } });
  function show() { if (api.narrow && api.narrow()) api.hideLayers(); card.hidden = false; render(); } // (on a phone the layer panel would cover it)
  function hide() { card.hidden = true; const b = $('#btn-markup-list'); if (b) b.setAttribute('aria-pressed', 'false'); }
  function toggle() { if (card.hidden) show(); else hide(); const b = $('#btn-markup-list'); if (b) b.setAttribute('aria-pressed', String(!card.hidden)); }
  app.hooks.history.push(render);
  app.hooks.open.push(() => { filter.value = ''; render(); });
  return { toggle, show, hide, refresh: render, get open() { return !card.hidden; } };
}
