// Sheet sets (loaded on first use): a folder or several drawings as one set. Navigator, Page Up / Down
// (each sheet keeps its view), a background text index (second parse worker; cached per file content),
// Find in all sheets, references as links. Only the shown sheet and an LRU of a few keep a drawing.
import { SHEET_EXTS, isSheetName, naturalCmp, indexSheet, indexBytes, searchSheets, XREF_DEFAULT, compilePatterns, xrefContext, findXrefs, LRU, sceneBytes } from '../tools/sheets.js';
import { hashBytes, loadInWorkerScope } from '../worker.js';
import { findRegex } from '../edit/find.js';
import { openStore, addRecent, updateRecent } from './store.js';
import { permit } from './files.js';
import { APP_VERSION } from '../config.js';
import { CHAR_W } from '../scene.js';
import { $, toast, esc, storage } from './ui.js';

const MAX = 1000; // sheets per set
const KEEP = 3000, KEEP_BYTES = 96 * 2 ** 20; // text indexes kept in this browser (the oldest go first)
const ROWS = 25; // find results listed per sheet (Enter steps through all)
const PAT = 'linework:xref';
const CSS = `.sheets-panel{width:260px;border-left:0;border-right:1px solid var(--line)}
.sheet-list .cmp-item{padding:5px 12px}.cmp-item[aria-current=true]{background:var(--accent-soft);box-shadow:inset 3px 0 var(--accent)}
.sheet-list b{min-width:1.6em;color:var(--muted);font-size:12px;font-weight:500}.sheet-list span{flex:1;min-width:0}
.sheet-list strong,.sheet-list small,.find-sets button{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.sheet-list small,.find-sets p,.find-sets h4{color:var(--muted);font-size:12px}.sheet-list .err small{color:var(--danger)}.sheet-list em{font-style:normal;font-size:12px;color:var(--accent)}
.sheets-panel details{flex-basis:100%}.sheets-panel textarea{width:100%;min-height:5em;font:12px monospace;color:var(--text);background:var(--bg-3);border:1px solid var(--line);border-radius:6px}
.find-sets{flex-basis:100%;max-height:min(42vh,360px);overflow:auto;border-top:1px solid var(--line);font-size:13px}.find-sets h4{display:flex;justify-content:space-between;margin:6px 6px 2px}.find-sets h4.on{color:var(--accent)}
.find-sets button{width:100%;padding:3px 8px;background:none;border:0;border-radius:5px;text-align:left;cursor:pointer}.find-sets button:hover,.find-sets .on{background:var(--accent-soft)}.find-sets p{margin:2px 8px}
#sheets-prev .ic{transform:rotate(90deg)}#sheets-next .ic{transform:rotate(-90deg)}.tools-stack .findbar{width:min(560px,100%)}
@media (max-width:760px){.sheets-panel{left:0;right:auto}}`;
const DOWN = '<svg class="ic" aria-hidden="true"><use href="#i-down"/></svg>';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const btn = (id, label, title, cls = 'btn icon sm') => `<button type="button" class="${cls}" id="${id}" title="${title}"${label.length < 2 || label[0] === '<' ? ` aria-label="${title}"` : ''}>${label}</button>`;
const sig = (app) => `${app.scene.texts.length}:${app.edit && app.edit.doc ? app.edit.doc.cur : 0}`;

/** Folder listing (and one level of subfolders): [{ name, handle }]. */
async function listDir(dir, pre = '', out = []) {
  for await (const [n, h] of dir.entries()) {
    if (h.kind === 'file' && isSheetName(n)) out.push({ name: pre + n, handle: h });
    else if (h.kind === 'directory' && !pre && !/^[.~]/.test(n)) await listDir(h, n + '/', out);
  }
  return out;
}
/** The same for a dropped folder where the browser gives no handles (FileSystemEntry). */
async function listEntry(d, pre = '', out = []) {
  const r = d.createReader();
  for (let es; (es = await new Promise((res) => r.readEntries(res, () => res([])))).length;) {
    for (const en of es) {
      if (en.isFile && isSheetName(en.name)) out.push({ name: pre + en.name, entry: en });
      else if (en.isDirectory && !pre) await listEntry(en, en.name + '/', out);
    }
  }
  return out;
}
const fileOf = (sh) => (sh.file ? Promise.resolve(sh.file) : sh.handle ? sh.handle.getFile() : new Promise((res, rej) => sh.entry.file(res, rej)));

