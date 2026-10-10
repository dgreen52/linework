// Level names for DGN v7 drawings (pure). DGN v7 levels are numbers 1-63 without names; names are kept
// in this browser per drawing and never written into the file. A names file is plain text, one level
// per line: "5,Power" (comma, semicolon, tab or spaces between them; quotes allowed; # comments and a
// header line are skipped).
export const MAX_LEVEL = 63;
const MAX_NAME = 64;

/** Split one CSV-ish line into two fields (number, name), honouring "quoted, fields". */
function fields(line) {
  const m = /^\s*"?\s*(\d+)\s*"?\s*(?:[,;\t]|\s+)\s*(.*)$/.exec(line);
  if (!m) return null;
  let name = m[2].trim();
  if (/^".*"$/.test(name)) name = name.slice(1, -1).replace(/""/g, '"');
  else name = name.replace(/[,;\t]+$/, '').trim(); // trailing empty columns
  return [Number(m[1]), name];
}

/**
 * Parse a names file. Returns { names: Map(level -> name), skipped: [line numbers] } (blank lines,
 * comments and a first header line are not counted as skipped).
 */
export function parseLevelNames(text) {
  const names = new Map(), skipped = [];
  String(text || '').replace(/^﻿/, '').split(/\r\n|\r|\n/).forEach((raw, k) => {
    const line = raw.trim();
    if (!line || line[0] === '#' || line.startsWith('//')) return;
    const f = fields(line);
    if (!f) { if (names.size || skipped.length || !/[a-z]/i.test(line)) skipped.push(k + 1); return; } // a header line is fine
    const [lv, name] = f;
    if (lv < 1 || lv > MAX_LEVEL || !name) { skipped.push(k + 1); return; }
    names.set(lv, cleanName(name));
  });
  return { names, skipped };
}

/** A level name as stored: one line, trimmed, at most 64 characters. */
export const cleanName = (s) => String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_NAME);

/** The names as a CSV file (level,name), quoted when needed. */
export function levelNamesCsv(names) {
  const q = (s) => (/[",;\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ['level,name', ...[...names].sort((a, b) => a[0] - b[0]).map(([lv, n]) => `${lv},${q(n)}`)].join('\r\n') + '\r\n';
}
