// Netlist (src/tools/nets.js): every net of a drawing from one graph (traceAll), classified ends (pin, part,
// symbol, off-sheet, open), options, and the from-to CSV (RFC 4180 quoting, formula-safe cells). On the
// invented wiring sheet tools/trace_sheet.json (DGN and DXF twins), the schematic sample, and the generated
// 53k-item stress drawing (performance; LINEWORK_SKIP_PERF=1 skips it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes } from './helpers.mjs';
import { parseDrawing } from '../../src/formats/detect.js';
import { buildScene } from '../../src/scene.js';
import { makeStressDxf } from '../../samples/gen/stress.js';
import { buildNetGraph, traceNet, traceAll, pickWire, ROLE } from '../../src/tools/trace.js';
import { buildNetlist, netlistCsv, netEnd, isTrivial, isSheetRef, csvCell } from '../../src/tools/nets.js';

function open(name) {
  const scene = buildScene(parseDrawing(bytes(name), name));
  return { scene, G: buildNetGraph(scene) };
}
const brief = (n) => `${n.id} ${n.labels.join('+')} ${n.length.toFixed(2)} ${n.wires}w ${n.junctions}j: ${n.ends.map((e) => `${e.kind}:${e.text}`).join(' | ')}`;

for (const name of ['trace-sheet.dxf', 'dgn-trace.dgn']) {
  test(`netlist of ${name}: every net once, in reading order, numbered; ends classified (pin, symbol, off-sheet, open)`, () => {
    const { scene, G } = open(name);
    const nets = buildNetlist(scene, G);
    assert.deepEqual(nets.map(brief), [
      'N1 W4100 130.00 1w 0j: pin:TB2-1 | off-sheet:TO SH 2',
      'N2 W5000 200.00 2w 1j: pin:TB2-2 | off-sheet:TO SH 3 | open:open | open:open',
      'N3 W9434 282.00 5w 0j: pin:J4-1 | pin:P1-A',
      'N4 W9435 11.00 1w 0j: pin:P1-A | open:open',
      'N5 W2001 312.00 2w 0j: pin:J4-2 | pin:P1-B | symbol:K1',
      'N6  11.00 1w 0j: pin:P1-B | open:open',
      'N7 W3003 307.00 2w 1j: pin:J4-3 | pin:P1-C | pin:TB2-3',
      'N8 W7007 75.98 2w 0j: pin:J4-4 | open:open',
      'N9 W8008 91.61 2w 0j: pin:J4-5 | open:open | open:open',
      'N10 W6006 224.28 1w 0j: pin:J4-6 | pin:P1-F',
    ]);
    // the fields of an end, in drawing coordinates
    const j4 = nets[2].ends[0];
    assert.deepEqual({ ...j4, ent: typeof j4.ent }, { kind: 'pin', text: 'J4-1', ref: 'J4', pin: '1', part: name.endsWith('dxf') ? 'J4CONN' : 'CONN', label: '', x: 34, y: 160, ent: 'number' });
    assert.ok(j4.ent >= 0, 'the connector entity');
    const k1 = nets[4].ends[2];
    assert.deepEqual([k1.kind, k1.part, k1.label], ['symbol', 'circle', 'K1']);
    const off = nets[0].ends[1];
    assert.deepEqual([off.kind, off.label, off.ent], ['off-sheet', 'TO SH 2', -1]);
    // the same nets as tracing each one from its seed; every visible wire in exactly one net
    for (const n of nets) {
      const t = traceNet(G, n.seed);
      assert.deepEqual([t.labels.map((l) => l.s), t.count, t.ends.length], [n.labels, n.wires, n.ends.length], n.id);
      assert.ok(Math.abs(t.length - n.length) < 1e-9);
      const [ox, oy] = scene.origin;
      assert.deepEqual(n.bbox, [t.bbox[0] + ox, t.bbox[1] + oy, t.bbox[2] + ox, t.bbox[3] + oy]);
      assert.deepEqual(n.entities, [...new Set(t.wires.map((p) => scene.ent[p]))].sort((a, b) => a - b));
    }
    const all = traceAll(G), wires = all.flatMap((n) => n.wires);
    assert.equal(new Set(wires).size, wires.length, 'no wire in two nets');
    assert.equal(wires.length, G.role.filter((r) => r === ROLE.WIRE).length, 'every wire in a net');
    assert.equal(buildNetlist(scene, G, { trivial: true }).length, all.length);
    assert.equal(all.length - nets.length, all.filter((n) => n.segments <= 1 && !n.labels.length && n.ends.every((e) => e.kind === 'open')).length, 'stray single lines left out by default');
    assert.deepEqual(buildNetlist(scene).map(brief), nets.map(brief), 'the graph is made when not given');
  });
}

