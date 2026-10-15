// The measurement list as CSV (loaded when it is saved, to keep the start-up code small): pure, DOM-free.
import { measure } from './measure.js';
import { csvRows } from './csv.js';
/**
 * The measurements (as the Measure tools keep them: [{ mode: 'distance' | 'length' | 'area', pts: flat [x, y, ...]
 * in drawing coordinates }]) as a CSV list, one row each: n, type, value, unit, dx, dy, angle (degrees),
 * segments, perimeter, corners, points ("x y; x y; ..."). Lengths in drawing units, areas in square units.
 * opts: { dec (decimals, default 3), abbr (the unit, e.g. 'm'; '' when the drawing has none), eol ('\r\n') }.
 */
export function measurementsCsv(measures, opts = {}) {
  const dec = Math.max(0, Math.min(8, opts.dec ?? 3)), abbr = opts.abbr || '';
  const r = (v) => (Number.isFinite(v) ? Number(v.toFixed(dec)) : '');
  const rows = [['n', 'type', 'value', 'unit', 'dx', 'dy', 'angle_deg', 'segments', 'perimeter', 'corners', 'points']];
  let n = 0;
  for (const m of measures || []) {
    const res = m && measure(m.mode, m.pts || []);
    if (!res) continue;
    const pts = [];
    for (let k = 0; k + 1 < m.pts.length; k += 2) pts.push(r(m.pts[k]) + ' ' + r(m.pts[k + 1]));
    const d = res.mode === 'distance', l = res.mode === 'length', a = res.mode === 'area';
    rows.push([++n, res.mode, r(res.value), a ? (abbr ? abbr + '²' : 'sq. units') : abbr || 'units',
      d ? r(res.dx) : '', d ? r(res.dy) : '', d ? Number(res.angle.toFixed(2)) : '',
      l ? res.segments : '', a ? r(res.perimeter) : '', a ? res.vertices : '', pts.join('; ')]);
  }
  return csvRows(rows, opts.eol ?? '\r\n');
}
