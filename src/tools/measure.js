// Measurement maths + formatting. The interactive tool lives in ../app/measure-tool.js.
import { polylineLength, polygonArea } from '../geom.js';

export const MEASURE_MODES = {
  distance: { label: 'Distance', minPts: 2, maxPts: 2 },
  length: { label: 'Length', minPts: 2, maxPts: Infinity },
  area: { label: 'Area', minPts: 3, maxPts: Infinity },
};

/** Result of a measurement over points (flat [x,y,...] in drawing units). */
export function measure(mode, pts) {
  const n = pts.length / 2;
  if (mode === 'distance') {
    if (n < 2) return null;
    const dx = pts[2] - pts[0], dy = pts[3] - pts[1];
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (ang < 0) ang += 360;
    return { mode, value: Math.hypot(dx, dy), dx, dy, angle: ang };
  }
  if (mode === 'length') {
    if (n < 2) return null;
    return { mode, value: polylineLength(pts, false), segments: n - 1 };
  }
  if (mode === 'area') {
    if (n < 3) return null;
    return { mode, value: polygonArea(pts), perimeter: polylineLength(pts, true), vertices: n };
  }
  return null;
}

/** Format a number with fixed decimals and thousands separators (locale-independent). */
export function fmtNum(v, decimals = 2) {
  if (!Number.isFinite(v)) return '—';
  const d = Math.max(0, Math.min(8, decimals | 0));
  const neg = v < 0;
  const s = Math.abs(v).toFixed(d);
  const [int, frac] = s.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg && Number(s) !== 0 ? '-' : '') + grouped + (frac ? '.' + frac : '');
}

export function fmtLen(v, decimals, abbr) {
  return fmtNum(v, decimals) + (abbr ? ' ' + abbr : '');
}
export function fmtArea(v, decimals, abbr) {
  return fmtNum(v, decimals) + (abbr ? ' ' + abbr + '²' : ' sq. units');
}

/** Human summary used by the result panel and on-canvas labels. */
export function describe(result, decimals, abbr) {
  if (!result) return '';
  if (result.mode === 'distance') return fmtLen(result.value, decimals, abbr);
  if (result.mode === 'length') return fmtLen(result.value, decimals, abbr);
  if (result.mode === 'area') return fmtArea(result.value, decimals, abbr);
  return '';
}

export function details(result, decimals, abbr) {
  if (!result) return '';
  if (result.mode === 'distance') {
    return `ΔX ${fmtLen(result.dx, decimals, abbr)} · ΔY ${fmtLen(result.dy, decimals, abbr)} · angle ${fmtNum(result.angle, 1)}°`;
  }
  if (result.mode === 'length') return `${result.segments} segment${result.segments === 1 ? '' : 's'}`;
  if (result.mode === 'area') return `perimeter ${fmtLen(result.perimeter, decimals, abbr)} · ${result.vertices} corners`;
  return '';
}
