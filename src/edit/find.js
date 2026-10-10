// Find and replace drawing text (pure). Searching reads the scene's drawn texts, so it works in every
// mode and finds text inside cells and inserts too (each scene text knows its entity and its path in it);
// replacing builds ordinary edit changes with setText / withPart, so a DGN keeps every other byte.
import { partAt, withPart, setText, isText } from './ops.js';

const WORD = '[\\p{L}\\p{N}_]';
/** RegExp for a literal query (null when empty). opts: { matchCase, wholeWord }. */
export function findRegex(q, opts = {}, global = false) {
  if (!q) return null;
  let src = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.wholeWord) src = `(?<!${WORD})${src}(?!${WORD})`;
  return new RegExp(src, (global ? 'g' : '') + (opts.matchCase ? '' : 'i') + 'u');
}

/**
 * Drawn texts that match: [{ t (scene text index), ent, sub, s, bbox (scene-local), h }], in reading order
 * (rows from the top, then left to right). q: literal text, or a RegExp (used as it is; opts then only
 * filter). opts: { matchCase, wholeWord, isVisible(layerIndex) }.
 */
export function findTexts(scene, q, opts = {}) {
  const re = q instanceof RegExp ? new RegExp(q.source, q.flags.replace(/[gy]/g, '')) : findRegex(q, opts);
  if (!re || !scene) return [];
  const vis = opts.isVisible || (() => true);
  const out = [];
  scene.texts.forEach((t, k) => {
    if (!t || t.dead || !vis(t.layer) || !re.test(t.s)) return;
    out.push({ t: k, ent: t.ent, sub: t.sub || '', s: t.s, bbox: t.bbox, h: Math.hypot(t.m[2], t.m[3]) || 1 });
  });
  if (out.length > 1) {
    const hs = out.map((x) => x.h).sort((a, b) => a - b);
    const band = hs[hs.length >> 1] * 1.5;
    let top = -Infinity;
    for (const x of out) if (x.bbox[3] > top) top = x.bbox[3];
    for (const x of out) x.row = Math.floor((top - x.bbox[3]) / band);
    out.sort((a, b) => a.row - b.row || a.bbox[0] - b.bbox[0] || a.t - b.t);
  }
  return out;
}

/** The text item at path `sub` of entity e ('' = e itself), or null. */
export const textPart = (e, sub) => { const p = sub ? partAt(e, sub) : e; return isText(p) ? p : null; };

/**
 * Entity e with every match in its text at `sub` replaced by `rep` (taken literally). Returns
 * { after, n } or { skip: 'shared' | 'blank' | 'none' }.
 */
export function replaceIn(e, sub, re, rep) {
  if (sub && sub[0] === '#') return { skip: 'shared' }; // block-definition text: shared by every copy
  const part = textPart(e, sub);
  if (!part) return { skip: 'none' };
  let n = 0;
  const text = String(part.text).replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), () => { n++; return rep; });
  if (!n || text === part.text) return { skip: 'none' };
  if (!text.trim()) return { skip: 'blank' }; // never leave an empty text behind
  return { after: sub ? withPart(e, sub, setText(part, text)) : setText(e, text), n };
}

/**
 * Edit changes that replace the matches of `hits` (from findTexts) in `entities`: one change per entity
 * (several texts of one cell are replaced together). Returns { changes, texts, shared, blank }.
 */
export function replaceChanges(entities, hits, q, rep, opts = {}) {
  const re = findRegex(q, opts, true);
  const out = { changes: [], texts: 0, shared: 0, blank: 0 };
  if (!re) return out;
  const byEnt = new Map();
  for (const h of hits) {
    if (!byEnt.has(h.ent)) byEnt.set(h.ent, new Set());
    byEnt.get(h.ent).add(h.sub || '');
  }
  for (const [i, subs] of byEnt) {
    const before = entities[i];
    if (!before) continue;
    let cur = before;
    for (const sub of subs) {
      const r = replaceIn(cur, sub, re, rep);
      if (r.skip === 'shared') out.shared++;
      else if (r.skip === 'blank') out.blank++;
      if (r.after) { cur = r.after; out.texts++; }
    }
    if (cur !== before) out.changes.push({ i, before, after: cur });
  }
  return out;
}
