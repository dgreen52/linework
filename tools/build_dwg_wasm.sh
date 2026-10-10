#!/usr/bin/env bash
# Rebuild vendor/libredwg/ (LibreDWG -> WebAssembly) from pinned sources, so the DWG reader binary
# is reproducible and its corresponding source is exactly known (GPL-3.0). See DWG.md.
#
#   LIBREDWG_WEB_REF=<commit or tag> tools/build_dwg_wasm.sh
#
# Needs: Linux, macOS or WSL with git, python3, make, autoconf, automake, libtool, texinfo, and
# network access to github.com and the Emscripten SDK downloads.
#
# It builds the same JavaScript API as the vendored binary (the embind bindings of the
# libredwg-web project), with three differences that tools/vendor_libredwg.mjs otherwise patches in:
#   -sDYNAMIC_EXECUTION=0   no eval/new Function in the glue (CSP needs only 'wasm-unsafe-eval')
#   -sINITIAL_MEMORY=64MB   instead of 1 GB (phones and tablets)
#   no --enable-debug       stable classes only
# After the build, update READER_REV in src/formats/dwg.js and READER_CACHE in sw.js, then run the
# unit and e2e tests (tests/unit/dwg.test.mjs compares every DWG fixture with its DXF).
#
# NOTE: not run yet (the SDK downloads were not reachable from the environment used for v0.3);
# the vendored binary currently comes from the npm package (tools/vendor_libredwg.mjs).
set -euo pipefail

EMSDK_VERSION="${EMSDK_VERSION:-3.1.74}"
LIBREDWG_WEB_REPO="${LIBREDWG_WEB_REPO:-https://github.com/mlightcad/libredwg-web.git}"
LIBREDWG_WEB_REF="${LIBREDWG_WEB_REF:?set LIBREDWG_WEB_REF to the libredwg-web commit or tag to build (pin it in DWG.md)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$ROOT/.build-dwg}"   # outside version control (see .gitignore)
OUT="$ROOT/vendor/libredwg"

mkdir -p "$WORK"
cd "$WORK"

# 1. Emscripten SDK, pinned
if [ ! -d emsdk ]; then git clone https://github.com/emscripten-core/emsdk.git; fi
(cd emsdk && git fetch --tags && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION")
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh

# 2. LibreDWG + JavaScript bindings, pinned
if [ ! -d libredwg-web ]; then git clone "$LIBREDWG_WEB_REPO" libredwg-web; fi
cd libredwg-web
git fetch --all --tags
git checkout --detach "$LIBREDWG_WEB_REF"
git submodule update --init --recursive
git clean -xfd
sh ./autogen.sh

# 3. Configure + compile LibreDWG (read-only: no DWG/DXF writers except the DXF output used as a
#    fallback, no JSON, no Python)
rm -rf build-wasm && mkdir build-wasm && cd build-wasm
emconfigure ../configure CFLAGS="-O2 -sUSE_ZLIB=1 -DNDEBUG" CC=emcc \
  --enable-release --disable-docs --disable-write --disable-python --disable-bindings --disable-shared --disable-json
emmake make -C src

# 4. Link the bindings
emcc ../bindings/javascript/embind/*.cpp src/*.o -O2 -lembind -std=c++17 -Isrc -I../src -I../include \
  -o libredwg-web.js \
  -sDYNAMIC_EXECUTION=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB -sMALLOC=mimalloc \
  -sEXPORT_ES6=1 -sMODULARIZE=1 -sEXPORT_NAME=createModule \
  -sEXPORTED_RUNTIME_METHODS=FS,ENV,ccall,cwrap,UTF8ToString,stringToNewUTF8,setValue

# 5. Install + check (no run-time code generation may remain in the glue)
mkdir -p "$OUT"
{ echo "// LibreDWG for Linework: built by tools/build_dwg_wasm.sh from libredwg-web $LIBREDWG_WEB_REF with Emscripten $EMSDK_VERSION. Emscripten runtime: MIT licence."; cat libredwg-web.js; } > "$OUT/libredwg-web.js"
cp libredwg-web.wasm "$OUT/libredwg-web.wasm"
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { dynamicCodeSites } from '$ROOT/tools/vendor_libredwg.mjs';
const left = dynamicCodeSites(readFileSync('$OUT/libredwg-web.js', 'utf8'));
if (left.length) { console.error('dynamic code left in the glue:', left); process.exit(1); }
console.log('glue OK; wasm bytes:', readFileSync('$OUT/libredwg-web.wasm').length);
"
echo "Now: set WASM_SIZE + READER_REV in src/formats/dwg.js, READER_CACHE in sw.js, rewrite vendor/libredwg/README.md, run the tests."
