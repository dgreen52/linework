// DWG reader (LibreDWG WebAssembly, vendor/libredwg). Every DWG fixture is a synthetic DXF fixture
// converted to DWG R2000 by tools/make_dwg_fixtures.mjs; the oracle is the same drawing opened as DXF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, bytes, liveItems, compareItems, rng } from './helpers.mjs';
import { detectFormat, parseDrawing, parseDrawingAsync } from '../../src/formats/detect.js';
import { parseDwg, dwgVersion, dwgColorGroups, UNREADABLE, WASM_SIZE, MAX_DWG_BYTES } from '../../src/formats/dwg.js';
import { parseDxf } from '../../src/formats/dxf.js';
import { writeDxf } from '../../src/formats/dxf-write.js';
import { buildScene, KIND } from '../../src/scene.js';
import { DWG_FIXTURES, dxfToDwg } from '../../tools/make_dwg_fixtures.mjs';
import { dynamicCodeSites, wasmMemory, libredwgVersion } from '../../tools/vendor_libredwg.mjs';

const wasmBytes = readFileSync(join(ROOT, 'vendor/libredwg/libredwg-web.wasm'));
const glue = readFileSync(join(ROOT, 'vendor/libredwg/libredwg-web.js'), 'utf8');
const file = (p) => new Uint8Array(readFileSync(join(ROOT, p)));
const open = (b, opts = {}) => parseDwg(b, { wasmBytes, ...opts });
const magic = (m, n = 128) => { const b = new Uint8Array(n); b.set(Buffer.from(m, 'latin1')); return b; };
const worldExt = (s) => [s.extents[0] + s.origin[0], s.extents[1] + s.origin[1], s.extents[2] + s.origin[0], s.extents[3] + s.origin[1]];
const relTol = (s) => (x) => 1e-6 * Math.max(1, ...worldExt(s).map(Math.abs), ...(x.bbox || []).map(Math.abs));
const layerRows = (m) => m.layers.map((l) => [l.name, l.color, l.visible, l.frozen, l.ltype]);

// ------------------------------------------------------------------ detection
test('detection: every DWG version magic (R13 to 2018) is a DWG; the version is named', () => {
  const names = { AC1012: 'R13', AC1014: 'R14', AC1015: 'R2000', AC1018: 'R2004', AC1021: 'R2007', AC1024: 'R2010', AC1027: 'R2013', AC1032: 'R2018' };
  for (const [m, name] of Object.entries(names)) {
    for (const fname of ['x.dwg', 'x', 'X.DWG']) assert.equal(detectFormat(magic(m), fname), 'dwg', `${m} ${fname}`);
    const v = dwgVersion(magic(m));
    assert.equal(v.name, name);
    assert.equal(v.known, true);
    assert.equal(v.unicode, ['AC1021', 'AC1024', 'AC1027', 'AC1032'].includes(m), 'R2007+ store text as Unicode');
  }
  for (const m of ['AC1009', 'AC1006', 'AC1.50', 'AC1.40']) assert.equal(dwgVersion(magic(m)).old, true, m);
  for (const [, out] of DWG_FIXTURES) assert.equal(detectFormat(file(out), out), 'dwg', out);
  assert.equal(detectFormat(bytes('edge-fake.dwg'), 'edge-fake.dwg'), 'dwg');
  assert.equal(detectFormat(file('samples/house-plan.dxf'), 'house-plan.dxf'), 'dxf', 'DXF is still DXF');
  assert.throws(() => parseDrawing(file(DWG_FIXTURES[0][1]), 'a.dwg'), (e) => e.code === 'dwg-async');
});

// ------------------------------------------------------------------ fixtures: DWG == DXF
test('DWG fixtures are reproducible from their synthetic DXF sources (tools/make_dwg_fixtures.mjs)', () => {
  for (const [src, out] of DWG_FIXTURES) assert.ok(Buffer.from(dxfToDwg(file(src)).bytes).equals(Buffer.from(file(out))), out);
});