/** api: { okToReplace() } */
export function initSheets(app, api) {
  let S = null, db = null, W = null, seq = 0, timer = 0, hover = null, down = null, live = null;
  const cache = new LRU(3, 160 * 2 ** 20, (r) => r.n); // recently shown sheets, ready to show again
  const FU = { q: '', res: [], flat: [], g: -1, tok: 0 }; // Find in all sheets: bar, options, results
  const idb = () => db || (db = openStore(globalThis.indexedDB, 'linework-sheets', ['index', 'meta']));
  const byId = (id) => (S && S.sheets.find((x) => x.id === id)) || null;
  /** The sheet on screen (null: another drawing, or none). */
  const shown = () => (S && app.doc && app.doc.set === S.id ? app.doc.sheet : null);
  const patterns = () => { try { const p = JSON.parse(storage.get(PAT)); if (Array.isArray(p) && p.length) return p.map(String); } catch { /* defaults */ } return XREF_DEFAULT; };

  // ---------------------------------------------------------------- opening a set
  async function pickFolder() {
    if (typeof window.showDirectoryPicker !== 'function') return chooser(true);
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'linework-set', mode: 'read' }); } catch (e) { if (e.name !== 'AbortError') chooser(true); return; }
    await openDir(dir);
  }
  /** The plain chooser: a folder where the browser can pick one, or several files. */
  function chooser(folder) {
    let inp = $('#sheets-input');
    if (!inp) document.body.appendChild(inp = Object.assign(document.createElement('input'), { type: 'file', id: 'sheets-input', multiple: true, hidden: true, accept: SHEET_EXTS.join() }));
    inp.webkitdirectory = folder;
    inp.onchange = () => { const fs = [...inp.files]; inp.value = ''; if (fs.length) openFiles(fs); };
    inp.click();
  }
  async function openDir(dir, last) {
    try { return openSet({ name: dir.name, key: 'dir:' + dir.name, dir, items: await listDir(dir), last }); } catch { toast(`Could not read the folder ${dir.name}`, { kind: 'error' }); }
  }
  const keyOf = (items) => 'files:' + hashBytes(new TextEncoder().encode(items.map((x) => x.name).sort().join('\n')));
  const nameOf = (items) => (items.length > 1 ? `${items[0].name} + ${items.length - 1} more` : items[0].name);
  function openFiles(files) {
    const top = files[0].webkitRelativePath && files[0].webkitRelativePath.split('/')[0];
    const items = files.map((f) => ({ name: top ? f.webkitRelativePath.slice(top.length + 1) : f.name, file: f })).filter((x) => isSheetName(x.name));
    return openSet({ name: top || (items.length ? nameOf(items) : files[0].name), key: top ? 'dir:' + top : items.length && keyOf(items), items });
  }
  function openHandles(hs, last) {
    const items = hs.filter((h) => isSheetName(h.name)).map((h) => ({ name: h.name, handle: h }));
    return openSet({ name: items.length ? nameOf(items) : 'these files', key: items.length && keyOf(items), handles: items.map((x) => x.handle), items, last });
  }
  /** Several files or a folder dropped (handles and entries asked for during the drop event). */
  async function dropped(files, handles, entries) {
    const dir = handles.find((h) => h && h.kind === 'directory'), de = entries.find((x) => x && x.isDirectory);
    if (dir) return openDir(dir);
    if (de) return openSet({ name: de.name, key: 'dir:' + de.name, items: await listEntry(de) });
    const hs = handles.filter((h) => h && h.kind === 'file' && isSheetName(h.name));
    return hs.length === files.filter((f) => isSheetName(f.name)).length ? openHandles(hs) : openFiles(files);
  }
  /** A set from the recent list (files.js): one click; the browser may ask for permission. */
  async function reopen(r) {
    const hs = r.handle ? [r.handle] : r.handles || [];
    if (!hs.length) { toast(`Choose the files of ${r.name} again`, { key: 'recent', detail: 'This browser cannot reopen files by itself.' }); return chooser(r.hash.startsWith('dir:')); }
    try {
      let ok = true;
      for (const h of hs) if (!(ok = await permit(h, 'read'))) break;
      if (ok) return await (r.handle ? openDir(r.handle, r.set.last) : openHandles(hs, r.set.last));
    } catch { /* below */ }
    toast(`Could not open ${r.name}`, { key: 'recent', kind: 'warn', detail: 'It was moved or deleted, or reading it was not allowed.' });
  }

  async function openSet(set) {
    const items = set.items.sort((a, b) => naturalCmp(a.name, b.name)).slice(0, MAX), n = new Map();
    if (!items.length) { toast(`No drawings in ${set.name}`, { kind: 'warn', detail: `A sheet set takes ${SHEET_EXTS.join(' ')} files.` }); return false; }
    if (!api.okToReplace()) return false;
    close();
    S = { name: set.name, key: set.key, id: set.key || 'set:' + set.name, dir: set.dir || null, handles: set.handles || null, cur: -1, at: null, seq: 0 };
    S.sheets = items.map((x) => { const k = (n.get(x.name) || 0) + 1; n.set(x.name, k); return { ...x, id: k > 1 ? `${x.name} (${k})` : x.name, idx: null, err: '' }; });
    panel();
    setPanel(innerWidth > 760);
    remember();
    toast(`Opened the set ${set.name}`, { key: 'set', timeout: 3500, detail: `${plural(S.sheets.length, 'sheet')} · Page Up / Page Down · Find searches all` });
    await open((byId(set.last) || S.sheets[0]).id, true);
    indexAll();
    return true;
  }
  /** Close the set (the sheet on screen stays open as a drawing). */
  function close() {
    if (!S) return;
    stopIndex();
    cache.clear();
    S = null;
    FU.res = FU.flat = [];
    for (const el of document.querySelectorAll('#sheets-panel, #btn-sheets, .find-sets, [data-o="all"]')) el.hidden = true;
    app.invalidate();
  }

  // ---------------------------------------------------------------- recent drawings: the set is one entry
  const same = async (a, b) => { try { return !!a.set && (a.handle && b.handle ? await a.handle.isSameEntry(b.handle) : !a.handle && !b.handle && a.hash === b.hash); } catch { return false; } };
  async function remember() {
    const set = S, db0 = app.files && app.files.db;
    if (!db0 || !set.key) return;
    const e = { name: set.name, format: 'Sheet set', size: 0, hash: set.key, when: Date.now(), handle: set.dir, handles: set.dir ? null : set.handles, set: { n: set.sheets.length, last: null } };
    try {
      const list = await addRecent(db0, e, same).catch((err) => { if (err.name !== 'DataCloneError') throw err; return addRecent(db0, { ...e, handles: null }, same); });
      set.recent = list.find((r) => r.set && r.hash === set.key);
      app.files.render();
    } catch { /* storage unavailable: no list */ }
  }

  // ---------------------------------------------------------------- showing a sheet
  /** Show sheet `id` through the normal open path: true when it is on screen. */
  async function open(id, asked) {
    const set = S, k = S ? S.sheets.findIndex((x) => x.id === id) : -1, sh = k >= 0 && S.sheets[k];
    if (!sh || shown() === id) return !!sh;
    if (!asked && !api.okToReplace()) return false;
    leave();
    const my = ++set.seq;
    set.at = k; // Page Up / Down go on from here (also past a sheet that does not open)
    try {
      const file = await fileOf(sh);
      if (my !== set.seq) return false;
      const src = { set: set.id, sheet: id, handle: sh.handle || null, dir: set.dir, state: sh.state, modified: file.lastModified };
      const hit = cache.get(id);
      sh.stamp = `${file.size}:${file.lastModified}`;
      if (hit && hit.stamp === sh.stamp) { if (app.loading) app.cancelOpen(); app.showDrawing(hit, sh.name, src); }
      else { cache.delete(id); await app.openDrawing(sh.name, await file.arrayBuffer(), file.size, undefined, src); }
    } catch {
      sh.err = 'Could not be read';
      toast(`Could not open ${sh.name}`, { kind: 'error', detail: 'It was moved, renamed or deleted, or the browser could not read it.' });
      render();
    }
    return shown() === id;
  }
  /** Leaving the shown sheet: keep its view and hidden layers, and (never edited) its drawing in the LRU. */
  function leave() {
    const sh = byId(shown()), d = app.edit.ready && app.edit.doc;
    if (!sh) return;
    sh.state = { view: { cx: app.view.cx, cy: app.view.cy, scale: app.view.scale }, off: app.scene.layers.filter((l, i) => !app.layerVisible[i]).map((l) => l.name) };
    if (d && !d.seq && d.scene === app.scene) cache.set(sh.id, { scene: app.scene, model: d.model, bytes: d.bytes, stamp: sh.stamp, n: sceneBytes(app.scene, d.model) });
    else cache.delete(sh.id);
  }
  function step(d) {
    if (!S) return;
    const n = S.sheets.length, k = S.at != null ? S.at + d : d > 0 ? 0 : n - 1;
    if (k >= 0 && k < n) return open(S.sheets[k].id);
    toast(k < 0 ? 'This is the first sheet' : 'This is the last sheet', { key: 'set', timeout: 1500 });
  }
  app.hooks.open.push((doc) => {
    const id = shown(), sh = byId(id);
    if (!S) return;
    if (sh && doc.keep) { sh.idx = null; cache.delete(id); } // saved over the original: new content
    if (sh) {
      S.cur = S.sheets.indexOf(sh);
      if (S.recent && !doc.keep) updateRecent(app.files.db, S.recent = { ...S.recent, when: Date.now(), set: { ...S.recent.set, last: id } }).catch(() => {});
      if (!sh.idx) indexShown(sh);
      if (innerWidth <= 760) setPanel(false);
    }
    render();
  });
  /** The shown sheet's index straight from its drawing (no second read), once its model is here. */
  async function indexShown(sh) {
    const set = S, scene = app.scene, hash = app.doc.hash;
    for (let t = 0; t < 600 && !app.edit.ready && app.scene === scene; t++) await new Promise((r) => setTimeout(r, 50));
    if (S !== set || app.scene !== scene || sh.idx || !app.edit.ready || app.edit.doc.seq) return;
    sh.idx = indexSheet(scene, app.edit.doc.model);
    if (hash) keep(`${APP_VERSION}:${hash}`, sh.idx);
    soon();
  }

  // ---------------------------------------------------------------- background index (a second parse worker)
  function worker() {
    if (W !== null) return W;
    try {
      const w = new Worker(new URL('../worker.js', import.meta.url), { type: 'module' });
      w.jobs = new Map();
      w.onmessage = (ev) => { w.alive = true; const j = w.jobs.get(ev.data.id); if (j) j(ev.data); };
      w.onerror = (e) => { e.preventDefault(); if (W === w) stopWorker('The reader stopped on this file.', !w.alive); }; // never started: read here from now on
      return (W = w);
    } catch { return (W = false); }
  }
  function stopWorker(message, never) {
    if (!W) return;
    for (const j of W.jobs.values()) j({ type: 'error', message, retry: never });
    W.terminate();
    W = never ? false : null;
  }
  /** Text index of one file: { index } | { error, retry? }. */
  async function read(name, buffer) {
    const w = worker();
    if (!w) {
      try { const r = await loadInWorkerScope({ name, buffer }, () => {}); return { index: indexSheet(r.scene, r.model) }; } catch (e) { return { error: e.message }; }
    }
    const id = ++seq;
    return new Promise((res) => {
      const t = setTimeout(() => stopWorker('It took too long to read.'), 90000);
      w.jobs.set(id, (m) => { clearTimeout(t); w.jobs.delete(id); res(m.index ? m : { error: m.message, retry: m.retry }); });
      w.postMessage({ type: 'index', id, name, buffer }, [buffer]);
    });
  }
  const keep = (id, idx) => idb().batch([{ s: 'index', put: { ...idx, id } }, { s: 'meta', put: { id, when: Date.now(), bytes: indexBytes(idx) } }]).catch(() => {});
  async function indexOne(sh, set) {
    for (let r = { retry: 1 }; r.retry;) {
      let buf;
      try { buf = await (await fileOf(sh)).arrayBuffer(); } catch { sh.err = 'Could not be read'; return; }
      const id = `${APP_VERSION}:${hashBytes(new Uint8Array(buf))}`, kept = await idb().get('index', id).catch(() => null);
      if (kept && kept.s) { sh.idx = kept; set.cached++; keep(id, kept); return; }
      r = await read(sh.name, buf);
      if (r.index) { sh.idx = sh.idx || r.index; keep(id, r.index); } else if (!set.stop && !r.retry) sh.err = r.error;
    }
  }
  async function indexAll() {
    const set = S;
    if (!set || set.indexing) return;
    Object.assign(set, { indexing: true, stop: false, cached: 0 });
    status();
    for (const sh of set.sheets) {
      if (set.stop || S !== set) break;
      if (!sh.idx && !sh.err) { await indexOne(sh, set); soon(); }
    }
    set.indexing = false;
    soon(true);
    // forget the oldest indexes beyond what this browser keeps
    try {
      let bytes = 0;
      const ops = [];
      (await idb().all('meta')).sort((a, b) => b.when - a.when).forEach((m, i) => { if (i >= KEEP || (bytes += m.bytes) > KEEP_BYTES) ops.push({ s: 'index', del: m.id }, { s: 'meta', del: m.id }); });
      await idb().batch(ops);
    } catch { /* storage unavailable */ }
  }
  function stopIndex() { if (S) { S.stop = true; stopWorker('Stopped.'); } }

  // ---------------------------------------------------------------- search across the set
  /** [{ sheetId, name, hits: [{ text, x, y, h, sub, ent, k }] }]: q is a literal (opts: matchCase, wholeWord) or a RegExp. */
  function findAcross(q, opts = {}) {
    const re = q instanceof RegExp ? q : findRegex(q, opts), on = shown();
    if (!S || !re) return [];
    if (on && (!live || live.scene !== app.scene || live.sig !== sig(app))) live = { scene: app.scene, sig: sig(app), idx: indexSheet(app.scene) };
    return searchSheets(S.sheets.map((sh) => (sh.id === on ? { ...sh, idx: live.idx } : sh)), re); // the shown sheet as drawn now
  }
  /** Find bar with All sheets on (tools-ui.js): the matches listed by sheet below it. */
  function findIn(bar, q, o) {
    if (!S) return;
    const cur = FU.q === q && FU.flat[FU.g], on = shown();
    let g = 0, box = $('.find-sets', bar);
    Object.assign(FU, { bar, o, q, res: q ? findAcross(q, o) : [], flat: [] });
    for (const r of FU.res) for (const h of r.hits) FU.flat.push({ id: r.sheetId, h });
    FU.g = cur ? FU.flat.findIndex((x) => x.id === cur.id && x.h.ent === cur.h.ent && x.h.sub === cur.h.sub && x.h.text === cur.h.text) : -1;
    if (!box) {
      bar.appendChild(box = Object.assign(document.createElement('div'), { className: 'find-sets' }));
      box.addEventListener('click', (e) => { const b = e.target.closest('[data-g]'); if (b) go(+b.dataset.g); });
    }
    const left = S.sheets.filter((x) => !x.idx && !x.err && x.id !== on).length;
    box.hidden = !q;
    box.innerHTML = FU.res.map((r) => `<h4${r.sheetId === on ? ' class="on"' : ''}><span>${esc(r.sheetId)}</span>${r.hits.length}</h4>${r.hits.map((h, i) => (i < ROWS ? `<button type="button" data-g="${g + i}"${g + i === FU.g ? ' class="on"' : ''}>${esc(h.text)}</button>` : '')).join('')}${r.hits.length > ROWS ? `<p>+ ${r.hits.length - ROWS} more (Enter steps through them)</p>` : ''}${((g += r.hits.length), '')}`).join('')
      + (FU.res.length ? '' : '<p>No matches in any sheet</p>') + (left ? `<p>Still reading ${plural(left, 'sheet')}…</p>` : '');
    label();
    render();
  }
  function label() {
    const n = FU.flat.length;
    $('#find-n', FU.bar).textContent = !FU.q ? '' : !n ? 'No matches' : FU.g >= 0 ? `${FU.g + 1} of ${n}` : `${n} in ${plural(FU.res.length, 'sheet')}`;
    for (const b of FU.bar.querySelectorAll('#find-prev, #find-next')) b.disabled = !n;
  }
  /** Enter / F3: the next match in any sheet (the first press: from the shown sheet on). */
  function findStep(d) {
    const n = FU.flat.length;
    if (!n || !S) return;
    const k = FU.flat.findIndex((x) => S.sheets.findIndex((s) => s.id === x.id) >= S.cur);
    go(FU.g >= 0 ? (FU.g + d + n) % n : d > 0 ? Math.max(0, k) : (Math.max(0, k) + n - 1) % n);
  }
  async function go(g) {
    const it = FU.flat[g], tok = ++FU.tok;
    if (!it) return;
    FU.g = g;
    label();
    for (const b of FU.bar.querySelectorAll('[data-g]')) if (b.classList.toggle('on', +b.dataset.g === g)) b.scrollIntoView({ block: 'nearest' });
    if (await open(it.id) && tok === FU.tok) app.tools.showHit(it.h);
  }

  // ---------------------------------------------------------------- references to other sheets: links
  /** In the shown sheet: [{ t (scene text), to (sheet id) }]. */
  function xrefs() {
    const on = shown();
    if (!on || !app.scene) return [];
    if (!S.xr || S.xr.scene !== app.scene || S.xr.sig !== sig(app)) {
      S.ctx = S.ctx || xrefContext(S.sheets, compilePatterns(patterns()));
      S.xr = { scene: app.scene, sig: sig(app), list: findXrefs(S.ctx, app.scene.texts.map((t) => (t.dead ? '' : t.s)), on).map((r) => ({ t: app.scene.texts[r.k], to: r.to })) };
    }
    return S.xr.list.filter((r) => app.layerVisible[r.t.layer]);
  }
  const cv = $('#cv-overlay');
  /** A drawn text on screen: (u, v) -> [sx, sy]; u along its width (0..1), v in cap heights (as Find draws it). */
  const along = (t) => {
    const W = t.fit || (t.w != null ? t.w : CHAR_W * t.s.length), u0 = t.align === 0 ? 0 : t.align === 1 ? -W / 2 : -W, [a, b, c, d] = t.m;
    return (u, v) => app.view.toScreen(t.x + (u0 + u * W) * a + v * c, t.y + (u0 + u * W) * b + v * d);
  };
  const quad = (t) => { const P = along(t); return [P(0, -0.3), P(1, -0.3), P(1, 1.2), P(0, 1.2)]; };
  function xrefAt(e) {
    if (!S || app.tool !== 'pan' || e.buttons) return null;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    return xrefs().find((x2) => { const q = quad(x2.t), xs = q.map((p) => p[0]), ys = q.map((p) => p[1]); return x >= Math.min(...xs) - 3 && x <= Math.max(...xs) + 3 && y >= Math.min(...ys) - 3 && y <= Math.max(...ys) + 3; }) || null;
  }
  cv.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  cv.addEventListener('click', (e) => { const r = down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5 && xrefAt(e); if (r) open(r.to); });
  cv.addEventListener('pointermove', (e) => {
    const r = xrefAt(e), to = r && byId(r.to);
    if (r) $('#st-info').textContent = `Sheet reference: click to open ${r.to}${to.idx && to.idx.title ? ' · ' + to.idx.title : ''}`;
    if (r === hover) return;
    hover = r;
    cv.style.cursor = r ? 'pointer' : '';
    app.invalidate();
  });
  app.hooks.draw.push((ctx) => { // references underlined like links
    ctx.save();
    ctx.setTransform(app.dpr, 0, 0, app.dpr, 0, 0);
    ctx.strokeStyle = ctx.fillStyle = app.theme === 'paper' ? '#0062d6' : '#2bd1ff';
    for (const r of S ? xrefs() : []) {
      if (Math.hypot(r.t.m[2], r.t.m[3]) * app.view.scale < 4) continue; // too small to read
      const P = along(r.t), on = r === hover;
      ctx.globalAlpha = on ? 1 : 0.75;
      ctx.lineWidth = on ? 2 : 1.25;
      ctx.beginPath(); ctx.moveTo(...P(0, -0.2)); ctx.lineTo(...P(1, -0.2)); ctx.stroke();
      if (on) { ctx.globalAlpha = 0.15; ctx.beginPath(); for (const q of quad(r.t)) ctx.lineTo(...q); ctx.fill(); }
    }
    ctx.restore();
  });

  // ---------------------------------------------------------------- navigator panel
  function panel() {
    if ($('#sheets-panel')) return;
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));
    $('.workspace').insertAdjacentHTML('afterbegin', `<aside class="panel sheets-panel" id="sheets-panel" aria-labelledby="sheets-title" hidden>
      <div class="panel-head"><h2 id="sheets-title">Sheets <span class="count" id="sheets-count"></span></h2><span>${btn('sheets-prev', DOWN, 'Previous sheet (Page Up)')}${btn('sheets-next', DOWN, 'Next sheet (Page Down)')}${btn('sheets-hide', '<svg class="ic" aria-hidden="true"><use href="#i-close"/></svg>', 'Hide the list (the set stays open)')}</span></div>
      <ol class="layer-list sheet-list" id="sheet-list" aria-label="Sheets"></ol>
      <div class="panel-foot"><span id="sheets-status" aria-live="polite"></span>${btn('sheets-stop', '', '', 'btn sm')}${btn('sheets-close', 'Close set', 'Close the set (the sheet on screen stays open)', 'btn sm')}
        <details><summary>Sheet references</summary><textarea id="xref-pat" spellcheck="false" aria-label="Sheet reference patterns"></textarea>Regular expressions, one per line (group 1: the sheet or drawing number); empty: the defaults.</details></div></aside>`);
    $('#btn-layers').insertAdjacentHTML('afterend', '<button type="button" class="tool" id="btn-sheets" aria-pressed="false" title="Sheets of the set: list, previous / next (Page Up / Page Down)"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h11v15M5 6h11v15H5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg><span>Sheets</span></button>');
    $('#btn-sheets').addEventListener('click', () => setPanel($('#sheets-panel').hidden));
    $('#sheets-panel').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b && b.dataset.sheet) open(b.dataset.sheet);
      else if (b) ({ 'sheets-prev': () => step(-1), 'sheets-next': () => step(1), 'sheets-hide': () => setPanel(false), 'sheets-close': close, 'sheets-stop': () => { if (S.indexing) stopIndex(); else { for (const x of S.sheets) x.err = ''; indexAll(); } } })[b.id]?.();
    });
    const ta = $('#xref-pat');
    ta.value = patterns().join('\n');
    ta.addEventListener('change', () => {
      const p = ta.value.split('\n').filter((x) => x.trim()), bad = compilePatterns(p).bad;
      storage.set(PAT, JSON.stringify(p));
      if (S) S.ctx = S.xr = null;
      if (!p.length) ta.value = XREF_DEFAULT.join('\n');
      toast(bad.length ? 'These patterns are not valid and are skipped' : 'Sheet references updated', { key: 'set', kind: bad.length ? 'warn' : 'info', list: bad, timeout: 3000 });
      app.invalidate();
    });
  }
  function setPanel(open) {
    const p = $('#sheets-panel');
    if (!S) return;
    p.hidden = !open;
    $('#btn-sheets').hidden = false;
    $('#btn-sheets').setAttribute('aria-pressed', String(open));
    if (open) $('#sheet-list [aria-current]')?.scrollIntoView({ block: 'nearest' });
  }
  /** After sheets were read: once per 300 ms, the list (and Find in all sheets) again. */
  function soon(now) {
    if (S) S.ctx = S.xr = null;
    const go = () => {
      timer = clearTimeout(timer) || 0;
      if (FU.bar && !FU.bar.hidden && FU.o.all && FU.q) findIn(FU.bar, FU.q, FU.o); else render();
      app.invalidate();
    };
    if (now) go(); else timer = timer || setTimeout(go, 300);
  }
  function render() {
    const list = $('#sheet-list'), on = shown();
    if (!S || !list) return;
    const hits = new Map(FU.q && FU.o.all && !FU.bar.hidden ? FU.res.map((r) => [r.sheetId, r.hits.length]) : []), n = S.sheets.length, done = S.sheets.filter((x) => x.idx).length;
    list.innerHTML = S.sheets.map((sh, i) => {
      const title = sh.idx ? sh.idx.title : '', sub = sh.err || title || (sh.idx ? '' : 'not read yet');
      return `<li><button type="button" class="cmp-item${sh.err ? ' err' : ''}" data-sheet="${esc(sh.id)}"${on === sh.id ? ' aria-current="true"' : ''} title="${esc(sh.id + (title ? ' — ' + title : ''))}"><b>${i + 1}</b><span><strong>${esc(sh.id)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${hits.has(sh.id) ? `<em>${hits.get(sh.id)}</em>` : ''}</button></li>`;
    }).join('');
    $('#sheets-count').textContent = on ? `${S.cur + 1} / ${n}` : n;
    $('#sheets-prev').disabled = S.at === 0;
    $('#sheets-next').disabled = S.at === n - 1;
    status(done);
  }
  function status(done = S.sheets.filter((x) => x.idx).length) {
    const n = S.sheets.length, bad = S.sheets.filter((x) => x.err).length, b = $('#sheets-stop');
    $('#sheets-status').textContent = S.indexing ? `Reading texts ${done} / ${n}…` : done === n ? `All ${plural(n, 'sheet')} searchable` : `${done} of ${n} searchable${bad ? `, ${bad} not read` : ''}`;
    b.hidden = !S.indexing && done === n;
    b.textContent = S.indexing ? 'Stop' : 'Read again';
    b.title = S.indexing ? 'Stop reading the sheets (Find searches the sheets read so far)' : 'Read the sheets not read yet';
  }
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!S || !/^Page(Up|Down)$/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey || (t.closest && t.closest('input:not([type=checkbox]), textarea, select, [contenteditable]')) || $('dialog[open]')) return;
    e.preventDefault();
    step(e.key === 'PageDown' ? 1 : -1);
  });

  return (app.sheets = {
    get active() { return !!S; },
    list: () => (S ? S.sheets.map((sh, i) => ({ id: sh.id, name: sh.name, n: i + 1, title: sh.idx ? sh.idx.title : '', num: sh.idx ? sh.idx.num : '', indexed: !!sh.idx, error: sh.err, current: shown() === sh.id })) : []),
    open: (id) => open(id), step, findAcross, close, xrefs: () => xrefs().map((r) => ({ text: r.t.s, to: r.to, bbox: r.t.bbox })),
    status: () => ({ sheets: S ? S.sheets.length : 0, indexed: S ? S.sheets.filter((x) => x.idx).length : 0, failed: S ? S.sheets.filter((x) => x.err).length : 0, indexing: !!(S && S.indexing), fromCache: S ? S.cached : 0, scenes: cache.count, sceneBytes: cache.bytes, indexBytes: S ? S.sheets.reduce((t, x) => t + (x.idx ? indexBytes(x.idx) : 0), 0) : 0 }),
    stop: stopIndex, resume: indexAll, panel: setPanel, cache,
    // entry points (app.js, files.js) and the find bar (tools-ui.js)
    pickFolder, openFiles, openHandles, dropped, reopen, findIn, findStep,
  });
}
