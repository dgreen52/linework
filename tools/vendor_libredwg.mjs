#!/usr/bin/env node
// Installs a build of the DWG reader into vendor/libredwg/ and writes vendor/libredwg/README.md
// (provenance + SHA-256). The build comes from tools/build_dwg_wasm.sh, which calls this script at
// its end; it normally runs on GitHub Actions (.github/workflows/build-libredwg-wasm.yml):
//
//   node tools/vendor_libredwg.mjs <dir>     <dir>: the build output (libredwg-web.js,
//                                            libredwg-web.wasm, build-info.json), e.g. the
//                                            unpacked workflow artifact
//
// The files are copied as built (no patching). The script refuses a build whose glue generates
// code at run time (eval / new Function: the app's Content-Security-Policy allows only
// 'wasm-unsafe-eval'), whose memory limits are not 64 MiB / 4 GiB, whose LibreDWG version string
// says "dirty" (built from a modified source tree) or whose build-info.json lacks a source pin.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const INITIAL_PAGES = 1024; // 64 MiB
export const MAXIMUM_PAGES = 65536; // 4 GiB

/** Dynamic code generation left in a glue file (must be empty for the CSP). */
export function dynamicCodeSites(js) {
  const out = [];
  for (const re of [/newFunc\(\s*Function/g, /\bnew\s+Function\b/g, /(^|[^\w$.])eval\s*\(/g, /(^|[^\w$.])Function\s*\(/g, /setTimeout\(\s*["'`]/g]) {
    for (const m of js.matchAll(re)) out.push(js.slice(Math.max(0, m.index - 30), m.index + 40));
  }
  return out;
}

function leb(buf, p) { let r = 0, s = 0, b; do { b = buf[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return [r, p]; }

/** Limits of the module's own memory, in 64 KiB pages: { initial, maximum }. */
export function wasmMemory(wasm) {
  let p = 8;
  while (p < wasm.length) {
    const id = wasm[p++];
    let size; [size, p] = leb(wasm, p);
    if (id === 5) {
      let n, initial, maximum = null;
      [n, p] = leb(wasm, p);
      if (n !== 1) throw new Error('expected one memory');
      const flags = wasm[p++];
      [initial, p] = leb(wasm, p);
      if (flags & 1) [maximum] = leb(wasm, p);
      return { initial, maximum };
    }
    p += size;
  }
  throw new Error('no memory section');
}

/** The version LibreDWG reports (e.g. "0.13.4.321_abcd"), read from the module's data. */
export function libredwgVersion(wasm) {
  const m = /LibreDWG (\d+\.\d+[\w.]*)/.exec(Buffer.from(wasm).toString('latin1'));
  return m ? m[1] : null;
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const PINS = ['libredwgWeb.repo', 'libredwgWeb.tag', 'libredwgWeb.commit', 'jsmn.commit', 'libredwgBase.tag', 'libredwgBase.commit',
  'emsdk.version', 'emsdk.commit', 'emcc', 'version', 'configure', 'cflags', 'link'];
const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);

/** vendor/libredwg/README.md for a build (build-info.json + the installed files, as bytes). */
export function readme(info, glue, wasm) {
  const w = info.libredwgWeb, mem = wasmMemory(wasm);
  const built = info.run
    ? `GitHub Actions: ${info.run.url} (workflow \`.github/workflows/build-libredwg-wasm.yml\` at commit \`${info.run.commit}\` of this repository; runner image \`${info.run.image}\`)`
    : 'a local run of `tools/build_dwg_wasm.sh`';
  return `# LibreDWG (WebAssembly) — vendored

Used by \`src/formats/dwg.js\` to read DWG files. Loaded only when a DWG is opened.

Built from pinned sources by \`tools/build_dwg_wasm.sh\` and installed unchanged by
\`tools/vendor_libredwg.mjs\` (which also wrote this file). Nothing is patched after the build.

| | |
|---|---|
| Library | GNU LibreDWG — https://www.gnu.org/software/libredwg/ ; the binary reports \`LibreDWG ${info.version}\` (a snapshot built from a clean source tree) |
| Licence | GPL-3.0-or-later (LibreDWG); GPL-3.0 (JavaScript bindings); MIT (Emscripten runtime glue, mimalloc); zlib licence (zlib); see \`NOTICE\` |
| Source | ${w.repo.replace(/\.git$/, '')} tag \`${w.tag}\`, commit \`${w.commit}\`: the LibreDWG source tree with the Emscripten/embind bindings (\`bindings/javascript/embind/\`); the same C/C++ sources as npm \`@mlightcad/libredwg-web@${w.tag.replace(/^v/, '')}\` |
| Submodule | \`jsmn\` (https://github.com/zserge/jsmn) at commit \`${info.jsmn.commit}\`, as pinned by that commit |
| LibreDWG base | upstream LibreDWG release \`${info.libredwgBase.tag}\` (commit \`${info.libredwgBase.commit}\`) is in that history; the version string counts the commits since it |
| Toolchain | Emscripten SDK \`${info.emsdk.version}\` (emsdk commit \`${info.emsdk.commit}\`): \`${info.emcc}\` |
| Configure | \`${info.configure}\` with \`CFLAGS=${info.cflags}\` |
| Link | \`${info.link}\` |
| Built on | ${built} |
| Memory | initial ${mem.initial} pages (${mem.initial / 16} MiB), grows on demand up to ${mem.maximum} pages (${mem.maximum / 16384} GiB) |

Differences from the npm package's own build (the scripts in its \`package.json\`):
\`-sDYNAMIC_EXECUTION=0\` (the glue never generates code at run time, so the Content-Security-Policy
needs only \`'wasm-unsafe-eval'\`), 64 MiB initial memory instead of 1 GiB (phones and tablets), no
TypeScript declarations. Same configure options (with \`--enable-debug\`, which these sources need;
it makes configure drop \`-O2\` from the C flags, as in the npm build).

| File | Bytes | SHA-256 |
|---|---|---|
| libredwg-web.js | ${glue.length} | \`${sha256(glue)}\` |
| libredwg-web.wasm | ${wasm.length} | \`${sha256(wasm)}\` |

Corresponding source: the commits above and \`tools/build_dwg_wasm.sh\`, which fetches exactly those,
verifies them and records them in \`build-info.json\` (part of the workflow artifact). Sources:
https://github.com/mlightcad/libredwg-web , LibreDWG https://git.savannah.gnu.org/git/libredwg.git .
See DWG.md.
`;
}

/** Check a build and install it into dest (default vendor/libredwg/). Returns the README text. */
export function install(dir, dest = join(ROOT, 'vendor', 'libredwg')) {
  const info = JSON.parse(readFileSync(join(dir, 'build-info.json'), 'utf8'));
  for (const k of PINS) if (!get(info, k)) throw new Error(`build-info.json: missing ${k}`);
  for (const k of ['libredwgWeb.commit', 'jsmn.commit', 'libredwgBase.commit', 'emsdk.commit']) {
    if (!/^[0-9a-f]{40}$/.test(get(info, k))) throw new Error(`build-info.json: ${k} is not a full commit hash`);
  }
  const glue = readFileSync(join(dir, 'libredwg-web.js'));
  const wasm = readFileSync(join(dir, 'libredwg-web.wasm'));
  const js = glue.toString('utf8');
  const left = dynamicCodeSites(js);
  if (left.length) throw new Error('dynamic code left in the glue:\n' + left.join('\n'));
  if (!js.startsWith('// LibreDWG for Linework')) throw new Error('glue without the build banner');
  const mem = wasmMemory(wasm);
  if (mem.initial !== INITIAL_PAGES || mem.maximum !== MAXIMUM_PAGES) throw new Error(`unexpected memory limits ${JSON.stringify(mem)}`);
  const ver = libredwgVersion(wasm);
  if (ver !== info.version) throw new Error(`the binary reports LibreDWG ${ver}, build-info.json says ${info.version}`);
  if (/dirty/i.test(ver)) throw new Error(`built from a modified source tree: ${ver}`);
  const text = readme(info, glue, wasm);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'libredwg-web.js'), glue);
  writeFileSync(join(dest, 'libredwg-web.wasm'), wasm);
  writeFileSync(join(dest, 'README.md'), text);
  return text;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node tools/vendor_libredwg.mjs <build output dir> [dest dir]'); process.exit(2); }
  console.log(install(dir, process.argv[3]));
}
