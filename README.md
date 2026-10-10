# Linework

**A free, open-source CAD drawing viewer, markup tool and light editor that runs in your browser.**
Open DXF and DGN v7 drawings, find your way around, measure, mark them up with clouds, arrows
and notes, fix the drawing itself (move, reshape, retype, draw) and save it back as DXF or
DGN v7 — on a desktop, a tablet or a phone, online or offline.

> **Your files never leave your device.** Linework reads drawings inside the browser tab. Nothing
> is uploaded, there is no account, no server, and no tracking. Once loaded it works fully
> offline (it installs as an app). That makes it safe for facilities and maintenance teams who
> are not allowed to put drawings on someone else's cloud.

*Working title — the name lives in one place: `src/config.js` (`APP_NAME`).*

## What it does (v0.2)

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
* **Edits the drawing** (new in v0.2, see [Edit mode](#edit-mode)): select, move, nudge, rotate,
  delete; double-click to retype text in place or to reshape lines, polylines and circles with
  handles; draw lines, polylines, rectangles, circles and text on any layer; change layer, colour
  and line weight; **copy and paste between drawings** (DGN ↔ DGN, DXF ↔ DGN, across tabs) and
  **duplicate**; one undo history for edits and markups.
* **Saves** the edited drawing as **DXF** (R2000) or **DGN v7** — downloaded to your device,
  never uploaded. A DGN you opened is saved back with every untouched element byte-for-byte.
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

| Edit the drawing | |
|---|---|
| `E` | Edit mode (select tool) — then `V` select, `N` line, `P` polyline, `R` rectangle, `O` circle, `T` text |
| Click / `Shift`+click | select / add or remove; `Ctrl+A` selects everything |
| Drag a box | left→right: items fully inside (solid box) · right→left: anything touched (dashed box) |
| Drag | move the selection (snaps; `Shift` keeps it horizontal/vertical); `Ctrl`+drag (`Alt` on a Mac) drops a copy |
| `Ctrl+C` / `Ctrl+V` | copy the selection / paste it (also into another drawing or tab): the items follow the cursor, click places them, `Esc` cancels |
| `Ctrl+Shift+V` | paste in place (same coordinates) |
| `Ctrl+D` | duplicate the selection (follows the cursor, click places it) |
| Arrow keys | nudge 1 screen pixel (`Shift`: 10) |
| Double-click | retype text in place / show handles to reshape |
| Right-click a handle / a side | delete that point / add a point (double-click a side also adds) |
| Type a number | while drawing a line: exact length along the cursor, then `Enter` |
| `C` / `Enter` / double-click | close / finish a polyline |
| `Delete` | delete the selection |
| `Ctrl+S` / `Ctrl+Shift+S` | save the drawing (in Edit) / save as DXF or DGN |

On touch screens: tap to select, drag to move, long-press for a menu (edit, copy, duplicate, rotate,
delete, paste here / in place, add or delete a point); the ribbon has Copy, Paste and Duplicate, and a
tap places pasted items; two fingers still pan and zoom.

Press `?` in the app for the same sheet.

## Edit mode

Open the **Edit** tab (or press `E`). The drawing itself is edited; markups stay separate.

* **Select** with a click (hover shows what is under the cursor: type, layer, colour), add with
  `Shift`+click, or drag a box: **left→right** selects what is fully inside, **right→left**
  selects anything the box touches. `Esc` clears. Hidden layers are never selected.
* **Move** by dragging (snaps to ends, middles, centres, crossings and nearest points; `Shift`
  keeps the move straight), **nudge** with the arrow keys, **Rotate 90°**, **Delete**.
* **Double-click text** to type over it in place (rotated with the text). `Enter` finishes
  single-line text, `Ctrl+Enter` finishes multi-line text, `Esc` cancels, clicking away keeps it.
  Outside Edit mode, double-clicking drawing text offers a button that switches to Edit.
* **Double-click a line, polyline or shape** to show its points: drag a point (`Shift` locks it
  horizontally/vertically), right-click a point to delete it, right-click or double-click a side
  to add one. Circles and arcs get a centre and a radius handle; ellipses a centre and an axis
  handle. **Blocks (INSERTs) and DGN cells** move, rotate, restyle and delete as a whole.
  **Text inside them can be retyped**: double-click a title-block field or a label in a cell
  (nested cells too) or a block's attribute, and only that text changes. Saving a DGN rewrites
  that one cell: its other parts are copied byte-for-byte and the edited text keeps its
  attribute data. Text that lives in a DXF block definition is shared by every copy of the
  block, so it stays locked for now (Linework says so).
* **Draw** lines (click points; type a length + `Enter` for an exact length), polylines
  (`Enter`/double-click finishes, `C` closes), rectangles, circles and text. New items go on the
  **current layer** (Layer box; "New layer…" creates one with a colour) in the **current colour**
  (ByLayer or a colour swatch; for DGN drawings the swatches are the file's own colour table).
* **Line weight**: the **Weight** box next to Colour. DGN drawings: weights 0–31; DXF drawings:
  ByLayer or a standard lineweight (0.00–2.11 mm). It applies to new items and, with a selection,
  changes the selection (a cell's components, a block's attributes too). Line weights are drawn
  (DGN: 1 px + 0.75 px per step; DXF: 0.25 mm ≈ 1 px; both capped) and saved.
* **Properties**: with a selection, the Layer box, colour swatches and Weight box change the selection.
* **Copy and paste** (`Ctrl+C`, `Ctrl+V`; ribbon Copy / Paste; right-click or long-press menu):
  the copied items follow the cursor with snaps on — their lower-left corner goes where you click
  (or tap); `Esc` cancels. `Ctrl+Shift+V` or *Paste in place* keeps the original coordinates. Copies
  travel as text on the system clipboard, so they paste into another drawing in the same tab, in
  another tab or window, and survive opening another drawing (no permission prompt; nothing leaves
  the device). One paste is one undo step, and the pasted items become the selection.
  * Units: when both drawings have known units the items are scaled (m → ft, mm → in…, the toast
    says so); if either has no units they are pasted 1:1, with a note.
  * Layers: DXF → DXF keeps layer names (missing layers are created with their colour, line type
    and lineweight); DGN → DGN keeps the level numbers; DGN → DXF creates layers "Level N";
    DXF → DGN puts the items on the current level of the Edit ribbon (DGN levels have no names).
  * Colours: copies carry explicit colours (ByLayer / ByBlock resolved), so they look the same.
    In a DGN the colour becomes the nearest entry of *that file's* colour table (the same entry when
    both files have that colour). In a DXF, white / black become colour 7, exact ACI colours stay
    ACI, others are true colour; an item that was ByLayer is ByLayer again when the target layer
    has the same colour. Line weights travel too (DGN weight ↔ DXF lineweight, see below).
  * Blocks and cells: DXF blocks (nested, dimension blocks too), line types and text styles come
    along; a block name that exists with other content gets a new name (`NAME_2`, `*D5`). A pasted
    DGN cell stays a cell: it gets a new cell header (name, transform, range) and its text can
    still be retyped. DXF blocks pasted into a DGN are exploded into separate items (DGN v7 has no
    blocks; the toast says so).
  * 3D DGN files: Z is kept between 3D files (converted for the other file's units and origin);
    pasting into a 2D drawing flattens it to Z = 0, with a note.
* **Duplicate** (`Ctrl+D`, ribbon, menu): like a paste of the selection in the same drawing.
  **`Ctrl`+drag** (`Alt`+drag on a Mac) leaves the originals and drops a copy where you release.
  Copies are new items: in a DGN round trip they are added at the end of the file and the
  originals' bytes are untouched.
* **Undo/redo**: one history for drawing edits and markups — `Ctrl+Z` always undoes the last
  thing you did. "• unsaved" next to the file name shows there are edits to save; the browser
  asks before leaving the page while it is shown.
* **Save** downloads `<name>-edited.dxf` or `<name>-edited.dgn` (same format as the file you
  opened); **Save as…** picks DXF or DGN v7. Nothing is uploaded. Markups are never baked into
  the drawing: they stay in their `.markup.json` sidecar.

How saving works:

* **DXF** (ASCII, AC1015 / R2000 structure with handles: HEADER `$ACADVER/$INSUNITS/$EXTMIN/
  $EXTMAX`, tables LTYPE/LAYER/STYLE/BLOCK_RECORD…, BLOCKS, ENTITIES, OBJECTS). Written:
  LINE, LWPOLYLINE (bulges, closed), CIRCLE, ARC, ELLIPSE, POINT, TEXT, MTEXT, INSERT + ATTRIB,
  SOLID, HATCH, DIMENSION (with its block). Text is pure ASCII: other characters become
  `\U+XXXX`. Curves (SPLINE, DGN curves) are written as their polyline approximation, and DGN
  cells as their components — the save notes say so.
* **DGN v7, drawing opened from a DGN**: a round trip that keeps the original file. Untouched
  elements stay byte-for-byte at the same place (header, colour table, levels, cells, attribute
  data, elements this app cannot show). Edited or deleted elements get their *deleted* flag set
  in place, and the new versions are appended before the end-of-design marker (cells keep their
  header, with an updated origin, transform, range, colour and weight; a single edited element
  keeps its attribute data). Pasted and duplicated items are appended the same way; pasted cells
  get a new type-2 cell header (2D or 3D layout).
* **Line weights**: DXF lineweights (group 370, on items and layers; ByLayer / ByBlock / default)
  are kept exactly. Between formats: DGN weight *n* = DXF lineweight 0.13, 0.18, 0.25, 0.35, 0.50,
  0.70, 1.00, 1.40, 2.00, 2.11 mm for *n* = 1–10 (11 and above: 2.11 mm; weight 0 = default);
  a DXF lineweight becomes the nearest of those (below 0.10 mm and default: weight 0).
* **DGN v7, drawing opened from a DXF**: a new 2D design file started from GDAL's seed file;
  working units are chosen so coordinates fit the 32-bit grid, layers become levels 1–63 (more
  than 63 are merged into level 63, with a note), colours go into a colour table, blocks are
  flattened, fills become outlines, text uses font 0.
* Items the reader could not load ("not shown") cannot be written: Save warns first ("N items
  from the original file weren't loaded and won't be in the saved copy"). A DGN saved as DGN
  keeps them.
* Written files are read back in the tests with this app's readers **and** with GDAL/OGR (an
  independent reader). They have **not been tested in AutoCAD or MicroStation** yet.

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
| Layers / levels | LAYER table: colour (ACI and true colour), on/off, frozen, linetype, lineweight | Levels 1–63 (swatch = most common colour); levels off in the saved open view start hidden |
| Line weights | Lineweight (370) on items and layers, ByLayer / ByBlock / default, drawn and saved | Weight 0–31, drawn and saved |
| Colours | ACI 256-colour table, true colour (420) | Colour table element (type 5) or the default DGN palette |
| Line types | LTYPE dash patterns (shown at screen scale) | Line styles 0–7 |
| Units | `$INSUNITS` | Master/sub units and UORs from the TCB, global origin |
| Other | OCS/extrusion (e.g. mirrored arcs), paper space shown if model space is empty, `$EXTMIN/$EXTMAX`, CRLF/LF, padded group codes, missing HEADER/TABLES sections, truncated files | Deleted elements skipped, 2D and 3D files, truncated files |
| Skipped (reported as "not shown") | 3DSOLID, REGION, BODY, MESH, IMAGE, WIPEOUT, OLE, XREFs, proxy/custom entities | Shared cells, B-splines (21/24–28), raster, dimensions (33) |
| Not supported yet | Binary DXF, DWG ([plan](DWG.md)) | DGN v8 |
| **Save** | **DXF** R2000 (AC1015), pure ASCII; layers, line types, lineweights, text styles, blocks and attributes kept; DGN drawings saved as DXF get layers "Level N", cells as separate items | **DGN v7**: a DGN you opened keeps every untouched element byte-for-byte (edits appended, originals flagged deleted); any other drawing becomes a new 2D DGN from GDAL's seed file (layers → levels 1–63, colour table, blocks flattened) |

Coordinates far from the origin (state-plane style millions) are rendered with a local origin, so
millimetre detail stays crisp at deep zoom.

## Performance (measured)

From the Playwright suite (`tests/e2e/out/perf.json`), headless Microsoft Edge 154, software
rendering, 1440×900, on the development laptop. Real GPUs do better.

| | |
|---|---|
| App shell (HTML + CSS + JS + icons, gzip) | **≈161 KB** total, **≈146 KB** code (v0.1: 100 / 81; before copy / paste, duplicate and line weights: 147 / 132) — no dependencies |
| First open (DOMContentLoaded, local server) | ≈0.4 s |
| 53,100-entity stress drawing: generate + parse + index | ≈0.6–1.3 s, in a Web Worker with a progress bar |
| Main-thread long tasks while that drawing loads | **0** (UI never freezes) |
| Pan the 53k drawing at "fit all" | median **16.7 ms**/frame (60 fps), p95 ≈17 ms |
| Wheel zoom / pan zoomed in on the 53k drawing | median 16.7 ms, p95 16.8 ms |
| Normal drawings (house plan) | 0.1 ms to draw, 60 fps |
| Edit, 53k drawing: box-select 554 items | ≈3 ms to select; 60 fps while dragging the box |
| Edit, 53k drawing: drag those 554 items | median **16.7 ms**/frame, p95 16.8 ms (60 fps) |
| Edit, 53k drawing: commit the move / undo it | ≈36 ms / ≈11 ms (no re-parse, no rebuild); next frame ≈2 ms |
| Edit, 53k drawing: copy those 554 items / paste them | ≈6–11 ms to copy; the pasted outline follows the cursor at median 16.7 ms/frame (p95 ≈17–33 ms); ≈6–8 ms to commit |

How: geometry is parsed and batched in a worker; each spatial chunk keeps one `Path2D` per style,
built lazily and drawn with the view transform (no re-tessellation on pan/zoom); arcs/ellipses
use exact canvas ellipses; small text is "greeked"; heavy views move the last frame with a CSS
transform during a gesture and redraw when it settles.

Editing is incremental: every primitive knows the drawing item it came from, so changing an item
retires its old primitives (skipped by drawing, snapping and picking), emits the new version with
the same code as a full load, adds it to an overlay of the spatial index and rebuilds only the
render batches involved. While you drag, only a cached outline of the selection moves on the
overlay canvas. The drawing model reaches the main thread from the worker in small pieces after
the first frame, so opening a large file never blocks the page.

## Privacy and security

* No network requests except loading the app's own files from where it is hosted; a unit test
  fails if any external URL appears in the app shell.
* Drawings are read with `FileReader`/`File.arrayBuffer` and parsed in a Web Worker in the same
  browser tab. The service worker caches only the app's own files and never sees your drawings.
* Markups stay in the sidecar file you save and in this browser's local storage.
* Copied drawing items go to the system clipboard as plain text (and stay in the open tab), only
  when you copy; nothing is sent anywhere.
* Saving an edited drawing creates the file in the page and hands it to the browser as a
  download (a `Blob`); it never leaves the device.

## Tests

```bash
npm test                                  # 129 Node unit tests (node --test, no dependencies)
NODE_PATH=/path/to/node_modules node tests/e2e/run.mjs   # 27 Playwright end-to-end tests
```

Some unit tests read the files the writers produce with GDAL/OGR through Python (`from osgeo
import ogr`, see `tools/ogr_dump.py`); they are skipped with a message when Python + GDAL are not
installed (set `LINEWORK_PYTHON` to choose the interpreter).

* Unit: DXF parser on every fixture (entity counts, extents, layer colours, block transforms with
  rotation/scale/mirroring/nesting, bulge arcs, encodings, broken files), DGN parser compared
  element-for-element with GDAL/OGR's independent reader (UOR scaling, global origin, colour
  table, cells, complex elements, 3D), geometry, snaps, measurement, markup sidecar round trip
  and schema checks, renderer smoke tests, offline cache completeness, colour contrast (WCAG AA).
* Writers and editing: DXF writer round trip (read → write → read gives the same items, layers,
  blocks) for every DXF and DGN fixture; safe text encoding (line breaks, `%%`, unicode as
  `\U+` codes, very long MTEXT chunked without breaking escapes); DGN round trip byte-identical
  without edits and, with edits, every untouched element byte-identical at its offset; DXF → new
  DGN (units, levels, colour table); everything written is also read back by GDAL/OGR and
  compared element for element; random edit sessions (fuzz) → incremental scene equals a full
  rebuild, and saved DXF/DGN read back equal to the edited drawing; edit operations (move,
  rotate, mirror, OCS baking, handles, add/delete points, text, layer/colour), undo/redo
  invariants (undoing everything restores the original objects), window vs crossing selection.
* Copy / paste, duplicate, line weights: clipboard payload round trip; source byte ranges and raw
  Z stripped; colours made explicit; unit scaling; layer / level rules; block dependencies and
  renames on a name clash; DGN → DGN (same and other units, origins and colour tables; cells with
  new headers read back by this app and GDAL/OGR; text in pasted cells retyped; every original
  byte kept), 3D DGN (Z kept / flattened), DXF → DGN (blocks exploded), DGN → DXF; duplicates of
  lines, line strings, text, cells and inserts with attributes; DXF lineweights (370, ByLayer /
  ByBlock) read, drawn and written exactly, DGN weight ↔ lineweight mapping, checked with GDAL/OGR.
* End to end: open every fixture, friendly errors, fit/zoom/box zoom, layer toggle (pixel check),
  measuring known distances/lengths/areas with snaps (DXF and DGN), every markup type, undo/redo,
  select/move/delete, sidecar save + reload in a fresh browser, autosave, PNG export, print
  emulation + one-page PDF, touch pinch/pan/finger drawing at 390 px, offline reload through the
  service worker, keyboard/a11y basics, drag and drop, performance. Edit mode: click/Shift/box
  selection (window vs crossing), moving with snaps and Shift, nudge, delete, one undo chain with
  markups, text editing in place (TEXT and MTEXT), handles (drag/add/delete points, circle
  radius), every draw tool with a typed length, new layer + colour changes, Save DXF and reopen
  it, Save as DGN, DGN round trip byte check, lost-item warning, unsaved indicator and the
  leave-page prompt, touch at 390 px (tap, drag, long-press menu, pinch), DGN cells, 53k
  performance. Copy / paste: DGN → DXF with a snapped click, save + reopen, paste in place, across
  two tabs (DGN cell, retyped, original bytes kept), Ctrl+D / Ctrl+drag / ribbon Duplicate with
  one-step undo, line weight changes drawn thicker (pixel check) and saved, touch at 390 px.
  Screenshots (dark + paper at 1440/1024/390) go to `tests/e2e/out/`.
* **All test drawings are synthetic**, generated by `tools/make_fixtures.mjs` (DXF) and
  `tools/make_dgn_fixtures.py` (DGN, via GDAL). No real drawings are used or committed.

## Project layout

```
index.html, app.css, sw.js, manifest.webmanifest   app shell (installable PWA)
src/model.js            common drawing model
src/formats/            dxf.js, dgn.js, detect.js (DWG/binary/v8 detection);
                        dxf-write.js, dgn-write.js (+ dgn-seed.js) — loaded only when saving
src/scene.js            blocks → flat primitives, colours, local origin, spatial grid
src/edit/               edit operations, edit document (changes, undo, selection), live scene
src/view/               viewport, Canvas2D renderer (WebGL-replaceable interface), batches, colours
src/tools/              snaps, measurement
src/markup/             markup model, revision clouds, sidecar format, undo history, drawing
src/app.js, src/app/    UI, input, tools, Edit mode (edit-ui.js), layers panel, export/print
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

* **v0.2 (this version)** — Edit mode and saving as DXF / DGN v7; copy / paste between drawings,
  duplicate and line weights.
* **v0.3** — DWG via LibreDWG compiled to WebAssembly, lazy-loaded ([plan](DWG.md)); vector PDF
  export (true lines and text instead of an image); measurement export (CSV); editing the
  geometry inside blocks/cells and shared block-definition text; mirror.
* **v0.4** — WebGL renderer for very large drawings; true linetype scaling; hatch patterns;
  layouts / paper space tabs; markup resize handles and markup list panel.
* **Later** — binary DXF, DGN v8 (if a permissively licensed reader becomes viable), shared
  markup review (still file-based, no server).

Deliberately **not** in v0.2: DWG, vector PDF, editing geometry inside blocks (text inside
cells and block attributes can be edited since 0.2.2).

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

Editing and saving (v0.2):

* Saved files are validated against GDAL's readers in the tests but have **not been tested in
  AutoCAD or MicroStation** yet. Please keep the original file.
* Blocks (INSERTs) and DGN cells can be moved, rotated, restyled and deleted, but not edited
  inside. Moving a dimension gives it its own copy of its block in the saved DXF.
* Copy / paste: DXF blocks pasted into a DGN are exploded; DGN cells pasted into a DXF stay cells
  in Linework but are saved as separate items (DXF has no cells). A pasted DGN cell gets a new
  header with class 0 and no attribute data of its own (its components keep theirs). Hatch pattern
  scales are not changed when a paste is scaled between units.
* The DXF writer writes the drawing model, not the original file: non-graphical data (layouts,
  dimension styles, extended data, plot settings, groups) is not carried over, and lineweights
  are not read. TEXT/MTEXT that you did not edit is written exactly as stored; edited MTEXT
  loses its inline formatting (fonts, colours, stacking).
* DGN: layer names do not exist in DGN v7 (DXF layers become numbered levels); fills are written
  as outlines; curves as line strings; an edited text in a text node becomes a plain text
  element; edited items in 3D files are written at the Z of the original element (new items at
  Z = 0). Text longer than DGN v7 allows (255 bytes) is shortened, with a note.
* Splines can be moved, rotated and deleted but not reshaped; zero-size ellipses are left out of
  a saved DXF (they are not valid DXF).
