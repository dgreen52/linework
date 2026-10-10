#!/usr/bin/env node
// Vendors LibreDWG (WebAssembly) into vendor/libredwg/ from the pinned npm package
// @mlightcad/libredwg-web, and makes it fit Linework's rules:
//
//   npm pack @mlightcad/libredwg-web@0.7.16          (downloads the .tgz; nothing is installed)
//   node tools/vendor_libredwg.mjs mlightcad-libredwg-web-0.7.16.tgz
//
// 1. Checks the tarball against the pinned npm integrity hash (sha512).
// 2. Copies package/wasm/libredwg-web.{js,wasm}.
// 3. Patches the Emscripten glue so it never generates code at run time: the two places where
//    embind builds functions with `new Function` (function invokers and emval method callers) are
//    replaced by the closure-based versions Emscripten emits for -sDYNAMIC_EXECUTION=0. The page's
//    Content-Security-Policy can then stay without 'unsafe-eval' (only 'wasm-unsafe-eval').
// 4. Lowers the module's initial memory from 1 GiB to 64 MiB (it still grows on demand up to
//    4 GiB), so phones and tablets can instantiate it.
// 5. Writes vendor/libredwg/README.md with the provenance and the SHA-256 of the output files.
//
// Preferred long-term route: build from source with tools/build_dwg_wasm.sh (see DWG.md).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE = '@mlightcad/libredwg-web';
export const VERSION = '0.7.16';
export const INTEGRITY = 'sha512-gWmjJ5TVNHR7JSHSke0Y8WmvTDPRTUNiRUejbIiymdjR4FV8Jv3hulR0Cv4TNwihr+r1DaxoD0phOFDENY5+Nw==';
const INITIAL_PAGES = 1024; // 64 MiB

function untar(buf) {
  const files = {};
  for (let o = 0; o + 512 <= buf.length;) {
    const h = buf.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, n) => { const s = h.subarray(a, a + n); const z = s.indexOf(0); return Buffer.from(z < 0 ? s : s.subarray(0, z)).toString('utf8'); };
    const name = (str(345, 155) ? str(345, 155) + '/' : '') + str(0, 100);
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    o += 512;
    if (type === '0' || type === '\0') files[name] = buf.subarray(o, o + size);
    o += Math.ceil(size / 512) * 512;
  }
  return files;
}

function replaceOnce(s, from, to, what) {
  const i = s.indexOf(from);
  if (i < 0 || s.indexOf(from, i + 1) >= 0) throw new Error(`glue patch "${what}": expected exactly one match`);
  return s.slice(0, i) + to + s.slice(i + from.length);
}

/** Patch the embind glue so it does not use `new Function` (see header comment). */
export function patchGlue(js) {
  // (a) function invokers
  js = replaceOnce(js,
    'let[args,invokerFnBody]=createJsInvoker(argTypes,isClassMethodFunc,returns,isAsync);args.push(invokerFnBody);var invokerFn=newFunc(Function,args)(...closureArgs);',
    'var invokerFn=lwInvoker(argTypes,isClassMethodFunc,needsDestructorStack,returns,cppInvokerFunc,cppTargetFunc);',
    'craftInvokerFunction');
  js = replaceOnce(js, 'function craftInvokerFunction(',
    // Same behaviour as the code createJsInvoker() generates, written as a closure.
    'function lwInvoker(argTypes,isClassMethodFunc,needsDestructorStack,returns,invoker,fn){' +
    'var argCount=argTypes.length-2,retType=argTypes[0],classParam=argTypes[1];' +
    'return function(...args){var destructors=needsDestructorStack?[]:null;var thisWired;' +
    'if(isClassMethodFunc){thisWired=classParam["toWireType"](destructors,this)}' +
    'var argsWired=new Array(argCount);for(var i=0;i<argCount;++i){argsWired[i]=argTypes[i+2]["toWireType"](destructors,args[i])}' +
    'var rv=isClassMethodFunc?invoker(fn,thisWired,...argsWired):invoker(fn,...argsWired);' +
    'if(needsDestructorStack){runDestructors(destructors)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var d=argTypes[i].destructorFunction;if(d!==null&&d!==undefined){d(i===1?thisWired:argsWired[i-2])}}}' +
    'if(returns){return retType["fromWireType"](rv)}}}' +
    'function craftInvokerFunction(',
    'lwInvoker');
  // (b) emval method callers
  const start = js.indexOf('var functionBody=`return function (obj, func, destructorsRef, args) {\\n`;');
  const endMark = 'var invokerFunction=newFunc(Function,params)(...args);';
  const end = js.indexOf(endMark, start);
  if (start < 0 || end < 0 || js.indexOf(endMark, end + 1) >= 0) throw new Error('glue patch "emval method caller": markers not found');
  js = js.slice(0, start) +
    'var invokerFunction=(obj,func,destructorsRef,args)=>{var offset=0;var argN=new Array(argCount);' +
    'for(var i=0;i<argCount;++i){argN[i]=types[i]["readValueFromPointer"](args+offset);offset+=types[i].argPackAdvance}' +
    'var rv=kind===1?reflectConstruct(func,argN):func.apply(obj,argN);' +
    'if(!retType.isVoid){return emval_returnValue(retType,destructorsRef,rv)}};' +
    js.slice(end + endMark.length);
  const banner = '// LibreDWG for Linework: Emscripten glue from @mlightcad/libredwg-web ' + VERSION +
    ', patched by tools/vendor_libredwg.mjs (no run-time code generation). Emscripten runtime: MIT licence.\n';
  return banner + js;
}

