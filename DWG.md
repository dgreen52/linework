# DWG support (v0.3)

Linework opens DWG files (AutoCAD R13 to 2018 formats) with **GNU LibreDWG** compiled to
WebAssembly. The reader runs in the parse worker, inside the browser tab: the file never leaves
the device, and nothing is fetched from anywhere but the app's own origin. Linework does **not**
write DWG: an edited DWG is saved as DXF (default) or DGN v7, and the save dialog says so.

## How it works

| Piece | What |
|---|---|
| `vendor/libredwg/libredwg-web.wasm` (+ `.js` glue) | LibreDWG + JavaScript bindings, built from pinned sources (see below); 9.4 MB raw, **2.1 MB gzip**, 1.07 MB brotli. Fetched only when the first DWG is opened. |
| `src/formats/dwg.js` | Loads the module (once per worker), reads the DWG, maps it to the drawing model. Imported lazily by `detect.js` (`parseDrawingAsync`); 12 KB gzip. |
| `src/worker.js` / `src/app.js` | Progress ("Loading the DWG reader for …", "Reading …"); the page applies a time limit to the one blocking read. |
| `sw.js` | DXF/DGN users never download the reader. After the first DWG, `dwg.js` is in the app cache and the reader in its own cache (`READER_CACHE`), which survives app updates; DWGs then open offline. |

**Mapping (milestone 2, done).** `dwg.js` walks LibreDWG's decoded objects (tables, blocks in
stored order, model and paper space) and translates each one into the DXF group codes it stands
for; the DXF reader's own logic (`readDxf` in `dxf.js`) then builds the model. A DWG therefore
behaves exactly like the same drawing saved as DXF: blocks and attributes, OCS/extrusion, text
alignment, MTEXT, dimensions (drawn from their anonymous blocks), hatches (incl. edge and pattern
data), splines (control and fit points), 2D/3D polylines, polyface and polygon meshes, 3DFACE,
SOLID/TRACE, leaders, line types, layer colour/on/off/frozen, true colours (R2004+), code pages
(pre-2007 text) and Unicode (2007+). Anything else (3DSOLID, REGION, IMAGE, WIPEOUT, OLE,
proxy and custom objects, MLINE, MULTILEADER, …) is counted in the usual "N items not shown".

