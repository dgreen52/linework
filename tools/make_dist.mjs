#!/usr/bin/env node
// Copies exactly the files the static site needs into dist/ (default) for upload to any static
// host. Nothing is built or minified: the files are served as they are in the repo.
//   node tools/make_dist.mjs [outDir]
// Layout (see README "Hosting"):
//   index.html app.css sw.js manifest.webmanifest   app shell
//   icons/ src/ samples/                             app code, icons, synthetic samples
//   vendor/libredwg/                                 DWG reader (loaded only when a DWG is opened)
//   _headers                                         HTTP headers (from deploy/_headers)
//   LICENSE NOTICE                                   GPL-3.0 licence and third-party notices
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DIST_FILES = ['index.html', 'app.css', 'sw.js', 'manifest.webmanifest', 'LICENSE', 'NOTICE'];
export const DIST_DIRS = ['icons', 'src', 'samples', 'vendor'];

/** Every file of the deployed site, as [repo path, deployed path]. */
export function distEntries() {
  const walk = (d) => readdirSync(join(ROOT, d)).flatMap((f) => { const p = join(d, f); return statSync(join(ROOT, p)).isDirectory() ? walk(p) : [p]; });
  const files = [...DIST_FILES, ...DIST_DIRS.flatMap(walk)].map((p) => p.split(sep).join('/'));
  return [...files.map((p) => [p, p]), ['deploy/_headers', '_headers']];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] || join(ROOT, 'dist');
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  let bytes = 0;
  for (const [from, to] of distEntries()) {
    mkdirSync(dirname(join(out, to)), { recursive: true });
    cpSync(join(ROOT, from), join(out, to));
    bytes += readFileSync(join(ROOT, from)).length;
  }
  console.log(`${relative(process.cwd(), out) || out}: ${distEntries().length} files, ${(bytes / 1048576).toFixed(1)} MB`);
}
