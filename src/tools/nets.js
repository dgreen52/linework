// Netlist (pure, DOM-free): every net of a drawing, as the Trace tool finds them (src/tools/trace.js: wires
// joined at shared ends, T-junctions and junction dots; crossings and through pins on request), with its
// labels, length and ends classified — a pin (J1-4), a part, a symbol, a reference to another sheet, an open
// end — and the from-to wire list as CSV. Exported by the library entry, for the hosts built on it.
import { buildNetGraph, traceAll } from './trace.js';
import { compilePatterns, XREF_DEFAULT } from './sheets.js';
import { csvCell } from './csv.js';

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
const XREFS = compilePatterns(XREF_DEFAULT).res;
const patterns = (p) => (!p ? XREFS : p.map((x) => (x instanceof RegExp ? x : compilePatterns([x]).res[0])).filter(Boolean));

/** A text that refers to another sheet ("SHEET 2", "TO SH 3", "SEE DWG 1234-56"); res: other patterns (RegExps). */
export function isSheetRef(s, res = XREFS) {
  return !!s && res.some((re) => { re.lastIndex = 0; return re.test(s); });
}

/**
 * One end of a net (an end as traceNet gives it, scene coordinates) as the netlist lists it, in drawing
 * coordinates: { kind: 'pin' | 'part' | 'symbol' | 'off-sheet' | 'open', text (the end in one string: J1-4,
 * TB1-3, K1, "SHEET 2", open (NOTE)), ref (the cell's reference), pin (its pin text), part (cell / block name,
 * or circle / shape for a symbol), label (the text by a symbol or an open end), x, y, ent (cell, block or
 * symbol entity; -1 for an open end) }.
 */
export function netEnd(scene, e, res = XREFS) {
  const [ox, oy] = scene.origin, x = e.x + ox, y = e.y + oy, ref = e.ref || '', pin = e.pin || '';
  const end = (kind, text, part, label, ent) => ({ kind, text, ref, pin, part, label, x, y, ent });
  if (e.kind === 'cell') {
    const sheet = isSheetRef(pin, res) ? pin : isSheetRef(ref, res) ? ref : '';
    if (sheet) return end('off-sheet', sheet, e.name, sheet, e.ent);
    const text = ref && pin ? (norm(pin).startsWith(norm(ref)) ? pin : `${ref}-${pin}`) : pin || ref || e.name;
    return end(pin ? 'pin' : 'part', text, e.name, '', e.ent);
  }
  const label = e.label || '';
  if (e.kind === 'shape') { const shape = e.name.toLowerCase(); return end('symbol', label || shape, shape, label, scene.ent[e.part]); }
  if (isSheetRef(label, res)) return end('off-sheet', label, '', label, -1);
  return end('open', label ? `open (${label})` : 'open', '', label, -1);
}

/** A net with nothing to say: one segment, no label, only plain open ends (a stray line). */
export const isTrivial = (net) => net.segments <= 1 && !net.labels.length && net.ends.every((e) => e.kind === 'open');

/**
 * Every net of a drawing, in reading order (top left first), numbered N1, N2…: [{ id, labels: [text],
 * length (drawing units, wires as drawn, arcs exact), wires (as drawn), segments, junctions (dots), ends:
 * [netEnd], bbox (drawing coordinates), seed (a wire of the net: traceNet(G, seed, opts) traces it again),
 * entities (the entity indices of its wires) }]. G: the graph of the scene (buildNetGraph; made here when
 * null, with opts.tol). opts: { crossings, throughPins, isVisible(layer), tol, trivial (also list stray
 * single lines: one segment, no label, open ends; default false), sheetRefs (patterns of references to
 * other sheets: RegExps or sources; default the sheet-set defaults) }.
 */
export function buildNetlist(scene, G = null, opts = {}) {
  const g = G || buildNetGraph(scene, { tol: opts.tol }), res = patterns(opts.sheetRefs), [ox, oy] = scene.origin, out = [];
  for (const n of traceAll(g, opts)) {
    const b = n.bbox, net = {
      id: '', labels: n.labels.map((l) => l.s), length: n.length, wires: n.count, segments: n.segments, junctions: n.junctions,
      ends: n.ends.map((e) => netEnd(scene, e, res)), bbox: [b[0] + ox, b[1] + oy, b[2] + ox, b[3] + oy], seed: n.seed,
      entities: [...new Set(n.wires.map((p) => scene.ent[p]))].sort((a, c) => a - c),
    };
    if (!opts.trivial && isTrivial(net)) continue;
    net.id = `N${out.length + 1}`;
    out.push(net);
  }
  return out;
}

export { csvCell }; // (from ./csv.js, shared with the measurement list)

/**
 * The netlist as a from-to wire list (CSV, RFC 4180): a header, then one row from the first end of each
 * net to each of its other ends (a net with one end: an empty "to") — net, labels, from, to, length, wires,
 * junctions. opts: { dec (decimals of the length, default 3), eol ('\r\n'), labelSep (' / '), header (true) }.
 */
export function netlistCsv(nets, opts = {}) {
  const dec = opts.dec ?? 3, sep = opts.labelSep ?? ' / ', eol = opts.eol ?? '\r\n', rows = [];
  if (opts.header !== false) rows.push(['net', 'labels', 'from', 'to', 'length', 'wires', 'junctions']);
  for (const n of nets) {
    const e = n.ends.map((x) => x.text), tail = [String(+n.length.toFixed(dec)), n.wires, n.junctions];
    for (const [a, b] of e.length > 1 ? e.slice(1).map((t) => [e[0], t]) : [[e[0] ?? '', '']]) rows.push([n.id, n.labels.join(sep), a, b, ...tail]);
  }
  return rows.map((r) => r.map(csvCell).join(',') + eol).join('');
}
