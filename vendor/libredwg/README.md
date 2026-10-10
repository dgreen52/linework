# LibreDWG (WebAssembly) — vendored

Used by `src/formats/dwg.js` to read DWG files. Loaded only when a DWG is opened.

| | |
|---|---|
| Library | GNU LibreDWG 0.13.3.7825.246_0c9ab_dirty — https://www.gnu.org/software/libredwg/ |
| Licence | GPL-3.0-or-later (LibreDWG); GPL-3.0 (JavaScript bindings); MIT (Emscripten runtime glue, mimalloc); zlib licence (zlib); see `NOTICE` |
| Built by | the `@mlightcad/libredwg-web` project — https://github.com/mlightcad/libredwg-web (Emscripten + embind bindings over LibreDWG) |
| Taken from | npm `@mlightcad/libredwg-web@0.7.16`, files `wasm/libredwg-web.js` and `wasm/libredwg-web.wasm` |
| npm integrity | `sha512-gWmjJ5TVNHR7JSHSke0Y8WmvTDPRTUNiRUejbIiymdjR4FV8Jv3hulR0Cv4TNwihr+r1DaxoD0phOFDENY5+Nw==` |
| Upstream build flags | `configure --enable-release --enable-debug --disable-docs --disable-write --disable-python --disable-bindings --disable-shared --disable-json` with `CFLAGS=-O2 -sUSE_ZLIB=1 -DNDEBUG`; link `-O2 -lembind -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=1GB -sMAXIMUM_MEMORY=4GB -sMALLOC=mimalloc -sMODULARIZE=1 -sEXPORT_ES6=1` (from the package's `package.json`) |
| Binary identifies itself as | `LibreDWG 0.13.3.7825.246_0c9ab_dirty` — a development snapshot ("dirty": built from a modified tree), so the exact source revision cannot be verified from the binary alone; see DWG.md |

Changes made by `tools/vendor_libredwg.mjs` (run it to reproduce these files byte for byte):

1. Glue: embind's two run-time code generators (`new Function` for function invokers and for
   emval method callers) are replaced by the closure versions Emscripten emits with
   `-sDYNAMIC_EXECUTION=0`, so the app's Content-Security-Policy needs only `'wasm-unsafe-eval'`.
2. WebAssembly: initial memory lowered from 16384 pages (1024 MiB) to 1024 pages (64 MiB); it still
   grows on demand. (Static data ends at 2032616 bytes, stack top 2142944.)

| File | Bytes | SHA-256 |
|---|---|---|
| libredwg-web.js | 115309 | `0ee79ab6ea8f24b82bc0effb756f58964c73ad1817a00cc29fed180d1a6e06d7` |
| libredwg-web.wasm | 9496803 | `f31e67b65c42b1938037ac8f97318affd315e6c27ead6611daa8a96e6948040b` |

Source code: LibreDWG — https://git.savannah.gnu.org/git/libredwg.git and https://github.com/LibreDWG/libredwg ;
bindings and build scripts — https://github.com/mlightcad/libredwg-web . See DWG.md for the
plan to rebuild this binary from pinned sources (`tools/build_dwg_wasm.sh`).
