// Recent drawings and the journal of unsaved edits (src/app/store.js): what is kept, what is
// never kept, and that edits restored after a "crash" give exactly the drawing (and the saved
// file) the session had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes, load } from './helpers.mjs';
import { parseDgn } from '../../src/formats/dgn.js';
import { buildScene } from '../../src/scene.js';
import { EditDoc } from '../../src/edit/doc.js';
import { moveEntity, rotateEntity, setText, restyle } from '../../src/edit/ops.js';
import { writeDgn } from '../../src/formats/dgn-write.js';
import { writeDxf } from '../../src/formats/dxf-write.js';
import { hashBytes } from '../../src/worker.js';
import {
  memoryStore, addRecent, recentList, clearRecent, fmtWhen, Journal, planRestore, packEntry, approxSize, journalKey, journalKeys,
  RECENT_MAX, JOURNAL_MAX_DOCS,
} from '../../src/app/store.js';
import { backupName } from '../../src/app/files.js';

/** A memory store that copies values like IndexedDB does (structured clone), and can refuse handles. */
function cloningStore({ refuseHandles = false } = {}) {
  const m = memoryStore();
  return {
    kind: 'test',
    get: async (s, id) => structuredClone(await m.get(s, id)),
    all: async (s, p) => structuredClone(await m.all(s, p)),
    batch: async (ops) => {
      for (const o of ops) if (o.put && refuseHandles && o.put.handle) throw Object.assign(new Error('could not be cloned'), { name: 'DataCloneError' });
      return m.batch(ops.map((o) => (o.put ? { ...o, put: structuredClone(o.put) } : o)));
    },
  };
}
const handle = (id) => ({ id, kind: 'file', isSameEntry: async (o) => o && o.id === id });

test('recent drawings: newest first, one entry per file (handle, sample or name), at most 12, folder access and confirmation kept; Clear list', async () => {
  const db = memoryStore();
  const t0 = Date.now();
  const h1 = handle('a'), h2 = handle('b');
  await addRecent(db, { name: 'plan.dgn', format: 'DGN', size: 10, hash: 'h1', when: t0, handle: h1 });
  let list = await addRecent(db, { name: 'plan.dgn', format: 'DGN', size: 11, hash: 'h2', when: t0 + 1, handle: h2 }); // same name, another file
  assert.equal(list.length, 2, 'two files with one name stay apart (different handles)');
  await db.batch([{ s: 'recent', put: { ...list.find((r) => r.handle === h1), dir: { name: 'folder' }, ok: true, bak: false } }]);
  list = await addRecent(db, { name: 'plan.dgn', format: 'DGN', size: 12, hash: 'h3', when: t0 + 2, handle: handle('a') });
  assert.equal(list.length, 2, 'the same file again replaces its entry');
  assert.equal(list[0].hash, 'h3');
  assert.equal(list[0].dir.name, 'folder', 'folder access is kept');
  assert.equal(list[0].ok, true, 'the save confirmation is kept');
  assert.equal(list[0].bak, false, 'and the backup choice');
  await addRecent(db, { name: 'site-plan.dgn', format: 'DGN', when: t0 + 3, sample: 'samples/site-plan.dgn' });
  list = await addRecent(db, { name: 'site-plan.dgn', format: 'DGN', when: t0 + 4, sample: 'samples/site-plan.dgn' });
  assert.equal(list.filter((r) => r.sample).length, 1, 'samples: one entry');
  await addRecent(db, { name: 'x.dxf', format: 'DXF', when: t0 + 5 });
  list = await addRecent(db, { name: 'x.dxf', format: 'DXF', when: t0 + 6 });
  assert.equal(list.filter((r) => r.name === 'x.dxf').length, 1, 'without a handle: one entry per name');
  for (let k = 0; k < 20; k++) list = await addRecent(db, { name: `f${k}.dxf`, format: 'DXF', when: t0 + 10 + k });
  assert.equal(list.length, RECENT_MAX);
  assert.equal((await recentList(db)).length, RECENT_MAX, 'older entries are dropped from storage too');
  assert.equal(list[0].name, 'f19.dxf', 'newest first');
  for (const r of await recentList(db)) for (const k of Object.keys(r)) assert.ok(['id', 'name', 'format', 'size', 'hash', 'when', 'handle', 'dir', 'sample', 'ok', 'bak'].includes(k), 'nothing but names, sizes, dates, handles: ' + k);
  await clearRecent(db);
  assert.equal((await recentList(db)).length, 0, 'Clear list');
  // a browser that cannot store the handle: the name is kept anyway
  const db2 = cloningStore({ refuseHandles: true });
  list = await addRecent(db2, { name: 'y.dgn', format: 'DGN', when: t0, handle: handle('y') });
  assert.equal(list[0].handle, null);
  assert.equal((await recentList(db2))[0].name, 'y.dgn');
});

