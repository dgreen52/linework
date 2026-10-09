# Linework

**A free, open-source CAD drawing viewer and markup tool that runs in your browser.**
Open DXF and DGN v7 drawings, find your way around, measure, and mark them up with clouds,
arrows and notes — on a desktop, a tablet or a phone, online or offline.

> **Your files never leave your device.** Linework reads drawings inside the browser tab. Nothing
> is uploaded, there is no account, no server, and no tracking. Once loaded it works fully
> offline (it installs as an app). That makes it safe for facilities and maintenance teams who
> are not allowed to put drawings on someone else's cloud.

*Working title — the name lives in one place: `src/config.js` (`APP_NAME`).*

## What it does (v0.1)

* **Opens** ASCII DXF (R12 through 2018) and DGN v7 (2D and 3D design files, shown in plan).
  Drag a file anywhere onto the window, or use **Open**. Try the built-in synthetic samples.
* **Views**: pan (drag, middle mouse, Space+drag, one finger), zoom at the cursor (wheel, pinch,
  `+`/`−`), **F** fits, box zoom, dark CAD background or white paper (white/black colour 7 swaps
  correctly), layer panel (toggle, isolate, colour swatches, filter), live coordinates in drawing
  units, hover to see what an item is (type, layer, block).
* **Measures** distance, path length and area with snaps to ends, middles, centres, crossings and
  nearest points; values in the drawing's units with 0–6 decimals; copy to clipboard.
* **Marks up** with pen, line, arrow, box, ellipse, revision cloud (drag a box or click a
  polygon), text callout (leader + box) and highlighter; colours and widths; select, move and
  delete; undo/redo (Ctrl+Z / Ctrl+Y); your name and a timestamp on every markup.
  Markups are saved to a small sidecar file, `<drawing>.markup.json`
  ([format](MARKUP_FORMAT.md)), stored in drawing coordinates, and also kept in this browser
  so a reload never loses work.
* **Exports** a PNG of the current view (with markups), and **prints / saves as PDF** with a
  title strip (title, file, date, author), landscape or portrait, current view or whole drawing.
* **Never crashes on a bad file**: it shows what loaded and a short "N items not shown" note.
  Binary DXF, DGN v8 and DWG get a friendly explanation instead of an error.

## Run it locally

It is a static site — no build step, no install.

```bash
node tools/serve.mjs 8080          # zero-dependency server included in the repo
# or
npx serve .                        # any static server works
# or
python -m http.server 8080         # (if .js is served as text/plain on your PC, use one of the above)
```

Then open <http://127.0.0.1:8080/>. Opening `index.html` straight from disk also lets you open
your own files, but samples and offline mode need a server (browser security rules).

**Hosting** costs ~$0: copy the folder to any static host (GitHub Pages, Netlify, an internal
web share, a USB stick with a tiny server). There is nothing to run on the server side.

## Keyboard shortcuts

| Get around | | Measure | | Mark up | |
|---|---|---|---|---|---|
| Drag / wheel / pinch | pan / zoom at cursor | `D` | distance | `V` | select (drag to move, `Delete` removes) |
| `F` | fit drawing | `G` | length along a path | `P` `N` `W` | pen, line, arrow |
| `Z` | zoom to a box | `A` | area | `R` `O` `C` | box, ellipse, revision cloud |
| `+` `−`, arrow keys | zoom, pan | `S` | snap on/off | `T` `K` | text callout, highlighter |
| `H` | pan tool | `Enter` / double-click | finish length/area | `Ctrl+Z` / `Ctrl+Y` | undo / redo |
| `L` | layers panel | `Backspace` | remove last point | `Ctrl+S` | save markups |
| `B` | dark / paper | `Esc` | cancel, back to pan | `Ctrl+O` / `Ctrl+P` | open / print |

Press `?` in the app for the same sheet.

## Supported formats and entities

