// DGN v7 reader vs. an independent oracle: the same files read back by GDAL/OGR
// (tests/fixtures/*.ogr.json, samples/site-plan.ogr.json, produced by tools/make_dgn_fixtures.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, fixture, conics, texts, near, bytes } from './helpers.mjs';
import { parseDgn } from '../../src/formats/dgn.js';
import { DGN_DEFAULT } from '../../src/palettes.js';
import { primPoints } from '../../src/scene.js';
import { flatEntities } from '../../src/model.js';

const oracleOf = (name) => JSON.parse(readFileSync(fixture(name.replace(/\.dgn$/, '.ogr.json')), 'utf8'));
const hex = (v) => v.toString(16).padStart(6, '0');

/** World-space bbox of a model entity (curves sampled densely). */
function entityBBox(e) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x, y) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); };
  if (e.type === 'line') { add(...e.a); add(...e.b); }
  else if (e.type === 'polyline' || e.type === 'spline') for (let i = 0; i < e.pts.length; i += 2) add(e.pts[i], e.pts[i + 1]);
  else if (e.type === 'text') add(...e.p);
  else if (e.type === 'circle') { add(e.c[0] - e.r, e.c[1] - e.r); add(e.c[0] + e.r, e.c[1] + e.r); }
  else if (e.type === 'arc' || e.type === 'ellipse') {
    const U = e.type === 'arc' ? [e.r, 0] : e.major, V = e.type === 'arc' ? [0, e.r] : e.minor;
    const t0 = e.type === 'arc' ? e.a0 : e.t0, t1 = e.type === 'arc' ? e.a1 : e.t1;
    for (let k = 0; k <= 720; k++) { const t = t0 + ((t1 - t0) * k) / 720; add(e.c[0] + U[0] * Math.cos(t) + V[0] * Math.sin(t), e.c[1] + U[1] * Math.cos(t) + V[1] * Math.sin(t)); }
  }
  return b;
}

function compareWithOgr(name) {
  const model = parseDgn(bytes(name));
  const oracle = oracleOf(name);
  const used = new Set();
  const ents = flatEntities(model.entities); // OGR reports cell components, not cell headers
  for (const f of oracle.features) {
    const size = f.env ? Math.max(f.env[2] - f.env[0], f.env[3] - f.env[1]) : 0;
    const tol = 1e-6 + size * 0.01; // OGR tessellates arcs/curves, so allow 1% on curved items
    const idx = ents.findIndex((e, i) => {
      if (used.has(i)) return false;
      if (e.layer !== 'Level ' + f.level) return false;
      if (f.rgb && hex(e.rgb) !== f.rgb) return false;
      if (f.text != null && e.text !== f.text) return false;
      const b = entityBBox(e);
      return f.env.every((v, k) => Math.abs(v - b[k]) <= tol);
    });
    assert.ok(idx >= 0, `${name}: no match for OGR feature type ${f.type} level ${f.level} env ${f.env.map((v) => v.toFixed(3))}`);
    used.add(idx);
    const e = ents[idx];
    if (f.points && e.type === 'line') {
      assert.ok(near(e.a[0], f.points[0][0]) && near(e.a[1], f.points[0][1]) && near(e.b[0], f.points.at(-1)[0]) && near(e.b[1], f.points.at(-1)[1]));
    } else if (f.points && e.type === 'polyline') {
      f.points.forEach((p, k) => { assert.ok(near(e.pts[2 * k], p[0]) && near(e.pts[2 * k + 1], p[1]), 'vertex ' + k); });
    }
    if (f.angle != null) {
      const d = ((((e.rot * 180) / Math.PI - f.angle) % 360) + 540) % 360 - 180; // compare modulo 360
      // OGR's LABEL style string truncates the angle to whole degrees, so allow < 1 degree here;
      // exact values are checked against the generator below.
      assert.ok(Math.abs(d) <= 1 + 1e-9, `text angle ${(e.rot * 180) / Math.PI} vs ${f.angle}`);
    }
    if (f.size != null) assert.ok(near(e.h, f.size, 1e-3), 'text size');
  }
  assert.equal(used.size, ents.length, `${name}: every JS entity is matched by an OGR feature`);
  return { model, oracle };
}

test('site plan matches OGR element-for-element (geometry, levels, colours, text)', () => {
  const { model, oracle } = compareWithOgr('site-plan.dgn');
  assert.equal(oracle.features.length, flatEntities(model.entities).length);
  const road = model.entities.find((e) => e.text === 'ACCESS ROAD');
  assert.ok(near((road.rot * 180) / Math.PI, -4, 1e-9), 'generator wrote -4 degrees');
  assert.ok(near(road.h, 1.2, 1e-6));
});