test('fmtWhen and backup names', () => {
  const now = Date.UTC(2026, 5, 10, 12);
  assert.equal(fmtWhen(now - 5000, now), 'just now');
  assert.equal(fmtWhen(now - 5 * 60e3, now), '5 min ago');
  assert.equal(fmtWhen(now - 3 * 3600e3, now), '3 h ago');
  assert.equal(fmtWhen(now - 30 * 3600e3, now), 'yesterday');
  assert.equal(fmtWhen(now - 4 * 86400e3, now), '4 days ago');
  assert.match(fmtWhen(now - 40 * 86400e3, now), /2026/);
  assert.equal(backupName('site-plan.dgn'), 'site-plan.bak.dgn');
  assert.equal(backupName('a.b.DXF'), 'a.b.bak.DXF');
  assert.equal(backupName('noext'), 'noext.bak');
});

// ------------------------------------------------------------------ journal
function openDgn(name = 'site-plan.dgn') {
  const b = bytes(name);
  const model = parseDgn(b);
  const scene = buildScene(model);
  return { b, model, scene, doc: new EditDoc(model, scene, { bytes: b }), info: { name, format: 'DGN', size: b.length, hash: hashBytes(b) } };
}
const ent = (t, i) => t.model.entities[i];
const commit = (t, label, changes) => t.doc.commit(label, changes);
/** A session: move, rotate, restyle, retype, delete, a new line, an undo, a redo and an edit after an undo. */
function session(t) {
  const e = [];
  e.push(commit(t, 'Move', [{ i: 1, before: ent(t, 1), after: moveEntity(ent(t, 1), 2, 1) }]));
  e.push(commit(t, 'Rotate', [{ i: 9, before: ent(t, 9), after: rotateEntity(ent(t, 9), 0.3, 0, 0) }]));
  e.push(commit(t, 'Restyle', [{ i: 13, before: ent(t, 13), after: restyle(ent(t, 13), { color: 3 }, 'DGN') }]));
  e.push(commit(t, 'Move again', [{ i: 1, before: ent(t, 1), after: moveEntity(ent(t, 1), -1, 0) }]));
  const del = commit(t, 'Delete', [{ i: 10, before: ent(t, 10), after: null }]);
  t.doc.revert(del); // undo
  t.doc.reapply(del); // redo
  const n = t.doc.nextIndex();
  e.push(commit(t, 'Line', [{ i: n, before: null, after: { type: 'line', layer: 'Level 5', color: 256, rgb: 0xff0000, ci: 3, weight: 2, a: [1, 1], b: [20, 30] } }]));
  const tx = commit(t, 'Text', [{ i: 6, before: ent(t, 6), after: setText(ent(t, 6), 'MAIN HALL 2') }]);
  t.doc.revert(tx); // undone, then something else instead
  e.push(commit(t, 'Text', [{ i: 7, before: ent(t, 7), after: setText(ent(t, 7), 'STORE B') }]));
  e.push(commit(t, 'Cell', [{ i: 17, before: ent(t, 17), after: moveEntity(ent(t, 17), 5, 5) }]));
  return e;
}

