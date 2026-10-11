// The library entry (lib/core.js, package export "linework/core"): everything it promises is there and
// works in Node, and it stays out of the web app (not imported by src/, not precached, not deployed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ROOT, bytes } from './helpers.mjs';
import * as core from 'linework/core';

const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

test('core: the package export resolves to lib/core.js and names the version and the DWG reader', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./core'], './lib/core.js');
  assert.equal(core.VERSION, pkg.version);
  assert.ok(core.DWG_WASM_URL instanceof URL && statSync(core.DWG_WASM_URL).size > 1e6, 'DWG reader wasm is where DWG_WASM_URL points');
  for (const name of ['detectFormat', 'parseDrawing', 'parseDrawingAsync', 'buildScene', 'findTexts', 'describeScene', 'diffScenes',
    'writeDxf', 'writeDgn', 'buildSvg', 'printLayout', 'cssColor', 'entityItems', 'entityInfo', 'typeName', 'queryRect', 'primPoints',
    'measure', 'bulgePolylineLength', 'hashBytes', 'flatEntities', 'FormatError']) assert.equal(typeof core[name], 'function', name);
});

test('core: stays out of the web app (no src/ import, not in the service worker, not deployed)', async () => {
  for (const f of walk(join(ROOT, 'src'))) assert.ok(!/lib\/core|linework\/core/.test(readFileSync(f, 'utf8')), `${relative(ROOT, f)} imports the library entry`);
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  assert.ok(!sw.includes('lib/'), 'sw.js does not cache lib/');
  const { distEntries } = await import('../../tools/make_dist.mjs');
  for (const [, to] of distEntries()) assert.ok(!to.split(sep).join('/').startsWith('lib/'), `dist contains ${to}`);
});

test('core: parse, scene, find (literal and RegExp), compare and both writers run through the entry', () => {
  const model = core.parseDrawing(bytes('house-plan.dxf'), 'house-plan.dxf');
  const scene = core.buildScene(model, { fileName: 'house-plan.dxf' });
  assert.ok(scene.n > 0 && scene.texts.length > 0);
  const word = scene.texts[0].s.split(/\s+/)[0];
  const lit = core.findTexts(scene, word);
  assert.ok(lit.length >= 1);
  const rx = core.findTexts(scene, new RegExp('^' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  assert.ok(rx.length >= 1 && rx.every((h) => h.s.toLowerCase().startsWith(word.toLowerCase())), 'a RegExp query is used as it is');
  assert.equal(core.findTexts(scene, /zz-no-such-text-zz/).length, 0);
  const d = core.describeScene(scene, { q: core.quantum(scene) });
  const r = core.diffScenes(d, d);
  assert.equal(r.changes.length, 0);
  assert.ok(core.writeDxf(model).text.includes('SECTION'));
  assert.ok(core.writeDgn(model).bytes.length > 0);
});

test('core: buildSvg themes (paper by default, dark: foreground white) and an optional frame', () => {
  const model = core.parseDrawing(bytes('house-plan.dxf'), 'house-plan.dxf');
  const scene = core.buildScene(model);
  const L = core.printLayout({ sheet: 'a4', orientation: 'landscape', scale: 'Fit', rect: scene.extents, units: scene.units });
  const paper = core.buildSvg(scene, L);
  const dark = core.buildSvg(scene, L, { theme: 'dark' });
  assert.equal(paper, core.buildSvg(scene, L, { theme: 'paper' }), 'paper is the default');
  assert.ok(/stroke="#000000"/.test(paper) && !/stroke="#ffffff"/.test(paper), 'foreground is black on paper');
  assert.ok(/stroke="#ffffff"/.test(dark), 'foreground is white on dark');
  assert.ok(/<rect x="\.15"[^>]*stroke="#000"/.test(paper) && /<rect x="\.15"[^>]*stroke="#fff"/.test(dark), 'frame follows the theme');
  const bare = core.buildSvg(scene, L, { frame: false });
  assert.ok(!/<rect x="\.15"/.test(bare) && bare.endsWith('</svg>'), 'frame: false leaves the border out');
  const monoDark = core.buildSvg(scene, L, { theme: 'dark', mono: true });
  const inks = new Set([...monoDark.matchAll(/(?:stroke|fill)="(#[0-9a-f]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...inks], ['#fff'], 'mono on dark draws everything white');
});