**Fallback (milestone 1).** If the mapping fails, LibreDWG's own DXF writer converts the file in
memory and the DXF reader reads that text (layer on/off states are then taken from the decoded
layers, because this LibreDWG build's DXF writer marks every R13–R2000 layer as off).

## Guard rails

* **Fresh WebAssembly instance per file** (the compiled module is reused): a trap or a corrupted
  heap can never affect the next file. Traps (`RuntimeError`), aborts and out-of-memory are caught
  and become *"This DWG could not be read; save it as DXF and open that."* (or "needs more memory
  than the browser allows").
* **Time limit**: the decode is one blocking call; the page stops the worker after 120 s
  (`app.readTimeLimitMs`) with a friendly message, and the next file starts a fresh worker.
* **Size limit**: DWGs over 120 MB are refused up front (`MAX_DWG_BYTES`).
* **Partial files**: whatever LibreDWG decoded is shown; serious read errors add a warning to the
  usual "N items not shown" note. Fuzz tests (truncated and byte-corrupted DWGs) check that every
  damaged file either opens or gives the friendly message.
* **Memory**: initial WebAssembly memory 64 MiB (grows on demand up to 4 GiB), not the 1 GiB the
  npm package's build reserves, so tablets and phones can instantiate it.
* **R12 and older** DWGs are refused with a clear message (LibreDWG's support for them is
  experimental).

## Content-Security-Policy

Compiling WebAssembly needs `'wasm-unsafe-eval'` in `script-src` — nothing else (no
`'unsafe-eval'`). The reader is built with `-sDYNAMIC_EXECUTION=0`, so embind's glue uses closures
where it would otherwise build functions with `new Function`; `tools/vendor_libredwg.mjs` refuses,
and a unit test fails on, any `eval`/`new Function` in the glue. The policy is in `deploy/_headers`:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
```

`tools/serve.mjs` applies `deploy/_headers`, so the e2e tests run under this exact policy; one
e2e test also serves the app *without* `'wasm-unsafe-eval'` and checks that the DWG reader is
refused (and the app says so) while DXF keeps working — proof that the policy really applies to
the worker that compiles the module.

## Where the binary comes from

**Built from pinned sources on GitHub Actions.** The workflow
`.github/workflows/build-libredwg-wasm.yml` runs `tools/build_dwg_wasm.sh` (the one build recipe;
it runs the same on any Linux, macOS or WSL machine with network access) and uploads the result as
the artifact `libredwg-wasm`; `tools/vendor_libredwg.mjs` checks that build and installs it into
`vendor/libredwg/` unchanged, writing `vendor/libredwg/README.md` (pins, flags, run, SHA-256).

| Pin | Value |
|---|---|
| Sources | https://github.com/mlightcad/libredwg-web tag `v0.7.16`, commit `0d4fd3fbe6eb1a451d7c5ce286d0785e4d65dd29`: a fork of LibreDWG (its whole source tree, not a submodule) plus the embind bindings in `bindings/javascript/embind/`. Its C/C++ sources are those of npm `@mlightcad/libredwg-web@0.7.16` (the two commits after that package's last binary change touch only TypeScript). |
| Submodule | `jsmn` commit `85695f3d5903b1cd5b4030efe50db3b4f5f3c928` (as pinned by that commit) |
| Upstream base | descends from LibreDWG release `0.13.4` (commit `e3774bd4020fcfebb68150361db74b8b34d170fe`) via upstream commit `6d6a33987a1a97095b069c799c3d8a793320f812`; the binary reports `LibreDWG 0.13.4.197_0d4f` (197 commits after 0.13.4, clean tree) |
| Toolchain | Emscripten SDK `4.0.6` (emsdk commit `24fc909c0da13ef641d5ae75e89b5a97f25e37aa`; emcc `1ddaae4d2d6dfbb678ecc193bc988820d1fc4633`), Ubuntu 24.04 runner (autoconf 2.71, automake 1.16.5, libtool 2.4.7) |
| Build | https://github.com/dgreen52/linework/actions/runs/38036898443 — `libredwg-web.wasm` 9,389,632 bytes, SHA-256 `93281952e1edb1d83195de6f4079433c2b8135e52813eee898d43d96458727dc`; `libredwg-web.js` 111,545 bytes, `4432a43f3477bbc8015ca1d001a595d91db2feb216efd8abd1cad380d67856cc`. Two other runs on other runners (38036162649, 38038100405) produced the same bytes. |

Build flags: the npm package's own (its `package.json` scripts: `--enable-release --enable-debug
--disable-write …`, `-O2 -lembind -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sMALLOC=mimalloc
-sMODULARIZE=1 -sEXPORT_ES6=1 …`) plus `-sDYNAMIC_EXECUTION=0`, `-sINITIAL_MEMORY=64MB` (instead of
1 GB) and `-O2` for the library's C code (`--enable-debug`, which these sources need for LibreDWG's
DEBUG_CLASSES, makes configure drop it; 9.4 MB instead of 10.9 MB). Nothing is patched after the
build. Emscripten 4.x matters: it passes 64-bit integers as BigInt (`WASM_BIGINT`), which the
bindings need; a 3.1.74 build lost handle references (layer line types, blocks).

The version string is LibreDWG's own `build-aux/git-version-gen`, run on the clean checkout with
upstream `0.13.4` as the only tag and fixed in `.tarball-version` before `autoreconf` — which
rewrites tracked files such as `src/config.h.in`, the likely source of the npm binary's `_dirty`.

**Updating the reader:** change the pins at the top of `tools/build_dwg_wasm.sh` and push (the
workflow runs when the script or the workflow changes; it can also be started by hand — the
Actions tab offers that once the workflow is on `main`, the REST API's workflow dispatch works for
any branch), download the `libredwg-wasm` artifact, run
`node tools/vendor_libredwg.mjs <unpacked artifact>`, set `WASM_SIZE` and bump `READER_REV`
(`src/formats/dwg.js`) together with `READER_CACHE` (`sw.js`), then run the unit and e2e tests.

**History.** v0.3.0–0.3.1 shipped the npm package's prebuilt binary (`LibreDWG
0.13.3.7825.246_0c9ab_dirty`, 9,496,803 bytes), patched for the CSP and the initial memory. It is
byte-identical to the binary committed in the libredwg-web repository at the tag, but it was built
from a modified tree, and none of our builds of the tagged sources reproduces it (Emscripten
4.0.0–4.0.7 with the package's flags; 4.0.6 with `-O2`), so its exact corresponding source could not
be shown. This build replaces it: same sources and
bindings, every DWG fixture reads exactly as before, 1% smaller (2,146,389 bytes gzip instead of
2,167,875; brotli 1,066,336 instead of 1,083,860).

**Corresponding source (GPL-3.0).** `vendor/libredwg/README.md` and `NOTICE` point to the exact
commits, and `tools/build_dwg_wasm.sh` fetches them. Because GPL-3.0 §6 makes the distributor
responsible for the source staying available, the project keeps its own copy:
https://github.com/dgreen52/libredwg-web (a fork of mlightcad/libredwg-web holding the pinned
commit and the v0.7.16 tag). Keep that fork in place for as long as this build is distributed.

## Testing (synthetic only)

* **Fixtures**: `tools/make_dwg_fixtures.mjs` converts the repo's own synthetic DXF files (the
  samples plus edge fixtures, and `edge-dwg-coverage.dxf`, a drawing made to exercise entity and
  table variants) to **DWG R2000 (AC1015)** with `tools/dwg-r2000.mjs`, a small DWG writer
  written for the tests from the public *Open Design Specification for .dwg files*. Output is
  deterministic (a test regenerates and compares). No real or work drawings, ever.
* **Oracle**: every DWG fixture must give the same model and scene as its DXF source — entity
  counts by type, "not shown" counts, warnings, layers (colour, on/off, frozen, line type), units,
  block names/base points/contents, every insert's transform and attributes, extents, every drawn
  primitive (kind, layer, colour, bounding box) and every text. Both the direct mapping and the
  LibreDWG-DXF fallback are checked (the fallback has two known gaps on the coverage drawing:
  constant attribute text and one bulged 2D polyline).
* **Also tested**: version detection (R13–2018 magic), friendly errors (stub, old versions,
  oversize, garbage), fuzzing (truncated/corrupted files), a broken file followed by a good one,
  variants real files have (strings stored with their terminating NUL; a model space whose entity
  links are missing — the reader then collects entities by their space), colour methods, saving a
  DWG drawing as DXF and reading it back; the vendored reader: hashes recorded in its README,
  no run-time code generation, 64 MiB / 4 GiB memory limits, a clean version string, pinned
  source and toolchain commits.
* **E2E** (Playwright, real CSP): the reader is not fetched for DXF/DGN and is fetched once for
  DWG; progress names the download; a DWG measures exactly like the DXF (snaps); layer toggle;
  edit + Save → DXF (the dialog says DWG is not written) → re-open; offline re-open through the
  service worker; time limit; CSP negative control.

**Not covered by fixtures yet**: R13/R14 and R2004–R2018 files. LibreDWG reads them (its own
test suite covers them), and the version-specific mapping paths (Unicode strings of 2007+, colour
methods of 2004+, owned-object lists of 2004+) are written against LibreDWG's API, but there is no
synthetic fixture in those versions because the test writer only produces R2000. Writing R2004+
(compressed sections) is the next testing step.

## Known limits

* Versions: R13–2018 (AC1012–AC1032). R12 and older are refused. Newer (2019+ uses AC1032 too)
  files read as 2018.
* Not shown (reported): 3D solids/regions/bodies/meshes (ACIS), images, wipeouts, OLE objects,
  proxy/custom objects, MLINE, MULTILEADER, TOLERANCE, RAY/XLINE, SHAPE, external references.
* Layouts: model space is shown; paper space only when model space is empty (as for DXF).
* Saving: DXF or DGN v7 only. DWG-only data (layouts, dimension styles, extended data,
  dictionaries) is not carried into the saved file.
* Performance: ~50–300 ms for the test drawings (Node), most of it instantiating the module.
  Very large DWGs need several times their size in WebAssembly memory.

## LibreDWG quirks found while testing (this build)

* `dwg_entity_polyline_2d_get_vertices` drops the last vertex of R13–R2000 polylines → the
  mapping walks the owned VERTEX sub-entities instead.
* The fixed `vertind[4]` array of polyface faces is not converted by the value API → read in place.
* The DXF writer skips the remaining blocks when all block headers precede the block contents in
  the object list, and marks R13–R2000 layers as off → one more reason the direct mapping is
  primary (the fallback repairs layer states).

## Licence implications

LibreDWG is GPL-3.0-or-later, so the app (which loads it into the same page) stays GPL-3.0; that
is why Linework was GPL-3.0 from v0.1. If a permissive licence is ever wanted for the main app,
the DWG reader must become a clearly separate, optional GPL component — get legal advice first.

## Milestones

1. ~~WASM + DXF-text bridge~~ — done (now the fallback).
2. ~~Direct object mapping, progress, partial-file handling~~ — done.
3. ~~Rebuild from pinned sources~~ — done (`tools/build_dwg_wasm.sh` on GitHub Actions).
4. Size/perf tuning (`-Oz`, drop unused LibreDWG parts, streaming compile); R2004+ synthetic
   fixtures.
