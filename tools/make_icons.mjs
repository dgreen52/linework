#!/usr/bin/env node
// Renders icons/icon.svg to the PNG sizes the web manifest needs (uses Playwright, see tests/e2e/browser.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../tests/e2e/browser.mjs';
import { optimizePng } from './optimize_png.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(ROOT, 'icons/icon.svg'), 'utf8');
const browser = await launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  const png = optimizePng(await page.screenshot({ omitBackground: true })); // lossless, smaller
  writeFileSync(join(ROOT, `icons/icon-${size}.png`), png);
  console.log('wrote icons/icon-' + size + '.png', png.length, 'bytes');
  await page.close();
}
await browser.close();
