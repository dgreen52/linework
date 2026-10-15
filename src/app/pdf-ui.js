// PDF pages (loaded with the first PDF, see app.js): the page picker in the status bar (always in
// view, also on a phone), Page Up / Page Down, and app.pages, the pages API other features build on (e.g. sheet sets):
//   app.pages.count, app.pages.current (1-based; 0 when the drawing is not a PDF),
//   app.pages.label(n) (the PDF's own page label, else "n"), await app.pages.goto(n) -> true when shown.
// A PDF shows one page at a time. Each page is read from the file again (app.doc.blob, kept by
// openDrawing) and is a drawing of its own: markups and unsaved edits are kept per page.
import { $, toast } from './ui.js';

const ICON = (d) => `<svg class="ic" aria-hidden="true" viewBox="0 0 24 24"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'range', 'file', 'image']);
const typing = (el) => !!el && ((el.tagName === 'INPUT' && !NOT_TEXT.has(el.type)) || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

export function initPages(app) {
  if (app.pages) return app.pages;
  const page = () => (app.scene && app.scene.page) || null;
  const box = document.createElement('span');
  box.id = 'doc-pages';
  box.className = 'field';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'PDF pages');
  box.style.cssText = 'flex-direction:row;align-items:center;gap:3px;padding:0';
  const B = 'style="min-height:22px;min-width:24px;padding:0 2px"';
  box.innerHTML = `<button type="button" class="btn icon sm" id="btn-page-prev" ${B} title="Previous page (Page Up)" aria-label="Previous page">${ICON('M15 6l-6 6 6 6')}</button>`
    + '<select id="sel-page" style="min-height:22px;padding:0 4px;font-size:12px" aria-label="Page" title="Page of this PDF (Page Up / Page Down)"></select>'
    + `<button type="button" class="btn icon sm" id="btn-page-next" ${B} title="Next page (Page Down)" aria-label="Next page">${ICON('M9 6l6 6-6 6')}</button>`;
  $('.statusbar .spacer').after(box);
  const sel = box.querySelector('select');
  let filled = '';

  const label = (n) => { const pg = page(); return pg && pg.labels && pg.labels[n - 1] ? pg.labels[n - 1] : String(n); };
  function update() {
    const pg = page();
    const show = !!(pg && pg.count > 1);
    box.style.display = show ? 'inline-flex' : 'none';
    if (!show) return;
    const key = `${app.doc && app.doc.name}|${pg.count}|${pg.labels ? pg.labels.join('\u0001') : ''}`;
    if (filled !== key) {
      filled = key;
      sel.innerHTML = '';
      for (let n = 1; n <= pg.count; n++) sel.add(new Option(pg.cad ? label(n) : `Page ${label(n)} / ${pg.count}`, String(n)));
      // a drawing's layouts (Model first) or a PDF's pages
      const what = pg.cad ? 'layout' : 'page';
      box.setAttribute('aria-label', pg.cad ? 'Model and layouts' : 'PDF pages');
      sel.setAttribute('aria-label', pg.cad ? 'Layout' : 'Page');
      sel.title = pg.cad ? 'Model space or a paper-space layout (Page Up / Page Down)' : 'Page of this PDF (Page Up / Page Down)';
      $('#btn-page-prev').title = `Previous ${what} (Page Up)`; $('#btn-page-prev').setAttribute('aria-label', `Previous ${what}`);
      $('#btn-page-next').title = `Next ${what} (Page Down)`; $('#btn-page-next').setAttribute('aria-label', `Next ${what}`);
    }
    sel.value = String(pg.n);
    $('#btn-page-prev').disabled = pg.n <= 1;
    $('#btn-page-next').disabled = pg.n >= pg.count;
  }

  /** Show page n of the open PDF. */
  async function goto(n) {
    const pg = page(), doc = app.doc;
    n = Math.round(n);
    if (!pg || !doc || app.loading || !(n >= 1 && n <= pg.count) || n === pg.n) { update(); return false; }
    if (!doc.blob) { toast('Open the PDF again to see its other pages.', { kind: 'warn' }); update(); return false; }
    const P = pg.cad ? '' : 'Page ';
    if (app.blockEdit) { toast('Close the block editor first', { key: 'block' }); update(); return false; }
    if (app.edit && app.edit.doc && app.edit.doc.dirty && !window.confirm(`${P}${label(pg.n)} has unsaved edits (they are kept in this browser). Show ${P}${label(n)} anyway?`)) { update(); return false; }
    let buf;
    try { buf = await doc.blob.arrayBuffer(); } catch {
      toast(`Could not read ${doc.name} again`, { kind: 'error', detail: 'It may have been moved or changed on disk. Open it again.' });
      update();
      return false;
    }
    const { name, size, handle, dir, modified, sample, blob } = doc;
    await app.openDrawing(name, buf, size, undefined, { handle, dir, modified, sample, blob, page: n });
    update();
    const now = page();
    return !!(now && now.n === n && app.doc && app.doc.name === name);
  }

  $('#btn-page-prev').addEventListener('click', () => { const pg = page(); if (pg) goto(pg.n - 1); });
  $('#btn-page-next').addEventListener('click', () => { const pg = page(); if (pg) goto(pg.n + 1); });
  sel.addEventListener('change', () => { goto(+sel.value); sel.blur(); });
  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'PageDown' && e.key !== 'PageUp') || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || document.querySelector('dialog[open]')) return;
    const pg = page();
    if (!pg || pg.count < 2) return;
    e.preventDefault();
    goto(pg.n + (e.key === 'PageDown' ? 1 : -1));
  });
  app.hooks.open.push(update);
  app.pages = {
    get count() { const pg = page(); return pg ? pg.count : 0; },
    get current() { const pg = page(); return pg ? pg.n : 0; },
    label,
    goto,
  };
  update();
  return app.pages;
}
