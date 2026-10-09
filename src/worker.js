// Parse worker: reads + prepares drawings off the main thread so the UI never freezes.
// Message in:  { id, name, buffer?: ArrayBuffer, sample?: 'stress' }
// Messages out: { id, type: 'progress', phase, fraction } | { id, type: 'done', scene } | { id, type: 'error', code, message }
import { parseDrawing } from './formats/detect.js';
import { buildScene, sceneTransferables, packTexts } from './scene.js';
import { buildChunks, chunkTransferables } from './view/batches.js';

export async function loadInWorkerScope(msg, post) {
  const { id, name } = msg;
  let bytes;
  if (msg.sample === 'stress') {
    post({ id, type: 'progress', phase: 'Generating', fraction: 0 });
    const { makeStressDxf } = await import('../samples/gen/stress.js');
    bytes = new TextEncoder().encode(makeStressDxf().text);
  } else {
    bytes = new Uint8Array(msg.buffer);
  }
  let last = 0;
  const progress = (phase, base, span) => (f) => {
    const now = Date.now();
    if (now - last < 40 && f < 1) return;
    last = now;
    post({ id, type: 'progress', phase, fraction: base + span * f });
  };
  const model = parseDrawing(bytes, name, { onProgress: progress('Reading', 0, 0.7) });
  const scene = buildScene(model, { fileName: name, onProgress: progress('Preparing', 0.7, 0.3) });
  scene.fileSize = bytes.length;
  return scene;
}

if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = async (ev) => {
    const msg = ev.data;
    try {
      const scene = packTexts(await loadInWorkerScope(msg, (m) => self.postMessage(m)));
      scene.chunks = buildChunks(scene); // render batches, prepared off the main thread
      self.postMessage({ id: msg.id, type: 'done', scene }, [...sceneTransferables(scene), ...chunkTransferables(scene.chunks)]);
    } catch (e) {
      self.postMessage({ id: msg.id, type: 'error', code: e.code || 'error', message: e.code ? e.message : `Could not read this file (${e.message || e}).` });
    }
  };
}
