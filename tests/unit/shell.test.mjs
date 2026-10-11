// App-shell hygiene: offline cache list is complete, no external URLs, no dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ROOT } from './helpers.mjs';

const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const rel = (p) => relative(ROOT, p).split(sep).join('/');
const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const shellBlock = sw.slice(sw.indexOf('const SHELL = ['), sw.indexOf('];', sw.indexOf('const SHELL = [')));
const SHELL = [...shellBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const listIn = (name) => { const i = sw.indexOf(`const ${name} = [`); return i < 0 ? [] : [...sw.slice(i, sw.indexOf('];', i)).matchAll(/'([^']+)'/g)].map((m) => m[1]); };
const ON_DEMAND = listIn('ON_DEMAND'), READER = listIn('READER'), PDF_ON_DEMAND = listIn('PDF_ON_DEMAND'), PDF_READER = listIn('PDF_READER');

test('service worker precaches every app module and sample (or caches it on first use), and every entry exists', () => {
  const needed = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'samples'))].map(rel).filter((p) => /\.(js|dxf|dgn)$/.test(p) && !p.endsWith('samples.js'));
  for (const p of needed) assert.equal([SHELL, ON_DEMAND, PDF_ON_DEMAND].filter((l) => l.includes(p)).length, 1, `sw.js SHELL (or ON_DEMAND / PDF_ON_DEMAND) is missing ${p} (and bump VERSION)`);
  for (const p of [...SHELL, ...ON_DEMAND, ...READER, ...PDF_ON_DEMAND, ...PDF_READER]) if (p !== './') assert.ok(existsSync(join(ROOT, p)), `sw.js entry ${p} does not exist`);
  for (const p of ['index.html', 'app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png']) assert.ok(SHELL.includes(p), p);
  // only the DWG and PDF readers are loaded on demand; they are never part of the precached shell
  assert.deepEqual(ON_DEMAND, ['src/formats/dwg.js']);
  assert.deepEqual(READER, ['vendor/libredwg/libredwg-web.js', 'vendor/libredwg/libredwg-web.wasm']);
  assert.deepEqual(PDF_ON_DEMAND, ['src/formats/pdf.js', 'src/app/pdf-ui.js']);
  assert.deepEqual(PDF_READER, ['vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs', 'vendor/pdfjs/openjpeg.wasm', 'vendor/pdfjs/jbig2.wasm']);
  for (const p of [...READER, ...PDF_READER]) assert.ok(!SHELL.includes(p));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const v = /LINEWORK_VERSION = '([^']+)'/.exec(readFileSync(join(ROOT, 'src/version.js'), 'utf8'))[1];
  assert.equal(pkg.version, v, 'src/version.js matches package.json');
  assert.ok(/importScripts\('src\/version\.js'\)/.test(sw), 'sw.js names its cache from src/version.js');
  const rev = /READER_REV = '([^']+)'/.exec(readFileSync(join(ROOT, 'src/formats/dwg.js'), 'utf8'))[1];
  assert.ok(sw.includes(`READER_CACHE = 'linework-reader-libredwg-${rev}'`), 'reader cache name follows READER_REV (bump both together)');
  const pdfRev = /PDF_READER_REV = '([^']+)'/.exec(readFileSync(join(ROOT, 'src/formats/pdf.js'), 'utf8'))[1];
  assert.ok(sw.includes(`PDF_READER_CACHE = 'linework-reader-pdfjs-${pdfRev}'`), 'PDF reader cache name follows PDF_READER_REV (bump both together)');
  assert.ok(/k !== READER_CACHE && k !== PDF_READER_CACHE/.test(sw), 'an app update keeps both reader caches');
});

