#!/usr/bin/env node
// Zero-dependency static file server for local use and the e2e tests.
//   node tools/serve.mjs [port]      (default 8080, binds to 127.0.0.1 only)
// Linework is a static site: any static server (or static hosting) works the same way.
// The response headers come from deploy/_headers (the file deployed with the site), so the app is
// tested under its real Content-Security-Policy.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.dxf': 'application/octet-stream', '.dgn': 'application/octet-stream',
  '.dwg': 'application/octet-stream', '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

/** Parse a "_headers" file: [{ pattern: RegExp, headers: [[name, value]] }]. */
export function parseHeadersFile(text) {
  const rules = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const path = line.trim();
      const re = new RegExp('^' + path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      cur = { path, pattern: re, headers: [] };
      rules.push(cur);
    } else if (cur) {
      const i = line.indexOf(':');
      if (i > 0) cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}
export const HEADER_RULES = parseHeadersFile(readFileSync(join(ROOT, 'deploy', '_headers'), 'utf8'));
/** Headers that deploy/_headers gives a URL path (later rules win for the same header). */
export function headersFor(path) {
  const out = {};
  for (const r of HEADER_RULES) if (r.pattern.test(path)) for (const [k, v] of r.headers) out[k] = v;
  return out;
}

/**
 * opts.onRequest(path) is called for every request (the e2e tests log what was fetched);
 * opts.headers(headers, path) may change the response headers (tests: a weaker or stricter CSP).
 */
export function startServer(port = 8080, host = '127.0.0.1', opts = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (opts.onRequest) opts.onRequest(url.pathname);
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT + sep) && file !== ROOT) { res.writeHead(403).end(); return; }
      const st = await stat(file);
      if (!st.isFile()) { res.writeHead(404).end(); return; }
      const body = await readFile(file);
      let headers = {
        'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        ...headersFor(url.pathname),
      };
      if (opts.headers) headers = opts.headers(headers, url.pathname) || headers;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 8080;
  startServer(port).then(() => console.log(`Linework at http://127.0.0.1:${port}/  (Ctrl+C to stop)`));
}
