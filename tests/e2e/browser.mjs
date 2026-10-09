// Playwright loader. Playwright is NOT a project dependency: point NODE_PATH at any install, e.g.
//   NODE_PATH=<a node_modules folder that has playwright> node tests/e2e/run.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    try { return require('playwright-core'); } catch { /* fall through */ }
    throw new Error('Playwright not found. Set NODE_PATH to a node_modules folder that contains "playwright".');
  }
}

/** Launch Chromium; fall back to the installed Microsoft Edge or Google Chrome channel. */
export async function launch(opts = {}) {
  const { chromium } = loadPlaywright();
  const errors = [];
  for (const extra of [{}, { channel: 'msedge' }, { channel: 'chrome' }]) {
    try {
      return await chromium.launch({ ...opts, ...extra });
    } catch (e) {
      errors.push(String(e.message).split('\n')[0]);
    }
  }
  throw new Error('Could not launch a Chromium browser:\n' + errors.join('\n'));
}
