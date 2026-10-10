// Precision key-ins in the MicroStation style (pure). Values are in the drawing's master units, angles
// in degrees counter-clockwise from +X:
//   XY=x,y   a point at x,y              DL=dx,dy  a point dx,dy from the last one
//   DI=d,a   a point d away at angle a   AA=a      the active angle (rotation)
//   a plain number: a length (along the cursor, a radius...); @dx,dy and @d<a also work.
const NUM = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[-+]?\\d+)?';
const RE = new RegExp(`^(xy|dl|di|aa)\\s*=\\s*(.*)$`, 'i');
const LIST = new RegExp(`^(${NUM})?(?:\\s*[,\\s]\\s*(${NUM}))?(?:\\s*[,\\s]\\s*(${NUM}))?\\s*°?$`, 'i');
const AT = new RegExp(`^@\\s*(${NUM})\\s*(?:([,<])\\s*(${NUM})\\s*°?)?$`, 'i');

/**
 * Parse a key-in. Returns { kind: 'xy' | 'dl' | 'di' | 'aa' | 'len', v: [numbers] } or { error }.
 * Missing values are 0 (XY=5 is 5,0), as in MicroStation.
 */
export function parseKeyin(text) {
  const s = String(text || '').trim();
  if (!s) return { error: 'Type XY=x,y · DL=dx,dy · DI=distance,angle · AA=angle' };
  const at = AT.exec(s);
  if (at) return at[2] === '<' ? { kind: 'di', v: [+at[1], +at[3]] } : { kind: 'dl', v: [+at[1], at[3] == null ? 0 : +at[3]] };
  const m = RE.exec(s);
  if (!m) {
    if (new RegExp(`^${NUM}$`, 'i').test(s)) return { kind: 'len', v: [+s] };
    return { error: `“${s.slice(0, 20)}” is not a key-in: use XY=, DL=, DI= or AA=` };
  }
  const kind = m[1].toLowerCase();
  const L = LIST.exec(m[2].trim());
  if (!L || L[1] == null) return { error: `${kind.toUpperCase()}= needs ${kind === 'aa' ? 'an angle' : kind === 'di' ? 'a distance and an angle' : 'two numbers'}` };
  const v = [+L[1], L[2] == null ? 0 : +L[2]];
  if (!v.every(Number.isFinite)) return { error: 'That number is out of range' };
  if (kind === 'aa') return L[2] == null ? { kind, v: [v[0]] } : { error: 'AA= takes one angle' };
  return { kind, v };
}

export const RAD = Math.PI / 180;
/** The point a key-in gives, from `last` (the last data point; null when there is none). Null for AA / length. */
export function keyinPoint(k, last) {
  if (!k || k.error) return null;
  if (k.kind === 'xy') return [k.v[0], k.v[1]];
  if (!last) return null;
  if (k.kind === 'dl') return [last[0] + k.v[0], last[1] + k.v[1]];
  if (k.kind === 'di') return [last[0] + k.v[0] * Math.cos(k.v[1] * RAD), last[1] + k.v[0] * Math.sin(k.v[1] * RAD)];
  return null;
}
