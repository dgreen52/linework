// Edit mode: select / move / reshape / draw / restyle drawing items, undo, and Save (DXF, DGN v7).
// The drawing model arrives from the parse worker after the first render; editing starts as soon
// as it is here. Every change goes through EditDoc (edit/doc.js) and the shared undo history.
import { EditDoc, selectInRect } from '../edit/doc.js';
import { entityItems, entityBBox, liveExtents } from '../edit/live-scene.js';
import {
  moveEntity, rotateEntity, gripsOf, moveGrip, insertVertex, deleteVertex, segmentsOf, nearestOnSegment,
  setText, restyle, canReshape, isText, colorInfo, weightLabel, partAt, withPart,
} from '../edit/ops.js';
import { makePayload, preparePaste, clipText, parseClip, CLIP_HEADER, CLIP_MAX } from '../edit/clipboard.js';
import { createEmitter, sceneTables, KIND, CHAR_W, DXF_LW, weightPx } from '../scene.js';
import { addConic, addPoly, CAP_HEIGHT } from '../view/renderer2d.js';
import { findSnap, pickItem } from '../tools/snap.js';
import { fmtNum } from '../tools/measure.js';
import { ACI } from '../palettes.js';
import { FG } from '../model.js';
import { $, toast, download, esc } from './ui.js';

export const EDIT_TOOLS = new Set(['eselect', 'eline', 'epoly', 'erect', 'ecircle', 'etext']);
export const EDIT_KEYS = { v: 'eselect', n: 'eline', p: 'epoly', r: 'erect', o: 'ecircle', t: 'etext' };
export const EDIT_HINTS = {
  eselect: 'Click to select · drag a box (→ inside, ← touching) · drag to move · double-click to edit',
  eline: 'Click the start, then each next point · type a length + Enter · Enter or Esc to stop',
  epoly: 'Click points · double-click or Enter to finish · C closes it · Backspace removes the last point',
  erect: 'Click two opposite corners',
  ecircle: 'Click the centre, then a point on the circle',
  etext: 'Click where the text goes, then type · Enter places it · Esc cancels',
};
const VEDIT_HINT = 'Drag a point to move it · right-click a point to delete it · double-click a side to add one · Esc when done';
const VEDIT_HINT_TOUCH = 'Drag a point to move it · long-press a point or a side for more · tap empty space when done';
/** Shorter, touch-worded hints for phones and tablets. */
export const TOUCH_HINTS = {
  eselect: 'Tap to select · drag a box (→ inside, ← touching) · drag to move · long-press for more',
  epoly: 'Tap points · Finish when done',
  eline: 'Tap the start, then each next point · Finish to stop',
};
const BLOCK_HINT = 'Blocks and cells move, rotate and delete as a whole · double-click a text inside one to edit it';
const SHARED_HINT = 'This text is part of a block definition shared by every copy, so it can’t be edited here yet · attributes can';
const DIM_HINT = 'Dimensions move, rotate and delete as a whole';
const DXF_COLORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 40, 140, 200, 250, 254];
const COLOR_NAMES = { 1: 'Red', 2: 'Yellow', 3: 'Green', 4: 'Cyan', 5: 'Blue', 6: 'Magenta', 7: 'White/black', 8: 'Dark grey', 9: 'Light grey', 30: 'Orange' };

