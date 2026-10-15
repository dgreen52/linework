// CSV (RFC 4180) for the lists Linework writes (netlist, measurements): pure, DOM-free.

/** One CSV cell: RFC 4180 quoting, and a leading apostrophe on text a spreadsheet would run as a formula (= + - @, tab, CR). */
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows to CSV text: finite numbers are written as numbers (a negative one is not a formula), anything else through csvCell. */
export function csvRows(rows, eol = '\r\n') {
  return rows.map((r) => r.map((v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : csvCell(v))).join(',') + eol).join('');
}