| | DXF (ASCII R12–2018) | DGN v7 |
|---|---|---|
| Lines, polylines | LINE, LWPOLYLINE, POLYLINE (2D, with exact bulge arcs), 3DFACE, polyface/polygon mesh edges | Line (3), line string (4), shape (6) |
| Circles, arcs, ellipses | CIRCLE, ARC, ELLIPSE (incl. partial), exact at every zoom | Ellipse (15), arc (16), incl. rotated/elliptical and clockwise |
| Curves | SPLINE (NURBS via de Boor, or fit points), HELIX | Curve (11) |
| Complex | — | Complex chain (12) and complex shape (14) joined into one item |
| Text | TEXT (12 alignments, fit/aligned, width factor, oblique, mirrored), MTEXT (plain text, `\P` paragraphs, wrapping, attachment), ATTRIB/ATTDEF, `%%c %%d %%p`, `\U+xxxx`, cp1252/UTF-8 | Text (17), text node (7), 16-bit text |
| Blocks / cells | INSERT with position/scale (incl. negative = mirrored)/rotation, MINSERT arrays, nested blocks, BYBLOCK colour & linetype, attributes | Cell header (2): components shown where they are placed; the cell transform is read and reported |
| Dimensions, leaders | DIMENSION via its block (fallback drawing when the block is missing), LEADER with arrowhead | — |
| Fills | SOLID, TRACE, HATCH (solid fill; pattern hatches as a light screen pattern) | — |
| Points | POINT | — |
| Layers / levels | LAYER table: colour (ACI and true colour), on/off, frozen, linetype | Levels 1–63 (swatch = most common colour) |
| Colours | ACI 256-colour table, true colour (420) | Colour table element (type 5) or the default DGN palette |
| Line types | LTYPE dash patterns (shown at screen scale) | Line styles 0–7 |
| Units | `$INSUNITS` | Master/sub units and UORs from the TCB, global origin |
| Other | OCS/extrusion (e.g. mirrored arcs), paper space shown if model space is empty, `$EXTMIN/$EXTMAX`, CRLF/LF, padded group codes, missing HEADER/TABLES sections, truncated files | Deleted elements skipped, 2D and 3D files, truncated files |
| Skipped (reported as "not shown") | 3DSOLID, REGION, BODY, MESH, IMAGE, WIPEOUT, OLE, XREFs, proxy/custom entities | Shared cells, B-splines (21/24–28), raster, dimensions (33) |
| Not supported yet | Binary DXF, DWG ([plan](DWG.md)) | DGN v8 |

Coordinates far from the origin (state-plane style millions) are rendered with a local origin, so
millimetre detail stays crisp at deep zoom.

## Performance (measured)

From the Playwright suite (`tests/e2e/out/perf.json`), headless Microsoft Edge 154, software
rendering, 1440×900, on the development laptop. Real GPUs do better.

| | |
|---|---|
| App shell (HTML + CSS + JS + icons, gzip) | **≈100 KB** total, **≈81 KB** code — no dependencies |
| First open (DOMContentLoaded, local server) | ≈0.4 s |
| 53,100-entity stress drawing: generate + parse + index | ≈0.6–1.3 s, in a Web Worker with a progress bar |
| Main-thread long tasks while that drawing loads | **0** (UI never freezes) |
| Pan the 53k drawing at "fit all" | median **16.7 ms**/frame (60 fps), p95 ≈17 ms |
| Wheel zoom / pan zoomed in on the 53k drawing | median 16.7 ms, p95 16.8 ms |
| Normal drawings (house plan) | 0.1 ms to draw, 60 fps |

How: geometry is parsed and batched in a worker; each spatial chunk keeps one `Path2D` per style,
built lazily and drawn with the view transform (no re-tessellation on pan/zoom); arcs/ellipses
use exact canvas ellipses; small text is "greeked"; heavy views move the last frame with a CSS
transform during a gesture and redraw when it settles.

## Privacy and security

* No network requests except loading the app's own files from where it is hosted; a unit test
  fails if any external URL appears in the app shell.
* Drawings are read with `FileReader`/`File.arrayBuffer` and parsed in a Web Worker in the same
  browser tab. The service worker caches only the app's own files and never sees your drawings.
* Markups stay in the sidecar file you save and in this browser's local storage.

## Tests

```bash
npm test                                  # 56 Node unit tests (node --test, no dependencies)
NODE_PATH=/path/to/node_modules node tests/e2e/run.mjs   # 13 Playwright end-to-end tests
```