export function initEdit(app, api) {
  const E = {
    doc: null, ready: false, waiters: [],
    sel: new Set(), selPath: null, hover: -1, hoverPath: null,
    vedit: -1, gripHover: -1,
    drag: null, box: null, gdrag: null, draft: null, cursor: null,
    curLayer: null, curColor: 'bylayer', curWeight: -1,
    clip: null, // this tab's last copy (a clipboard payload; survives opening another drawing)
    place: null, // items following the cursor (paste / duplicate): { r, path, label, at }
    text: null, // in-place text editor state
    nudgeAt: 0,
  };
  app.edit = E;
  const scene = () => app.scene;
  const model = () => (E.doc ? E.doc.model : null);
  const isDgn = () => app.scene && app.scene.format === 'DGN';
  const coarse = () => E.lastPointer === 'touch' || (window.matchMedia && matchMedia('(pointer: coarse)').matches);
  const inEdit = () => EDIT_TOOLS.has(app.tool);
  const vis = (li) => !app.layerVisible || !!app.layerVisible[li];
  const [W2S, S2W] = [(x, y) => app.worldToScreen(x, y), (x, y) => app.screenToWorld(x, y)];

  // ---------------------------------------------------------------- lifecycle
  function reset() {
    E.doc = null; E.ready = false;
    E.sel = new Set(); E.selPath = null; E.hover = -1; E.vedit = -1;
    E.drag = E.box = E.gdrag = E.draft = E.place = null;
    E.curColor = isDgn() ? { ci: 0, rgb: 0xffffff } : 'bylayer';
    E.curWeight = isDgn() ? 0 : -1;
    closeText(false); closeMenus(); hideLen();
    updateRibbon(); updateDirty();
  }
  /** The model arrived from the worker: editing can start. */
  function setModel(m, bytes) {
    if (!app.scene) return;
    E.doc = new EditDoc(m, app.scene, { bytes });
    E.ready = true;
    E.palette = m.header && m.header.palette ? m.header.palette : null;
    fillLayers();
    updateRibbon();
    for (const w of E.waiters.splice(0)) w(true);
  }
  function whenReady() {
    if (E.ready) return Promise.resolve(true);
    if (!app.scene) return Promise.resolve(false);
    toast('Preparing the drawing for editing…', { key: 'prep', timeout: 2500 });
    return new Promise((res) => E.waiters.push(res));
  }

  // ---------------------------------------------------------------- committing changes
  function commit(label, changes, selAfter) {
    if (!E.doc || !changes.length) return null;
    const t0 = performance.now();
    const selBefore = [...E.sel];
    const entry = E.doc.commit(label, changes, { selBefore, selAfter: selAfter || selBefore });
    app.history.push(entry);
    applied(entry.result, entry.selAfter);
    E.lastCommit = { label, items: changes.length, ms: performance.now() - t0 };
    return entry;
  }
  function applied(result, sel) {
    app.renderer.applyEdit(result);
    if (result.layersChanged) { api.layersChanged(); fillLayers(); }
    const m = model();
    E.sel = new Set((sel || []).filter((i) => m && m.entities[i]));
    if (E.vedit >= 0 && !(m && m.entities[E.vedit] && canReshape(m.entities[E.vedit]))) endVedit();
    E.selPath = null; E.hoverPath = null; E.hover = -1;
    app.hover = null; app.hoverPath = null;
    updateDirty(); updateRibbon(); api.updateUndoButtons(); status();
    api.invalidate(true);
  }
  /** Undo / redo of an edit entry (called by the app's shared history). */
  function revert(entry) { applied(E.doc.revert(entry), entry.selBefore); }
  function reapply(entry) { applied(E.doc.reapply(entry), entry.selAfter); }

  const entity = (i) => (model() ? model().entities[i] : null);
  const newIdx = (k = 0) => E.doc.nextIndex(k);
  const fmt = () => (E.doc ? E.doc.format : 'DXF');

  /** Properties for a new item on the current layer / colour. */
  function newProps(src) {
    const p = { layer: E.curLayer || '0', ltype: 'BYLAYER', weight: 0, src };
    if (isDgn()) { const c = E.curColor && E.curColor.ci != null ? E.curColor : { ci: 0, rgb: 0xffffff }; p.color = 256; p.rgb = c.rgb; p.ci = c.ci; p.ltype = 'CONTINUOUS'; p.weight = E.curWeight | 0; }
    else {
      p.color = E.curColor === 'bylayer' || !E.curColor ? 256 : E.curColor.aci;
      if (E.curWeight >= 0) p.lw = E.curWeight;
    }
    return p;
  }

  // ---------------------------------------------------------------- picking and snapping
  function pickEnt(sx, sy, tolPx) {
    const s = scene();
    if (!s) return -1;
    const [lx, ly] = app.view.toWorld(sx, sy);
    const h = pickItem(s, lx, ly, (tolPx || (coarse() ? 14 : 6)) / app.view.scale, vis);
    return h && h.ent != null && entity(h.ent) ? h.ent : -1;
  }
  /** Cursor point (world): snapped when snaps are on; Shift keeps it horizontal/vertical from `from`. */
  function pointAt(sx, sy, ev, opts = {}) {
    const s = scene();
    const [ox, oy] = s.origin;
    let snap = null;
    if (app.snapOn && !opts.noSnap) {
      const [lx, ly] = app.view.toWorld(sx, sy);
      const skip = opts.skip && opts.skip.size ? (id) => opts.skip.has(s.ent[id]) : null;
      snap = findSnap(s, lx, ly, (coarse() ? 22 : 11) / app.view.scale, { isVisible: vis, skip });
    }
    let x, y;
    if (snap) { x = snap.x + ox; y = snap.y + oy; } else [x, y] = S2W(sx, sy);
    if (ev && ev.shiftKey && opts.from) {
      const dx = x - opts.from[0], dy = y - opts.from[1];
      if (Math.abs(dx) >= Math.abs(dy)) y = opts.from[1]; else x = opts.from[0];
      snap = null;
    }
    const [csx, csy] = W2S(x, y);
    return { x, y, sx: csx, sy: csy, snap };
  }

  // ---------------------------------------------------------------- paths for the overlay
  function textBox(p, t, ox = 0, oy = 0) {
    const W = t.fit || (t.w != null ? t.w : CHAR_W * t.s.length);
    const u0 = t.align === 0 ? 0 : t.align === 1 ? -W / 2 : -W;
    const [a, b, c, d] = t.m;
    const P = (u, v) => [t.x - ox + u * a + v * c, t.y - oy + u * b + v * d];
    const q = [P(u0 - 0.1, -0.25), P(u0 + W + 0.1, -0.25), P(u0 + W + 0.1, 1.15), P(u0 - 0.1, 1.15)];
    p.moveTo(...q[0]); p.lineTo(...q[1]); p.lineTo(...q[2]); p.lineTo(...q[3]); p.closePath();
  }
  function itemsPath(ents) {
    const s = scene(), p = new Path2D();
    for (const i of ents) {
      const it = entityItems(s, i);
      for (const id of it.prims) {
        if (s.dead[id]) continue;
        const k = s.kind[id];
        if (k === KIND.CONIC) addConic(p, s, id);
        else if (k === KIND.POINT) { const o = s.start[id] * 2; p.moveTo(s.coords[o], s.coords[o + 1]); p.lineTo(s.coords[o], s.coords[o + 1]); }
        else addPoly(p, s, id);
      }
      for (const t of it.texts) if (!s.texts[t].dead) textBox(p, s.texts[t]);
    }
    return p;
  }
  /** Path (scene coordinates) of entities that are not in the scene yet (drafts, previews, pastes). */
  function entityPath(list, m = model(), tables = null) {
    const s = scene();
    const p = new Path2D();
    if (!m) return p;
    const em = createEmitter(m, tables || sceneTables(m, s));
    [].concat(list).forEach((e, k) => e && em.emit(e, k));
    const B = em.B, [ox, oy] = s.origin;
    for (let j = 0; j < B.kind.length; j++) {
      if (B.kind[j] === KIND.CONIC) {
        const o = B.start[j] * 8, c = B.conics;
        const t0 = c[o + 6], t1 = c[o + 7], n = Math.max(16, Math.ceil(((t1 - t0) / (2 * Math.PI)) * 96));
        for (let k = 0; k <= n; k++) {
          const t = t0 + ((t1 - t0) * k) / n;
          const x = c[o] + c[o + 2] * Math.cos(t) + c[o + 4] * Math.sin(t) - ox, y = c[o + 1] + c[o + 3] * Math.cos(t) + c[o + 5] * Math.sin(t) - oy;
          if (k) p.lineTo(x, y); else p.moveTo(x, y);
        }
      } else {
        const o = B.start[j] * 2, n = B.count[j];
        let move = true;
        for (let k = 0; k < n; k++) {
          const x = B.coords[o + 2 * k] - ox, y = B.coords[o + 2 * k + 1] - oy;
          if (x !== x) { move = true; continue; }
          if (move) { p.moveTo(x, y); move = false; } else p.lineTo(x, y);
        }
        if (n === 1) p.lineTo(B.coords[o] - ox, B.coords[o + 1] - oy);
        if (B.flags[j] & 1) p.closePath();
      }
    }
    for (const t of B.texts) textBox(p, t, ox, oy);
    return p;
  }
  const selPath = () => (E.selPath || (E.selPath = itemsPath(E.sel)));

  // ---------------------------------------------------------------- overlay
  function drawOverlay(ctx) {
    if (!inEdit() || !scene()) return;
    const dpr = app.dpr, M = app.view.matrix(dpr), s = app.view.scale;
    const acc = api.accent(), paper = app.theme === 'paper';
    const halo = paper ? 'rgba(255,255,255,0.9)' : 'rgba(5,8,12,0.85)';
    ctx.save();
    ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const stroke = (p, color, px, alpha = 1, dash = null) => {
      ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = px / s;
      ctx.setLineDash(dash ? dash.map((v) => v / s) : []);
      ctx.stroke(p);
      ctx.globalAlpha = 1;
    };
    const moving = E.drag && E.drag.moving;
    if (E.hover >= 0 && !E.sel.has(E.hover) && !moving && !E.box) {
      if (!E.hoverPath || E.hoverPath.i !== E.hover) E.hoverPath = { i: E.hover, p: itemsPath([E.hover]) };
      stroke(E.hoverPath.p, halo, 4, 0.8); stroke(E.hoverPath.p, acc, 2, 0.75);
    }
    if (E.sel.size) {
      const p = selPath();
      const big = E.sel.size > 150; // dashes and halos cost per frame: keep big selections cheap
      if (moving) {
        stroke(p, acc, 1.2, 0.3); // ghost where it was
        ctx.save();
        ctx.translate(E.drag.dx, E.drag.dy);
        if (!big) stroke(p, halo, 5, 0.9);
        stroke(p, acc, big ? 1.5 : 2.2);
        ctx.restore();
      } else { stroke(p, halo, 5.5, 0.9); stroke(p, acc, 2.2, 1, big ? null : [7, 4]); } // dashed: reads on any line colour
    }
    if (E.gdrag && E.gdrag.preview) { stroke(E.gdrag.preview, halo, 5, 0.9); stroke(E.gdrag.preview, acc, 2.2); }
    const P = E.place;
    if (P && P.at) { // the items being pasted / duplicated, at the cursor
      ctx.save();
      ctx.translate(P.at[0] - P.r.base[0], P.at[1] - P.r.base[1]);
      const big = P.r.ents.length > 150; // dashes and halos cost per frame: keep big pastes cheap
      if (!big) stroke(P.path, halo, 5, 0.9);
      stroke(P.path, acc, big ? 1.5 : 2, 1, big ? null : [7, 4]);
      ctx.restore();
    }
    if (E.draft) {
      const p = draftPath();
      if (p) { stroke(p, halo, 4.5, 0.8); stroke(p, acc, 2, 1, [7, 5]); }
    }
    ctx.restore();
    // screen-space parts: grips, box, snap glyph
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (E.vedit >= 0 && entity(E.vedit)) {
      const sz = coarse() ? 15 : 9;
      gripsOf(entity(E.vedit)).forEach((g, k) => {
        const [x, y] = W2S(g.x, g.y);
        ctx.beginPath();
        if (g.kind === 'c') ctx.arc(x, y, sz / 2 + 1, 0, Math.PI * 2); else ctx.rect(x - sz / 2, y - sz / 2, sz, sz);
        ctx.fillStyle = k === E.gripHover ? acc : (paper ? '#ffffff' : '#0f1216');
        ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = acc; ctx.stroke();
      });
    }
    if (E.box) {
      const b = E.box, crossing = b.x1 < b.x0;
      const col = crossing ? (paper ? '#1f8a3b' : '#4ade80') : acc;
      const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1), w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
      ctx.fillStyle = col; ctx.globalAlpha = 0.1; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1;
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash(crossing ? [6, 4] : []);
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.setLineDash([]);
    }
    if (E.cursor && E.cursor.snap && (app.tool !== 'eselect' || E.drag || E.gdrag || E.place)) api.drawSnapGlyph(ctx, E.cursor.sx, E.cursor.sy, E.cursor.snap.kind);
    ctx.restore();
  }

  // ---------------------------------------------------------------- drafts (draw tools)
  function draftEntity() {
    const d = E.draft, c = E.cursor;
    if (!d) return null;
    const P = newProps();
    const cur = c ? [c.x, c.y] : null;
    switch (d.tool) {
      case 'eline': return cur && d.pts.length ? { ...P, type: 'line', a: d.pts.slice(-2), b: cur } : null;
      case 'epoly': { const pts = cur ? [...d.pts, ...cur] : d.pts; return pts.length >= 4 ? { ...P, type: 'polyline', pts, bulges: null, closed: false } : null; }
      case 'erect': return cur ? rectEntity(d.pts, cur, P) : null;
      case 'ecircle': return cur ? { ...P, type: 'circle', c: d.pts.slice(0, 2), r: Math.max(1e-9, Math.hypot(cur[0] - d.pts[0], cur[1] - d.pts[1])) } : null;
      default: return null;
    }
  }
  const rectEntity = (a, b, P) => ({ ...P, type: 'polyline', pts: [a[0], a[1], b[0], a[1], b[0], b[1], a[0], b[1]], bulges: null, closed: true });
  function draftPath() {
    const e = draftEntity();
    if (!e) return null;
    if (!E.draftCache || E.draftCache.key !== JSON.stringify([e.a, e.b, e.c, e.r, e.pts])) E.draftCache = { key: JSON.stringify([e.a, e.b, e.c, e.r, e.pts]), p: entityPath(e) };
    return E.draftCache.p;
  }
  function finishDraft() {
    if (E.place) { placeAt(E.place.at); return true; }
    const d = E.draft;
    if (!d) return false;
    if (d.tool === 'epoly' && d.pts.length >= 4) {
      const P = newProps(isDgn() ? 'LINE_STRING' : 'LWPOLYLINE');
      commit('Polyline', [{ i: newIdx(), before: null, after: { ...P, type: 'polyline', pts: d.pts.slice(), bulges: null, closed: !!d.close } }]);
    }
    E.draft = null; hideLen();
    api.updateFinishBar(); api.invalidate();
    return true;
  }
  function undoDraftPoint() {
    const d = E.draft;
    if (!d || !(d.tool === 'epoly' || d.tool === 'eline')) return false;
    d.pts.length -= 2;
    if (!d.pts.length) E.draft = null;
    api.updateFinishBar(); api.invalidate();
    return true;
  }
  function cancelDraft() {
    if (E.place) { E.place = null; hint(''); status(); api.updateFinishBar(); api.invalidate(); return true; }
    if (!E.draft) return false;
    E.draft = null; hideLen(); api.updateFinishBar(); api.invalidate(); return true;
  }

  // ---------------------------------------------------------------- pointer handling
  function down(sx, sy, ev) {
    if (!scene()) return;
    E.lastPointer = ev.pointerType;
    closeMenus();
    if (E.text) { closeText(true); return; }
    if (!E.ready) { whenReady(); return; }
    if (E.place) { E.place.down = true; return; }
    startLongPress(sx, sy, ev);
    const t = app.tool;
    if (t === 'eselect') return selectDown(sx, sy, ev);
    const c = pointAt(sx, sy, ev, { from: E.draft && E.draft.pts.length ? E.draft.pts.slice(-2) : null });
    E.cursor = c;
    const p = [c.x, c.y];
    if (t === 'etext') { E.pendingText = { at: p, sx, sy }; return; } // opened on release (a press would steal the focus)
    if (t === 'eline') {
      if (!E.draft) { E.draft = { tool: t, pts: p }; api.updateFinishBar(); }
      else addLine(p);
    } else if (t === 'epoly') {
      if (!E.draft) { E.draft = { tool: t, pts: p }; api.updateFinishBar(); }
      else {
        const n = E.draft.pts.length;
        const [lx, ly] = W2S(E.draft.pts[n - 2], E.draft.pts[n - 1]);
        if (Math.hypot(lx - c.sx, ly - c.sy) < 3) return; // repeated click (double-click)
        const [fx, fy] = W2S(E.draft.pts[0], E.draft.pts[1]);
        if (n >= 6 && Math.hypot(fx - c.sx, fy - c.sy) < 10) { E.draft.close = true; finishDraft(); return; }
        E.draft.pts.push(...p);
      }
    } else if (t === 'erect' || t === 'ecircle') {
      if (!E.draft) E.draft = { tool: t, pts: p, s0: [sx, sy] };
      else completeShape(p);
    }
    api.invalidate();
  }
  function addLine(p) {
    const a = E.draft.pts.slice(-2);
    if (Math.hypot(p[0] - a[0], p[1] - a[1]) * app.view.scale < 2) return;
    commit('Line', [{ i: newIdx(), before: null, after: { ...newProps('LINE'), type: 'line', a, b: p } }]);
    E.draft = { tool: 'eline', pts: p };
    api.updateFinishBar();
  }
  function completeShape(p) {
    const d = E.draft;
    if (d.tool === 'erect') {
      if (Math.abs(p[0] - d.pts[0]) * app.view.scale < 2 || Math.abs(p[1] - d.pts[1]) * app.view.scale < 2) return;
      commit('Rectangle', [{ i: newIdx(), before: null, after: rectEntity(d.pts, p, newProps(isDgn() ? 'SHAPE' : 'LWPOLYLINE')) }]);
    } else {
      const r = Math.hypot(p[0] - d.pts[0], p[1] - d.pts[1]);
      if (r * app.view.scale < 2) return;
      commit('Circle', [{ i: newIdx(), before: null, after: { ...newProps(isDgn() ? 'ELLIPSE' : 'CIRCLE'), type: 'circle', c: d.pts.slice(0, 2), r } }]);
    }
    E.draft = null;
  }

  function selectDown(sx, sy, ev) {
    // 1) a handle of the item being reshaped
    if (E.vedit >= 0) {
      const g = gripAt(sx, sy);
      if (g >= 0) {
        const e = entity(E.vedit), grip = gripsOf(e)[g];
        E.gdrag = { grip, k: g, start: [grip.x, grip.y], sx, sy, moved: false };
        return;
      }
    }
    const hit = pickEnt(sx, sy);
    if (hit >= 0) {
      // Shift: a click toggles the item, a drag moves the selection kept straight (decided on move/release)
      const wasSel = E.sel.has(hit);
      if (!wasSel && !ev.shiftKey) { E.sel = new Set([hit]); E.selPath = null; if (E.vedit !== hit) endVedit(); }
      const base = pointAt(sx, sy, ev, {});
      E.drag = { sx, sy, base: [base.x, base.y], hit, wasSel, shift: ev.shiftKey, moving: false, dx: 0, dy: 0 };
      status(); updateRibbon(); api.invalidate();
      return;
    }
    E.box = { x0: sx, y0: sy, x1: sx, y1: sy, add: ev.shiftKey };
    api.invalidate();
  }

  function move(sx, sy, ev, pressed) {
    if (!scene() || !E.ready) return;
    E.lastPointer = ev.pointerType;
    if (E.lp && Math.hypot(sx - E.lp.sx, sy - E.lp.sy) > 8) cancelLongPress();
    E.mouse = ev.pointerType === 'mouse' ? [sx, sy] : null;
    if (E.place) { const c = (E.cursor = pointAt(sx, sy, ev)); E.place.at = [c.x, c.y]; api.invalidate(); return; }
    const t = app.tool;
    if (t !== 'eselect') {
      E.cursor = pointAt(sx, sy, ev, { from: E.draft && E.draft.pts.length ? E.draft.pts.slice(-2) : null });
      if (pressed && E.draft && (t === 'erect' || t === 'ecircle')) E.draft.dragging = Math.hypot(sx - E.draft.s0[0], sy - E.draft.s0[1]) > 6;
      if (E.lenBox) placeLen();
      api.invalidate();
      return;
    }
    if (E.gdrag) {
      const g = E.gdrag;
      if (!g.moved && Math.hypot(sx - g.sx, sy - g.sy) < 3) return;
      g.moved = true;
      const c = pointAt(sx, sy, ev, { from: g.start, skip: new Set([E.vedit]) });
      E.cursor = c;
      g.to = [c.x, c.y];
      g.preview = entityPath(moveGrip(entity(E.vedit), g.grip, c.x, c.y));
      api.invalidate();
      return;
    }
    if (E.drag) {
      const d = E.drag;
      if (!d.moving && Math.hypot(sx - d.sx, sy - d.sy) < (coarse() ? 8 : 4)) return;
      cancelLongPress();
      if (!d.moving && d.shift && !E.sel.has(d.hit)) { E.sel.add(d.hit); E.selPath = null; }
      d.moving = true;
      if (!!d.copy !== copyKey(ev)) { d.copy = copyKey(ev); hint(d.copy ? 'Copy: release to drop a copy (the originals stay)' : ''); api.setCursor(d.copy ? 'copy' : 'move'); }
      const c = pointAt(sx, sy, ev, { from: d.base, skip: E.sel });
      E.cursor = c;
      d.dx = c.x - d.base[0]; d.dy = c.y - d.base[1];
      api.invalidate();
      return;
    }
    if (E.box) { E.box.x1 = sx; E.box.y1 = sy; if (Math.hypot(sx - E.box.x0, sy - E.box.y0) > 4) cancelLongPress(); api.invalidate(); return; }
    if (!pressed) {
      E.cursor = null;
      let gh = -1;
      if (E.vedit >= 0) gh = gripAt(sx, sy);
      const h = gh >= 0 ? E.vedit : pickEnt(sx, sy);
      if (gh !== E.gripHover || h !== E.hover) { E.gripHover = gh; E.hover = h; status(); api.invalidate(); }
      api.setCursor(gh >= 0 ? 'grab' : h >= 0 ? 'move' : 'pointer');
    }
  }

  function up(sx, sy, ev) {
    cancelLongPress();
    if (E.lpFired) { E.lpFired = false; E.drag = E.box = E.gdrag = null; return; }
    if (E.place) {
      if (E.place.down) { const c = pointAt(sx, sy, ev); placeAt([c.x, c.y]); }
      return;
    }
    const t = app.tool;
    if (t === 'etext') {
      const pt = E.pendingText;
      E.pendingText = null;
      if (pt && Math.hypot(sx - pt.sx, sy - pt.sy) < 10) openText({ create: true, at: pt.at });
      return;
    }
    if (t === 'erect' || t === 'ecircle') {
      if (E.draft && E.draft.dragging) { const c = pointAt(sx, sy, ev, {}); completeShape([c.x, c.y]); api.invalidate(); }
      return;
    }
    if (t !== 'eselect') return;
    if (E.gdrag) {
      const g = E.gdrag;
      E.gdrag = null;
      if (g.moved && g.to) {
        const e = entity(E.vedit);
        commit('Edit point', [{ i: E.vedit, before: e, after: moveGrip(e, g.grip, g.to[0], g.to[1]) }], [E.vedit]);
      }
      api.invalidate();
      return;
    }
    if (E.drag) {
      const d = E.drag;
      E.drag = null;
      if (d.moving && d.copy) { hint(''); pasteNow(dupPrep(), [d.dx, d.dy], 'Copy'); }
      else if (d.moving && (d.dx || d.dy)) {
        const ids = [...E.sel];
        commit(ids.length > 1 ? `Move ${ids.length} items` : 'Move', ids.map((i) => ({ i, before: entity(i), after: moveEntity(entity(i), d.dx, d.dy) })), ids);
      } else if (d.shift) { if (d.wasSel) E.sel.delete(d.hit); else E.sel.add(d.hit); E.selPath = null; status(); updateRibbon(); }
      else if (d.wasSel && E.sel.size > 1) { E.sel = new Set([d.hit]); E.selPath = null; status(); updateRibbon(); }
      api.invalidate();
      return;
    }
    if (E.box) {
      const b = E.box;
      E.box = null;
      if (Math.abs(b.x1 - b.x0) > 4 || Math.abs(b.y1 - b.y0) > 4) {
        const [ax, ay] = app.view.toWorld(Math.min(b.x0, b.x1), Math.max(b.y0, b.y1));
        const [bx, by] = app.view.toWorld(Math.max(b.x0, b.x1), Math.min(b.y0, b.y1));
        const t0 = performance.now();
        const found = selectInRect(scene(), [ax, ay, bx, by], b.x1 < b.x0 ? 'crossing' : 'window', vis);
        E.lastSelect = { mode: b.x1 < b.x0 ? 'crossing' : 'window', count: found.size, ms: performance.now() - t0 };
        const next = b.add ? new Set([...E.sel, ...found]) : found;
        for (const i of [...next]) if (!entity(i)) next.delete(i);
        E.sel = next;
      } else if (!b.add) { E.sel = new Set(); endVedit(); }
      E.selPath = null;
      status(); updateRibbon(); api.invalidate();
    }
  }

  function dbl(sx, sy) {
    if (!E.ready || E.place) return;
    const t = app.tool;
    if (t === 'epoly' || t === 'eline') { if (t === 'epoly') finishDraft(); else cancelDraft(); return; }
    if (t !== 'eselect') return;
    if (E.vedit >= 0 && addPointAt(sx, sy)) return;
    const hit = pickEnt(sx, sy);
    if (hit < 0) return;
    editEntity(hit, sx, sy);
  }
  /** Double-click / "Edit" on an entity: text editor (also for a text inside a cell or insert), reshape handles, or a hint. */
  function editEntity(i, sx, sy, sub) {
    const e = entity(i);
    if (!e) return;
    E.sel = new Set([i]); E.selPath = null;
    if (isText(e)) { openText({ ent: i }); return; }
    if (e.type === 'insert' || e.type === 'cell') {
      // which text inside: given (a path from the scene), or the one under the cursor
      const part = sub ? (sub[0] === '#' ? { shared: true } : { sub }) : sx != null ? partTextAt(i, sx, sy) : null;
      if (part && part.sub) { openText({ ent: i, sub: part.sub }); return; }
      hint(part && part.shared ? SHARED_HINT : BLOCK_HINT, 4500);
    } else if (canReshape(e) && e.type !== 'point') { E.vedit = i; hint(coarse() ? VEDIT_HINT_TOUCH : VEDIT_HINT); }
    else if (e.type === 'dimension') hint(DIM_HINT, 4000);
    else hint('This item can be moved, rotated, restyled or deleted, but not reshaped', 4000);
    status(); updateRibbon(); api.invalidate();
  }
  /**
   * The text inside cell / insert i under the cursor (the smallest one when they overlap):
   * { sub } when it can be edited on its own, { shared: true } for block-definition text, else null.
   */
  function partTextAt(i, sx, sy) {
    const s = scene();
    if (!s) return null;
    const [lx, ly] = app.view.toWorld(sx, sy);
    const tol = (coarse() ? 10 : 4) / app.view.scale;
    let best = null, area = Infinity;
    for (const k of entityItems(s, i).texts) {
      const x = s.texts[k];
      if (!x || x.dead || !x.sub || !vis(x.layer)) continue;
      const b = x.bbox;
      if (lx < b[0] - tol || lx > b[2] + tol || ly < b[1] - tol || ly > b[3] + tol) continue;
      const a = (b[2] - b[0]) * (b[3] - b[1]);
      if (a < area) { area = a; best = x; }
    }
    if (!best) return null;
    return best.sub[0] === '#' ? { shared: true } : { sub: best.sub };
  }
  /** Leave reshaping (handles hidden, the tool's own hint back). */
  function endVedit() { if (E.vedit >= 0) { E.vedit = -1; E.gripHover = -1; hint(''); } }
  function gripAt(sx, sy) {
    const e = entity(E.vedit);
    if (!e) return -1;
    const tol = coarse() ? 22 : 9;
    let best = -1, bd = Infinity;
    gripsOf(e).forEach((g, k) => { const [x, y] = W2S(g.x, g.y); const d = Math.hypot(x - sx, y - sy); if (d <= tol && d < bd) { bd = d; best = k; } });
    return best;
  }
  function segmentAt(sx, sy) {
    const e = entity(E.vedit);
    if (!e) return null;
    const [x, y] = S2W(sx, sy);
    const tol = (coarse() ? 16 : 7) / app.view.scale;
    let best = null;
    for (const sg of segmentsOf(e)) { const r = nearestOnSegment(sg, x, y); if (r.d <= tol && (!best || r.d < best.d)) best = { ...r, i: sg.i }; }
    return best;
  }
  function addPointAt(sx, sy) {
    if (gripAt(sx, sy) >= 0) return false;
    const sg = segmentAt(sx, sy);
    if (!sg) return false;
    const e = entity(E.vedit);
    commit('Add point', [{ i: E.vedit, before: e, after: insertVertex(e, sg.i, sg.x, sg.y) }], [E.vedit]);
    return true;
  }
  function deletePointAt(sx, sy) {
    const g = gripAt(sx, sy);
    if (g < 0) return false;
    const e = entity(E.vedit), grip = gripsOf(e)[g];
    if (grip.kind !== 'v' || e.type === 'point') return false;
    const ne = deleteVertex(e, grip.k);
    if (ne === null) { hint(e.type === 'line' ? 'A line needs both ends — delete the line instead' : 'Too few points left — delete the item instead', 3000); return true; }
    commit('Delete point', [{ i: E.vedit, before: e, after: ne }], [E.vedit]);
    return true;
  }

  /** Right-click (mouse) or long-press (touch) at a point. */
  function context(sx, sy) {
    if (!E.ready || app.tool !== 'eselect') return false;
    if (E.place) return cancelDraft(); // right-click while placing: cancel
    if (E.vedit >= 0) {
      if (deletePointAt(sx, sy)) return true;
      if (addPointAt(sx, sy)) return true;
    }
    const hit = pickEnt(sx, sy);
    const pastes = E.clip ? [{ label: 'Paste here', act: () => { const c = pointAt(sx, sy); pasteNow(prep(E.clip), null, 'Paste', [c.x, c.y]); } }, { label: 'Paste in place', act: () => paste(null, true) }] : [];
    if (hit < 0) { if (pastes.length) openMenu(sx, sy, pastes); return !!pastes.length; }
    if (!E.sel.has(hit)) { E.sel = new Set([hit]); E.selPath = null; updateRibbon(); status(); }
    openMenu(sx, sy, [
      { label: 'Edit…', act: () => editEntity(hit, sx, sy) },
      { label: 'Copy', act: copyButton },
      { label: 'Duplicate', act: duplicateSel },
      { label: 'Rotate 90°', act: () => rotateSel(Math.PI / 2) },
      { label: 'Delete', act: deleteSel },
      ...pastes,
    ]);
    api.invalidate();
    return true;
  }
  function startLongPress(sx, sy, ev) {
    cancelLongPress();
    if (ev.pointerType !== 'touch' || app.tool !== 'eselect') return;
    E.lp = { sx, sy, timer: setTimeout(() => {
      E.lp = null;
      // long-press on a handle: offer to delete it; on a side: add a point; on an item: menu
      if (E.vedit >= 0) {
        const g = gripAt(sx, sy);
        if (g >= 0) { E.lpFired = true; E.gdrag = null; openMenu(sx, sy, [{ label: 'Delete point', act: () => deletePointAt(sx, sy) }]); return; }
        const sg = segmentAt(sx, sy);
        if (sg) { E.lpFired = true; E.drag = null; openMenu(sx, sy, [{ label: 'Add point here', act: () => addPointAt(sx, sy) }, { label: 'Delete', act: () => deleteSel() }]); return; }
      }
      E.lpFired = true; E.drag = null; E.box = null;
      context(sx, sy);
    }, 550) };
  }
  function cancelLongPress() { if (E.lp) { clearTimeout(E.lp.timer); E.lp = null; } }
  /** Two fingers went down, or the gesture was cancelled. */
  function cancelGesture() { cancelLongPress(); E.drag = null; E.box = null; E.gdrag = null; api.invalidate(); }

  // ---------------------------------------------------------------- commands
  function deleteSel() {
    if (!E.sel.size) return false;
    const ids = [...E.sel];
    commit(ids.length > 1 ? `Delete ${ids.length} items` : 'Delete', ids.map((i) => ({ i, before: entity(i), after: null })), []);
    endVedit();
    return true;
  }
  /** World extents of entity slots `ids`. */
  function extOf(ids) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const i of ids) { const q = entityBBox(scene(), i); if (!q) continue; b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[2]); b[3] = Math.max(b[3], q[3]); }
    const [ox, oy] = scene().origin;
    return b[0] <= b[2] ? [b[0] + ox, b[1] + oy, b[2] + ox, b[3] + oy] : [0, 0, 0, 0];
  }
  function selCentre() { const b = extOf(E.sel); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
  function rotateSel(a) {
    if (!E.sel.size) return;
    const [cx, cy] = selCentre();
    const ids = [...E.sel];
    commit('Rotate', ids.map((i) => ({ i, before: entity(i), after: rotateEntity(entity(i), a, cx, cy) })), ids);
  }
  function nudge(dxPx, dyPx) {
    if (!E.sel.size) return false;
    const dx = dxPx / app.view.scale, dy = dyPx / app.view.scale;
    const ids = [...E.sel];
    commit('Nudge', ids.map((i) => ({ i, before: entity(i), after: moveEntity(entity(i), dx, dy) })), ids);
    return true;
  }
  function selectAll() {
    const m = model();
    if (!m) return;
    E.sel = new Set();
    m.entities.forEach((e, i) => { if (e) E.sel.add(i); });
    E.selPath = null; status(); updateRibbon(); api.invalidate();
  }
  // ---------------------------------------------------------------- copy, paste, duplicate
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  /** Ctrl (Alt on macOS) while dragging: drop a copy, keep the originals. */
  const copyKey = (ev) => !!(isMac ? ev.altKey : ev.ctrlKey);
  const plural = (n) => `${n} item${n === 1 ? '' : 's'}`;
  /**
   * Copy the selection: kept in this tab (survives opening another drawing) and returned as
   * clipboard text (a stub when too large for the system clipboard; null: nothing to copy).
   */
  function copySel() {
    if (!E.ready || !inEdit() || !E.sel.size || E.text || E.draft) return null;
    const ids = [...E.sel];
    E.clip = makePayload(model(), ids, { ext: extOf(ids) });
    const t = clipText(E.clip), big = t.length > CLIP_MAX;
    toast(`Copied ${plural(ids.length)}`, { timeout: 2000, detail: big ? 'Too large for the system clipboard: paste it in this tab.' : 'Paste it here or in another drawing (Ctrl+V).' });
    updateRibbon();
    return big ? CLIP_HEADER + '\n{"v":1,"ents":[],"big":1}' : t;
  }
  function copyButton() { const t = copySel(); if (t && navigator.clipboard) navigator.clipboard.writeText(t).catch(() => {}); }
  const prep = (P) => preparePaste(P, model(), { layer: E.curLayer });
  const dupPrep = () => { const ids = [...E.sel]; return preparePaste(makePayload(model(), ids, { ext: extOf(ids) }), model(), { layer: E.curLayer }); };
  /** Paste P (null: this tab's last copy) so that it follows the cursor, or in place (same coordinates). */
  async function paste(P, inPlace) {
    if (P && P.big && E.clip) P = null; // our own oversized copy: the full one is here
    P = P || E.clip;
    if (!app.scene || E.text || E.draft || E.place) return;
    if (!P || !P.ents.length) { toast(P ? 'That copy was too large for the clipboard: copy fewer items.' : 'Nothing to paste yet: select items and copy them (Ctrl+C) first.', { timeout: 3500 }); return; }
    if (!(await whenReady())) return;
    if (app.tool !== 'eselect') api.setTool('eselect');
    E.clip = P;
    const r = prep(P);
    if (inPlace) pasteNow(r, null, 'Paste'); else startPlace(r, 'Paste');
  }
  function duplicateSel() { if (E.ready && E.sel.size && !E.place) startPlace(dupPrep(), 'Duplicate'); }
  /** The items follow the cursor (snaps on); a click or tap places them, Esc cancels. */
  function startPlace(r, label) {
    if (!r.ents.length) return;
    cancelDraft(); endVedit(); closeMenus();
    const m = model(), s = scene(), tm = { ...m };
    for (const c of r.changes) if (c.table) tm[c.table] = { ...tm[c.table], [c.key]: c.after };
    // private copies of the scene tables: the preview must not add layers to the real ones
    const tables = sceneTables(tm, { ...s, layers: s.layers.slice(), ltypes: s.ltypes.slice(), srcNames: s.srcNames.slice(), blockNames: s.blockNames.slice() });
    const c = E.mouse ? pointAt(...E.mouse) : null;
    E.place = { r, label, path: entityPath(r.ents, tm, tables), at: c ? [c.x, c.y] : S2W(app.view.w / 2, app.view.h / 2) };
    hint(`${coarse() ? 'Tap' : 'Click'} to place ${plural(r.ents.length)} (lower-left corner at the ${coarse() ? 'finger' : 'cursor'}) · Esc cancels`);
    api.setInfo(`${label}: ${plural(r.ents.length)}`);
    api.updateFinishBar(); api.invalidate();
  }
  function placeAt(p) { const P = E.place; E.place = null; hint(''); api.updateFinishBar(); pasteNow(P.r, [p[0] - P.r.base[0], p[1] - P.r.base[1]], P.label); }
  /** Commit a paste as one undo step. d: offset from the copied position, or to: where the base point goes. */
  function pasteNow(r, d, label, to) {
    if (to) d = [to[0] - r.base[0], to[1] - r.base[1]];
    const i0 = newIdx(), ids = r.ents.map((_, k) => i0 + k);
    const ents = d && (d[0] || d[1]) ? r.ents.map((e) => moveEntity(e, d[0], d[1])) : r.ents;
    commit(`${label} ${plural(ents.length)}`, [...r.changes, ...ents.map((e, k) => ({ i: i0 + k, before: null, after: e }))], ids);
    if (r.notes.length) toast(`${label}: ${plural(ents.length)}`, { list: r.notes, timeout: 6000 });
  }

  function applyProps(props) {
    if (!E.sel.size) return;
    const ids = [...E.sel];
    commit('Change properties', ids.map((i) => ({ i, before: entity(i), after: restyle(entity(i), props, fmt()) })), ids);
  }

  // ---------------------------------------------------------------- keyboard
  /** Returns true when the key was handled. */
  function key(e) {
    if (!inEdit() || !E.ready) return false;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const d = E.draft;
    if (d && (d.tool === 'eline' || d.tool === 'epoly') && /^[0-9.]$/.test(e.key) && !E.lenBox) { openLen(e.key); e.preventDefault(); return true; }
    if (e.key === 'Escape') {
      if (closeMenus()) return true;
      if (cancelDraft()) return true;
      if (E.vedit >= 0) { endVedit(); api.invalidate(); return true; }
      if (E.sel.size) { E.sel = new Set(); E.selPath = null; status(); updateRibbon(); api.invalidate(); return true; }
      return false;
    }
    if (e.key === 'Enter' && E.place) { finishDraft(); e.preventDefault(); return true; }
    if (e.key === 'Enter') { if (d) { if (d.tool === 'epoly') finishDraft(); else cancelDraft(); e.preventDefault(); return true; } return false; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (undoDraftPoint()) return true; deleteSel(); return true; }
    if (k === 'c' && d && d.tool === 'epoly' && d.pts.length >= 6) { d.close = true; finishDraft(); return true; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key] && E.sel.size && app.tool === 'eselect') {
      e.preventDefault();
      const f = e.shiftKey ? 10 : 1;
      nudge(arrows[e.key][0] * f, -arrows[e.key][1] * f);
      return true;
    }
    if (EDIT_KEYS[k] && !e.shiftKey) { api.setTool(EDIT_KEYS[k]); return true; }
    return false;
  }

  // ---------------------------------------------------------------- typed length (line / polyline)
  function openLen(first) {
    const box = $('#len-box'), inp = $('#inp-len');
    E.lenBox = true;
    box.hidden = false;
    $('#len-unit').textContent = scene().units.abbr || '';
    inp.value = first || '';
    placeLen();
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  }
  function placeLen() {
    const c = E.cursor, box = $('#len-box');
    if (!c || box.hidden) return;
    box.style.left = `${Math.min(app.view.w - 170, c.sx + 16)}px`;
    box.style.top = `${Math.max(4, c.sy - 40)}px`;
  }
  function hideLen() { E.lenBox = false; const b = $('#len-box'); if (b) b.hidden = true; }
  function applyLen() {
    const L = parseFloat($('#inp-len').value.replace(',', '.'));
    hideLen();
    const d = E.draft, c = E.cursor;
    if (!d || !c || !(L > 0)) return;
    const a = d.pts.slice(-2);
    let dx = c.x - a[0], dy = c.y - a[1];
    const n = Math.hypot(dx, dy);
    if (n < 1e-12) { dx = 1; dy = 0; } else { dx /= n; dy /= n; }
    const p = [a[0] + dx * L, a[1] + dy * L];
    if (d.tool === 'eline') addLine(p); else d.pts.push(...p);
    api.invalidate();
  }
  $('#inp-len').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); applyLen(); api.focusStage(); }
    else if (e.key === 'Escape') { e.preventDefault(); hideLen(); api.focusStage(); }
  });

  // ---------------------------------------------------------------- in-place text editor
  function defaultTextHeight() {
    const s = scene();
    const hs = [];
    for (let k = 0; k < s.texts.length && hs.length < 400; k += Math.max(1, Math.floor(s.texts.length / 400))) { const t = s.texts[k]; if (!t.dead) hs.push(Math.hypot(t.m[2], t.m[3])); }
    if (hs.length) { hs.sort((a, b) => a - b); return hs[Math.floor(hs.length / 2)]; }
    return 14 / app.view.scale;
  }
  function openText(o) {
    closeText(true);
    const s = scene(), ed = $('#edit-text'), ta = $('#ta-edit');
    let ax, ay, rot = 0, capPx, align = 0, value = '', multi = false, minW = 0;
    if (o.create) {
      const h = defaultTextHeight();
      [ax, ay] = W2S(o.at[0], o.at[1]);
      capPx = h * app.view.scale;
      E.text = { create: true, at: o.at, h };
    } else {
      const e = entity(o.ent);
      const part = o.sub ? partAt(e, o.sub) : e;
      if (!part) return;
      const it = entityItems(s, o.ent);
      const mine = it.texts.map((k) => s.texts[k]).filter((x) => x && !x.dead && (!o.sub || x.sub === o.sub));
      const t = mine[0];
      if (!t) return;
      const [ox, oy] = s.origin;
      [ax, ay] = W2S(t.x + ox, t.y + oy);
      rot = Math.atan2(t.m[1], t.m[0]);
      capPx = Math.hypot(t.m[2], t.m[3]) * app.view.scale;
      align = t.align;
      value = part.text;
      // at least as wide as the drawn text, so the box covers it
      for (const x of mine) minW = Math.max(minW, (x.w != null ? x.w : CHAR_W * x.s.length) * Math.hypot(x.m[0], x.m[1]) * app.view.scale);
      multi = part.type === 'mtext';
      E.text = { ent: o.ent, sub: o.sub || null };
    }
    Object.assign(E.text, { multi, minW, ax, ay, rot, align, fontPx: Math.max(12, Math.min(160, capPx / CAP_HEIGHT)) });
    ta.value = value;
    ta.style.fontSize = `${E.text.fontPx}px`;
    ed.hidden = false;
    autoSize();
    if (o.ent != null) { E.sel = new Set([o.ent]); E.selPath = null; }
    ta.focus();
    ta.select();
    updateRibbon();
    api.invalidate();
  }
  /** Size the box to its text (never narrower than the drawn text) and place it over the text. */
  function autoSize() {
    const st = E.text;
    if (!st) return;
    const ta = $('#ta-edit'), ed = $('#edit-text');
    const lines = ta.value.split('\n');
    ta.rows = Math.max(1, lines.length);
    ta.style.width = `${Math.max(st.minW + 12, Math.max(...lines.map((l) => l.length), 3) * 0.62 * st.fontPx + 16)}px`;
    const w = ta.offsetWidth, ascent = st.fontPx * 0.98;
    const offX = st.align === 0 ? -4 : st.align === 1 ? -w / 2 : -w + 4;
    ed.style.transform = `translate(${st.ax}px, ${st.ay}px) rotate(${-st.rot}rad) translate(${offX}px, ${-ascent}px)`;
    const hintEl = $('#et-hint');
    hintEl.textContent = st.multi ? 'Ctrl+Enter to finish · Enter for a new line · Esc cancels' : 'Enter to finish · Esc cancels';
    hintEl.hidden = false;
    const r = ed.getBoundingClientRect(), sr = $('#stage').getBoundingClientRect();
    hintEl.style.left = `${Math.max(8, Math.min(app.view.w - hintEl.offsetWidth - 8, r.left - sr.left))}px`;
    const below = r.bottom - sr.top + 6;
    hintEl.style.top = `${below + 30 < app.view.h ? below : Math.max(4, r.top - sr.top - 32)}px`;
  }
  function closeText(commitIt) {
    const st = E.text;
    if (!st) return;
    E.text = null;
    $('#edit-text').hidden = true;
    $('#et-hint').hidden = true;
    if (!commitIt) { api.invalidate(); return; }
    const v = $('#ta-edit').value.replace(/\s+$/, '');
    if (st.create) {
      if (!v.trim()) return;
      const multi = v.includes('\n');
      const P = newProps(multi ? 'MTEXT' : 'TEXT');
      const e = multi
        ? { ...P, type: 'mtext', p: st.at, h: st.h, rot: 0, text: v, attach: 1, width: 0, spacing: 1, wf: 1 }
        : { ...P, type: 'text', p: st.at, h: st.h, rot: 0, text: v, halign: 0, valign: 0, wf: 1, oblique: 0 };
      const i = newIdx();
      commit('Text', [{ i, before: null, after: e }], [i]);
      return;
    }
    const e = entity(st.ent);
    if (st.sub) { // a text inside a cell or insert: the whole cell/insert is the undoable change
      const part = e && partAt(e, st.sub);
      if (!part || v === part.text) { api.invalidate(); return; }
      const attr = /(^|\.)a\d+$/.test(st.sub); // an attribute is kept even when cleared
      const after = withPart(e, st.sub, v.trim() || attr ? setText(part, v) : null);
      commit(v.trim() ? 'Edit text' : attr ? 'Clear attribute' : 'Delete text', [{ i: st.ent, before: e, after }], [st.ent]);
      return;
    }
    if (!e || v === e.text) { api.invalidate(); return; }
    if (!v.trim()) commit('Delete', [{ i: st.ent, before: e, after: null }], []);
    else commit('Edit text', [{ i: st.ent, before: e, after: setText(e, v) }], [st.ent]);
  }
  const ta = $('#ta-edit');
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeText(false); api.focusStage(); return; }
    if (e.key === 'Enter') {
      const multi = E.text && (E.text.multi || E.text.create);
      if (!multi || e.ctrlKey || e.metaKey || (E.text.create && !e.shiftKey && !ta.value.includes('\n'))) { e.preventDefault(); closeText(true); api.focusStage(); }
    }
  });
  ta.addEventListener('input', autoSize);
  ta.addEventListener('blur', () => { setTimeout(() => { if (E.text && document.activeElement !== ta) closeText(true); }, 0); });

  // ---------------------------------------------------------------- menus, hints
  function openMenu(sx, sy, items) {
    const m = $('#ctx-menu');
    m.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'menuitem'); b.textContent = it.label;
      b.addEventListener('click', () => { m.hidden = true; it.act(); });
      m.appendChild(b);
    }
    m.hidden = false;
    m.style.left = `${Math.max(4, Math.min(app.view.w - m.offsetWidth - 4, sx))}px`;
    m.style.top = `${Math.max(4, Math.min(app.view.h - m.offsetHeight - 4, sy))}px`;
    m.querySelector('button').focus();
  }
  function closeMenus() {
    let was = false;
    for (const id of ['#ctx-menu', '#color-pop']) { const m = $(id); if (m && !m.hidden) { m.hidden = true; was = true; } }
    for (const id of ['#btn-ecolor', '#btn-eweight']) $(id).setAttribute('aria-expanded', 'false');
    return was;
  }
  let hintTimer = 0;
  function hint(text, ms = 0) {
    const h = $('#tool-hint');
    clearTimeout(hintTimer);
    if (!text) { api.restoreHint(); return; }
    h.hidden = false; h.textContent = text;
    if (ms) hintTimer = setTimeout(() => api.restoreHint(), ms);
  }

  // ---------------------------------------------------------------- status bar, ribbon
  const TYPE_NAME = { line: 'Line', polyline: 'Polyline', spline: 'Curve', circle: 'Circle', arc: 'Arc', ellipse: 'Ellipse', text: 'Text', mtext: 'Text',
    insert: 'Block', point: 'Point', solid: 'Solid fill', hatch: 'Hatch', dimension: 'Dimension', cell: 'Cell' };
  function describe(e) {
    if (!e) return '';
    let t = TYPE_NAME[e.type] || e.type;
    if (e.type === 'insert') t += ` “${e.block}”`;
    if (e.type === 'cell') t += ` “${e.name}”`;
    if (e.type === 'polyline' && e.closed) t = 'Closed polyline';
    if (isText(e)) t += ` “${String(e.text).replace(/\n/g, ' ').slice(0, 40)}”`;
    const c = colorInfo(e, fmt());
    return `${t} · Layer ${e.layer ?? '0'} · ${c.label} · ${weightLabel(e, fmt())}`;
  }
  function status() {
    if (!inEdit()) return;
    let txt = '';
    if (E.sel.size === 1) txt = '1 selected · ' + describe(entity([...E.sel][0]));
    else if (E.sel.size > 1) {
      const kinds = new Map(), layers = new Set(), ws = new Set();
      for (const i of E.sel) { const e = entity(i); if (!e) continue; const n = TYPE_NAME[e.type] || e.type; kinds.set(n, (kinds.get(n) || 0) + 1); layers.add(e.layer ?? '0'); ws.add(weightLabel(e, fmt())); }
      txt = `${E.sel.size} selected · ${[...kinds].map(([k, v]) => `${v} ${k.toLowerCase()}${v > 1 ? 's' : ''}`).slice(0, 3).join(', ')} · ${layers.size === 1 ? 'Layer ' + [...layers][0] : layers.size + ' layers'}${ws.size === 1 ? ' · ' + [...ws][0] : ''}`;
    }
    if (E.hover >= 0 && !E.sel.has(E.hover)) txt = (txt ? txt + '   |   ' : '') + describe(entity(E.hover));
    api.setInfo(txt);
  }
  function updateRibbon() {
    const has = E.ready && E.sel.size > 0;
    for (const id of ['#btn-edelete', '#btn-erotate', '#btn-ecopy', '#btn-edup']) $(id).disabled = !has;
    $('#btn-epaste').disabled = !E.clip || !app.scene;
    for (const id of ['#btn-esave', '#btn-esaveas']) $(id).disabled = !app.scene;
    // show the selection's layer / colour when they are uniform
    if (has) {
      const es = [...E.sel].map(entity).filter(Boolean);
      const L = es[0].layer ?? '0';
      if (es.every((e) => (e.layer ?? '0') === L)) $('#sel-elayer').value = L;
    } else if (E.curLayer) $('#sel-elayer').value = E.curLayer;
    paintColorButton();
    paintWeightButton();
  }
  function fillLayers() {
    const sel = $('#sel-elayer');
    const names = E.doc ? E.doc.layerNames() : [];
    if (!E.curLayer || !names.includes(E.curLayer)) {
      const used = scene().layers.filter((l) => !l.removed && l.count > 0 && l.name !== '0' && l.name.toUpperCase() !== 'DEFPOINTS');
      E.curLayer = (used[0] || { name: names[0] || '0' }).name;
    }
    sel.innerHTML = names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('') + '<option value="__new">New layer…</option>';
    sel.value = E.curLayer;
  }
  function colorSwatch(c) {
    if (c === 'bylayer') return { cls: 'bylayer', label: 'ByLayer', css: '' };
    if (c.ci != null) return { cls: (c.rgb & 0xffffff) === 0xffffff ? 'fg' : '', label: `Colour ${c.ci}`, css: '#' + (c.rgb & 0xffffff).toString(16).padStart(6, '0') };
    return { cls: c.aci === 7 ? 'fg' : '', label: COLOR_NAMES[c.aci] || `Colour ${c.aci}`, css: c.aci === 7 ? '' : '#' + ACI[c.aci].toString(16).padStart(6, '0') };
  }
  function paintColorButton() {
    const sw = colorSwatch(E.curColor || 'bylayer');
    const el = $('#ecolor-sw');
    el.className = 'sw ' + sw.cls;
    el.style.setProperty('--c', sw.css || 'transparent');
    $('#ecolor-label').textContent = sw.label;
  }
  function colorChoices() {
    if (isDgn()) { // the file's own colour table: the first 16 entries
      const pal = E.palette || [];
      return Array.from({ length: 16 }, (_, ci) => ({ ci, rgb: pal[ci] ?? 0xffffff }));
    }
    return ['bylayer', ...DXF_COLORS.map((aci) => ({ aci }))];
  }
  /** The colour or the weight list, under its ribbon button. items: [{ html, on, act }] */
  function openPop(btn, items, cols) {
    const pop = $('#color-pop');
    if (!pop.hidden) { const was = pop.dataset.for; closeMenus(); if (was === btn.id) return; }
    pop.dataset.for = btn.id;
    pop.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(it.on));
      b.innerHTML = it.html;
      b.addEventListener('click', () => { closeMenus(); it.act(); });
      pop.appendChild(b);
    }
    pop.style.gridTemplateColumns = `repeat(${cols}, auto)`;
    pop.hidden = false;
    const r = btn.getBoundingClientRect(), st = $('#stage').getBoundingClientRect();
    pop.style.left = `${Math.max(4, Math.min(st.width - pop.offsetWidth - 4, r.left - st.left))}px`;
    pop.style.top = '6px';
    btn.setAttribute('aria-expanded', 'true');
    (pop.querySelector('[aria-checked="true"]') || pop.querySelector('button')).focus();
  }
  function openColorPop() {
    openPop($('#btn-ecolor'), colorChoices().map((c) => {
      const sw = colorSwatch(c);
      return { html: `<i class="sw ${sw.cls}" style="--c:${sw.css || 'transparent'}"></i> ${esc(sw.label)}`, on: JSON.stringify(c) === JSON.stringify(E.curColor), act: () => setColor(c) };
    }), 4);
  }
  // line weights: DGN 0-31, DXF ByLayer + the standard lineweights (mm)
  const weightName = (w) => (isDgn() ? String(w) : w < 0 ? 'ByLayer' : (w / 100).toFixed(2) + ' mm');
  const weightLine = (w) => `<i class="lw" style="--w:${isDgn() ? weightPx(w, 'DGN') : weightPx(DXF_LW.indexOf(w) + 1, 'DXF')}px"></i>`;
  function openWeightPop() {
    const list = isDgn() ? Array.from({ length: 32 }, (_, w) => w) : [-1, ...DXF_LW];
    openPop($('#btn-eweight'), list.map((w) => ({ html: `${weightLine(w)} ${weightName(w)}`, on: w === E.curWeight, act: () => setWeight(w) })), isDgn() ? 4 : 3);
  }
  function paintWeightButton() { $('#eweight-sw').outerHTML = weightLine(E.curWeight).replace('<i ', '<i id="eweight-sw" '); $('#eweight-label').textContent = weightName(E.curWeight); }
  function setWeight(w) {
    E.curWeight = w;
    paintWeightButton();
    if (E.sel.size) applyProps({ weight: w });
  }
  function setColor(c) {
    E.curColor = c;
    paintColorButton();
    if (E.sel.size) applyProps({ color: c });
  }

  // new layer dialog
  function openLayerDialog() {
    const dlg = $('#dlg-layer');
    const sws = $('#layer-swatches');
    const choices = isDgn() ? [] : [1, 2, 3, 4, 5, 6, 7, 8, 30];
    let picked = 7;
    $('#layer-name').value = isDgn() ? nextLevelName() : 'NEW-LAYER';
    $('#layer-name').readOnly = isDgn();
    sws.parentElement.hidden = isDgn();
    sws.innerHTML = '';
    for (const aci of choices) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'swatch'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(aci === picked));
      b.title = COLOR_NAMES[aci] || 'Colour ' + aci; b.setAttribute('aria-label', b.title);
      b.style.setProperty('--c', aci === 7 ? '#888' : '#' + ACI[aci].toString(16).padStart(6, '0'));
      if (aci === 7) b.style.background = 'linear-gradient(135deg, #fff 50%, #000 50%)';
      b.addEventListener('click', () => { picked = aci; for (const x of sws.children) x.setAttribute('aria-checked', String(x === b)); });
      sws.appendChild(b);
    }
    dlg.returnValue = '';
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') { $('#sel-elayer').value = E.curLayer; return; }
      const name = $('#layer-name').value.trim().replace(/[<>/\\":;?*|=`]/g, '_');
      if (!name) { $('#sel-elayer').value = E.curLayer; return; }
      if (E.doc.layerNames().some((n) => n.toUpperCase() === name.toUpperCase())) { setLayer(E.doc.layerNames().find((n) => n.toUpperCase() === name.toUpperCase())); return; }
      const rec = { name, aci: picked, color: picked === 7 ? FG : ACI[picked] };
      commit('New layer', [{ layer: name, before: null, after: rec }]);
      setLayer(name);
    };
    dlg.showModal();
    $('#layer-name').select();
  }
  function nextLevelName() {
    const used = new Set(scene().layers.filter((l) => !l.removed).map((l) => l.name.toUpperCase()));
    for (let k = 1; k <= 63; k++) if (!used.has('LEVEL ' + k)) return 'Level ' + k;
    return 'Level 63';
  }
  function setLayer(name) {
    E.curLayer = name;
    fillLayers();
    if (E.sel.size) applyProps({ layer: name });
  }

  // ---------------------------------------------------------------- dirty state + saving
  function updateDirty() {
    const d = !!(E.doc && E.doc.dirty);
    const el = $('#doc-dirty');
    if (el) el.hidden = !d;
    document.title = (d ? '• ' : '') + document.title.replace(/^• /, '');
  }
  const baseName = () => (app.doc ? app.doc.name.replace(/\.[^.]+$/, '') : 'drawing');
  const srcFormat = () => (app.scene && app.scene.format === 'DGN' ? 'DGN' : 'DXF');
  const defaultName = (f) => `${baseName()}-edited.${f.toLowerCase()}`;
  /** Items the reader could not load (they cannot be written), for a target format. */
  function lostCount(f) {
    const m = model();
    if (!m) return 0;
    if (m.format === 'DGN' && f === 'DGN') return 0; // round trip keeps every original element
    let n = 0;
    for (const [k, v] of Object.entries(m.stats.notShown || {})) if (!/paper-space/i.test(k) || f === 'DGN') n += v;
    return n;
  }
  function saveNotes(f) {
    const m = model(), src = m ? m.format : srcFormat(), notes = [];
    if (src === 'DWG') notes.push('Opened from a DWG. Linework does not write DWG: save a DXF copy (recommended) or DGN v7. DWG-only data (layouts, dimension styles) is not kept.');
    if (src === 'DGN' && f === 'DGN') notes.push('Untouched items stay exactly as they were; edited items are added at the end of the file.');
    const np = m ? m.entities.filter((e) => e && e.pasted).length : 0;
    if (np) notes.push(`${plural(np)} pasted or duplicated${f === 'DGN' ? '; pasted cells get new cell headers' : ''}.`);
    if (src === 'DGN' && f === 'DXF') notes.push('Cells are saved as separate items; DGN levels become layers.');
    if (src !== 'DGN' && f === 'DGN') notes.push('Layers become DGN levels 1–63 (DGN v7 has no layer names); blocks are flattened; fills become outlines.');
    if (f === 'DGN') notes.push('Saved DGN files are checked with GDAL’s reader but have not been tested in MicroStation yet.');
    notes.push('Markups are not part of the drawing — they stay in their own .markup.json file.');
    return notes;
  }
  async function save(f, name) {
    if (!(await whenReady())) return;
    const m = model();
    f = f || srcFormat();
    name = name || defaultName(f);
    const ext = liveExtents(scene()) || undefined;
    let blob, notes;
    if (f === 'DGN') {
      const { writeDgn } = await import('../formats/dgn-write.js');
      const r = writeDgn(m, { bytes: E.doc.bytes, orig: E.doc.orig, extents: ext });
      blob = new Blob([r.bytes], { type: 'application/octet-stream' });
      notes = r.notes;
    } else {
      const { writeDxf } = await import('../formats/dxf-write.js');
      const r = writeDxf(m, { extents: ext });
      blob = new Blob([r.text], { type: 'application/dxf' });
      notes = r.notes;
    }
    if (m.format === 'DWG') notes.unshift(`Linework does not write DWG, so this is a ${f} copy.`);
    download(blob, name);
    E.doc.markSaved();
    updateDirty();
    app.lastSave = { name, format: f, size: blob.size };
    toast(`Saved ${name}`, { detail: 'Downloaded to this device — nothing was uploaded.', list: notes, listTitle: 'Notes', timeout: notes.length ? 9000 : 4000 });
  }
  /** Save in the drawing's own format; asks first when some original items would be lost. */
  function quickSave() {
    if (!app.scene) return;
    if (lostCount(srcFormat())) { openSaveAs(); return; }
    save(srcFormat());
  }
  function openSaveAs() {
    if (!app.scene) return;
    const dlg = $('#dlg-save'), form = $('#save-form');
    const f0 = srcFormat();
    for (const r of form.querySelectorAll('input[name="fmt"]')) r.checked = r.value === f0;
    const refresh = () => {
      const f = form.querySelector('input[name="fmt"]:checked').value;
      const nm = $('#save-name');
      nm.value = nm.value && !nm.dataset.auto ? nm.value.replace(/\.(dxf|dgn)$/i, '') + '.' + f.toLowerCase() : defaultName(f);
      nm.dataset.auto = '1';
      const lost = lostCount(f);
      const w = $('#save-warn');
      w.hidden = !lost;
      w.textContent = lost ? `${fmtNum(lost, 0)} item${lost === 1 ? '' : 's'} from the original file weren’t loaded and won’t be in the saved copy.` : '';
      $('#save-notes').innerHTML = saveNotes(f).map((n) => `<li>${esc(n)}</li>`).join('');
    };
    $('#save-name').value = '';
    $('#save-name').oninput = () => { delete $('#save-name').dataset.auto; };
    for (const r of form.querySelectorAll('input[name="fmt"]')) r.onchange = () => { $('#save-name').dataset.auto = '1'; $('#save-name').value = ''; refresh(); };
    refresh();
    dlg.returnValue = '';
    dlg.onclose = () => {
      if (dlg.returnValue !== 'save') return;
      const f = form.querySelector('input[name="fmt"]:checked').value;
      let nm = $('#save-name').value.trim() || defaultName(f);
      if (!/\.(dxf|dgn)$/i.test(nm)) nm += '.' + f.toLowerCase();
      save(f, nm.replace(/[\\/:*?"<>|]/g, '_'));
    };
    dlg.showModal();
  }

  // ---------------------------------------------------------------- tool changes
  function toolChanged(t) {
    if (!EDIT_TOOLS.has(t)) {
      closeText(true); cancelDraft(); closeMenus(); hideLen();
      cancelDraft(); // (a placement first, then a draft)
      if (E.sel.size || E.vedit >= 0) { E.sel = new Set(); E.selPath = null; endVedit(); }
      E.hover = -1;
      return;
    }
    if (t !== 'eselect') { endVedit(); E.hover = -1; if (E.place) cancelDraft(); }
    if (E.draft && E.draft.tool !== t) cancelDraft();
    if (app.scene && !E.ready) whenReady();
    status(); updateRibbon();
  }

  // ---------------------------------------------------------------- wiring
  $('#sel-elayer').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === '__new') { if (E.ready) openLayerDialog(); else e.target.value = E.curLayer; return; }
    setLayer(v);
    e.target.blur();
  });
  $('#btn-ecolor').addEventListener('click', (e) => { e.stopPropagation(); if (app.scene) openColorPop(); });
  $('#btn-eweight').addEventListener('click', (e) => { e.stopPropagation(); if (app.scene) openWeightPop(); });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#color-pop, #btn-ecolor, #btn-eweight, #ctx-menu')) closeMenus(); });
  window.addEventListener('beforeunload', (e) => { if (E.doc && E.doc.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // clipboard events (app.js): Ctrl+C -> copy event; Ctrl+V / Ctrl+Shift+V -> keydown, then the paste event
  let pk = null;
  /** Ctrl+V pressed (Shift: in place). The paste event normally follows; if it does not, this tab's copy is used. */
  function pasteKey(inPlace) {
    pk = { inPlace };
    const me = pk;
    setTimeout(() => { if (pk === me) { pk = null; paste(null, inPlace); } }, 400);
  }
  /** Text from a paste event: pasted when it is a Linework copy, ignored otherwise. */
  function pasteText(t) {
    const inPlace = !!(pk && pk.inPlace);
    pk = null;
    const P = parseClip(t);
    if (P) paste(P, inPlace);
  }

  return {
    reset, setModel, revert, reapply, drawOverlay, down, move, up, dbl, context, key, toolChanged, cancelGesture,
    finishDraft, undoDraftPoint, cancelDraft, deleteSel, rotateSel, selectAll, quickSave, openSaveAs, save, editEntity,
    copy: copySel, copyButton, paste, pasteKey, pasteText, duplicate: duplicateSel,
    get placing() { return !!E.place; },
    get draftActive() { return !!(E.place || (E.draft && (E.draft.tool === 'epoly' || E.draft.tool === 'eline') && E.draft.pts.length)); },
    get dirty() { return !!(E.doc && E.doc.dirty); },
    get ready() { return E.ready; },
    status,
  };
}