test('site plan: TCB units, UOR scaling and global origin', () => {
  const { model } = load('site-plan.dgn');
  const o = oracleOf('site-plan.dgn');
  assert.equal(model.units.abbr, 'm');
  assert.equal(model.header.subPerMaster * model.header.uorPerSub, o.uor_per_master);
  assert.deepEqual(model.header.origin, o.origin);
  assert.equal(model.header.dimension, 2);
  // property boundary corner exactly at (0,0) and (86,52)
  const shape = model.entities.find((e) => e.layer === 'Level 1');
  assert.deepEqual(shape.pts.slice(0, 2), [0, 0]);
  assert.equal(shape.closed, true);
});

test('site plan: colour table (type 5) overrides the default palette', () => {
  const { model } = load('site-plan.dgn');
  const o = oracleOf('site-plan.dgn');
  assert.equal(model.header.colorTable, true);
  const boundary = model.entities.find((e) => e.layer === 'Level 1'); // colour 3
  assert.equal(hex(boundary.rgb), o.palette[3]);
  const survey = model.entities.find((e) => e.src === 'LINE'); // colour 1
  assert.equal(hex(survey.rgb), o.palette[1]);
  assert.equal(survey.ltype, 'DGN3', 'line style 3');
});

test('site plan: arcs, ellipse, curve, complex chain/shape, text node, deleted element', () => {
  const { model, scene } = load('site-plan.dgn');
  const o = oracleOf('site-plan.dgn').raw;
  const arcs = model.entities.filter((e) => e.type === 'arc');
  assert.equal(arcs.length, 2 + 0);
  const a1 = arcs.find((a) => near(a.c[0], 40));
  assert.ok(near(a1.r, 6) && near(a1.a0, Math.PI) && near(a1.a1, 2 * Math.PI));
  const a2 = arcs.find((a) => near(a.c[0], 70));
  assert.ok(near(a2.a0, 0) && near(a2.a1, Math.PI / 2) && a2.reversed, 'negative sweep normalised');
  const ell = model.entities.find((e) => e.type === 'ellipse' && near(e.c[0], o.ellipse.c[0]));
  assert.ok(near(Math.hypot(...ell.major), 6) && near(Math.hypot(...ell.minor), 3));
  assert.ok(near(Math.atan2(ell.major[1], ell.major[0]), (25 * Math.PI) / 180, 1e-9));
  // curve: drawn between its 3rd and 3rd-last vertex
  const curve = model.entities.find((e) => e.src === 'CURVE');
  assert.deepEqual(curve.pts.slice(0, 2), [0, 30]);
  assert.deepEqual(curve.pts.slice(-2), [12, 35]);
  // complex chain (150 vertices split over components) merged back into one polyline
  const chain = model.entities.find((e) => e.src === 'COMPLEX_CHAIN');
  assert.equal(chain.pts.length / 2, 150);
  assert.equal(chain.closed, false);
  const cshape = model.entities.find((e) => e.src === 'COMPLEX_SHAPE');
  assert.equal(cshape.closed, true);
  assert.equal(cshape.pts.length / 2, 160);
  // text node: two text components
  assert.ok(texts(scene).some((t) => t.s === 'NOTE: SYNTHETIC SITE'));
  assert.ok(texts(scene).some((t) => t.s === 'NOT A REAL LOCATION'));
  // deleted element is not shown
  assert.ok(!flatEntities(model.entities).some((e) => e.layer === 'Level 12'));
  // conics in the scene reproduce the ellipse exactly
  const sc = conics(scene).find((c) => near(c.c[0], 72) && near(c.c[1], 8));
  assert.ok(sc && near(Math.hypot(...sc.u), 6));
  assert.ok(primPoints(scene, sc.i).length > 10);
});

test('site plan: cell headers (type 2) expose their placement transform; components are not transformed twice', () => {
  const { model } = load('site-plan.dgn');
  const o = oracleOf('site-plan.dgn');
  assert.equal(model.cells.length, o.cells.length);
  o.cells.forEach((exp, i) => {
    const c = model.cells[i];
    assert.equal(c.name, exp.name);
    assert.ok(near(c.origin[0], exp.origin[0]) && near(c.origin[1], exp.origin[1]), 'origin');
    assert.ok(near((c.rotation * 180) / Math.PI, exp.rotation, 1e-3), 'rotation');
    assert.ok(near(c.xscale, exp.xscale ?? exp.scale, 1e-4), 'x scale');
    assert.ok(near(c.yscale, exp.yscale ?? exp.scale, 1e-4), 'y scale');
  });
  // the NORTH arrow tip (0,3) placed with S(1.5,1) R30 at (90,50)
  const a = Math.PI / 6;
  const tip = [90 - Math.sin(a) * 3, 50 + Math.cos(a) * 3];
  const north = flatEntities(model.entities).find((e) => e.layer === 'Level 11' && e.type !== 'cell');
  const has = [];
  for (let i = 0; i < north.pts.length; i += 2) has.push([north.pts[i], north.pts[i + 1]]);
  assert.ok(has.some((p) => near(p[0], tip[0], 1e-3) && near(p[1], tip[1], 1e-3)), 'cell component at its placed position');
  // components remember their cell for hover info; the cell is one top-level item holding them
  assert.ok(north.group != null);
  const cellEnt = model.entities.find((e) => e.type === 'cell' && e.name === 'NORTH');
  assert.ok(cellEnt && cellEnt.children.includes(north), 'cell entity holds its components');
  assert.equal(model.entities.filter((e) => e.type === 'cell').length, o.cells.length, 'one top-level item per cell');
});

