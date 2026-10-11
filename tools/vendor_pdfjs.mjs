#!/usr/bin/env node
// Installs the PDF reader (Mozilla pdf.js, Apache-2.0) into vendor/pdfjs/ and writes
// vendor/pdfjs/README.md (provenance + SHA-256). The files come unchanged from the npm package
// pdfjs-dist at the pinned version; the tarball is checked against the registry's pinned integrity.
//
//   node tools/vendor_pdfjs.mjs              download the pinned tarball from registry.npmjs.org
//   node tools/vendor_pdfjs.mjs <file.tgz>   use a tarball downloaded by other means (same check)
//
// Used: the legacy build (it runs on older Safari / iPadOS and Chromium versions too; the modern
// build needs ES2024 built-ins), its worker (run inside Linework's parse worker, not as a worker
// of its own), and the JPEG 2000 and JBIG2 / CCITT decoders (WebAssembly) that scanned pages use.
// Not vendored: character maps (cmaps/, CJK text without embedded maps), the standard font files
// (glyph outlines of non-embedded fonts, only for drawing a scanned page's own text), the ICC
// colour module (qcms), the JavaScript-sandbox (quickjs) and the no-WebAssembly fallbacks.
// The script refuses a build with run-time code generation (eval / new Function): the app's
// Content-Security-Policy allows only 'wasm-unsafe-eval'.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dynamicCodeSites } from './vendor_libredwg.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PIN = {
  name: 'pdfjs-dist',
  version: '6.3.289',
  tarball: 'https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.3.289.tgz',
  integrity: 'sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw==',
};
/** Package path -> vendor/pdfjs/ name. */
export const FILES = {
  'package/legacy/build/pdf.min.mjs': 'pdf.min.mjs',
  'package/legacy/build/pdf.worker.min.mjs': 'pdf.worker.min.mjs',
  'package/wasm/openjpeg.wasm': 'openjpeg.wasm',
  'package/wasm/jbig2.wasm': 'jbig2.wasm',
  'package/LICENSE': 'LICENSE',
  'package/wasm/LICENSE_OPENJPEG': 'LICENSE_OPENJPEG',
  'package/wasm/LICENSE_PDFJS_OPENJPEG': 'LICENSE_PDFJS_OPENJPEG',
  'package/wasm/LICENSE_JBIG2': 'LICENSE_JBIG2',
  'package/wasm/LICENSE_PDFJS_JBIG2': 'LICENSE_PDFJS_JBIG2',
};

const sha = (alg, b) => createHash(alg).update(b).digest();
/**
 * The one known run-time code site in the legacy build: core-js's global-object lookup, whose last
 * fallback `Function("return this")()` is reached only where globalThis, window, self and global are
 * all missing (never in a browser that runs module workers). Exactly one per file is allowed.
 */
export const CORE_JS_GLOBAL = /var check=function\((\w)\)\{return \1&&\1\.Math===Math&&\1\};\w\.exports=check\("object"==typeof globalThis&&globalThis\)\|\|[^;]{0,200}?\|\|function\(\)\{return this\}\(\)\|\|Function\("return this"\)\(\)/g;
/** Dynamic code sites of a pdf.js build other than the allowed core-js lookup: { sites, allowed }. */
export function pdfjsCodeSites(js) {
  const allowed = (js.match(CORE_JS_GLOBAL) || []).length;
  return { sites: dynamicCodeSites(js.replace(CORE_JS_GLOBAL, '')), allowed };
}
/** npm "integrity" (sha512-<base64>) of a tarball. */
export const integrityOf = (tgz) => 'sha512-' + sha('sha512', tgz).toString('base64');

