// File access (loaded after start-up): Open with the file picker (a file handle where the File
// System Access API exists), recent drawings, Save over the original (asked once per file, backup
// copy, read back first) and the journal of unsaved edits. Without handles: the plain chooser and
// downloads, as before.
import { openStore, addRecent, recentList, updateRecent, clearRecent, fmtWhen, Journal, planRestore, journalKeys, journalKey } from './store.js';
import { $, toast, esc, fmtBytes } from './ui.js';

const TYPES = [
  { description: 'Drawings', accept: { 'application/octet-stream': ['.dxf', '.dwg', '.dgn'], 'application/pdf': ['.pdf'] } },
  { description: 'Markups', accept: { 'application/json': ['.json'] } },
];
/** name.bak.ext (the extension stays last). */
export const backupName = (n) => { const m = /^(.*?)(\.[^.]*)?$/.exec(n); return `${m[1]}.bak${m[2] || ''}`; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** Permission on a handle (a prompt needs a click or key press). */
export async function permit(h, mode) {
  if (!h || typeof h.queryPermission !== 'function') return true;
  const o = { mode };
  if ((await h.queryPermission(o)) === 'granted') return true;
  return (await h.requestPermission(o)) === 'granted';
}

/** api: { openFile, openSample, save(format, name?, target?), commit(label, changes), readDrawing, showDrawing } */
export function initFiles(app, api) {
  const db = openStore();
  const F = { list: [], journal: null, paused: false, timer: 0, chain: Promise.resolve(), warned: false, kept: new Set() };

  // ---------------------------------------------------------------- open
  /** Open, Ctrl+O: the picker (a handle for Save), else the plain chooser. */
  async function pick() {
    if (typeof window.showOpenFilePicker !== 'function') { $('#file-input').click(); return; }
    let hs;
    try { hs = await window.showOpenFilePicker({ id: 'linework-open', types: TYPES, multiple: true }); } catch (e) {
      if (!(e && e.name === 'AbortError')) $('#file-input').click(); // not allowed here (a frame...)
      return;
    }
    const drawings = (hs || []).filter((h) => !/\.json$/i.test(h.name));
    if (drawings.length > 1) { (await app.loadSheets()).openHandles(drawings); return; } // several: a sheet set
    if (hs && hs[0]) await openHandle(hs[0]);
  }
  /** Open a file handle (picker, recent list, "Open with"); extra.dir: its folder. */
  async function openHandle(h, extra = {}) {
    let file;
    try {
      if (!(await permit(h, 'read'))) { toast(`No permission to open ${h.name}`, { kind: 'warn', detail: 'The browser asked whether Linework may read it.' }); return false; }
      file = await h.getFile();
    } catch (e) {
      toast(`Could not open ${h.name}`, { kind: 'error', detail: e && e.name === 'NotFoundError' ? 'It was moved, renamed or deleted.' : 'The browser could not read it.' });
      return false;
    }
    await api.openFile(file, { handle: h, dir: extra.dir || null });
    return true;
  }

  // ---------------------------------------------------------------- recent drawings
  async function opened(doc) {
    endJournal();
    for (const el of document.querySelectorAll('#toasts [data-key="journal"]')) el.remove(); // an offer for the drawing before
    if (!doc.hash) return;
    F.journal = new Journal(db, doc);
    if (!doc.keep) F.warned = false;
    // a sheet of a set: the set is the recent entry (src/app/sheets.js)
    if (!doc.set) {
      try {
        F.list = await addRecent(db, { name: doc.name, format: doc.format, size: doc.size, hash: doc.hash, when: Date.now(), handle: doc.handle || null, dir: doc.dir || null, sample: doc.sample || null });
        if (app.doc === doc) {
          doc.recent = F.list[0];
          if (!doc.dir && doc.recent.dir) doc.dir = doc.recent.dir; // folder access given earlier
        }
      } catch { /* storage unavailable: no list */ }
    }
    if (doc.keep || app.doc !== doc) { render(); return; }
    const j = await F.journal.read().catch(() => null);
    await render();
    if (j && app.doc === doc) offer(j);
  }
  async function render() {
    try { F.list = await recentList(db); F.kept = await journalKeys(db); } catch { /* keep the last list */ }
    const list = F.list;
    $('#btn-recent').hidden = !list.length;
    const host = $('#recent');
    host.hidden = !list.length;
    host.innerHTML = list.length ? `<h2>Recent drawings</h2><div class="samples recent-list">${list.map(item).join('')}</div>
      <p><button type="button" class="btn sm" data-recent-clear title="Forget this list (the files themselves are not touched)">Clear list</button></p>` : '';
    if (!$('#menu-recent').hidden) fillMenu();
  }
  const meta = (r) => (r.set ? ['Sheet set', plural(r.set.n, 'sheet'), fmtWhen(r.when), r.handle || (r.handles && r.handles.length) ? '' : 'pick again'] : [r.format, r.size ? fmtBytes(r.size) : '', fmtWhen(r.when), F.kept.has(journalKey(r)) ? 'unsaved edits kept' : '', !r.handle && !r.sample && r.format ? 'pick again' : '']).filter(Boolean).join(' · ');
  const item = (r) => `<button type="button" class="sample" data-recent="${esc(r.id)}" title="${esc(r.handle || r.sample || r.handles ? 'Open ' + r.name : 'Choose ' + r.name + ' in the file dialog')}"><strong>${esc(r.name)}</strong><span>${esc(meta(r))}</span></button>`;
  function fillMenu() {
    const m = $('#menu-recent');
    m.innerHTML = F.list.map((r) => `<button type="button" role="menuitem" data-recent="${esc(r.id)}"><span><strong>${esc(r.name)}</strong><small>${esc(meta(r))}</small></span></button>`).join('')
      + '<button type="button" role="menuitem" data-recent-clear>Clear list</button>';
  }
  function toggleMenu(open) {
    const m = $('#menu-recent'), b = $('#btn-recent');
    m.hidden = !open;
    b.setAttribute('aria-expanded', String(open));
    if (open) { fillMenu(); m.querySelector('button').focus(); }
  }
  async function reopen(id) {
    const r = F.list.find((x) => x.id === id);
    if (!r) return;
    if (r.set) { (await app.loadSheets()).reopen(r); return; }
    if (r.sample) { api.openSample(r.sample); return; }
    if (r.handle) { await openHandle(r.handle, { dir: r.dir }); return; }
    toast(`Choose ${r.name} again`, { key: 'recent', detail: 'This browser cannot reopen files by itself: pick it in the file dialog.' });
    pick();
  }
  async function clear() {
    await clearRecent(db).catch(() => {});
    if (app.doc) app.doc.recent = null;
    toggleMenu(false);
    await render();
    toast('Recent drawings cleared', { key: 'recent', timeout: 2500, detail: 'Only the list was cleared; the files are not touched.' });
  }
  document.addEventListener('click', (e) => {
    const r = e.target.closest('[data-recent]'), c = e.target.closest('[data-recent-clear]');
    if (r) { toggleMenu(false); reopen(r.dataset.recent); } else if (c) clear();
    else if (e.target.closest('#btn-recent')) toggleMenu($('#menu-recent').hidden);
    else if (!e.target.closest('#menu-recent')) toggleMenu(false);
  });
  $('#menu-recent').addEventListener('keydown', (e) => {
    const items = [...e.currentTarget.querySelectorAll('button')], i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { toggleMenu(false); $('#btn-recent').focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
  });

  // ---------------------------------------------------------------- journal of unsaved edits
  function endJournal() { clearTimeout(F.timer); F.journal = null; F.paused = false; }
  /** The history changed (edit, undo, redo, save): write the journal soon. */
  function history() {
    if (!F.journal || F.paused) return;
    clearTimeout(F.timer);
    F.timer = setTimeout(flush, 250);
  }
  /** Write the journal now (also used by the tests). */
  function flush() {
    clearTimeout(F.timer);
    const j = F.journal;
    F.chain = F.chain.then(async () => {
      const d = app.edit && app.edit.doc;
      if (!j || j !== F.journal || F.paused || !d || d.scene !== app.scene) return;
      const r = await j.sync(d).catch((e) => { app.journalError = String(e && e.message || e); return 'error'; });
      app.journalState = r;
      if (r === 'too-big' && !F.warned) {
        F.warned = true;
        toast('Too many unsaved edits to keep for recovery', { key: 'journal', kind: 'warn', timeout: 10000, detail: 'Save the drawing to keep them safe.' });
      }
    });
    return F.chain;
  }
  function offer(j) {
    F.paused = true; // the stored edits stay until the user decides
    const n = j.meta.count;
    toast(`Restore ${plural(n, 'unsaved edit')}?`, {
      key: 'journal', kind: 'warn', timeout: 0,
      detail: `They were made on this drawing ${fmtWhen(j.meta.when)} and not saved${j.meta.last ? ` (last: ${j.meta.last})` : ''}.`,
      actions: [{ label: 'Restore', onClick: () => restore(j) }, { label: 'Discard', onClick: () => discard(j) }],
    });
  }
  async function ready() {
    for (let t = 0; t < 1200 && !(app.edit && app.edit.ready); t++) await new Promise((r) => setTimeout(r, 50));
    return !!(app.edit && app.edit.ready);
  }
  async function restore(j) {
    const doc = app.doc, journal = F.journal;
    if (!journal || journal.key !== j.meta.id || !(await ready()) || app.doc !== doc || F.journal !== journal) return;
    let plan;
    try { plan = planRestore(j.entries, app.edit.doc); } catch (e) {
      toast('The unsaved edits could not be restored', { key: 'journal', kind: 'error', detail: `${e && e.message ? e.message : e} Nothing was changed; they are still kept.`,
        actions: [{ label: 'Discard them', onClick: () => discard(j) }] });
      return;
    }
    for (const p of plan) api.commit(p.label, p.changes);
    journal.adopt(app.edit.doc);
    F.paused = false;
    history();
    toast(`Restored ${plural(plan.length, 'edit')}`, { key: 'journal', detail: 'They are not saved yet. Undo takes them back one by one.' });
  }
  async function discard(j) {
    const journal = F.journal;
    if (!journal || journal.key !== j.meta.id) return;
    await journal.discard().catch(() => {});
    F.paused = false;
    history();
    render();
  }
  window.addEventListener('pagehide', () => { if (F.timer) flush(); });

  // ---------------------------------------------------------------- save over the original file
  const ownFormat = (doc) => (doc.format === 'DGN' || doc.format === 'DXF' ? doc.format : null);
  /** Edit › Save: true when it saves over the file the drawing came from. */
  function quickSave(f) {
    const doc = app.doc;
    if (!doc || !doc.handle || typeof doc.handle.createWritable !== 'function' || f !== ownFormat(doc)) return false;
    saveOver(doc, f);
    return true;
  }
  async function saveOver(doc, f) {
    if (!doc.saveOk && !(doc.recent && doc.recent.ok)) {
      const choice = await askOnce(doc, f);
      if (app.doc !== doc) return;
      if (choice === 'download') { api.save(f); return; }
      if (choice !== 'over') return;
      doc.saveOk = true;
      doc.backup = $('#ip-bak').checked;
      if (doc.recent) updateRecent(db, doc.recent = { ...doc.recent, ok: true, bak: doc.backup, dir: doc.dir || doc.recent.dir || null }).catch(() => {});
    } else if (doc.backup == null) doc.backup = !(doc.recent && doc.recent.bak === false);
    let done = null, notes = [];
    const ok = await api.save(f, doc.name, async (blob, n) => { notes = n; done = await writeOver(doc, f, blob); return !!done; });
    if (!ok || !done || app.doc !== doc) return;
    if (app.edit.doc && app.edit.doc.dirty) { // edited while writing: not in the file yet
      doc.modified = done.modified; doc.size = done.size;
      toast(`Saved over ${doc.name}`, { key: 'saved', kind: 'warn', detail: 'Edits made while it was saving are not in the file yet: save again.' });
      return;
    }
    // carry on from the file on disk (view, layers, markups kept)
    await (F.journal ? F.journal.discard().catch(() => {}) : null);
    api.showDrawing(done.read, doc.name, { set: doc.set, sheet: doc.sheet, handle: doc.handle, dir: doc.dir, modified: done.modified, saveOk: true, backup: doc.backup, backupDone: doc.backupDone, keep: true });
    toast(`Saved over ${doc.name}`, {
      key: 'saved', timeout: 7000, list: notes, listTitle: 'Notes',
      detail: [done.bak, 'Nothing was uploaded. Undo starts again from the saved file.'].filter(Boolean).join(' '),
    });
  }
  /** Read back, check the file, back it up, write: { read, modified, size, bak } or null (reported). */
  async function writeOver(doc, f, blob) {
    const h = doc.handle, fail = (msg, detail, kind = 'error') => { toast(msg, { key: 'saved', kind, detail, actions: [{ label: 'Download a copy', onClick: () => api.save(f) }] }); return null; };
    let read;
    try { read = await api.readDrawing(doc.name, await blob.arrayBuffer()); } catch (e) {
      return fail(`Did not save over ${doc.name}`, `The saved drawing did not read back (${e && e.message ? e.message : e}). Nothing was written; your edits are still here.`);
    }
    let cur;
    try {
      if (!(await permit(h, 'readwrite'))) return fail(`No permission to save over ${doc.name}`, 'Download a copy instead, or allow saving when the browser asks.', 'warn');
      cur = await h.getFile();
    } catch (e) { return fail(`Could not save over ${doc.name}`, e && e.name === 'NotFoundError' ? 'It was moved, renamed or deleted. Your edits are still here.' : `${e && e.message ? e.message : e}. Your edits are still here.`); }
    if (doc.modified != null && (cur.lastModified !== doc.modified || cur.size !== doc.size)
      && !window.confirm(`${doc.name} was changed on disk after you opened it (by another program?).\n\nSave over it anyway?`)) return null;
    let bak = '';
    if (doc.backup !== false && !doc.backupDone) {
      if (!doc.dir) bak = 'No backup copy was made: the browser gave access to this file only, not to its folder.';
      else {
        try {
          if (!(await permit(doc.dir, 'readwrite'))) throw new Error('no permission for the folder');
          const bh = await doc.dir.getFileHandle(backupName(doc.name), { create: true });
          await writeBlob(bh, cur);
          doc.backupDone = backupName(doc.name);
          bak = `Backup of the file as it was: ${doc.backupDone}.`;
        } catch (e) { bak = `No backup copy was made (${e && e.message ? e.message : e}).`; }
      }
    }
    try { await writeBlob(h, blob); } catch (e) {
      return fail(`Could not save over ${doc.name}`, `${e && e.message ? e.message : e}. The file was not changed (or a backup exists); your edits are still here.`);
    }
    const now = await h.getFile().catch(() => null);
    return { read, modified: now ? now.lastModified : null, size: blob.size, bak };
  }
  async function writeBlob(h, blob) {
    const w = await h.createWritable();
    try { await w.write(blob); await w.close(); } catch (e) { try { await w.abort(); } catch { /* ignore */ } throw e; }
  }
  /** The one-time question per file: 'over' | 'download' | ''. */
  function askOnce(doc, f) {
    let dlg = $('#dlg-inplace');
    if (!dlg) {
      document.body.insertAdjacentHTML('beforeend', `<dialog id="dlg-inplace" aria-labelledby="ip-title"><form method="dialog" class="dlg">
        <div class="dlg-head"><h2 id="ip-title">Save over the original file?</h2><button class="btn icon sm" value="" aria-label="Close"><svg class="ic" aria-hidden="true"><use href="#i-close"/></svg></button></div>
        <div class="dlg-body form-grid"><p id="ip-what"></p><p class="warn-note" id="ip-dxf" hidden></p>
          <label class="check"><input type="checkbox" id="ip-bak" checked> <span id="ip-bak-label"></span></label>
          <p class="note"><span id="ip-bak-note"></span> <button type="button" class="btn sm" id="ip-dir" hidden>Allow the folder…</button></p>
          <p class="note">Linework asks once per file. Save as… still downloads a copy.</p></div>
        <div class="dlg-foot"><button class="btn" value="">Cancel</button><button class="btn" value="download">Download a copy</button><button class="btn primary" value="over" id="btn-ip-save">Save over the original</button></div>
      </form></dialog>`);
      dlg = $('#dlg-inplace');
      $('#ip-dir').addEventListener('click', () => allowFolder(dlg.doc));
    }
    dlg.doc = doc;
    $('#ip-what').innerHTML = `<strong>${esc(doc.name)}</strong> will be replaced by the edited drawing.`
      + (f === 'DGN' ? ' Untouched elements stay byte for byte; edited ones are appended, as in every DGN save.' : '');
    const dx = $('#ip-dxf');
    dx.hidden = f !== 'DXF';
    dx.textContent = 'The DXF is written again from what Linework read (R2000): layouts, dimension styles, extended data and plot settings in the original are not kept.';
    $('#ip-bak-label').textContent = `Also keep a backup copy (${backupName(doc.name)})`;
    $('#ip-bak').checked = !(doc.recent && doc.recent.bak === false);
    folderNote(doc);
    return new Promise((res) => { dlg.returnValue = ''; dlg.onclose = () => res(dlg.returnValue); dlg.showModal(); });
  }
  function folderNote(doc) {
    $('#ip-bak-note').textContent = doc.dir ? `The backup goes next to it, in “${doc.dir.name}”, before it is first saved over.`
      : 'The browser gave access to this file only, not to its folder, so no backup copy can be written unless you allow the folder.';
    $('#ip-dir').hidden = !!doc.dir || typeof window.showDirectoryPicker !== 'function';
  }
  async function allowFolder(doc) {
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'linework-open', mode: 'readwrite', startIn: doc.handle }); } catch { return; }
    let path = null;
    try { path = await dir.resolve(doc.handle); } catch { /* not comparable */ }
    if (!path || path.length !== 1) { $('#ip-bak-note').textContent = `“${dir.name}” does not hold ${doc.name}: choose the folder the file is in.`; return; }
    doc.dir = dir;
    if (doc.recent) updateRecent(db, doc.recent = { ...doc.recent, dir }).catch(() => {});
    folderNote(doc);
  }

  render();
  return { pick, openHandle, opened, history, flush, quickSave, render, db };
}