for (const [src, out] of DWG_FIXTURES) {
  test(`DWG reads like its DXF: ${out.split('/').pop()} vs ${src.split('/').pop()}`, async () => {
    const d = parseDxf(file(src));
    const m = await open(file(out), { mode: 'direct' });
    assert.equal(m.format, 'DWG');
    assert.equal(m.version, 'AC1015');
    assert.equal(m.header.dwgVersion, 'R2000');
    assert.deepEqual(m.stats.byType, d.stats.byType, 'entity counts by type');
    assert.deepEqual(m.stats.notShown, d.stats.notShown, 'items not shown');
    assert.deepEqual(m.stats.warnings, d.stats.warnings, 'warnings');
    assert.deepEqual(layerRows(m), layerRows(d), 'layers: name, colour, on/off, frozen, line type');
    assert.deepEqual(m.units, d.units, 'units');
    assert.deepEqual(Object.keys(m.blocks).sort(), Object.keys(d.blocks).sort(), 'block names');
    for (const [k, b] of Object.entries(d.blocks)) {
      assert.deepEqual(m.blocks[k].base, b.base, `block ${k} base point`);
      assert.equal(m.blocks[k].entities.length, b.entities.length, `block ${k} contents`);
    }
    // block transforms (position, scale incl. mirroring, rotation, arrays) of every insert
    // (a DWG insert points at its block by handle, so an insert of a missing block has no name)
    const inserts = (mm) => mm.entities.filter((e) => e.type === 'insert').map((e) => [d.blocks[e.block.toUpperCase()] ? e.block : '', ...e.p, e.sx, e.sy, e.rot, e.cols, e.rows, e.dc, e.dr, e.attribs.map((a) => a.text).join('|')]);
    const ia = inserts(d), ib = inserts(m);
    assert.equal(ib.length, ia.length);
    ia.forEach((row, i) => row.forEach((v, j) => (typeof v === 'number' ? assert.ok(Math.abs(v - ib[i][j]) < 1e-9, `insert ${i} field ${j}: ${v} vs ${ib[i][j]}`) : assert.equal(ib[i][j], v))));
    // the scene: extents, every primitive (kind, layer, colour, bbox) and every text
    const sa = buildScene(d), sb = buildScene(m);
    worldExt(sa).forEach((v, i) => assert.ok(Math.abs(v - worldExt(sb)[i]) < 1e-6 * Math.max(1, Math.abs(v)), 'extents'));
    assert.deepEqual(compareItems(liveItems(sa), liveItems(sb), relTol(sa)), [], 'same items');
    assert.deepEqual(sb.texts.map((t) => t.s).sort(), sa.texts.map((t) => t.s).sort(), 'same texts');
  });
}

test('the fallback (LibreDWG’s own DXF conversion) reads the same drawings, layer states included', async () => {
  for (const [src, out] of DWG_FIXTURES) {
    const d = parseDxf(file(src));
    const m = await open(file(out), { mode: 'dxf' });
    assert.equal(m.format, 'DWG');
    assert.deepEqual(layerRows(m).map((r) => [r[0], r[2], r[3]]), layerRows(d).map((r) => [r[0], r[2], r[3]]), `${out}: layer on/off and frozen`);
    const p = compareItems(liveItems(buildScene(d)), liveItems(buildScene(m)), relTol(buildScene(d)), { subset: true });
    if (out.includes('coverage')) {
      // known gaps of this LibreDWG build's DXF writer: constant attribute text, a 2D polyline with bulges
      assert.ok(p.length <= 12, `${out}: ${p.length} differences`);
    } else assert.deepEqual(p, [], out);
  }
});

test('async entry point: parseDrawingAsync opens DWG, DXF and DGN', async () => {
  const m = await parseDrawingAsync(file(DWG_FIXTURES[0][1]), 'plan.dwg', { wasmBytes });
  assert.equal(m.format, 'DWG');
  assert.equal((await parseDrawingAsync(file('samples/bracket.dxf'), 'bracket.dxf')).format, 'DXF');
  assert.equal((await parseDrawingAsync(file('samples/site-plan.dgn'), 'site-plan.dgn')).format, 'DGN');
});

