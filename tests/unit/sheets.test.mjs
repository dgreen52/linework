// Sheet sets (src/tools/sheets.js): text index of a sheet, titles and sheet numbers, search across sheets,
// references between sheets, the LRU that bounds memory, and the index cache store. Synthetic fixtures only:
// tests/fixtures/sheets (an invented pump control panel set, made by tools/make_dgn_fixtures.py + make_fixtures.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, texts } from './helpers.mjs';
import { parseDrawing } from '../../src/formats/detect.js';
import { buildScene } from '../../src/scene.js';
import { findRegex } from '../../src/edit/find.js';
import { loadInWorkerScope, hashBytes } from '../../src/worker.js';
import { openStore } from '../../src/app/store.js';
import {
  SHEET_EXTS, isSheetName, stemOf, naturalCmp, indexSheet, indexBytes, indexJob, searchIndex, searchSheets,
  XREF_DEFAULT, compilePatterns, xrefContext, resolveRef, findXrefs, LRU, sceneBytes,
} from '../../src/tools/sheets.js';

const NAMES = ['PNL-01.dgn', 'PNL-02.dgn', 'PNL-03.dgn', 'PNL-04.dxf', 'PNL-05.dxf'];
const bytesOf = (n) => new Uint8Array(readFileSync(join(ROOT, 'tests', 'fixtures', 'sheets', n)));
function load(name) {
  const model = parseDrawing(bytesOf(name), name);
  return { model, scene: buildScene(model, { fileName: name }) };
}
const SET = NAMES.map((name) => { const { model, scene } = load(name); return { id: name, name, idx: indexSheet(scene, model), scene }; });
const byName = (n) => SET.find((s) => s.id === n);

test('which files a set takes: drawings by extension (one list), not Save backups or hidden files; natural order', () => {
  assert.deepEqual(SHEET_EXTS, ['.dxf', '.dwg', '.dgn']);
  for (const n of ['A.dgn', 'b.DXF', 'sub/C.dwg', 'PNL-01.dgn']) assert.ok(isSheetName(n), n);
  for (const n of ['PNL-01.bak.dgn', 'notes.txt', 'x.dgn.json', '.hidden.dxf', '~lock.dgn', 'sub/.x.dgn', 'dgn']) assert.ok(!isSheetName(n), n);
  assert.equal(stemOf('sub/PNL-04.dxf'), 'PNL-04');
  assert.deepEqual(['SH10.dgn', 'sh2.dgn', 'SH1.dgn'].sort(naturalCmp), ['SH1.dgn', 'sh2.dgn', 'SH10.dgn']);
});

test('text index: every drawn text with its centre in drawing coordinates, height, entity and path inside a cell', () => {
  const { scene, idx } = byName('PNL-01.dgn');
  const T = texts(scene).filter((t) => t.s.trim());
  assert.equal(idx.n, T.length);
  assert.equal(idx.format, 'DGN');
  assert.ok(idx.p instanceof Float64Array && idx.e instanceof Int32Array && idx.p.length === 3 * idx.n);
  for (let k = 0; k < idx.n; k++) {
    const t = T[k];
    assert.equal(idx.s[k], t.s);
    assert.ok(Math.abs(idx.p[3 * k] - ((t.bbox[0] + t.bbox[2]) / 2 + scene.origin[0])) < 1e-9, 'x in drawing coordinates');
    assert.ok(Math.abs(idx.p[3 * k + 1] - ((t.bbox[1] + t.bbox[3]) / 2 + scene.origin[1])) < 1e-9, 'y');
    assert.equal(idx.e[k], t.ent);
    assert.equal(idx.sub[k] || '', t.sub || '');
  }
  const w = idx.s.indexOf('W210');
  assert.ok(Math.abs(idx.p[3 * w + 2] - 2) < 1e-6, 'text height 2 m');
  assert.ok(Object.keys(idx.sub).length >= 5, 'texts in the marker and title block cells carry their path');
  assert.ok(indexBytes(idx) > 0 && indexBytes(idx) < 4096, 'small: ' + indexBytes(idx));
});

test('titles and sheet numbers: DGN from the title block (largest text at the lower right), DXF from a TITLE / DWG_TITLE attribute even when a bigger text is there', () => {
  assert.deepEqual(SET.map((s) => s.idx.title), ['PUMP CONTROL POWER', 'PUMP CONTROL RELAYS', 'PUMP CONTROL TERMINALS', 'PUMP CONTROL I/O', 'PUMP CONTROL CABLES']);
  assert.deepEqual(SET.map((s) => s.idx.num), ['1', '2', '3', '4', '5'], 'from "SHEET n OF 5"');
  assert.ok(byName('PNL-05.dxf').idx.s.includes('NOTES') && byName('PNL-05.dxf').idx.tb.includes('NOTES'), 'the bigger NOTES text is in the title block area');
  assert.ok(byName('PNL-01.dgn').idx.tb.includes('PNL-01'), 'title block texts kept (upper case) for resolving drawing numbers');
  // no title block: no title, no number (never a crash)
  const { scene, model } = load('PNL-04.dxf');
  scene.texts = scene.texts.filter((t) => !/PUMP|SHEET/.test(t.s));
  const bare = indexSheet(scene, null);
  assert.equal(bare.num, '');
  assert.notEqual(bare.title, 'PUMP CONTROL I/O');
  assert.equal(indexSheet({ ...scene, texts: [] }, model).title, '');
});

