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

test('service worker precaches every app module and sample, and every entry exists', () => {
  const needed = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'samples'))].map(rel).filter((p) => /\.(js|dxf|dgn)$/.test(p) && !p.endsWith('samples.js'));
  for (const p of needed) assert.ok(SHELL.includes(p), `sw.js SHELL is missing ${p} (and bump VERSION)`);
  for (const p of SHELL) if (p !== './') assert.ok(existsSync(join(ROOT, p)), `SHELL entry ${p} does not exist`);
  for (const p of ['index.html', 'app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png']) assert.ok(SHELL.includes(p), p);
});

test('no network dependencies: no external URLs or CDNs in the app shell', () => {
  const files = ['index.html', 'app.css', 'sw.js', 'manifest.webmanifest', ...walk(join(ROOT, 'src')).map(rel)];
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