/** Dynamic code generation left in a glue file (must be empty for the CSP). */
export function dynamicCodeSites(js) {
  const out = [];
  for (const re of [/newFunc\(\s*Function/g, /\bnew\s+Function\b/g, /(^|[^\w$.])eval\s*\(/g, /(^|[^\w$.])Function\s*\(/g, /setTimeout\(\s*["'`]/g]) {
    for (const m of js.matchAll(re)) out.push(js.slice(Math.max(0, m.index - 30), m.index + 40));
  }
  return out;
}

function leb(buf, p) { let r = 0, s = 0, b; do { b = buf[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return [r, p]; }

/** Rewrite the defined memory's initial size in place (same LEB128 length). */
export function patchWasmMemory(wasm, pages) {
  const out = Uint8Array.from(wasm);
  let p = 8, dataEnd = 0, stackTop = 0, memAt = -1, memLen = 0, oldPages = 0;
  while (p < out.length) {
    const id = out[p++];
    let size; [size, p] = leb(out, p);
    const start = p;
    if (id === 5) {
      let n; [n, p] = leb(out, p);
      if (n !== 1) throw new Error('expected one memory');
      const flags = out[p++];
      memAt = p;
      [oldPages, p] = leb(out, p);
      memLen = p - memAt;
      if (flags & 1) [, p] = leb(out, p);
    } else if (id === 6) { // globals: the stack pointer is the first mutable i32 global
      let n; [n, p] = leb(out, p);
      for (let i = 0; i < n; i++) {
        const type = out[p++], mut = out[p++];
        if (out[p] === 0x41) { let v; [v, p] = leb(out, p + 1); if (type === 0x7f && mut && !stackTop) stackTop = v; } else { while (out[p] !== 0x0b) p++; }
        p++; // end
      }
    } else if (id === 11) { // data segments
      let n; [n, p] = leb(out, p);
      for (let i = 0; i < n; i++) {
        let kind; [kind, p] = leb(out, p);
        let off = 0;
        if (kind === 0 || kind === 2) { if (kind === 2) [, p] = leb(out, p); if (out[p] === 0x41) [off, p] = leb(out, p + 1); while (out[p] !== 0x0b) p++; p++; }
        let len; [len, p] = leb(out, p);
        dataEnd = Math.max(dataEnd, off + len);
        p += len;
      }
    }
    p = start + size;
  }
  if (memAt < 0) throw new Error('no memory section');
  const need = Math.max(dataEnd, stackTop);
  if (pages * 65536 < need + 16 * 1024 * 1024) throw new Error(`initial memory too small: needs ${need} bytes`);
  if (memLen < 3) throw new Error('unexpected memory encoding');
  // padded LEB128 of `pages` in memLen bytes
  let v = pages;
  for (let i = 0; i < memLen; i++) { out[memAt + i] = (v & 0x7f) | (i < memLen - 1 ? 0x80 : 0); v = Math.floor(v / 128); }
  return { wasm: out, oldPages, dataEnd, stackTop };
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tgzPath = process.argv[2];
  if (!tgzPath) { console.error(`usage: npm pack ${PACKAGE}@${VERSION} && node tools/vendor_libredwg.mjs <tgz>`); process.exit(2); }
  const tgz = readFileSync(tgzPath);
  const integrity = 'sha512-' + createHash('sha512').update(tgz).digest('base64');
  if (integrity !== INTEGRITY) { console.error(`integrity mismatch:\n  got      ${integrity}\n  expected ${INTEGRITY}`); process.exit(1); }
  const files = untar(gunzipSync(tgz));
  const pkg = JSON.parse(Buffer.from(files['package/package.json']).toString('utf8'));
  if (pkg.version !== VERSION || pkg.license !== 'GPL-3.0') throw new Error('unexpected package metadata');
  const glue = patchGlue(Buffer.from(files['package/wasm/libredwg-web.js']).toString('utf8'));
  const left = dynamicCodeSites(glue);
  if (left.length) throw new Error('dynamic code left in the glue:\n' + left.join('\n'));
  const { wasm, oldPages, dataEnd, stackTop } = patchWasmMemory(files['package/wasm/libredwg-web.wasm'], INITIAL_PAGES);
  const ver = /LibreDWG (\d+\.\d+[\w.]*)/.exec(Buffer.from(wasm).toString('latin1'));
  const dir = join(ROOT, 'vendor', 'libredwg');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'libredwg-web.js'), glue);
  writeFileSync(join(dir, 'libredwg-web.wasm'), wasm);
  const readme = `# LibreDWG (WebAssembly) — vendored

Used by \`src/formats/dwg.js\` to read DWG files. Loaded only when a DWG is opened.

| | |
|---|---|
| Library | GNU LibreDWG ${ver ? ver[1] : '(version string not found)'} — https://www.gnu.org/software/libredwg/ |
| Licence | GPL-3.0-or-later (LibreDWG); GPL-3.0 (JavaScript bindings); MIT (Emscripten runtime glue, mimalloc); zlib licence (zlib); see \`NOTICE\` |
| Built by | the \`${PACKAGE}\` project — https://github.com/mlightcad/libredwg-web (Emscripten + embind bindings over LibreDWG) |
| Taken from | npm \`${PACKAGE}@${VERSION}\`, files \`wasm/libredwg-web.js\` and \`wasm/libredwg-web.wasm\` |
| npm integrity | \`${INTEGRITY}\` |
| Upstream build flags | \`configure --enable-release --enable-debug --disable-docs --disable-write --disable-python --disable-bindings --disable-shared --disable-json\` with \`CFLAGS=-O2 -sUSE_ZLIB=1 -DNDEBUG\`; link \`-O2 -lembind -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=1GB -sMAXIMUM_MEMORY=4GB -sMALLOC=mimalloc -sMODULARIZE=1 -sEXPORT_ES6=1\` (from the package's \`package.json\`) |
| Binary identifies itself as | \`${ver ? ver[0] : '?'}\` — a development snapshot ("dirty": built from a modified tree), so the exact source revision cannot be verified from the binary alone; see DWG.md |

Changes made by \`tools/vendor_libredwg.mjs\` (run it to reproduce these files byte for byte):

1. Glue: embind's two run-time code generators (\`new Function\` for function invokers and for
   emval method callers) are replaced by the closure versions Emscripten emits with
   \`-sDYNAMIC_EXECUTION=0\`, so the app's Content-Security-Policy needs only \`'wasm-unsafe-eval'\`.
2. WebAssembly: initial memory lowered from ${oldPages} pages (${oldPages / 16} MiB) to ${INITIAL_PAGES} pages (${INITIAL_PAGES / 16} MiB); it still
   grows on demand. (Static data ends at ${dataEnd} bytes, stack top ${stackTop}.)

| File | Bytes | SHA-256 |
|---|---|---|
| libredwg-web.js | ${Buffer.byteLength(glue)} | \`${sha256(glue)}\` |
| libredwg-web.wasm | ${wasm.length} | \`${sha256(wasm)}\` |

Source code: LibreDWG — https://git.savannah.gnu.org/git/libredwg.git and https://github.com/LibreDWG/libredwg ;
bindings and build scripts — https://github.com/mlightcad/libredwg-web . See DWG.md for the
plan to rebuild this binary from pinned sources (\`tools/build_dwg_wasm.sh\`).
`;
  writeFileSync(join(dir, 'README.md'), readme);
  console.log(readme);
}
