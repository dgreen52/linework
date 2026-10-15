#!/usr/bin/env node
// Synthetic DWG fixtures: converts the repo's own synthetic DXF samples/fixtures to DWG R2000
// (AC1015) with tools/dwg-r2000.mjs. No real drawings are involved.
//   node tools/make_dwg_fixtures.mjs          (writes tests/fixtures/*.dwg)
// The unit tests open each DWG with LibreDWG (vendor/libredwg) and compare it with the same
// drawing opened as DXF.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeDxfBytes } from '../src/formats/dxf.js';
import { writeDwgR2000 } from './dwg-r2000.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Group-code accessor for one DXF record (lookups stop at an embedded object, code 101). */
export class G {
  constructor(type, codes, vals) {
    this.type = type; this.codes = codes; this.vals = vals;
    const end = codes.indexOf(101);
    this.end = end < 0 ? codes.length : end;
  }
  idx(code) { for (let k = 0; k < this.end; k++) if (this.codes[k] === code) return k; return -1; }
  has(code) { return this.idx(code) >= 0; }
  s(code, def = '') { const k = this.idx(code); return k < 0 ? def : this.vals[k]; }
  f(code, def = 0) { const k = this.idx(code); if (k < 0) return def; const v = parseFloat(this.vals[k]); return Number.isFinite(v) ? v : def; }
  i(code, def = 0) { const k = this.idx(code); if (k < 0) return def; const v = parseInt(this.vals[k], 10); return Number.isFinite(v) ? v : def; }
  all(code) { const out = []; for (let k = 0; k < this.end; k++) if (this.codes[k] === code) out.push(this.vals[k]); return out; }
}

/** DXF text -> { header, layers, ltypes, styles, blocks: [{ g, entities }], entities } of raw records. */
export function readRawDxf(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (Number.isNaN(code)) { i--; continue; }
    pairs.push([code, lines[i + 1].replace(/\r$/, '')]);
  }
  const doc = { header: {}, layers: [], ltypes: [], styles: [], blocks: [], entities: [] };
  // records: split at code 0
  const recs = [];
  let cur = null;
  for (const [c, v] of pairs) {
    if (c === 0) { cur = { type: v.trim().toUpperCase(), codes: [], vals: [] }; recs.push(cur); continue; }
    if (cur) { cur.codes.push(c); cur.vals.push(v); }
  }
  let section = '', table = '', block = null;
  for (const r of recs) {
    const g = new G(r.type, r.codes, r.vals);
    if (r.type === 'SECTION') { section = g.s(2, '').trim().toUpperCase(); if (section === 'HEADER') readHeader(r, doc.header); continue; }
    if (r.type === 'ENDSEC') { section = ''; continue; }
    if (r.type === 'EOF') break;
    if (section === 'TABLES') {
      if (r.type === 'TABLE') { table = g.s(2, '').trim().toUpperCase(); continue; }
      if (r.type === 'ENDTAB') { table = ''; continue; }
      if (table === 'LAYER' && r.type === 'LAYER') doc.layers.push(g);
      else if (table === 'LTYPE' && r.type === 'LTYPE') doc.ltypes.push(g);
      else if (table === 'STYLE' && r.type === 'STYLE') doc.styles.push(g);
    } else if (section === 'BLOCKS') {
      if (r.type === 'BLOCK') { block = { g, entities: [] }; doc.blocks.push(block); continue; }
      if (r.type === 'ENDBLK') { block = null; continue; }
      if (block) block.entities.push(g);
    } else if (section === 'ENTITIES') {
      doc.entities.push(g);
    } else if (!section && r.type !== 'SECTION') {
      doc.entities.push(g); // entities-only files
    }
  }
  return doc;
}

function readHeader(r, H) {
  let name = null;
  for (let k = 0; k < r.codes.length; k++) {
    if (r.codes[k] === 9) { name = r.vals[k].trim().toUpperCase(); H[name] = {}; continue; }
    if (name) H[name][r.codes[k]] = r.vals[k];
  }
}

/** DXF bytes -> DWG bytes: R2000, or R2004 with opts.version 'R2004' (opts: test variants, see writeDwgR2000). */
export function dxfToDwg(bytes, opts = {}) {
  const { text } = decodeDxfBytes(bytes);
  return writeDwgR2000(readRawDxf(text), opts);
}

// Fixtures: [source DXF, output DWG]. Sources are the repo's synthetic samples + edge fixtures.
export const DWG_FIXTURES = [
  ['samples/house-plan.dxf', 'tests/fixtures/dwg-house-plan.dwg'],
  ['samples/bracket.dxf', 'tests/fixtures/dwg-bracket.dwg'],
  ['samples/schematic.dxf', 'tests/fixtures/dwg-schematic.dwg'],
  ['tests/fixtures/edge-nested-mirror.dxf', 'tests/fixtures/dwg-nested-mirror.dwg'],
  ['tests/fixtures/edge-far-coords.dxf', 'tests/fixtures/dwg-far-coords.dwg'],
  ['tests/fixtures/edge-crlf-cp1252.dxf', 'tests/fixtures/dwg-cp1252.dwg'],
  ['tests/fixtures/edge-zero-length.dxf', 'tests/fixtures/dwg-zero-length.dwg'],
  ['tests/fixtures/edge-dwg-coverage.dxf', 'tests/fixtures/dwg-coverage.dwg'],
];
// The same drawings as DWG R2004 (paged, compressed sections), plus true colours (R2004+ only): [source, output, version].
export const DWG_FIXTURES_R2004 = [...DWG_FIXTURES, ['tests/fixtures/edge-truecolor.dxf', 'tests/fixtures/dwg-truecolor.dwg']]
  .map(([src, out]) => [src, out.replace(/\/dwg-/, '/dwg2004-'), 'R2004']);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [src, out, version] of [...DWG_FIXTURES, ...DWG_FIXTURES_R2004]) {
    const { bytes, notes } = dxfToDwg(readFileSync(join(ROOT, src)), { version });
    writeFileSync(join(ROOT, out), bytes);
    console.log(`${out}: ${bytes.length} bytes${notes.length ? ' — ' + notes.join(' ') : ''}`);
  }
}
