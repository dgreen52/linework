// Kept in this browser (IndexedDB 'linework'; memory when unavailable), no DOM: recent drawings
// (names, sizes, dates, file handles — never contents) and the journal of unsaved edits (the
// EditDoc change lists, keyed by the content hash of the file they apply to: 'journal' holds one
// record per drawing, 'edits' its entries).

export const RECENT_MAX = 12;
export const JOURNAL_MAX_BYTES = 32 * 1024 * 1024; // per drawing (approxSize)
export const JOURNAL_MAX_DOCS = 6; // the oldest are forgotten first
const STORES = ['recent', 'journal', 'edits'];
const ORIG = { orig: 1 }; // a stored entry's "entity as read from the file"

/**
 * get(store, id), all(store, idPrefix?), batch([{ s, put } | { s, del } | { s, prefix }]) in one transaction.
 * name / stores: another database (the sheet-set index cache, src/app/sheets.js, keeps its own).
 */
export function openStore(idb = globalThis.indexedDB, name = 'linework', stores = STORES) {
  const mem = memoryStore(stores);
  if (!idb) return mem;
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = idb.open(name, 1);
    r.onupgradeneeded = () => { for (const s of stores) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('blocked'));
  }));
  const range = (p) => IDBKeyRange.bound(p, p + '\uffff');
  async function tx(names, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(names, mode);
      let req = null;
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('aborted'));
      try { req = fn(t); } catch (e) { try { t.abort(); } catch { /* ignore */ } rej(e); }
    });
  }
  const idbApi = {
    get: (s, id) => tx(s, 'readonly', (t) => t.objectStore(s).get(id)),
    all: (s, prefix) => tx(s, 'readonly', (t) => (prefix == null ? t.objectStore(s).getAll() : t.objectStore(s).getAll(range(prefix)))),
    batch: (ops) => tx([...new Set(ops.map((o) => o.s))], 'readwrite', (t) => {
      for (const o of ops) {
        const st = t.objectStore(o.s);
        if (o.put) st.put(o.put); else if (o.del != null) st.delete(o.del); else if (o.prefix != null) st.delete(range(o.prefix));
      }
      return null;
    }),
  };
  // a failing IndexedDB (blocked, private mode) gives way to memory; data errors are passed on
  const api = { kind: 'idb' };
  for (const k of ['get', 'all', 'batch']) {
    api[k] = async (...a) => {
      if (api.kind === 'memory') return mem[k](...a);
      if (k === 'batch' && !a[0].length) return undefined;
      try { return await idbApi[k](...a); } catch (e) {
        if (e && (e.name === 'DataCloneError' || e.name === 'QuotaExceededError')) throw e;
        api.kind = 'memory';
        return mem[k](...a);
      }
    };
  }
  return api;
}

/** The same API in memory (values kept as given). */
export function memoryStore(stores = STORES) {
  const S = Object.fromEntries(stores.map((s) => [s, new Map()]));
  return {
    kind: 'memory',
    async get(s, id) { return S[s].get(id); },
    async all(s, prefix) { return [...S[s].keys()].filter((k) => prefix == null || k.startsWith(prefix)).sort().map((k) => S[s].get(k)); },
    async batch(ops) {
      for (const o of ops) {
        const m = S[o.s];
        if (o.put) m.set(o.put.id, o.put);
        else if (o.del != null) m.delete(o.del);
        else if (o.prefix != null) for (const k of [...m.keys()]) if (k.startsWith(o.prefix)) m.delete(k);
      }
    },
  };
}

// ------------------------------------------------------------------ recent drawings
/**
 * Add { name, format, size, hash, when, handle?, dir?, sample? }: it replaces the entry of the same
 * file (handle, sample, or name without a handle), keeping its folder and confirmation. Newest first.
 */
