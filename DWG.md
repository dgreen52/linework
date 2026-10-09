# DWG support plan (v0.2)

v0.1 opens DXF and DGN v7. When a DWG is dropped in, the app detects it from the file's version
magic and says: *"DWG support is coming. For now, export the drawing to DXF."* This document
plans how v0.2 adds DWG without breaking the product principles (light, smooth, works offline,
files never leave the device, ~$0 to run).

## Approach: LibreDWG compiled to WebAssembly

[LibreDWG](https://www.gnu.org/software/libredwg/) is the GNU project's free C library for
reading DWG (R13 through 2018 in good shape, R2000–2018 most complete). It can be compiled to
WebAssembly with Emscripten and run inside our existing parse worker.

1. **Build** `libredwg` with Emscripten (`emconfigure ./configure --disable-bindings ... && emmake make`),
   exporting a tiny C shim: `int lw_read(const uint8_t *buf, size_t len)` plus iterators that
   walk model-space entities, blocks, layers and the header. Pin the LibreDWG release and record
   the exact build command in `tools/build_dwg_wasm.sh` so the binary is reproducible.
2. **Map** LibreDWG objects to the common drawing model (`src/model.js`) in a new
   `src/formats/dwg.js`. The mapping mirrors `dxf.js` (same entity types, same group semantics:
   LINE, LWPOLYLINE with bulges, CIRCLE/ARC/ELLIPSE, SPLINE, TEXT/MTEXT, INSERT with attributes,
   DIMENSION via its anonymous block, HATCH boundaries, SOLID). Everything downstream — scene
   building, rendering, snaps, measurement, markups — is unchanged.
   *Fallback/shortcut:* LibreDWG can also emit DXF in memory (`dwg_write_dxf`); feeding that text
   to the existing DXF reader is a quick first milestone, at the cost of speed and memory.
3. **Lazy-load**: the `.wasm` (expected 2–4 MB, ~1 MB gzipped) is fetched only the first time
   a DWG is opened and is cached by the service worker afterwards, so the app shell stays under
   the 150 KB budget and DXF/DGN users never download it.
4. **Never upload**: the WASM runs in the browser worker exactly like the JS parsers; no server.
5. **Guard rails**: run the parse with a time/memory budget, catch traps from the WASM module,
   and fall back to "this DWG could not be read — export to DXF" with the usual
   "N items not shown" report for partially readable files.

## Licence implications (important)

* LibreDWG is **GPL-3.0-or-later**. Distributing it together with the app means the combined
  work must be distributed under GPL-3.0-compatible terms, with source available.
* That is why `LICENSE` is **GPL-3.0** for v0.1: adding DWG later needs no relicensing.
* If the owner prefers a permissive licence (MIT/Apache-2.0) for the main app before the first
  public release, the DWG converter must stay a clearly separate, optional GPL component
  (separate download, separate licence, communicating through a narrow interface). Whether a
  WASM module loaded into the same page is "mere aggregation" is a grey area; get legal advice
  before relying on it. Keeping the whole app GPL-3.0 is the simple, safe option.
* GPL-3.0 does not stop anyone using the app at work or hosting it for free; it only requires
  that modified versions that are distributed also share their source.

## Alternatives considered

| Option | Why not (for now) |
|--------|-------------------|
| ODA Drawings SDK / web SDK | Proprietary, membership fees, licence terms incompatible with a free open-source app. |
| Server-side conversion | Breaks the privacy promise (files would leave the device) and adds running costs. |
| Writing a DWG reader from scratch | The format is large and only partly documented publicly (Open Design Specification); LibreDWG already encodes years of that work. |

## Testing (synthetic only)

* Generate DWG fixtures by converting our synthetic DXF fixtures with LibreDWG's own `dxf2dwg`
  tool (`tools/make_dwg_fixtures.sh`). No real or employer drawings, ever.
* Oracle: the same fixture opened as DXF must produce the same scene (entity counts, extents,
  layer colours, block transforms) as the DWG — reuse the existing unit-test helpers.
* E2E: open each DWG fixture, measure a known distance, and check the lazy-load + offline cache.

## Milestones

1. WASM build + shim + DXF-text bridge (works end to end, slower).
2. Direct object mapping in `dwg.js`, progress reporting, partial-file handling.
3. Size/perf tuning (strip unused LibreDWG writers, `-Oz`, streaming compile).