test('index job (the parse worker): the index and the file hash, or a friendly error', async () => {
  const b = bytesOf('PNL-02.dgn');
  const r = await indexJob({ id: 7, name: 'PNL-02.dgn', buffer: b.slice().buffer }, loadInWorkerScope);
  assert.equal(r.id, 7);
  assert.equal(r.type, 'indexed');
  assert.equal(r.index.hash, hashBytes(b));
  assert.equal(r.index.title, 'PUMP CONTROL RELAYS');
  assert.deepEqual(r.index.s, byName('PNL-02.dgn').idx.s);
  const bad = await indexJob({ id: 8, name: 'x.dxf', buffer: new TextEncoder().encode('not a drawing').buffer }, loadInWorkerScope);
  assert.equal(bad.type, 'error');
  assert.match(bad.message, /not a DXF file/);
});

test('search across sheets: repeated wire numbers by sheet in set order, reading order, options, a cap', () => {
  const r = searchSheets(SET, findRegex('W201'));
  assert.deepEqual(r.map((x) => [x.sheetId, x.hits.length]), [['PNL-01.dgn', 2], ['PNL-02.dgn', 2], ['PNL-04.dxf', 1]]);
  const h = r[0].hits;
  assert.ok(h.every((x) => x.text === 'W201' && Number.isFinite(x.x) && Number.isFinite(x.y) && x.h > 0));
  assert.ok(h[0].x < h[1].x && h[1].sub, 'left to right on one row; the second is in the marker cell');
  assert.deepEqual(searchSheets(SET, findRegex('w201', { matchCase: true })), []);
  assert.equal(searchSheets(SET, findRegex('W20')).reduce((n, x) => n + x.hits.length, 0), 11, 'W20 inside W201, W202, W203');
  assert.deepEqual(searchSheets(SET, findRegex('W20', { wholeWord: true })), []);
  assert.equal(searchSheets(SET, findRegex('W20'), 4).reduce((n, x) => n + x.hits.length, 0), 4, 'capped');
  assert.deepEqual(searchSheets([{ id: 'x', name: 'x', idx: null }, ...SET], findRegex('PUMP CONTROL I/O')).map((x) => x.sheetId), ['PNL-04.dxf'], 'sheets not read yet are skipped');
  assert.deepEqual(searchIndex(byName('PNL-03.dgn').idx, /W2\d0/g).map((x) => x.text), ['W230'], 'a RegExp (g flag ignored)');
  // reading order: rows from the top
  const rows = searchIndex(byName('PNL-01.dgn').idx, /^W2/);
  assert.deepEqual(rows.map((x) => x.text), ['W201', 'W201', 'W202', 'W210']);
});

test('references between sheets: SHEET n / SH n / SHT. n by the sheets\' own numbers, SEE DWG x and a text equal to another sheet\'s name; never itself, never "SHEET 1 OF 5"', () => {
  const C = xrefContext(SET);
  const refs = Object.fromEntries(SET.map((s) => [s.id, findXrefs(C, s.idx.s, s.id).map((r) => `${s.idx.s[r.k]}>${r.to}`)]));
  assert.deepEqual(refs, {
    'PNL-01.dgn': ['CONT ON SHEET 2>PNL-02.dgn', 'SEE DWG PNL-05>PNL-05.dxf'],
    'PNL-02.dgn': ['FROM SH 1>PNL-01.dgn', 'TO SHT. 3>PNL-03.dgn'],
    'PNL-03.dgn': ['PNL-04>PNL-04.dxf'],
    'PNL-04.dxf': ['SEE SHEET 3>PNL-03.dgn'],
    'PNL-05.dxf': ['BACK TO SH 1>PNL-01.dgn'],
  });
  assert.ok(byName('PNL-03.dgn').idx.s.includes('SHEET 9'), 'SHEET 9: no such sheet, no link');
  // before the sheets are read: by the trailing number of the file names
  const unread = SET.map(({ id, name }) => ({ id, name }));
  assert.equal(resolveRef(xrefContext(unread), '2', 'PNL-01.dgn'), 'PNL-02.dgn');
  assert.equal(resolveRef(xrefContext(unread), 'pnl-05', 'PNL-01.dgn'), 'PNL-05.dxf', 'not case-sensitive');
  assert.equal(resolveRef(xrefContext(unread), '05', null), 'PNL-05.dxf', 'leading zeros');
  // ambiguous: no link
  const two = xrefContext([{ id: 'A-1.dgn', name: 'A-1.dgn' }, { id: 'B-1.dgn', name: 'B-1.dgn' }, { id: 'C.dgn', name: 'C.dgn' }]);
  assert.equal(resolveRef(two, '1', 'C.dgn'), null);
  assert.equal(resolveRef(two, '1', 'A-1.dgn'), 'B-1.dgn', 'the other one, from one of them');
  // drawing numbers found in another sheet's title block
  const tb = [{ id: 'one.dgn', name: 'one.dgn', idx: { num: '', tb: ['1234-56'] } }, { id: 'two.dgn', name: 'two.dgn', idx: { num: '', tb: [] } }];
  assert.deepEqual(findXrefs(xrefContext(tb), ['SEE DWG 1234-56'], 'two.dgn').map((r) => r.to), ['one.dgn']);
});