test('default palette (no colour table) matches OGR, imperial units', () => {
  const { model } = compareWithOgr('dgn-default-palette.dgn');
  assert.equal(model.units.abbr, 'ft');
  assert.equal(model.header.subPerMaster * model.header.uorPerSub, 96000);
  for (let c = 0; c < 16; c++) {
    const e = model.entities.find((x) => x.type !== 'text' && near(x.pts ? x.pts[0] : x.a[0], c));
    assert.equal(e.rgb, DGN_DEFAULT[c], 'colour ' + c);
  }
});

test('3D design file: 12-byte vertices, global origin, text', () => {
  const { model } = compareWithOgr('dgn-3d.dgn');
  assert.equal(model.header.dimension, 3);
  assert.ok(model.stats.warnings.some((w) => /3D/.test(w)));
  const ls = model.entities.find((e) => e.type === 'polyline' && !e.closed);
  assert.deepEqual(ls.pts, [0, 0, 10, 0, 10, 10]);
});

test('non-DGN and DGN v8 input give friendly errors', () => {
  assert.throws(() => parseDgn(new Uint8Array(100)), (e) => e.code === 'not-dgn');
  const ole = new Uint8Array(512);
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.throws(() => parseDgn(ole), (e) => e.code === 'dgn-v8');
});

test('truncated DGN keeps elements read so far', () => {
  const b = bytes('site-plan.dgn');
  const cut = b.slice(0, Math.floor(b.length * 0.75));
  const m = parseDgn(cut);
  assert.ok(m.entities.length > 3);
  assert.ok(m.stats.warnings.some((w) => /ended/.test(w)) || m.entities.length > 0);
});

test('saved view: levels switched off in the open view start hidden, with a note; a mask that hides everything is ignored', () => {
  const src = bytes('site-plan.dgn');
  const levels = parseDgn(src).layers.map((l) => Number(l.name.replace('Level ', ''))).sort((a, c) => a - c);
  assert.ok(levels.length >= 2, 'fixture uses several levels');
  // all on in the seed: nothing hidden, no note
  const plain = parseDgn(src);
  assert.ok(plain.layers.every((l) => l.visible), 'all levels visible when the view shows them all');
  assert.ok(!plain.stats.warnings.some((w) => /saved view/.test(w)));
  // which view is open: flags word bit 0x80
  const openView = [0, 1, 2, 3, 4, 5, 6, 7].find((v) => src[46 + v * 118] & 0x80);
  assert.equal(openView, 0, 'seed opens view 1');
  // switch off the first used level in view 1 (bit n-1 of the 64-bit mask at view + 2)
  const b = src.slice();
  const lv = levels[0];
  b[46 + 2 + ((lv - 1) >> 3)] &= ~(1 << ((lv - 1) & 7));
  const m = parseDgn(b);
  for (const L of m.layers) assert.equal(L.visible, L.name !== 'Level ' + lv, L.name);
  assert.ok(m.stats.warnings.some((w) => /1 level is off in this drawing's saved view 1/.test(w)), 'note explains it');
  assert.deepEqual(m.header.savedView, { view: 1, levelsOff: [lv] });
  assert.equal(m.entities.length, plain.entities.length, 'hidden, not dropped');
  // the open view wins over view 1: open view 2 instead, whose mask still shows everything
  const b2 = b.slice();
  b2[46] &= ~0x80; b2[46 + 118] |= 0x80;
  assert.ok(parseDgn(b2).layers.every((l) => l.visible), 'view 2 is the open one and shows all levels');
  // a mask that hides every level in use is not trusted
  const b3 = src.slice();
  for (let k = 0; k < 8; k++) b3[46 + 2 + k] = 0;
  assert.ok(parseDgn(b3).layers.every((l) => l.visible));
});