test('journal: a crash after a session of edits (with undo / redo) restores the same drawing, and the same saved DGN bytes', async () => {
  const db = cloningStore();
  const a = openDgn();
  const j = new Journal(db, a.info);
  session(a);
  assert.equal(await j.sync(a.doc), 'kept');
  assert.equal(await j.sync(a.doc), 'same', 'nothing new: nothing written');
  assert.equal(a.doc.log.length, 8, 'the log holds the applied entries only (undone ones are gone)');
  // the stored entries: original entities are markers, not copies of the file's content
  const stored = await db.all('edits', j.key + '#');
  assert.equal(stored.length, 8);
  assert.deepEqual(stored[0].changes[0].before, { orig: 1 }, 'an entity as read from the file is a marker');
  assert.ok(!JSON.stringify(stored).includes('"dgn":[0,'), 'no header bytes');
  // "crash": the same file is opened again
  const b = openDgn();
  const j2 = new Journal(db, b.info);
  assert.equal(j2.key, j.key, 'keyed by the content hash');
  const got = await j2.read();
  assert.equal(got.meta.count, 8);
  assert.equal(got.meta.last, 'Cell');
  const plan = planRestore(got.entries, b.doc);
  for (const p of plan) b.doc.commit(p.label, p.changes);
  j2.adopt(b.doc);
  assert.equal(await j2.sync(b.doc), 'same', 'after a restore the stored journal is already right');
  assert.deepEqual(JSON.parse(JSON.stringify(b.model.entities)), JSON.parse(JSON.stringify(a.model.entities)), 'same entities');
  const wa = writeDgn(a.model, { bytes: a.b, orig: a.doc.orig }), wb = writeDgn(b.model, { bytes: b.b, orig: b.doc.orig });
  assert.deepEqual(Buffer.from(wb.bytes), Buffer.from(wa.bytes), 'the restored drawing saves byte for byte like the session would have');
  // the restored edits undo one by one, back to the file as read
  for (const e of b.doc.log.slice().reverse()) b.doc.revert(e);
  b.model.entities.forEach((x, i) => { if (i < b.doc.orig.length) assert.equal(x, b.doc.orig[i], `slot ${i} is the original object again`); });
  assert.deepEqual(Buffer.from(writeDgn(b.model, { bytes: b.b, orig: b.doc.orig }).bytes), Buffer.from(b.b), 'undoing everything gives the original file');
});

test('journal: kept only while there are unsaved edits; undo back to the start, or saving, clears it', async () => {
  const db = cloningStore();
  const t = openDgn();
  const j = new Journal(db, t.info);
  const e1 = commit(t, 'Move', [{ i: 2, before: ent(t, 2), after: moveEntity(ent(t, 2), 1, 1) }]);
  assert.equal(await j.sync(t.doc), 'kept');
  t.doc.revert(e1);
  assert.equal(await j.sync(t.doc), 'clean');
  assert.equal((await db.all('edits')).length + (await db.all('journal')).length, 0, 'nothing left');
  t.doc.reapply(e1);
  commit(t, 'Move', [{ i: 3, before: ent(t, 3), after: moveEntity(ent(t, 3), 1, 1) }]);
  assert.equal(await j.sync(t.doc), 'kept');
  assert.equal((await j.read()).meta.count, 2);
  t.doc.saved = t.doc.cur; // Save
  assert.equal(await j.sync(t.doc), 'clean');
  assert.equal(await j.read(), null);
  // after a download save, further edits are kept together with the saved ones (all relative to the file as read)
  commit(t, 'Move', [{ i: 4, before: ent(t, 4), after: moveEntity(ent(t, 4), 1, 1) }]);
  assert.equal(await j.sync(t.doc), 'kept');
  assert.equal((await j.read()).meta.count, 3);
  // an undo then a new edit: the stale record goes, the new one is written
  const last = t.doc.log[t.doc.log.length - 1];
  t.doc.revert(last);
  commit(t, 'Restyle', [{ i: 5, before: ent(t, 5), after: restyle(ent(t, 5), { color: 4 }, 'DGN') }]);
  await j.sync(t.doc);
  const r = await j.read();
  assert.deepEqual(r.entries.map((e) => e.label), ['Move', 'Move', 'Restyle']);
  await j.discard();
  assert.equal(await j.read(), null, 'Discard');
});