test('progress: phases and fractions are reported while a DWG is read', async () => {
  const phases = [], fr = [];
  await open(file(DWG_FIXTURES[0][1]), { onPhase: (p, f, watch) => phases.push([p, watch]), onProgress: (f) => fr.push(f) });
  assert.ok(phases.some(([p, w]) => p === 'Reading' && w === true), 'the blocking read is announced (the page watches its time)');
  assert.ok(fr.length && fr.every((f) => f >= 0 && f <= 1), 'fractions in 0..1');
});

// ------------------------------------------------------------------ robustness
test('friendly errors: the stub, wrong versions and oversize files never reach the user as crashes', async () => {
  const isFriendly = (code) => (e) => e.code === code && /save it as DXF/i.test(e.message);
  await assert.rejects(parseDrawingAsync(bytes('edge-fake.dwg'), 'edge-fake.dwg', { wasmBytes }), (e) => e.code === 'dwg-unreadable' && e.message === UNREADABLE);
  await assert.rejects(open(magic('AC1009')), isFriendly('dwg-version'));
  await assert.rejects(open(magic('AC1.50')), isFriendly('dwg-version'));
  const big = new Uint8Array(MAX_DWG_BYTES + 1);
  big.set(Buffer.from('AC1015', 'latin1'));
  await assert.rejects(open(big), isFriendly('dwg-too-large'));
  await assert.rejects(open(magic('AC1032', 4096)), (e) => e.code === 'dwg-unreadable');
});

test('damaged DWG files (truncated, corrupted bytes): a partial drawing or a friendly error, never a crash', async () => {
  const good = file('tests/fixtures/dwg-house-plan.dwg');
  const cases = [];
  for (const f of [0.3, 0.6, 0.9, 0.99]) cases.push([`truncated ${f}`, good.slice(0, Math.floor(good.length * f))]);
  const r = rng(429);
  for (let k = 0; k < 10; k++) {
    const b = good.slice();
    const n = 1 + Math.floor(r() * 40);
    for (let i = 0; i < n; i++) b[0x80 + Math.floor(r() * (b.length - 0x80))] = Math.floor(r() * 256);
    cases.push([`corrupted #${k} (${n} bytes)`, b]);
  }
  const zeroed = good.slice(); zeroed.fill(0, good.length - 600); cases.push(['object map zeroed', zeroed]);
  let opened = 0, refused = 0;
  for (const [name, b] of cases) {
    try {
      const m = await open(b);
      assert.equal(m.format, 'DWG', name);
      buildScene(m); // whatever was read can be drawn
      opened++;
    } catch (e) {
      assert.ok(e.code === 'dwg-unreadable' || e.code === 'dwg-too-large', `${name}: unexpected ${e.code || ''} ${e.stack}`);
      assert.ok(/save it as DXF/i.test(e.message), name);
      refused++;
    }
  }
  assert.equal(opened + refused, cases.length);
});

test('a broken DWG does not affect the next one (fresh WebAssembly instance per file)', async () => {
  await assert.rejects(open(bytes('edge-fake.dwg')));
  const m = await open(file('tests/fixtures/dwg-bracket.dwg'));
  assert.equal(m.stats.byType.LINE, parseDxf(file('samples/bracket.dxf')).stats.byType.LINE);
});

test('variants real files have: text stored with its terminating NUL; model space whose entity links are missing', async () => {
  for (const [src] of [DWG_FIXTURES[1], DWG_FIXTURES[5], DWG_FIXTURES[7]]) {
    const d = parseDxf(file(src));
    const sa = buildScene(d);
    for (const variant of [{ nulTerminated: true }, { unlinkModelSpace: true }]) {
      const m = await open(dxfToDwg(file(src), variant).bytes, { mode: 'direct' });
      const sb = buildScene(m);
      assert.deepEqual(compareItems(liveItems(sa), liveItems(sb), relTol(sa)), [], `${src} ${JSON.stringify(variant)}`);
      assert.deepEqual(sb.texts.map((t) => t.s).sort(), sa.texts.map((t) => t.s).sort(), 'texts without stray NULs');
    }
  }
});

