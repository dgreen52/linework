# LibreDWG (WebAssembly) — vendored

Used by `src/formats/dwg.js` to read DWG files. Loaded only when a DWG is opened.

Built from pinned sources by `tools/build_dwg_wasm.sh` and installed unchanged by
`tools/vendor_libredwg.mjs` (which also wrote this file). Nothing is patched after the build.

| | |
|---|---|
| Library | GNU LibreDWG — https://www.gnu.org/software/libredwg/ ; the binary reports `LibreDWG 0.13.4.197_0d4f` (a snapshot built from a clean source tree) |
| Licence | GPL-3.0-or-later (LibreDWG); GPL-3.0 (JavaScript bindings); MIT (Emscripten runtime glue, mimalloc); zlib licence (zlib); see `NOTICE` |
| Source | https://github.com/mlightcad/libredwg-web tag `v0.7.16`, commit `0d4fd3fbe6eb1a451d7c5ce286d0785e4d65dd29`: the LibreDWG source tree with the Emscripten/embind bindings (`bindings/javascript/embind/`); the same C/C++ sources as npm `@mlightcad/libredwg-web@0.7.16` |
| Submodule | `jsmn` (https://github.com/zserge/jsmn) at commit `85695f3d5903b1cd5b4030efe50db3b4f5f3c928`, as pinned by that commit |
| LibreDWG base | upstream LibreDWG release `0.13.4` (commit `e3774bd4020fcfebb68150361db74b8b34d170fe`) is in that history; the version string counts the commits since it |
| Toolchain | Emscripten SDK `4.0.6` (emsdk commit `24fc909c0da13ef641d5ae75e89b5a97f25e37aa`): `emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 4.0.6 (1ddaae4d2d6dfbb678ecc193bc988820d1fc4633)` |
| Configure | `--enable-release --enable-debug --disable-docs --disable-write --disable-python --disable-bindings --disable-shared --disable-json` with `CFLAGS=-O2 -sUSE_ZLIB=1 -DNDEBUG` |
| Compile (C) | `make -C src CFLAGS="-sUSE_ZLIB=1 -DNDEBUG -Wno-limited-postlink-optimizations -Wno-cast-align -fno-omit-frame-pointer -O2"` |
| Link | `-O2 -lembind -std=c++17 -sWASM_BIGINT=1 -sDYNAMIC_EXECUTION=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB -sMALLOC=mimalloc -sEXPORT_ES6=1 -sMODULARIZE=1 -sEXPORT_NAME=createModule -sEXPORTED_RUNTIME_METHODS=FS,ENV,ccall,cwrap,UTF8ToString,stringToNewUTF8,setValue` |
| Built on | GitHub Actions: https://github.com/dgreen52/linework/actions/runs/38036898443 (workflow `.github/workflows/build-libredwg-wasm.yml` at commit `24755f1b031f2f3ddb3f5ea802c7ff4aa3ca1f24` of this repository; runner image `ubuntu24 20261004.327.1`) |
| Memory | initial 1024 pages (64 MiB), grows on demand up to 65536 pages (4 GiB) |

Differences from the npm package's own build (the scripts in its `package.json`):
`-sDYNAMIC_EXECUTION=0` (the glue never generates code at run time, so the Content-Security-Policy
needs only `'wasm-unsafe-eval'`), 64 MiB initial memory instead of 1 GiB (phones and tablets), no
TypeScript declarations, and the C code compiled with `-O2` (configure removes it when
`--enable-debug` is given; these sources need that option, for LibreDWG's DEBUG_CLASSES).

| File | Bytes | SHA-256 |
|---|---|---|
| libredwg-web.js | 111545 | `4432a43f3477bbc8015ca1d001a595d91db2feb216efd8abd1cad380d67856cc` |
| libredwg-web.wasm | 9389632 | `93281952e1edb1d83195de6f4079433c2b8135e52813eee898d43d96458727dc` |

Corresponding source: the commits above and `tools/build_dwg_wasm.sh`, which fetches exactly those,
verifies them and records them in `build-info.json` (part of the workflow artifact). Sources:
https://github.com/mlightcad/libredwg-web , LibreDWG https://git.savannah.gnu.org/git/libredwg.git .
See DWG.md.