test('no network dependencies: no external URLs or CDNs in the app shell', () => {
  const files = ['index.html', 'app.css', 'sw.js', 'manifest.webmanifest', ...walk(join(ROOT, 'src')).map(rel), 'vendor/libredwg/libredwg-web.js'];
  for (const f of files) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    const urls = (s.match(/https?:\/\/[^\s'")]+/g) || []).filter((u) => !/^http:\/\/www\.w3\.org\//.test(u));
    assert.deepEqual(urls, [], `${f} references external URLs`);
    assert.ok(!/\bfetch\(\s*['"`]https?:/.test(s), `${f} fetches a remote URL`);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.equal(pkg.devDependencies, undefined, 'no dev dependencies');
});

test('colour tokens meet WCAG AA contrast for text in both themes', () => {
  const css = readFileSync(join(ROOT, 'app.css'), 'utf8');
  const block = (sel) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
  const tokens = (b) => Object.fromEntries([...b.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
  const L = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  for (const sel of [':root {', ':root[data-theme="paper"] {']) {
    const t = tokens(block(sel));
    for (const bg of ['bg', 'bg-2', 'bg-3']) {
      assert.ok(ratio(t.text, t[bg]) >= 7, `${sel} text on ${bg}`);
      assert.ok(ratio(t.muted, t[bg]) >= 4.5, `${sel} muted on ${bg}: ${ratio(t.muted, t[bg]).toFixed(2)}`);
    }
    assert.ok(ratio(t['accent-text'], t.accent) >= 4.5, `${sel} primary button text`);
    assert.ok(ratio(t.accent, t['bg-2']) >= 3, `${sel} accent (icons, focus) on panels`);
  }
});

test('deploy: dist/ holds every file the site needs (shell, on-demand modules, DWG reader, headers, licence) and nothing else', async () => {
  const { distEntries } = await import('../../tools/make_dist.mjs');
  const deployed = new Set(distEntries().map(([, to]) => to));
  for (const p of [...SHELL, ...ON_DEMAND, ...READER, ...PDF_ON_DEMAND, ...PDF_READER, '_headers', 'LICENSE', 'NOTICE', 'vendor/libredwg/README.md', 'vendor/pdfjs/README.md', 'vendor/pdfjs/LICENSE', 'vendor/pdfjs/LICENSE_OPENJPEG', 'vendor/pdfjs/LICENSE_JBIG2']) if (p !== './') assert.ok(deployed.has(p), `dist is missing ${p}`);
  for (const p of deployed) assert.ok(!/^(tests|tools|deploy|node_modules|dist)\//.test(p) && !p.startsWith('.'), `dist should not contain ${p}`);
});

test('deploy/_headers: CSP allows WebAssembly but not eval; reader cached long with the wasm type; shell revalidated', async () => {
  const { headersFor } = await import('../../tools/serve.mjs');
  const root = headersFor('/index.html');
  const csp = root['Content-Security-Policy'];
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.ok(!/'unsafe-eval'/.test(csp.replace(/'wasm-unsafe-eval'/g, '')), 'no unsafe-eval');
  for (const d of ["default-src 'self'", "worker-src 'self'", "connect-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'none'", "base-uri 'self'"]) assert.ok(csp.includes(d), d);
  assert.equal(root['X-Content-Type-Options'], 'nosniff');
  assert.equal(root['X-Frame-Options'], 'DENY');
  assert.equal(root['Referrer-Policy'], 'no-referrer');
  assert.equal(root['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  for (const p of ['/', '/index.html', '/sw.js']) assert.equal(headersFor(p)['Cache-Control'], 'no-cache', p);
  const wasm = headersFor('/vendor/libredwg/libredwg-web.wasm');
  assert.match(wasm['Cache-Control'], /max-age=31536000/);
  assert.equal(wasm['Content-Type'], 'application/wasm');
  assert.equal(headersFor('/src/app.js')['Cache-Control'], undefined, 'app code: host default (revalidated by the service worker)');
  for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs', 'openjpeg.wasm', 'jbig2.wasm']) assert.match(headersFor('/vendor/pdfjs/' + f)['Cache-Control'], /max-age=31536000, immutable/, f);
  assert.equal(headersFor('/vendor/pdfjs/openjpeg.wasm')['Content-Type'], 'application/wasm');
  assert.match(headersFor('/vendor/pdfjs/pdf.worker.min.mjs')['Content-Type'], /^text\/javascript/, 'module scripts need a JavaScript type (some hosts do not know .mjs)');
});