test('journal: size cap (nothing kept, says so), at most 6 drawings, a DXF session with a new layer, and a journal that does not fit is refused', async () => {
  const db = cloningStore();
  const t = openDgn();
  const j = new Journal(db, t.info, 2000);
  commit(t, 'Move all', t.model.entities.map((e, i) => ({ i, before: e, after: moveEntity(e, 1, 1) })));
  assert.ok(approxSize(packEntry(t.doc.log[0], t.doc.orig)) > 2000);
  assert.equal(await j.sync(t.doc), 'too-big');
  assert.equal(await j.read(), null, 'too big: nothing kept');
  // only the newest JOURNAL_MAX_DOCS drawings keep their edits
  for (let k = 0; k < JOURNAL_MAX_DOCS + 2; k++) {
    const x = openDgn();
    const jx = new Journal(db, { ...x.info, hash: 'h' + k });
    commit(x, 'Move', [{ i: 1, before: ent(x, 1), after: moveEntity(ent(x, 1), k, 0) }]);
    await jx.sync(x.doc);
    await new Promise((r) => setTimeout(r, 2));
  }
  const keys = await journalKeys(db);
  assert.equal(keys.size, JOURNAL_MAX_DOCS);
  assert.ok(keys.has(journalKey({ format: 'DGN', hash: 'h' + (JOURNAL_MAX_DOCS + 1) })) && !keys.has(journalKey({ format: 'DGN', hash: 'h0' })), 'the oldest are forgotten');
  assert.equal((await db.all('edits')).length, JOURNAL_MAX_DOCS, 'with their entries');
  // DXF: a new layer and an item on it
  const d = load('house-plan.dxf');
  const dd = new EditDoc(d.model, d.scene);
  const info = { name: 'house-plan.dxf', format: 'DXF', size: 1, hash: 'dxf' };
  const jd = new Journal(db, info);
  dd.commit('New layer', [{ layer: 'NEW', before: null, after: { name: 'NEW', color: 0xff0000, aci: 1 } }]);
  dd.commit('Line', [{ i: dd.nextIndex(), before: null, after: { type: 'line', layer: 'NEW', color: 256, a: [0, 0], b: [500, 500] } }]);
  await jd.sync(dd);
  const d2 = load('house-plan.dxf'), dd2 = new EditDoc(d2.model, d2.scene);
  for (const p of planRestore((await jd.read()).entries, dd2)) dd2.commit(p.label, p.changes);
  assert.equal(writeDxf(d2.model, {}).text, writeDxf(d.model, {}).text, 'restored DXF saves the same');
  // a journal that does not fit this drawing: refused before anything is applied
  const other = load('bracket.dxf'), od = new EditDoc(other.model, other.scene);
  const before = other.model.entities.slice();
  const bad = [{ label: 'x', changes: [{ i: 0, before: { orig: 1 }, after: null }, { i: 1, before: null, after: { type: 'line', a: [0, 0], b: [1, 1] } }] }];
  assert.throws(() => planRestore(bad, od), (e) => e.code === 'journal-mismatch');
  assert.deepEqual(other.model.entities, before, 'nothing applied');
  const e0 = od.commit('Move', [{ i: 2, before: other.model.entities[2], after: moveEntity(other.model.entities[2], 1, 0) }]);
  assert.throws(() => planRestore([], od), /edited after it was opened/);
  od.revert(e0);
});
