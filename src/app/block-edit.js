// Block editor: a block's definition (DXF) or a cell's parts (DGN) opened on their own, with the whole of Edit mode:
// select, move, reshape, draw, retype, paste, undo. A block is shown in its own coordinates (as AutoCAD's block
// editor does), a cell where its parts are. Done writes it back as one undo step of the drawing (every insert of the
// block is drawn again); Cancel leaves the drawing as it was. While it is open the drawing's own undo history,
// markups and measurements are put aside, and saving or opening another drawing waits for Done or Cancel.
// Loaded the first time a block is opened (double-click a block in Edit, or its right-click menu).
import { buildScene } from '../scene.js';
import { $, esc, toast } from './ui.js';

const up = (s) => String(s ?? '').toUpperCase();
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/** Does any of `ents` draw block K, directly or through other blocks (or cells)? */
export function drawsBlock(blocks, ents, K) {
  const seen = new Set(), todo = ents.slice();
  while (todo.length) {
    const e = todo.pop();
    if (!e) continue;
    const R = e.block ? up(e.block) : '';
    if (R === K) return true;
    if (R && !seen.has(R) && blocks[R]) { seen.add(R); for (const c of blocks[R].entities || []) todo.push(c); }
    for (const c of e.children || []) todo.push(c);
  }
  return false;
}

/**
 * The drawing's model with the block (or cell) as its only items: the tables are copies, so what the editor adds
 * (a layer, a pasted block) stays out of the drawing until Done.
 */
export function blockModel(m, ents) {
  return {
    ...m, entities: ents.slice(), paperEntities: [], layerIndex: undefined, page: undefined, layoutData: undefined, modelSpace: undefined,
    layers: m.layers.map((l) => ({ ...l })), blocks: { ...m.blocks }, ltypes: { ...m.ltypes }, styles: { ...(m.styles || {}) },
    stats: { entities: ents.length, byType: {}, notShown: {}, warnings: [] },
  };
}

/**
 * The drawing's changes for an edited block: the layers and definitions the editor added, then the block itself (B.K)
 * or the cell (slot B.i). sub: the editor's model. Returns null when the block would contain itself.
 */
export function blockChanges(m, B, sub) {
  const ents = sub.entities.filter(Boolean);
  if (!B.cell && drawsBlock(sub.blocks, ents, B.K)) return null;
  const changes = [], names = new Set(m.layers.map((l) => up(l.name)));
  for (const l of sub.layers) if (!names.has(up(l.name))) changes.push({ layer: l.name, before: null, after: l });
  for (const t of ['blocks', 'ltypes', 'styles']) for (const [k, v] of Object.entries(sub[t] || {})) if (!own(m[t], k)) changes.push({ table: t, key: k, before: null, after: v });
  changes.push(B.cell ? { i: B.i, before: B.before, after: { ...B.before, children: ents } } : { table: 'blocks', key: B.K, before: B.before, after: { ...B.before, entities: ents } });
  return changes;
}

