# DWG support (v0.3)

Linework opens DWG files (AutoCAD R13 to 2018 formats) with **GNU LibreDWG** compiled to
WebAssembly. The reader runs in the parse worker, inside the browser tab: the file never leaves
the device, and nothing is fetched from anywhere but the app's own origin. Linework does **not**
write DWG: an edited DWG is saved as DXF (default) or DGN v7, and the save dialog says so.

## How it works

| Piece | What |
|---|---|
| `vendor/libredwg/libredwg-web.wasm` (+ `.js` glue) | LibreDWG + JavaScript bindings, 9.5 MB raw, **2.1 MB gzip**, 1.1 MB brotli. Fetched only when the first DWG is opened. |
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
  upstream build reserves, so tablets and phones can instantiate it.
* **R12 and older** DWGs are refused with a clear message (LibreDWG's support for them is
  experimental).

## Content-Security-Policy

Compiling WebAssembly needs `'wasm-unsafe-eval'` in `script-src` — nothing else (no
`'unsafe-eval'`). The upstream Emscripten glue built functions with `new Function` (embind); the
vendoring script replaces those two code generators with the closure versions Emscripten emits
for `-sDYNAMIC_EXECUTION=0`, and a unit test fails if any `eval`/`new Function` comes back. The
policy is in `deploy/_headers`:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
```

`tools/serve.mjs` applies `deploy/_headers`, so the e2e tests run under this exact policy; one
e2e test also serves the app *without* `'wasm-unsafe-eval'` and checks that the DWG reader is
refused (and the app says so) while DXF keeps working — proof that the policy really applies to
the worker that compiles the module.

## Where the binary comes from (decision)

**Preferred: build it ourselves** from pinned LibreDWG sources with Emscripten
(`tools/build_dwg_wasm.sh`). That could not be done for this release: the Emscripten SDK and
source downloads were not reachable from the available build environment.

**Used for v0.3: the prebuilt npm package `@mlightcad/libredwg-web@0.7.16`**, vetted:

| Check | Result |
|---|---|
| Licence | GPL-3.0 (package), LibreDWG GPL-3.0-or-later — compatible with Linework's GPL-3.0 |
| Source | public repository https://github.com/mlightcad/libredwg-web (LibreDWG tree + embind bindings + build scripts in its `package.json`) |
| Pinned | exact version 0.7.16, npm integrity `sha512-gWmjJ5TV…ENY5+Nw==` checked by `tools/vendor_libredwg.mjs` |
| Contents | only `wasm/libredwg-web.js` + `.wasm` are vendored (not the package's TypeScript wrapper) |
| Glue | used `new Function` (embind) → patched, see above; no external URLs, no network access other than the (bypassed) wasm fetch |
| Memory | 1 GiB initial → patched to 64 MiB |
| Size | 9,496,803 bytes raw, 2,167,875 gzip, 1,083,860 brotli |
| Version | identifies itself as `LibreDWG 0.13.3.7825.246_0c9ab_dirty` |

`vendor/libredwg/README.md` records provenance, changes and SHA-256 hashes; `NOTICE` has the
licence section. Re-running `npm pack @mlightcad/libredwg-web@0.7.16` + `node
tools/vendor_libredwg.mjs <tgz>` reproduces the vendored files byte for byte.

**GPL caveat (to resolve before a public release).** GPL-3.0 requires the *corresponding source*
of the object code we distribute. The vendored binary says it was built from a modified ("dirty")
tree at LibreDWG snapshot `0c9ab`, so its exact source cannot be verified from the binary alone.
Pointing to the upstream repositories is the usual practice, but the clean fix is to rebuild with
`tools/build_dwg_wasm.sh` from a pinned commit (it also removes the need for the glue/memory
patches) and vendor that output instead. Steps: run the script with `LIBREDWG_WEB_REF=<commit>`
on a machine with normal network access, bump `READER_REV` (`src/formats/dwg.js`) and
`READER_CACHE` (`sw.js`), regenerate `vendor/libredwg/README.md`, run the unit + e2e tests.

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
  DWG drawing as DXF and reading it back, the vendored files' hashes and absence of run-time code
  generation.
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
3. Rebuild from pinned sources (`tools/build_dwg_wasm.sh`), then size/perf tuning (`-Oz`, drop
   unused LibreDWG parts, streaming compile); R2004+ synthetic fixtures.
