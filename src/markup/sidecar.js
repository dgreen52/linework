// Markup sidecar file: "<drawing name>.markup.json". Versioned schema, see MARKUP_FORMAT.md.
import { APP_NAME, APP_VERSION, MARKUP_SCHEMA, MARKUP_VERSION } from '../config.js';
import { MARKUP_TYPES, newId } from './model.js';

export function sidecarName(drawingName) {
  return `${drawingName || 'drawing'}.markup.json`;
}

/**
 * Serialise markups. drawing: { name, size, format, units }.
 * Coordinates are in drawing (world) units so the file is view- and device-independent.
 */
export function serializeMarkups(drawing, markups, extra = {}) {
  const now = new Date().toISOString();
  const doc = {
    schema: MARKUP_SCHEMA,
    version: MARKUP_VERSION,
    app: { name: APP_NAME, version: APP_VERSION },
    drawing: {
      name: drawing?.name || '',
      size: drawing?.size ?? null,
      format: drawing?.format || '',
      units: drawing?.units || '',
    },
    created: extra.created || now,
    saved: now,
    markups: markups.map((m) => {
      const o = {
        id: m.id,
        type: m.type,
        pts: m.pts.slice(), // full double precision: exact round trip
        color: m.color,
        width: m.width,
        author: m.author || '',
        created: m.created,
        modified: m.modified,
      };
      if (m.opacity != null) o.opacity = m.opacity;
      if (m.text != null) o.text = m.text;
      if (m.size != null) o.size = m.size;
      if (m.arc != null) o.arc = m.arc;
      return o;
    }),
  };
  return JSON.stringify(doc, null, 2);
}

export class SidecarError extends Error {}

/** Parse + validate a sidecar. Returns { drawing, markups, warnings, version }. Throws SidecarError. */
export function parseMarkups(text) {
  let doc;
  try {
    doc = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new SidecarError('This markup file is not valid JSON.');
  }
  if (!doc || typeof doc !== 'object' || doc.schema !== MARKUP_SCHEMA) {
    throw new SidecarError('This is not a markup file (missing "schema": "' + MARKUP_SCHEMA + '").');
  }
  const v = Number(doc.version);
  if (!Number.isInteger(v) || v < 1) throw new SidecarError('The markup file has an invalid version.');
  if (v > MARKUP_VERSION) {
    throw new SidecarError(`This markup file was saved by a newer version (format v${v}); this app reads up to v${MARKUP_VERSION}.`);
  }
  const warnings = [];
  const markups = [];
  const list = Array.isArray(doc.markups) ? doc.markups : [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || !MARKUP_TYPES.includes(raw.type)) { warnings.push(`Skipped a markup of unknown type "${raw && raw.type}".`); continue; }
    const pts = Array.isArray(raw.pts) ? raw.pts.map(Number) : [];
    if (pts.length < 4 || pts.length % 2 || !pts.every(Number.isFinite)) { warnings.push(`Skipped a ${raw.type} markup with invalid points.`); continue; }
    let id = typeof raw.id === 'string' && raw.id ? raw.id : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    const m = {
      id,
      type: raw.type,
      pts,
      color: /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color.toLowerCase() : '#e5262b',
      width: clampNum(raw.width, 0.5, 64, 2),
      author: typeof raw.author === 'string' ? raw.author.slice(0, 200) : '',
      created: validDate(raw.created),
      modified: validDate(raw.modified || raw.created),
    };
    if (raw.opacity != null) m.opacity = clampNum(raw.opacity, 0.05, 1, 0.35);
    if (raw.text != null) m.text = String(raw.text).slice(0, 5000);
    if (raw.size != null && Number.isFinite(Number(raw.size)) && Number(raw.size) > 0) m.size = Number(raw.size);
    if (raw.arc != null && Number.isFinite(Number(raw.arc)) && Number(raw.arc) > 0) m.arc = Number(raw.arc);
    markups.push(m);
  }
  return { drawing: doc.drawing || {}, markups, warnings, version: v, created: doc.created };
}

function clampNum(v, lo, hi, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
function validDate(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
