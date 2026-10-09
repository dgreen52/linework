// Renderer smoke test with a recording mock canvas (Node has no Canvas/Path2D).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
import { Canvas2DRenderer, primPath } from '../../src/view/renderer2d.js';
import { buildChunks } from '../../src/view/batches.js';
import { Viewport } from '../../src/view/viewport.js';

class MockPath { constructor() { this.ops = []; } moveTo(...a) { this.ops.push(['M', ...a]); } lineTo(...a) { this.ops.push(['L', ...a]); } closePath() { this.ops.push(['Z']); } ellipse(...a) { this.ops.push(['E', ...a]); } rect(...a) { this.ops.push(['R', ...a]); } }
globalThis.Path2D = MockPath;
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); } };
globalThis.DOMMatrix = class { constructor(m) { this.m = m; } inverse() { return this; } };
function mockCtx() {
  const calls = [];
  const ctx = new Proxy({ canvas: { width: 800, height: 600 } }, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s) => ({ width: s.length * 30 });
      if (k === 'createPattern') return () => ({ setTransform() {} });
      return (...a) => calls.push([k, ...a]);
    },
    set(t, k, v) { t[k] = v; calls.push(['set', k, v]); return true; },
  });
  return { ctx, calls };
}

for (const name of ['house-plan.dxf', 'bracket.dxf', 'schematic.dxf', 'site-plan.dgn', 'edge-nested-mirror.dxf']) {
  test(`renderer draws ${name} (mock canvas), with and without worker-built batches`, () => {
    const { scene } = load(name);
    for (const pre of [false, true]) {
      if (pre) scene.chunks = buildChunks(scene); else delete scene.chunks;
      const { ctx, calls } = mockCtx();
      const r = new Canvas2DRenderer({ getContext: () => ctx, width: 800, height: 600 });
      r.setScene(scene);
      const v = new Viewport();
      v.setSize(800, 600);
      v.fit(scene.fitBox);
      const res = r.drawTo(ctx, v, { theme: 'dark', layerVisible: null }, 1, 800, 600);
      assert.ok(res.batches > 0, 'drew batches');
      assert.equal(res.incomplete, false);
      assert.ok(calls.some((c) => c[0] === 'stroke'));
      if (scene.texts.length) assert.ok(calls.some((c) => c[0] === 'fillText') || res.texts === 0);
      // budgeted (progressive) render eventually completes
      const r2 = new Canvas2DRenderer({ getContext: () => ctx, width: 800, height: 600 });
      r2.setScene(scene);
      let guard = 0, out;
      do { out = r2.drawTo(ctx, v, { theme: 'paper', budgetMs: 0.0001 }, 1, 800, 600); } while (out.incomplete && ++guard < 10000);
      assert.equal(out.incomplete, false);
      for (let i = 0; i < Math.min(scene.n, 50); i++) assert.ok(primPath(scene, i).ops.length > 0);
    }
  });
}