test('reference patterns are configurable: own patterns, a pattern without a group, invalid ones reported', () => {
  assert.equal(compilePatterns().res.length, XREF_DEFAULT.length);
  const p = compilePatterns(['DRG\\s+(\\S+)', 'GOTO-\\d', '(unclosed', '  ']);
  assert.deepEqual(p.bad, ['(unclosed']);
  assert.equal(p.res.length, 2);
  const C = xrefContext([...SET, { id: 'GOTO-7.dxf', name: 'GOTO-7.dxf' }], p);
  assert.deepEqual(findXrefs(C, ['drg pnl-02', 'SHEET 2', 'see GOTO-7 here'], 'PNL-01.dgn').map((r) => [r.k, r.to]), [[0, 'PNL-02.dgn'], [2, 'GOTO-7.dxf']], 'only the given patterns (a whole-match token without a group)');
  const none = xrefContext(SET, compilePatterns([]));
  assert.deepEqual(findXrefs(none, ['PNL-02', 'SHEET 2'], 'PNL-01.dgn').map((r) => r.to), ['PNL-02.dgn'], 'another sheet\'s name always links');
});

test('LRU: bounded by count and by bytes, recently used kept, too-large values not kept', () => {
  const c = new LRU(3, 100, (v) => v.n);
  for (const k of ['a', 'b', 'c']) c.set(k, { n: 10 });
  assert.equal(c.count, 3);
  assert.ok(c.get('a'));
  c.set('d', { n: 10 });
  assert.equal(c.count, 3);
  assert.equal(c.get('b'), undefined, 'least recently used went first');
  assert.ok(c.get('a') && c.get('c') && c.get('d'));
  c.set('e', { n: 75 });
  assert.ok(c.bytes <= 100 && c.get('e'), 'bytes bound: ' + c.bytes);
  assert.equal(c.count, 3);
  assert.equal(c.get('a'), undefined, 'the oldest made room');
  c.set('huge', { n: 500 });
  assert.equal(c.get('huge'), undefined, 'larger than the whole budget: not kept');
  c.set('e', { n: 5 });
  assert.equal(c.bytes, 25, 'replacing a value updates the bytes');
  assert.ok(c.delete('e') && !c.delete('e'));
  c.clear();
  assert.equal(c.count + c.bytes, 0);
  assert.equal(new LRU(0).set('x', { n: 1 }).count, 0);
});

test('memory estimate of a shown drawing grows with its scene and model', () => {
  const { scene, model } = load('PNL-01.dgn');
  const a = sceneBytes(scene), b = sceneBytes(scene, model);
  assert.ok(a > 1000 && b > a, `${a} < ${b}`);
});

test('index cache: its own database (or memory) keeps the typed arrays and the meta records', async () => {
  const db = openStore(null, 'linework-sheets', ['index', 'meta']);
  assert.equal(db.kind, 'memory');
  const idx = byName('PNL-04.dxf').idx, id = '0.0.0:' + hashBytes(bytesOf('PNL-04.dxf'));
  await db.batch([{ s: 'index', put: { ...idx, id } }, { s: 'meta', put: { id, when: 1, bytes: indexBytes(idx) } }]);
  const back = await db.get('index', id);
  assert.deepEqual(back.s, idx.s);
  assert.ok(back.p instanceof Float64Array);
  assert.equal((await db.all('meta')).length, 1);
  await assert.rejects(() => db.get('recent', 'x'), 'the main stores are not in it');
  const main = openStore(null);
  assert.equal(await main.get('recent', 'x'), undefined, 'the main database keeps its stores');
});