/** Files of a .tgz: Map(path -> Buffer). Plain ustar as npm writes it (pax headers skipped). */
export function untar(tgz) {
  const tar = gunzipSync(tgz);
  const out = new Map();
  let p = 0, longName = null;
  while (p + 512 <= tar.length) {
    const h = tar.subarray(p, p + 512);
    if (h.every((x) => x === 0)) break;
    const field = (o, n) => h.subarray(o, o + n).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = field(345, 155);
    let name = longName || (prefix ? prefix + '/' : '') + field(0, 100);
    longName = null;
    const body = tar.subarray(p + 512, p + 512 + size);
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === 'x') { const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8')); if (m) longName = m[1]; }
    else if (type === '0' || type === '\0') out.set(name, Buffer.from(body));
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** vendor/pdfjs/README.md for the installed files. */
export function readme(files) {
  const rows = Object.values(FILES).filter((n) => !n.startsWith('LICENSE')).map((n) => `| ${n} | ${files[n].length} | \`${sha('sha256', files[n]).toString('hex')}\` |`).join('\n');
  return `# pdf.js — vendored

Used by \`src/formats/pdf.js\` to read PDF files. Loaded only when a PDF is opened, then cached for
offline use in its own cache (\`PDF_READER_CACHE\` in \`sw.js\`). Installed unchanged by
\`tools/vendor_pdfjs.mjs\` (which also wrote this file). Nothing is patched.

| | |
|---|---|
| Library | Mozilla pdf.js — https://github.com/mozilla/pdf.js |
| Package | npm \`${PIN.name}@${PIN.version}\` (${PIN.tarball}) |
| Integrity | \`${PIN.integrity}\` (checked before anything is installed) |
| Licence | Apache-2.0 (pdf.js, \`LICENSE\`); the legacy build bundles core-js (MIT); \`openjpeg.wasm\`: OpenJPEG (BSD-2-Clause, \`LICENSE_OPENJPEG\`) with pdf.js glue (\`LICENSE_PDFJS_OPENJPEG\`); \`jbig2.wasm\`: PDFium's JBIG2 / CCITT decoders (BSD-3-Clause and Apache-2.0, \`LICENSE_JBIG2\`) with pdf.js glue (\`LICENSE_PDFJS_JBIG2\`). See \`NOTICE\`. |
| Build | the package's **legacy** build (\`legacy/build/\`): runs on older Safari / iPadOS and Chromium too |

How Linework runs it: \`pdf.worker.min.mjs\` is imported into Linework's own parse worker and pdf.js
runs there in-thread (\`globalThis.pdfjsWorker\`), so no worker of its own is started; fonts are
never installed (\`disableFontFace\`), nothing is fetched except the WebAssembly decoders below from
this folder (\`wasmUrl\`), and pdf.js 6 compiles PostScript functions to WebAssembly rather than
JavaScript, so the Content-Security-Policy needs only \`'wasm-unsafe-eval'\`. The only run-time
code site in these files is core-js's global-object lookup (\`...||function(){return this}()||
Function("return this")()\`), whose last fallback runs only where \`globalThis\`, \`window\`, \`self\`
and \`global\` are all missing — never in a browser that runs module workers; the vendoring script
allows exactly that pattern and refuses any other \`eval\` / \`new Function\`.

| File | Bytes | SHA-256 |
|---|---|---|
${rows}

Not vendored (not needed to read drawings): \`cmaps/\` (character maps for CJK text whose PDF does
not embed them), \`standard_fonts/\` (outlines of non-embedded fonts, used only when a scanned page
is drawn as a picture), \`qcms_bg.wasm\` (ICC colour management; pdf.js falls back to the
alternate colour space), \`quickjs-eval\` (form scripts) and the no-WebAssembly fallbacks.

**Updating:** change \`PIN\` in \`tools/vendor_pdfjs.mjs\` (version, tarball, the registry's
integrity), run \`node tools/vendor_pdfjs.mjs\`, then bump \`PDF_READER_REV\` in
\`src/formats/pdf.js\` together with \`PDF_READER_CACHE\` in \`sw.js\`, and run the unit and e2e
tests. See PDF.md.
`;
}

/** Check a tarball and install it into dest (default vendor/pdfjs/). Returns the README text. */
export function install(tgz, dest = join(ROOT, 'vendor', 'pdfjs')) {
  const got = integrityOf(tgz);
  if (got !== PIN.integrity) throw new Error(`tarball integrity ${got} is not the pinned ${PIN.integrity}`);
  const all = untar(tgz);
  const pkg = JSON.parse(all.get('package/package.json').toString('utf8'));
  if (pkg.name !== PIN.name || pkg.version !== PIN.version) throw new Error(`package is ${pkg.name}@${pkg.version}`);
  if (pkg.license !== 'Apache-2.0') throw new Error(`unexpected licence ${pkg.license}`);
  const files = {};
  for (const [from, to] of Object.entries(FILES)) {
    const b = all.get(from);
    if (!b) throw new Error(`missing ${from}`);
    files[to] = b;
  }
  for (const n of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    const js = files[n].toString('utf8');
    const { sites, allowed } = pdfjsCodeSites(js);
    if (sites.length) throw new Error(`dynamic code in ${n}:\n` + sites.join('\n'));
    if (allowed > 1) throw new Error(`${n}: ${allowed} copies of the core-js global lookup (expected at most 1)`);
    if (!js.includes(`"${PIN.version}"`)) throw new Error(`${n} does not report version ${PIN.version}`);
  }
  for (const n of ['openjpeg.wasm', 'jbig2.wasm']) if (files[n].readUInt32LE(0) !== 0x6d736100) throw new Error(`${n} is not WebAssembly`);
  const text = readme(files);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dest, n), b);
  writeFileSync(join(dest, 'README.md'), text);
  return text;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const src = process.argv[2];
  const tgz = src ? readFileSync(src) : Buffer.from(await (await fetch(PIN.tarball)).arrayBuffer());
  console.log(install(tgz));
}