/** Open the block editor on insert or cell i. x: the Edit mode's internals (src/app/edit-ui.js). */
export function openBlock(app, x, i) {
  const doc = x.doc();
  if (app.blockEdit) { toast('One block at a time: Done or Cancel this one first', { key: 'block' }); return false; }
  if (!doc) return false;
  const m = doc.model, e = m.entities[i], cell = !!e && e.type === 'cell';
  const K = !cell && e && e.type === 'insert' ? up(e.block) : '', blk = K ? m.blocks[K] : null;
  if (!cell && !blk) { toast(e && e.type === 'insert' ? 'This block has no definition in the drawing' : 'Select a block or cell to edit', { key: 'block', kind: 'warn' }); return false; }
  if (blk && blk.xref) { toast('An external reference (xref) is another drawing: open that one to edit it', { key: 'block', kind: 'warn' }); return false; }
  const name = cell ? e.name || 'cell' : blk.name || e.block;
  const sub = blockModel(m, (cell ? e.children : blk.entities) || []);
  const scene = buildScene(sub, { fileName: name });
  // the layers hidden in the drawing stay hidden in the editor
  const shown = new Map(app.scene.layers.map((l, k) => [up(l.name), app.layerVisible ? app.layerVisible[k] : 1]));
  const vis = Uint8Array.from(scene.layers.map((l) => shown.get(up(l.name)) ?? (l.visible ? 1 : 0)));
  const h = app.history;
  const B = app.blockEdit = {
    i, K, cell, name, doc, before: cell ? e : blk, scene: app.scene, view: app.view.snapshot(), vis: app.layerVisible,
    undo: h.undoStack.splice(0), redo: h.redoStack.splice(0), markups: app.markups, measures: app.measures,
  };
  app.markups = []; app.measures = [];
  app.swapScene(scene, null, vis);
  x.reset();
  x.setModel(sub);
  if (!cell && sub.layers.some((l) => l.name === '0')) x.layer('0'); // (a block's items are usually drawn on layer 0)
  if (!/^e/.test(app.tool)) x.api.setTool('eselect');
  showBar(app, x);
  x.status();
  x.api.updateUndoButtons();
  toast(`Editing ${cell ? 'cell' : 'block'} ${name}`, { key: 'block', timeout: 4000, detail: cell ? 'Its parts, where they are in the drawing.' : 'Its definition, in its own coordinates: every copy of it changes. Done keeps the changes.' });
  return B;
}

/** Done: the block back into the drawing (one undo step). Stays open when the block would contain itself. */
export function closeBlock(app, x, keep = true) {
  const B = app.blockEdit;
  if (!B) return false;
  const sub = x.doc(), edited = keep && sub && sub.dirty;
  const changes = edited ? blockChanges(B.doc.model, B, sub.model) : null;
  if (edited && !changes) {
    toast('A block can’t contain itself', { key: 'block', kind: 'error', detail: `Remove the copies of ${B.name} from it first, or Cancel.` });
    return false;
  }
  if (!keep && sub && sub.dirty && !window.confirm(`Drop the changes to ${B.cell ? 'cell' : 'block'} ${B.name}?`)) return false;
  app.blockEdit = null;
  const bar = $('#block-bar');
  if (bar) bar.remove();
  $('#stage').classList.remove('in-block');
  const h = app.history;
  h.undoStack.length = 0; h.redoStack.length = 0;
  for (const u of B.undo) h.undoStack.push(u);
  for (const r of B.redo) h.redoStack.push(r);
  app.markups = B.markups; app.measures = B.measures;
  app.swapScene(B.scene, B.view, B.vis);
  x.reset();
  x.setModel(B.doc.model, null, B.doc);
  if (changes) x.commit(`Edit ${B.cell ? 'cell' : 'block'} ${B.name}`, changes, [B.i]);
  else x.setSel([B.i]);
  x.api.updateUndoButtons();
  x.updateDirty();
  x.status();
  x.api.invalidate(true);
  return true;
}

function showBar(app, x) {
  const B = app.blockEdit, el = document.createElement('div');
  el.className = 'finish-bar';
  el.id = 'block-bar';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', 'Block editor');
  el.style.cssText = 'top:12px;bottom:auto;left:12px;transform:none;align-items:center;max-width:calc(100% - 24px)';
  el.innerHTML = `<span style="padding:0 6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${B.cell ? 'Cell' : 'Block'} <b>${esc(B.name)}</b></span>`
    + '<button type="button" class="btn primary" data-act="done">Done</button><button type="button" class="btn" data-act="cancel">Cancel</button>';
  el.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-act]');
    if (a) closeBlock(app, x, a.dataset.act === 'done');
  });
  if (!$('#block-css')) document.head.append(Object.assign(document.createElement('style'), { id: 'block-css', textContent: '#stage.in-block .tool-hint{top:64px}' }));
  $('#stage').classList.add('in-block');
  $('#stage').append(el);
}