* Unit: DXF parser on every fixture (entity counts, extents, layer colours, block transforms with
  rotation/scale/mirroring/nesting, bulge arcs, encodings, broken files), DGN parser compared
  element-for-element with GDAL/OGR's independent reader (UOR scaling, global origin, colour
  table, cells, complex elements, 3D), geometry, snaps, measurement, markup sidecar round trip
  and schema checks, renderer smoke tests, offline cache completeness, colour contrast (WCAG AA).
* End to end: open every fixture, friendly errors, fit/zoom/box zoom, layer toggle (pixel check),
  measuring known distances/lengths/areas with snaps (DXF and DGN), every markup type, undo/redo,
  select/move/delete, sidecar save + reload in a fresh browser, autosave, PNG export, print
  emulation + one-page PDF, touch pinch/pan/finger drawing at 390 px, offline reload through the
  service worker, keyboard/a11y basics, drag and drop, performance. Screenshots (dark + paper at
  1440/1024/390) go to `tests/e2e/out/`.
* **All test drawings are synthetic**, generated by `tools/make_fixtures.mjs` (DXF) and
  `tools/make_dgn_fixtures.py` (DGN, via GDAL). No real drawings are used or committed.

## Project layout

```
index.html, app.css, sw.js, manifest.webmanifest   app shell (installable PWA)
src/model.js            common drawing model
src/formats/            dxf.js, dgn.js, detect.js (DWG/binary/v8 detection)
src/scene.js            blocks → flat primitives, colours, local origin, spatial grid
src/view/               viewport, Canvas2D renderer (WebGL-replaceable interface), batches, colours
src/tools/              snaps, measurement
src/markup/             markup model, revision clouds, sidecar format, undo history, drawing
src/app.js, src/app/    UI, input, tools, layers panel, export/print
src/worker.js           parse worker
samples/                synthetic sample drawings (+ generators in samples/gen/)
tools/                  fixture generators, palette extraction, icon rendering, static server
tests/unit, tests/e2e   tests
```

## Licence

**GPL-3.0** (see `LICENSE`; credits in `NOTICE`). Chosen so the planned DWG support, which
depends on the GPL-3.0 LibreDWG library, can be added without relicensing.

Trade-offs, for the owner to decide before the first public release:

* **GPL-3.0 (current):** anyone may use, host, change and share it for free, including at work;
  people who distribute modified versions must share their source under the same licence. It is
  compatible with LibreDWG. Some companies avoid embedding GPL code in their own closed products.
* **MIT or Apache-2.0:** maximum reuse (including in closed products), simpler for companies to
  adopt — but DWG support via LibreDWG would then have to live in a separate, optional GPL
  component (see [DWG.md](DWG.md)), and others could ship closed forks.

## Roadmap

* **v0.2** — DWG via LibreDWG compiled to WebAssembly, lazy-loaded ([plan](DWG.md)); vector PDF
  export (true lines and text instead of an image); measurement export (CSV).
* **v0.3** — WebGL renderer for very large drawings; true linetype scaling; hatch patterns;
  layouts / paper space tabs; markup resize handles and markup list panel.
* **Later** — binary DXF, DGN v8 (if a permissively licensed reader becomes viable), simple
  editing, shared markup review (still file-based, no server).

Deliberately **not** in v0.1: DWG, vector PDF, editing drawings.

## Known limitations

* Text uses the system sans-serif font (not the drawing's SHX/TrueType fonts), so text widths are
  approximate; MTEXT inline formatting (fonts, colours, stacking) is reduced to plain text.
* Linetype dashes are drawn at a fixed screen scale; complex linetypes with shapes/text show as
  their dash pattern only. Pattern hatches use a generic screen pattern.
* Dimensions are drawn from their stored block (as CAD programs do); dimension styles are not
  re-evaluated.
* 3D drawings are shown in plan (top) view only; DGN 3D cells and views are not interpreted.
* DGN cell components are drawn at their stored (already placed) positions; shared cells (35),
  B-spline elements and raster references are reported as not shown.
* Printing is a high-resolution image, not to scale.