export async function addRecent(db, entry, same = sameFile) {
  const list = await db.all('recent');
  let prev = null;
  for (const r of list) if (await same(r, entry)) { prev = r; break; }
  let rec = { ...entry, id: prev ? prev.id : newId(), dir: entry.dir || (prev && prev.dir) || null, ok: !!(entry.ok || (prev && prev.ok)), bak: prev ? prev.bak : undefined };
  const next = [rec, ...list.filter((r) => r !== prev)].sort((a, b) => b.when - a.when);
  const drop = next.slice(RECENT_MAX).map((r) => ({ s: 'recent', del: r.id }));
  try {
    await db.batch([{ s: 'recent', put: rec }, ...drop]);
  } catch (e) {
    if (!(e && e.name === 'DataCloneError')) throw e;
    rec = { ...rec, handle: null, dir: null }; // a handle that cannot be stored: the name only
    await db.batch([{ s: 'recent', put: rec }, ...drop]);
    next[0] = rec;
  }
  return next.slice(0, RECENT_MAX);
}
export async function sameFile(a, b) {
  if (a.sample || b.sample) return a.sample === b.sample;
  if (a.handle && b.handle) { try { return await a.handle.isSameEntry(b.handle); } catch { return false; } }
  return !a.handle && !b.handle && a.name === b.name;
}
export const recentList = async (db) => (await db.all('recent')).sort((a, b) => b.when - a.when).slice(0, RECENT_MAX);
export const updateRecent = (db, rec) => db.batch([{ s: 'recent', put: rec }]);
export const clearRecent = (db) => db.batch([{ s: 'recent', prefix: '' }]);
const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", or a date. */
export function fmtWhen(t, now = Date.now()) {
  const s = (now - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ------------------------------------------------------------------ journal of unsaved edits
/** Journal key: format + content hash (two revisions with one name stay apart). */
export const journalKey = (doc) => `${doc.format}:${doc.hash}`;
const entryId = (key, k) => `${key}#${String(k).padStart(6, '0')}`;

/** Approximate stored size (JSON length). */
export function approxSize(v) {
  try { return JSON.stringify(v, (k, x) => (ArrayBuffer.isView(x) ? x.byteLength : x)).length; } catch { return Infinity; }
}

/** An entry as stored: entities still as read from the file become a marker. */
export function packEntry(entry, orig) {
  const mark = (v, i) => (v && v === orig[i] ? ORIG : v);
  return {
    label: entry.label,
    changes: entry.changes.map((c) => (c.i == null ? c : { i: c.i, before: mark(c.before, c.i), after: mark(c.after, c.i) })),
  };
}
const isOrig = (v) => !!v && v.orig === 1 && Object.keys(v).length === 1;

/**
 * Stored entries -> change lists for `doc` (an EditDoc on the same file), checked as a dry run:
 * each change must find its slot as the previous ones left it, else it throws and nothing applies.
 */
export function planRestore(entries, doc) {
  const ents = doc.model.entities, orig = doc.orig;
  const state = new Map(); // slot -> value during the dry run
  const cur = (i) => (state.has(i) ? state.get(i) : (ents[i] || null));
  const bad = (msg) => { throw Object.assign(new Error(msg), { code: 'journal-mismatch' }); };
  if (doc.log && doc.log.length) bad('The drawing was edited after it was opened.');
  return entries.map((r) => ({
    label: String(r.label || 'Edit'),
    changes: (r.changes || []).map((c) => {
      if (c.i == null) return c;
      if (!(Number.isInteger(c.i) && c.i >= 0 && c.i < ents.length + 1e7)) bad('A change has no valid slot.');
      const now = cur(c.i);
      if (isOrig(c.before)) { if (!now || now !== orig[c.i]) bad(`Item ${c.i} is not as read from the file.`); }
      else if (c.before == null) { if (now) bad(`Item ${c.i} should not exist yet.`); }
      else if (!now || now.type !== c.before.type) bad(`Item ${c.i} is something else.`);
      const after = isOrig(c.after) ? (orig[c.i] || bad(`Item ${c.i} has no original.`)) : (c.after || null);
      state.set(c.i, after);
      return { i: c.i, before: now, after };
    }),
  }));
}

/**
 * The journal of one drawing. sync(doc) writes only the entries changed since the last call and
 * keeps nothing while there are no unsaved edits: 'kept' | 'same' | 'clean' | 'too-big'.
 */
export class Journal {
  constructor(db, doc, max = JOURNAL_MAX_BYTES) {
    this.db = db;
    this.max = max;
    this.key = journalKey(doc);
    this.info = { name: doc.name, format: doc.format, size: doc.size, hash: doc.hash };
    this.ids = []; // EditDoc entry ids stored, in order
    this.sizes = [];
  }
  async read() {
    const meta = await this.db.get('journal', this.key);
    if (!meta || !meta.count) return null;
    const entries = await this.db.all('edits', this.key + '#');
    return entries.length === meta.count ? { meta, entries } : null;
  }
  /** After a restore the stored entries are the doc's. */
  adopt(doc) { this.ids = doc.log.map((e) => e.id); this.sizes = this.ids.map(() => 0); }
  async discard() {
    this.ids = []; this.sizes = [];
    await this.db.batch([{ s: 'journal', del: this.key }, { s: 'edits', prefix: this.key + '#' }]);
  }
  async sync(doc) {
    const log = doc && doc.dirty ? doc.log : [];
    let p = 0;
    while (p < this.ids.length && p < log.length && this.ids[p] === log[p].id) p++;
    if (p === this.ids.length && p === log.length) return log.length ? 'same' : 'clean';
    if (!log.length) { await this.discard(); return 'clean'; }
    const first = !this.ids.length;
    const ops = [], sizes = this.sizes.slice(0, p);
    for (let k = p; k < log.length; k++) {
      const e = log[k];
      const r = { id: entryId(this.key, k), ...packEntry(e, doc.orig) };
      if (e._jsz == null) e._jsz = approxSize(r);
      sizes.push(e._jsz);
      ops.push({ s: 'edits', put: r });
    }
    const total = sizes.reduce((s, v) => s + v, 0);
    if (!(total <= this.max)) { await this.discard(); return 'too-big'; }
    for (let k = log.length; k < this.ids.length; k++) ops.push({ s: 'edits', del: entryId(this.key, k) });
    ops.push({ s: 'journal', put: { id: this.key, ...this.info, when: Date.now(), count: log.length, bytes: total, last: log[log.length - 1].label } });
    await this.db.batch(ops);
    this.ids = log.map((e) => e.id);
    this.sizes = sizes;
    if (first) await trimJournals(this.db, this.key);
    return 'kept';
  }
}

/** Forget the oldest journals beyond JOURNAL_MAX_DOCS (never `keep`). */
export async function trimJournals(db, keep) {
  const metas = (await db.all('journal')).sort((a, b) => b.when - a.when);
  const ops = [];
  for (const m of metas.slice(JOURNAL_MAX_DOCS)) if (m.id !== keep) ops.push({ s: 'journal', del: m.id }, { s: 'edits', prefix: m.id + '#' });
  await db.batch(ops);
}
/** Keys of the drawings that have unsaved edits kept. */
export const journalKeys = async (db) => new Set((await db.all('journal')).filter((m) => m.count).map((m) => m.id));