test('netlist options: crossings and through pins join nets; hidden layers are left out; patterns for references to other sheets', () => {
  const { scene, G } = open('trace-sheet.dxf');
  const base = buildNetlist(scene, G), [ox, oy] = scene.origin;
  const pins = buildNetlist(scene, G, { throughPins: true });
  assert.ok(pins.some((n) => n.labels.join() === 'W9434,W9435'), 'through the connector P1');
  assert.ok(pins.length < base.length);
  const cross = buildNetlist(scene, G, { crossings: true });
  assert.ok(cross.length < base.length && cross.some((n) => n.wires >= 17), 'crossings connect');
  const w = pickWire(G, 100 - ox, 160 - oy, 0.5), hide = scene.layer[w];
  const vis = buildNetlist(scene, G, { isVisible: (li) => li !== hide, trivial: true });
  assert.ok(!vis.some((n) => n.labels.includes('W9434')), 'the hidden layer\'s wires are not in any net');
  const own = buildNetlist(scene, G, { sheetRefs: ['^NEVER$'] });
  assert.deepEqual(own[0].ends.map((e) => `${e.kind}:${e.text}`), ['pin:TB2-1', 'open:open (TO SH 2)'], 'own patterns (sources): "TO SH 2" is then a plain note');
  assert.ok(isSheetRef('CONT ON SHEET 4') && isSheetRef('SEE DWG 1234-56') && !isSheetRef('SHEET 1 OF 4') && !isSheetRef(''));
  assert.ok(isSheetRef('GO 7', [/GO \d/g]) && isSheetRef('GO 7', [/GO \d/g]), 'a global RegExp is used from the start each time');
  // ends of every kind from traceNet's ends: a part without a pin text, a cell whose pin is a sheet reference
  const e0 = { x: 1, y: 2, ent: 7, part: 3 };
  assert.deepEqual(netEnd(scene, { ...e0, kind: 'cell', name: 'GND', pin: '', ref: '' }), { kind: 'part', text: 'GND', ref: '', pin: '', part: 'GND', label: '', x: 1 + ox, y: 2 + oy, ent: 7 });
  assert.equal(netEnd(scene, { ...e0, kind: 'cell', name: 'TERM', pin: 'TB1-4', ref: 'TB1' }).text, 'TB1-4', 'a pin text that starts with the reference stays');
  assert.deepEqual([netEnd(scene, { ...e0, kind: 'cell', name: 'OFFPAGE', pin: 'SH 3', ref: '' })].map((e) => [e.kind, e.text, e.part]), [['off-sheet', 'SH 3', 'OFFPAGE']]);
  assert.equal(netEnd(scene, { ...e0, kind: 'open', label: 'SPARE' }).text, 'open (SPARE)');
  assert.ok(isTrivial({ segments: 1, labels: [], ends: [{ kind: 'open' }, { kind: 'open' }] }) && !isTrivial({ segments: 1, labels: [], ends: [{ kind: 'off-sheet' }] }));
});