// ------------------------------------------------------------------ mapping details
test('colours: R13-R2000 colour index and R2004+ colour methods map to DXF groups 62/420', () => {
  assert.deepEqual(dwgColorGroups({ index: 1, rgb: 0, method: 0 }), [[62, 1]]);
  assert.deepEqual(dwgColorGroups({ index: 256, rgb: 0, method: 0 }), [], 'BYLAYER (R2000)');
  assert.deepEqual(dwgColorGroups({ index: 0, rgb: 0, method: 0 }), [[62, 0]]);
  assert.deepEqual(dwgColorGroups({ index: 0, rgb: 0xc0000000, method: 0xc0 }), [], 'BYLAYER');
  assert.deepEqual(dwgColorGroups({ index: 0, rgb: 0xc1000000, method: 0xc1 }), [[62, 0]], 'BYBLOCK');
  assert.deepEqual(dwgColorGroups({ index: 0, rgb: 0xc3000005, method: 0xc3 }), [[62, 5]], 'index in the low byte');
  assert.deepEqual(dwgColorGroups({ index: 0, rgb: 0xc2123456, method: 0 }), [[420, 0x123456]], 'true colour (method in the top byte)');
  assert.deepEqual(dwgColorGroups({ index: 3, rgb: 0xc2123456, method: 0xc2 }), [[62, 3], [420, 0x123456]]);
  assert.deepEqual(dwgColorGroups(null), []);
});

test('saving a DWG drawing as DXF gives the same drawing back (Linework does not write DWG)', async () => {
  for (const [, out] of DWG_FIXTURES) {
    const m = await open(file(out));
    const s = buildScene(m);
    const w = writeDxf(m, { extents: worldExt(s) });
    const back = parseDxf(new TextEncoder().encode(w.text));
    assert.equal(back.version, 'AC1015');
    const zero = (x) => x.kind === KIND.CONIC && x.bbox[0] === x.bbox[2] && x.bbox[1] === x.bbox[3]; // zero-size ellipses are not written
    assert.deepEqual(compareItems(liveItems(s).filter((x) => !zero(x)), liveItems(buildScene(back)), relTol(s)), [], out);
  }
});

// ------------------------------------------------------------------ the vendored reader
test('vendored LibreDWG: built from pinned sources, no run-time code generation (CSP without unsafe-eval), provenance hashes, memory, size', () => {
  assert.deepEqual(dynamicCodeSites(glue), [], 'no eval / new Function in the glue');
  assert.ok(glue.startsWith('// LibreDWG for Linework: built by tools/build_dwg_wasm.sh'), 'glue from the build script');
  const readme = readFileSync(join(ROOT, 'vendor/libredwg/README.md'), 'utf8');
  for (const [name, buf] of [['libredwg-web.js', Buffer.from(glue)], ['libredwg-web.wasm', wasmBytes]]) {
    const sha = createHash('sha256').update(buf).digest('hex');
    assert.ok(readme.includes(`| ${name} | ${buf.length} | \`${sha}\` |`), `README records ${name}`);
  }
  assert.equal(WASM_SIZE, wasmBytes.length, 'WASM_SIZE (download progress) matches the file');
  assert.deepEqual(wasmMemory(wasmBytes), { initial: 1024, maximum: 65536 }, 'initial memory 64 MiB (not 1 GiB), grows up to 4 GiB');
  // the exact corresponding source is known (GPL-3.0): a clean tree at a pinned commit
  const version = libredwgVersion(wasmBytes);
  assert.ok(version && !/dirty/i.test(version), `LibreDWG version string of a clean source tree: ${version}`);
  assert.ok(readme.includes(`\`LibreDWG ${version}\``), 'README names the version the binary reports');
  assert.match(readme, /\| Source \| https:\/\/github\.com\/mlightcad\/libredwg-web tag `v[\d.]+`, commit `[0-9a-f]{40}`/, 'README pins the source commit');
  assert.match(readme, /\| Toolchain \| Emscripten SDK `[\d.]+` \(emsdk commit `[0-9a-f]{40}`\)/, 'README pins the toolchain');
  assert.match(readme, /-sDYNAMIC_EXECUTION=0/, 'built without run-time code generation');
  const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8');
  assert.ok(/LibreDWG/.test(notice) && /GPL-3\.0-or-later/.test(notice), 'NOTICE credits LibreDWG and its licence');
});