test('from-to CSV: a header, one row per other end, RFC 4180 quoting, cells a spreadsheet would run as a formula start with an apostrophe', () => {
  const { scene, G } = open('trace-sheet.dxf');
  const csv = netlistCsv(buildNetlist(scene, G));
  const rows = csv.split('\r\n');
  assert.equal(rows[0], 'net,labels,from,to,length,wires,junctions');
  assert.deepEqual(rows.slice(1, 5), ['N1,W4100,TB2-1,TO SH 2,130,1,0', 'N2,W5000,TB2-2,TO SH 3,200,2,1', 'N2,W5000,TB2-2,open,200,2,1', 'N2,W5000,TB2-2,open,200,2,1']);
  assert.ok(rows.includes('N10,W6006,J4-6,P1-F,224.283,1,0'), 'length to 3 decimals');
  assert.equal(rows.at(-1), '', 'every row ends with CRLF');
  // the schematic sample: +24V is a label (a formula to a spreadsheet)
  const s = open('schematic.dxf');
  assert.ok(netlistCsv(buildNetlist(s.scene, s.G)).includes("\r\nN1,'+24V / W101 / W102 / W103,X1,X2,"), 'formula-safe label cell');
  // quoting and formula-safe cells
  const net = (labels, ends) => ({ id: 'N1', labels, length: 12.34567, wires: 2, junctions: 1, ends: ends.map((text) => ({ text })) });
  const one = netlistCsv([net(['A,B', 'say "hi"'], ['J1-1', 'line1\nline2', '=SUM(A1)', '@cmd', '-5V', '+5V', '\tTAB'])], { dec: 2, eol: '\n', header: false });
  const L = '"A,B / say ""hi"""'; // (a comma and quotes: quoted, quotes doubled)
  assert.equal(one, [`N1,${L},J1-1,"line1\nline2",12.35,2,1`, `N1,${L},J1-1,'=SUM(A1),12.35,2,1`, `N1,${L},J1-1,'@cmd,12.35,2,1`,
    `N1,${L},J1-1,'-5V,12.35,2,1`, `N1,${L},J1-1,'+5V,12.35,2,1`, `N1,${L},J1-1,'\tTAB,12.35,2,1`, ''].join('\n'));
  assert.equal(netlistCsv([net([], ['J1-1'])], { header: false }), 'N1,,J1-1,,12.346,2,1\r\n', 'one end: an empty "to"');
  assert.equal(netlistCsv([net([], [])], { header: false, labelSep: '|' }), 'N1,,,,12.346,2,1\r\n', 'no ends');
  assert.deepEqual(['=1', 'a"b', 'x\ry', '', null, 7, 'A-1'].map(csvCell), ["'=1", '"a""b"', '"x\ry"', '', '', '7', 'A-1']);
  assert.equal(csvCell('\rX'), '"\'\rX"', 'apostrophe first, then quoted');
});

const perfSkip = process.env.LINEWORK_SKIP_PERF ? 'LINEWORK_SKIP_PERF is set' : false;
test('performance: the netlist of the 53k-item stress drawing (31,501 nets) from one graph < 3 s; the CSV < 1.5 s', { skip: perfSkip }, () => {
  const scene = buildScene(parseDrawing(new TextEncoder().encode(makeStressDxf().text), 'stress.dxf'));
  const G = buildNetGraph(scene), ms = [], csvMs = [];
  let nets, csv;
  for (let k = 0; k < 3; k++) {
    let t = performance.now();
    nets = buildNetlist(scene, G, { trivial: true });
    ms.push(performance.now() - t);
    t = performance.now();
    csv = netlistCsv(nets);
    csvMs.push(performance.now() - t);
  }
  const best = Math.min(...ms);
  console.log(`  # 53k netlist: ${nets.length} nets in ${ms.map((v) => v.toFixed(0)).join(' / ')} ms (graph ${G.ms.toFixed(0)} ms), CSV ${Math.min(...csvMs).toFixed(0)} ms, ${(csv.length / 1024).toFixed(0)} KB`);
  assert.equal(nets.length, 31501);
  assert.equal(nets.reduce((n, x) => n + x.wires, 0) >= 31501, true);
  assert.ok(best < 3000, `netlist ${best.toFixed(0)} ms (tracing every net on its own took 6 s before 0.5.3)`);
  assert.ok(Math.min(...csvMs) < 1500, 'CSV ms');
});
