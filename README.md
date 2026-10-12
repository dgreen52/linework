# Linework

**A free, open-source CAD drawing viewer, markup tool and light editor that runs in your browser.**
Open DXF, DWG and DGN v7 drawings — and PDF drawings, manuals and wiring diagrams, a page at a
time — find your way around, measure, mark them up with clouds,
arrows and notes, fix the drawing itself (move, reshape, retype, draw) and save it as DXF or
DGN v7 — on a desktop, a tablet or a phone, online or offline.

> **Your files never leave your device.** Linework reads drawings inside the browser tab. Nothing
> is uploaded, there is no account, no server, and no tracking. Once loaded it works fully
> offline (it installs as an app). That makes it safe for facilities and maintenance teams who
> are not allowed to put drawings on someone else's cloud.

*Working title — the name lives in one place: `src/config.js` (`APP_NAME`).*

## What it does

* **Opens** ASCII DXF (R12 through 2018), **DWG (R13 through 2018)** and DGN v7 (2D and 3D
  design files, shown in plan). Drag a file anywhere onto the window, or use **Open**. Try the
  built-in synthetic samples. DWG files are read with GNU LibreDWG compiled to WebAssembly, inside
  this browser tab; the reader (about 2 MB compressed) downloads from the same site the first time
  you open a DWG and works offline after that ([details](DWG.md)).
* **Opens PDF pages as drawings** (new, [details](PDF.md)): a page's lines, arcs, circles,
  fills and text become drawing items in paper units (mm, or inches for inch-sized pages), with
  layers from the PDF's own layers or by colour, so find, measure with snaps, markups, editing
  and saving as DXF / DGN work as on any drawing; a page picker (and Page Up / Page Down) moves
  between pages, each with its own markups. Scanned pages and photos are shown as a picture under
  the drawing at their true scale (measure and mark up; no text recognition). PDFs are read with
  Mozilla pdf.js inside this tab; it (about 0.7 MB compressed) downloads from the same site the
  first time you open a PDF and works offline after that.
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
  so a reload never loses work (per file revision; Help › *Clear stored markups* forgets them).
* **Edits the drawing** (new in v0.2, see [Edit mode](#edit-mode)): select, move, nudge, rotate,
  delete; double-click to retype text in place or to reshape lines, polylines and circles with
  handles; draw lines, polylines, rectangles, circles and text on any layer; change layer, colour
  and line weight; **copy and paste between drawings** (DGN ↔ DGN, DXF ↔ DGN, across tabs) and
  **duplicate**; one undo history for edits and markups.
* **Editing tools** (new in v0.4, see [Editing tools](#editing-tools-v04)): **find and replace text**
  (`Ctrl+F`, also inside cells and blocks), **MicroStation-style key-ins** (`XY=`, `DL=`, `DI=`,
  `AA=`) for exact points, moves, copies and rotations, **mirror, scale and array**, **select same**
  level / colour / weight / type, **match attributes**, an **element information** panel (`I`: DGN
  element type and file offset too) and **DGN level names** (kept in the browser, never in the file).
* **Saves** the edited drawing as **DXF** (R2000) or **DGN v7** — **over the original file**
  where the browser allows it (asked once per file, with a backup copy), otherwise downloaded to
  your device; never uploaded. A DGN you opened is saved back with every untouched element
  byte-for-byte. Linework does not write DWG or PDF: a DWG or a PDF page you opened is saved as DXF
  (the default) or DGN v7.
* **Keeps your work**: **recent drawings** reopen in one click, and **unsaved edits survive** a
  crash, a closed tab or an update reload — open the drawing again and Linework offers them back
  ([Files](#files-recent-drawings-saving-over-the-original-recovery)).
* **Traces wires** in schematics: View › **Trace** (`J`), click a wire and everything connected to it
  lights up — through shared ends, T-junctions and junction dots, not through plain crossings — with
  its length, its labels (wire numbers) and where it ends: the connector or terminal and the pin text,
  a symbol, or an open end ([Trace a wire](#trace-a-wire)).
* **Opens sheet sets**: a whole folder of drawings (or several files, or a folder dropped on the
  window) as one set — a list of the sheets with the titles from their title blocks, `Page Up` /
  `Page Down` from sheet to sheet, **Find in all sheets**, and references such as "SHEET 12" or
  "SEE DWG 1234-56" become links to that sheet ([Sheet sets](#sheet-sets)).
* **Compares revisions** (new in v0.4): View › **Compare** lays another revision over the open
  drawing — only in this one red, only in the other green, the rest dimmed — with counts and a
  list to step through ([Compare](#compare-two-revisions)).
* **Exports** a PNG of the current view (with markups), and **prints / saves as PDF to scale**:
  vector lines and real text, Letter to ANSI D or A4 to A1, Fit or 1:N / 1"=N', current view or
  extents, black and white, line weights, title line ([Print](#print-to-scale)).
* **Never crashes on a bad file**: it shows what loaded and a short "N items not shown" note.
  Binary DXF, DGN v8, R12-and-older DWG and unreadable DWG files get a friendly explanation
  instead of an error. A tiny file whose blocks expand to millions of copies is drawn up to a
  limit ("N block copies not shown"), and **Cancel** on the progress card stops any file that
  takes too long to open.

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

**Hosting** costs ~$0: any static host works (Cloudflare Pages, Netlify, GitHub Pages, an
internal web share, a USB stick with a tiny server). There is nothing to run on the server side.

```bash
node tools/make_dist.mjs           # copies exactly the deployable files into dist/
```

Deploy folder layout (`dist/`, upload its contents as the site root):

```
index.html  app.css  sw.js  manifest.webmanifest   app shell (precached by the service worker)
icons/  src/  samples/                            app code (served as-is, no build step), samples
vendor/libredwg/                                  DWG reader: libredwg-web.wasm (9.4 MB) + .js glue
                                                  + README (provenance); fetched only for DWGs
vendor/pdfjs/                                     PDF reader: pdf.js (legacy build) + image decoders
                                                  + licences + README; fetched only for PDFs
_headers                                          HTTP headers, from deploy/_headers
LICENSE  NOTICE                                   GPL-3.0 + third-party notices (LibreDWG, pdf.js, GDAL)
```

`_headers` (Cloudflare Pages / Netlify format; on other hosts set the same headers in their
configuration) sets the Content-Security-Policy — `script-src 'self' 'wasm-unsafe-eval'` lets the
page compile the DWG reader, no `'unsafe-eval'` — plus `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and HSTS; `Cache-Control: no-cache` for
`/`, `/index.html` and `/sw.js`; a one-year immutable cache and `Content-Type: application/wasm`
for `vendor/libredwg/` (its URLs carry a version, `READER_REV` in `src/formats/dwg.js`) and the
same for `vendor/pdfjs/` (`PDF_READER_REV` in `src/formats/pdf.js`; `.mjs` served as
`text/javascript`).
`tools/serve.mjs` applies the same file, so local runs and the tests use the real policy.

## Keyboard shortcuts

| Get around | | Measure | | Mark up | |
|---|---|---|---|---|---|
| Drag / wheel / pinch | pan / zoom at cursor | `D` | distance | `V` | select (drag to move, `Delete` removes) |
| `F` | fit drawing | `G` | length along a path | `P` `N` `W` | pen, line, arrow |
| `Z` | zoom to a box | `A` | area | `R` `O` `C` | box, ellipse, revision cloud |
| `+` `−`, arrow keys | zoom, pan | `S` | snap on/off | `T` `K` | text callout, highlighter |
| `H` | pan tool | `Enter` / double-click | finish length/area | `Ctrl+Z` / `Ctrl+Y` | undo / redo |
| `J` | trace a wire (`Esc` clears) | | | | |
| `L` | layers panel | `Backspace` | remove last point | `Ctrl+S` | save markups |
| `B` | dark / paper | `Esc` | cancel, back to pan | `Ctrl+O` / `Ctrl+P` | open / print |

| Edit the drawing | |
|---|---|
| `E` | Edit mode (select tool) — then `V` select, `N` line, `P` polyline, `R` rectangle, `O` circle, `T` text |
| Click / `Shift`+click | select / add or remove; `Ctrl+A` selects everything on the visible layers |
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
| `Esc` | cancel what is in progress; in a draw tool with nothing in progress: back to Select |
| Right-click | menu: edit, copy, duplicate, rotate 90°, delete, paste here / in place |
| `Delete` | delete the selection |
| `Ctrl+S` / `Ctrl+Shift+S` | save the drawing (in Edit) / save as DXF or DGN |

| Editing tools (v0.4) | |
|---|---|
| `Ctrl+F` | find text (any mode; the View tab has a Find button): `Enter` / `Shift+Enter` or `F3` / `Shift+F3` next / previous, `Esc` closes; in Edit also Replace / Replace all |
| `XY=x,y` `DL=dx,dy` `DI=d,a` | in a draw tool: start typing (`X`, `D`) and press `Enter` for an exact point; with a selection: move it (tick Copy to copy it); `XY=` moves its lower-left corner there |
| `AA=angle` | with a selection: rotate it about its centre; otherwise the angle of new text |
| A number | while drawing a line or polyline: the length; a circle: the radius |
| `I` | element information (selection, or the item under the cursor) |
| Edit › **More** | find and replace, key-in, move / copy / rotate by a value, mirror, scale, array, select same, match attributes, element info |

| Sheet sets | |
|---|---|
| `Ctrl+Shift+O` | open a folder as a sheet set (or choose / drop several drawings) |
| `Page Up` / `Page Down` | previous / next sheet |
| `Ctrl+F` | with a set open: find in all sheets (`Enter` goes from sheet to sheet) |
| Click a sheet reference | open that sheet (Pan tool) |

On touch screens: tap to select, drag to move, long-press for a menu (edit, copy, duplicate, rotate,
delete, paste here / in place, add or delete a point); the ribbon has Copy, Paste and Duplicate, and a
tap places pasted items; two fingers still pan and zoom.

Press `?` in the app for the same sheet.

## Editing tools (v0.4)

Made for MicroStation users working in DGN v7 wiring schematics and title blocks; they work on DXF and
DWG drawings too. Each change is one undo step, and a DGN keeps its original bytes (see *How saving
works* below). The tools load the first time one is used (a few KB, cached for offline use).

* **Find and replace** (`Ctrl+F` in any mode, or View › Find): a search box with the match count;
  `Enter` / `Shift+Enter` (or `F3` / `Shift+F3`, or the arrows) zoom to the next / previous match and
  highlight it (all matches are outlined). Text inside cells, nested cells and block attributes is
  found too. Options: **Aa** match case, **Word** whole words only, **Visible** only levels / layers that
  are shown (on by default). In Edit mode the found item is selected and **Replace** / **Replace all**
  appear: a replacement goes through the same path as typing over a text (a DGN cell is rebuilt from its
  original bytes with only that text changed), **Replace all** is one undo step, a text is never left
  empty, and text in a DXF block definition (shared by every copy) is left alone, with a note.
* **Key-ins** (as in MicroStation; drawing master units, angles in degrees counter-clockwise from +X):
  in a draw tool (line, polyline, rectangle, circle, text) type `XY=x,y` for a point at x,y,
  `DL=dx,dy` for a point relative to the last one, `DI=distance,angle` for a point at a distance and
  direction from the last one; a plain number is the length of the next line segment (towards the
  cursor) or a circle's radius. Typing `X`, `D` or `A` opens the key-in box; it shows what the key-in
  will do (and draws it) before `Enter` commits; `Esc` cancels; a mistake keeps the box open and says
  what is wrong. With a **selection**: `DL=` / `DI=` move it by that vector, `XY=` moves its lower-left
  corner to the point (tick **Copy** to drop a copy instead), `AA=angle` rotates it about its centre.
  Without a selection `AA=` sets the angle new text is placed at. `@dx,dy` and `@d<a` also work. Edit ›
  More › *Move by a distance…*, *Copy by a distance…*, *Rotate by an angle…* open the box ready to type.
  While pasting (or picking a point for a tool) `XY=` places at an exact point.
* **Mirror** (Edit › More): left ↔ right or up ↕ down about the selection's centre, or about a point you
  click (or type with `XY=`). Text stays readable (also in cells and block attributes): it moves to its
  mirrored place without being reversed.
  DGN elements cannot be mirrored in place, so on Save mirrored items (other than text) are written from
  what Linework shows, and the save notes say so.
* **Scale** (factor about the selection's centre or a clicked point) and **Array** (*n* copies, each
  offset by a typed X, Y from the previous one; the copies are selected). Both are one undo step; in a
  DGN a scaled item keeps its bytes (the scale is applied to them in place) and array copies are copies
  of the original bytes, moved.
* **Select same** (Edit › More, or right-click › *Select same…*): every item on a shown level / layer
  with the same level, colour, weight and/or type as the selection, or as picked from lists of the
  values in the drawing (with counts); the dialog shows how many items match before selecting.
* **Match attributes**: click the item to copy from, then click the items to change (`Esc` when done);
  level, colour, weight and line style are copied (cells: all their components). If items were selected
  when you started, they are changed straight away.
* **Element info** (`I`, Edit › More, right-click › *Element info*): type, level / layer (with its
  name), colour (index and swatch), weight, line style, cell or block name; text, font, justification,
  height, width factor and angle; coordinates, length, perimeter, area, radius…; for DGN the element
  type number, its size and **file offset** (decimal and hex) and whether it will be saved unchanged or
  rebuilt from those bytes; a cell's components. Several items: counts per type, level, colour and
  weight, and the extents. Outside Edit it shows the item under the cursor.
* **Level names** (DGN): DGN v7 levels have no names. Give them names with the pen next to a level in
  the Layers panel, or **Import…** a text / CSV file with one `number,name` per line (comma, semicolon,
  tab or spaces; quotes allowed; a header line and `#` comments are skipped). Names show in the Layers
  panel (the filter finds them), the Level box and the status bar, are kept in this browser per drawing
  name, and can be **Export**ed as CSV or cleared. They are never written into the DGN file.

## Edit mode

Open the **Edit** tab (or press `E`): it starts with the Select tool. The drawing itself is
edited; markups stay separate.

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
  (nested cells too) or a block's attribute, and only that text changes. Saving a DGN rebuilds
  that one cell from its original bytes: only the text element is replaced (same header, graphic
  group, enter-data fields and attribute data), and the word counts of its text node and cell
  are fixed; everything else in the cell is kept byte-for-byte. Text that lives in a DXF block
  definition is shared by every copy of the block, so it stays locked for now (Linework says so).
* **Draw** lines (click points; type a length + `Enter` for an exact length), polylines
  (`Enter`/double-click finishes, `C` closes), rectangles, circles and text. New items go on the
  **current layer** (Layer box; "New layer…" creates one with a colour; it starts on a visible
  layer, and if new items land on a hidden one a message offers to show it) in the **current
  colour** (ByLayer or a colour swatch; for DGN drawings the swatches are the file's whole colour
  table, 256 entries, also reachable with the arrow keys). DGN drawings list only real levels.
* **Line weight**: the **Weight** box next to Colour. DGN drawings: weights 0–31; DXF drawings:
  ByLayer or a standard lineweight (0.00–2.11 mm). It applies to new items and, with a selection,
  changes the selection (a cell's components, a block's attributes too). Line weights are drawn
  (DGN: 1 px + 0.75 px per step; DXF: 0.25 mm ≈ 1 px; both capped) and saved.
* **Properties**: with a selection, the Layer, Colour and Weight boxes show the selection's
  values ("Varies" when they differ; their labels turn blue) and change only the selection — the
  current layer, colour and weight for new items stay as they were and come back when the
  selection is cleared.
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
    along; a block name that exists with other content gets a new name (`NAME_2`, `*D5`). A DGN
    cell pasted into another DGN stays a cell: it gets a new cell header (name, transform, range)
    and its text can still be retyped. Pasted into the same DGN file (also in another tab), items
    are copies of their original bytes, moved. DXF blocks pasted into a DGN are exploded into
    separate items (DGN v7 has no blocks; the toast says so).
  * 3D DGN files: Z is kept between 3D files (converted for the other file's units and origin);
    pasting into a 2D drawing flattens it to Z = 0, with a note.
* **Duplicate** (`Ctrl+D`, ribbon, menu): like a paste of the selection in the same drawing.
  **`Ctrl`+drag** (`Alt`+drag on a Mac) leaves the originals and drops a copy where you release.
  Copies are new items: in a DGN round trip they are copies of the originals' bytes (moved),
  added at the end of the file; the originals' bytes are untouched.
* **Undo/redo**: one history for drawing edits and markups — `Ctrl+Z` always undoes the last
  thing you did. "• unsaved" next to the file name shows there are edits to save; the browser
  asks before leaving the page while it is shown.
* **Save** writes over the file you opened when the browser gave Linework a handle to it (see
  [Files](#files-recent-drawings-saving-over-the-original-recovery)); otherwise it downloads
  `<name>-edited.dxf` or `<name>-edited.dgn` (same format as the file you opened). **Save as…**
  picks DXF or DGN v7 and always downloads. Nothing is uploaded. Markups are never baked into
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
  in place, and the new versions are appended before the end-of-design marker. An edited item
  is rebuilt **from its original bytes**, never re-encoded from what the app shows: a move or
  rotate transforms the coordinates of every element of the item (cell header origin and
  transform, text nodes, point strings, B-spline poles, arcs, texts...), a colour / level /
  weight change patches each element's symbology (and a cell's level mask), a retyped text is
  spliced in with its old header, enter-data fields and attribute data, and the word counts and
  ranges of the text node / cell / complex chain around it are fixed. Text node headers, empty
  placeholder nodes, blank texts, point strings, B-splines, linkages, graphic groups and fills
  all survive. Duplicates and pastes of items from the same file are copies of their original
  bytes; items pasted from another file get new elements (cells a new type-2 header, 2D or 3D
  layout; arcs in complex chains stay arcs). Only what cannot be rebuilt that way (a reshaped
  complex chain with elliptical arcs, a cell holding an element type that cannot be moved such
  as a tag) is written from the app's model, and the save notes list it.
* **Never written wrong**: coordinates outside the 32-bit grid (or text too large for it) are
  never clamped — the save stops with a message saying how many items are out of range (round
  trip and new files); a complex chain longer than a 16-bit word count allows is split into
  several chains; a cell that cannot fit is refused with a message.
* **Line weights**: DXF lineweights (group 370, on items and layers; ByLayer / ByBlock / default)
  are kept exactly. Between formats: DGN weight *n* = DXF lineweight 0.13, 0.18, 0.25, 0.35, 0.50,
  0.70, 1.00, 1.40, 2.00, 2.11 mm for *n* = 1–10 (11 and above: 2.11 mm; weight 0 = default);
  a DXF lineweight becomes the nearest of those (below 0.10 mm and default: weight 0).
* **DGN v7, drawing opened from a DXF**: a new 2D design file started from GDAL's seed file;
  working units are chosen so coordinates fit the 32-bit grid, layers become levels 1–63 (more
  than 63 are merged into level 63, with a note), colours go into a colour table, blocks are
  flattened, DXF fills become outlines (DGN fills pasted in stay fills), text uses font 0, arcs
  keep their direction (clockwise bulges are clockwise arcs), and saved view 1 shows the drawing.
* Text: cp1252 text is 8-bit; text with other characters (Ω, CJK) is written as DGN 16-bit text
  holding UTF-8 the way GDAL unpacks it, so GDAL and Linework read the same string (older CAD
  programs may show other characters; the save notes say so).
* **Drawing opened from a DWG**: Linework does not write DWG. **Save** writes DXF and **Save
  as…** offers DXF (default) or DGN v7; the dialog says so first, and DWG-only data (layouts,
  dimension styles, extended data) is not carried over.
* **Page opened from a PDF**: Linework does not write PDF. **Save** writes the page's lines, fills
  and text as DXF (`name-edited.dxf`, `name-p3-edited.dxf` for page 3) and **Save as…** offers DXF
  (default) or DGN v7; the dialog says so first. Pictures and fonts are not kept.
* Items the reader could not load ("not shown") cannot be written: Save warns first ("N items
  from the original file weren't loaded and won't be in the saved copy"). A DGN saved as DGN
  keeps them.
* Written files are read back in the tests with this app's readers **and** with GDAL/OGR (an
  independent reader). They have **not been tested in AutoCAD or MicroStation** yet.

## Files: recent drawings, saving over the original, recovery

Browsers with the File System Access API (Chrome, Edge and other Chromium browsers on desktop)
hand Linework a *file handle* when you open a drawing with **Open** (the file picker), with the
installed app's "Open with", or by dropping it on the window. With a handle:

* **Edit › Save** (`Ctrl+S` in Edit) writes over the original file. The first time for each file
  Linework asks: *Save over the original*, *Download a copy* (the old behaviour) or *Cancel*.
  A DXF is written again from what Linework read (R2000), so the question says what a DXF loses
  (layouts, dimension styles, extended data, plot settings); a DGN keeps every untouched element
  byte for byte, as in every DGN save. A DWG is never overwritten (Save writes a DXF copy).
* **Backup copy** (on by default): before the first save over a file in a session, the file as it
  was is copied to `name.bak.dgn` (`.bak.dxf`) next to it. Browsers give access to the file, not to
  its folder, so the question offers *Allow the folder…*; Linework checks that the chosen folder
  holds the file and remembers it with the recent entry. Without folder access the save goes ahead
  and the note says no backup was made.
* **Safe writing**: the new file is first read back by Linework's own reader (nothing is written
  if it does not open), the file on disk is checked for changes made by another program since it
  was opened (Linework asks before overwriting them), and the browser writes to a temporary file
  that replaces the original only when complete. Afterwards the drawing continues from the saved
  file (view, hidden layers and markups kept; undo starts again from the saved state).
* **Recent drawings**: the empty screen and the arrow next to **Open** list the last 12 drawings
  (name, format, size, when; "unsaved edits kept" when there are some). With a handle one click
  reopens the file (the browser may ask once for permission); samples reopen too; other entries
  open the file picker. **Clear list** forgets the list (the files are not touched). Only names,
  sizes, dates and the browser's handles are kept — never the files' contents.
* **Unsaved-edit recovery**: every edit is also written to this browser (IndexedDB) as the edit
  history — the change list behind undo, not the file — keyed by the content hash of the file it
  applies to. After a crash, a closed tab or an update reload, opening the same file (any way:
  picker, recent list, drop, plain chooser) offers *Restore N unsaved edits?*: Restore re-applies
  them (each one undoable), Discard forgets them. The journal is checked against the drawing
  before anything is applied, is cleared when you save or undo back to the start, keeps at most
  32 MB per drawing (it says so when a session is too large) and at most 6 drawings.

Other browsers (Firefox, Safari, phones) keep the previous behaviour: the plain file chooser, Save
downloads a copy, and recent entries open the chooser; recovery works there too.

## Trace a wire

For troubleshooting from a wiring schematic (made with DGN v7 schematics in mind; DXF and DWG work the
same way). View › **Trace** (`J`) — in any mode, and it never changes the drawing:

* **Click a wire** (tap on a phone; dragging still pans) and its whole net lights up in pink, the rest
  of the drawing dimmed. Wires are lines, line strings, chains and arcs that are not part of a cell or
  block. They connect where their **ends meet**, where an end lands **on another wire (a T)**, and
  through **junction dots** (small filled circles or shapes, small circles; a wire passing through a
  dot is connected too). Lines that merely **cross** are *not* connected — the schematic convention;
  *Options › Crossings connect* joins them anyway. A hop arc over another wire is part of its wire.
* **Cells and blocks** (connectors, terminal strips, splices) stop the net: the cell line or pin dot the
  wire lands on is lit, and the end is listed with the **cell name and the pin** — the cell's text
  nearest to the wire end (and the cell's larger reference text, e.g. `J4 · 12`); a wire drawn into a
  connector up to its pin text counts too. *Options › Through pins* continues to the wires on the same
  pin text of the same cell (both sides of a connector or terminal). Wire ends on a symbol outline
  (a relay coil) are listed with the text in it; other ends are **open ends**, with a note next to them
  (`TO SH 2`) when there is one.
* **The panel**: the net's length (wires as drawn, arcs exact), wires, segments and junction dots; its
  **labels** — texts right next to its wires, such as wire numbers and signal names (click one to show
  it); its **ends** — click one, or step with ‹ ›, to zoom to it with its pin readable. **Zoom to net**,
  **Copy** (the net as text), `Esc` or × clears. On a phone the panel sits at the bottom of the drawing.
* **Gap** (*Options*): ends closer than this touch — by default 5 % of the drawing's usual text height
  (so a sloppy end still connects); type a larger value for drawings with bigger gaps.
* Hidden levels / layers are not traced through. After an edit the net is traced again from the same
  point. When a set of sheets is open ([Sheet sets](#sheet-sets)), **Find on other sheets** opens
  *Find in all sheets* with the net's label (whole words): its matches listed by sheet, a click on one
  opens that sheet at the match.
* The connections are found once per drawing (a slice at a time, so the page never freezes): about
  0.1–0.3 s for a 50,000-item drawing, then each trace takes a few milliseconds.

## Sheet sets

Schematics and wiring diagrams come as sets of dozens of sheets. **Open folder** (`Ctrl+Shift+O`;
on a phone: the start screen's button or More › Open folder…) opens every drawing in a folder (and its subfolders, one level
deep) as one set; choosing several files in **Open**, or dropping several files or a folder on the
window, does the same. Save backups (`*.bak.dgn`) and other files are left out. The file types a
set takes are one list in `src/tools/sheets.js` (`SHEET_EXTS`).

* **Navigator** (View › **Sheets**): the sheets in natural order (SH2 before SH10) with the title
  from each title block — a `TITLE` / `DWG_TITLE` block attribute, otherwise the largest text at
  the lower right — and the current one highlighted. `Page Up` / `Page Down` (or the arrows)
  step through the set through the normal open path: unsaved edits are asked about first, and each
  sheet keeps its zoom, position and hidden layers for the session. A sheet that does not read is
  marked in the list, and `Page Down` goes on past it.
* **Background index**: a second parse worker reads every sheet once (progress, **Stop**) and keeps
  only a compact text index — strings, positions, heights and paths inside cells — never the
  drawing. The indexes are kept in this browser (IndexedDB, per file content hash, the oldest
  forgotten beyond 3,000 sheets / 96 MB), so opening the set again is instant. Only the sheet on
  screen and up to three recently shown ones (an LRU, at most 160 MB) keep a full drawing in
  memory (the 120-sheet test set: a 44 KB index, the heap grows by about 2 MB).
* **Find in all sheets**: with a set open, `Ctrl+F` has an **All sheets** scope (on by default):
  the matches are listed by sheet with counts (also in the navigator), `Enter` / `F3` go from
  match to match across sheets — opening the sheet and zooming to the text — and a click on a
  listed match goes there. The sheet on screen is searched as drawn (edits included). Replace works
  on the sheet on screen.
* **Sheet references become links**: on the sheet on screen, texts like `SHEET 12`, `SH 4`,
  `SHT. 3` (the sheet whose title block says "SHEET 12 OF …", else the file whose name ends in 12),
  `SEE DWG 1234-56` (a file named so, or a sheet whose title block shows that number), or a text
  that is another sheet's file name are underlined; hover shows where they go, a click (Pan tool)
  opens that sheet. A reference that matches no sheet or more than one stays plain text, as do
  "SHEET 1 OF 5" and a sheet's own number. The patterns are regular expressions you can change
  (Sheets › *Sheet references*, kept in this browser).
* **Recent drawings** keeps the set as one entry ("Sheet set · 24 sheets"): one click opens it
  again at the sheet you were on (the browser may ask once for permission to read the folder).
* For other features: `app.sheets = { list(), open(id), step(±1), findAcross(query, { matchCase,
  wholeWord }) → [{ sheetId, name, hits: [{ text, x, y, h, sub, ent }] }], xrefs(), status() }`
  (`x`, `y` in drawing coordinates).

## Compare two revisions

View › **Compare** asks for another revision of the drawing (same kind: DGN with DGN, DXF or DWG
with DXF or DWG), reads it in this tab with the same reader (nothing leaves the device, it works
offline) and lays it over the open drawing (A):

* **Only in A** (red), **only in B** (green), **unchanged** (the drawing dimmed) — each a toggle
  with its count.
* Items are the drawing's top-level items. In DGN files an item that is still exactly as read from
  the file is matched by the **bytes of its elements**, wherever it sits in the file (so elements
  that MicroStation or Linework moved to the end of the file are still unchanged); everything else
  is matched by **geometry and attributes** (layer / level, colour, line style, weight, text,
  coordinates rounded to a billionth of the drawing size).
* What is left is listed top to bottom: an item with the same shape elsewhere is **Moved**, one of
  the same kind on the same layer in the same place is **Changed** (texts show old → new), the
  rest are **Only in A** / **Only in B**. Previous / Next or a click zooms to each.
* Edits made while comparing update the comparison; opening another drawing or the close button
  ends it.

## Print to scale

`Ctrl+P` (or Print / PDF) builds the sheet as SVG — the browser's *Save as PDF* turns it into a
vector PDF with sharp lines and real (searchable) text:

* **Sheet**: Letter, Legal, Tabloid (11×17), ANSI C, ANSI D, A4, A3, A1; landscape or portrait
  (8 mm margins, a title line with title, file, scale, sheet, date and author).
* **Scale**: *Fit*, or a ratio (`1:50`, `1/100`, `2:1`), or an imperial scale (`1"=20'`,
  `1/4"=1'-0"`), in the drawing's units (a drawing without units prints 1 unit as 1 mm). The dialog
  says what will print and when the area does not fit the sheet at that scale. Print at 100 %
  (not "Fit to page") to keep the scale on paper.
* **What to print**: the current view or the extents; hidden layers stay hidden.
* **Black and white** option; **line weights** printed as weights (DXF lineweights in their
  millimetres, DGN weights like on screen, 0.18 mm by default); line styles as dashes; fills and
  markups / measurements as vector too.

## Supported formats and entities

| | DXF (ASCII R12–2018) | DWG (R13–2018, via LibreDWG) | DGN v7 |
|---|---|---|---|
| Lines, polylines | LINE, LWPOLYLINE, POLYLINE (2D, with exact bulge arcs), 3DFACE, polyface/polygon mesh edges | Same entities as DXF (LINE, LWPOLYLINE, 2D/3D POLYLINE, polyface/polygon mesh, 3DFACE) | Line (3), line string (4), shape (6) |
| Circles, arcs, ellipses | CIRCLE, ARC, ELLIPSE (incl. partial), exact at every zoom | CIRCLE, ARC, ELLIPSE | Ellipse (15), arc (16), incl. rotated/elliptical and clockwise |
| Curves | SPLINE (NURBS via de Boor, or fit points), HELIX | SPLINE (control or fit points, weights) | Curve (11) |
| Complex | — | — | Complex chain (12) and complex shape (14) joined into one item; circular arcs in them stay exact arcs |
| Text | TEXT (12 alignments, fit/aligned, width factor, oblique, mirrored), MTEXT (plain text, `\P` paragraphs, wrapping, attachment), ATTRIB/ATTDEF, `%%c %%d %%p`, `\U+xxxx`, cp1252/UTF-8 | TEXT, MTEXT, ATTRIB/ATTDEF as for DXF; code-page text (pre-2007) and Unicode (2007+) | Text (17), text node (7), 16-bit text |
| Blocks / cells | INSERT with position/scale (incl. negative = mirrored)/rotation, MINSERT arrays, nested blocks, BYBLOCK colour & linetype, attributes | INSERT, MINSERT, nested blocks, attributes, anonymous blocks; tables (ACAD_TABLE) via their block | Cell header (2): components shown where they are placed; the cell transform is read and reported |
| Dimensions, leaders | DIMENSION via its block (fallback drawing when the block is missing), LEADER with arrowhead | All dimension types via their block (same fallback), LEADER | — |
| Fills | SOLID, TRACE, HATCH (solid fill; pattern hatches as a light screen pattern) | SOLID, TRACE, HATCH (polyline and edge boundaries, pattern data kept for saving) | Fill colour linkage on shapes, complex shapes and ellipses (junction dots, arrowheads); saved as solid HATCH in DXF |
| Points | POINT | POINT | — |
| Layers / levels | LAYER table: colour (ACI and true colour), on/off, frozen, linetype, lineweight | LAYER table: colour (index; true colour from 2004), on/off, frozen, linetype | Levels 1–63 (swatch = most common colour); levels off in the saved open view start hidden |
| Line weights | Lineweight (370) on items and layers, ByLayer / ByBlock / default, drawn and saved | Not read yet (drawn at the default weight) | Weight 0–31, drawn and saved |
| Colours | ACI 256-colour table, true colour (420) | Colour index; true colour (2004+) | Colour table element (type 5) or the default DGN palette |
| Line types | LTYPE dash patterns (shown at screen scale) | LTYPE dash patterns | Line styles 0–7 |
| Units | `$INSUNITS` | `INSUNITS` | Master/sub units and UORs from the TCB, global origin |
| Other | OCS/extrusion (e.g. mirrored arcs), paper space shown if model space is empty, `$EXTMIN/$EXTMAX`, CRLF/LF, padded group codes, missing HEADER/TABLES sections, truncated files | OCS/extrusion, paper space as for DXF, damaged files (shows what LibreDWG could read), 120 MB size limit, 2-minute read limit | Deleted elements skipped, 2D and 3D files (Z of every vertex kept), truncated files, several colour tables (the last counts, as in GDAL), files without an end-of-design marker |
| Skipped (reported as "not shown") | 3DSOLID, REGION, BODY, MESH, IMAGE, WIPEOUT, OLE, XREFs, proxy/custom entities | Same as DXF, plus MLINE, MULTILEADER, TOLERANCE, RAY/XLINE, SHAPE | Shared cells, B-splines (21/24–28, one item each), point strings, tag values, reference file attachments (with their file names), raster, dimensions (33) — all kept when the DGN is saved as DGN |
| Not supported yet | Binary DXF | R12 and older DWG; writing DWG | DGN v8 |
| **Save** | **DXF** R2000 (AC1015), pure ASCII; layers, line types, lineweights, text styles, blocks and attributes kept; DGN drawings saved as DXF get layers "Level N", cells as separate items | Saved as **DXF** (default) or **DGN v7** — Linework does not write DWG | **DGN v7**: a DGN you opened keeps every untouched element byte-for-byte (edits appended, originals flagged deleted); any other drawing becomes a new 2D DGN from GDAL's seed file (layers → levels 1–63, colour table, blocks flattened) |

DWG versions: the tests use synthetic R2000 (AC1015) files; LibreDWG also reads R13/R14 and
R2004–R2018, which are not covered by synthetic fixtures yet ([DWG.md](DWG.md)).

**PDF** (pdf.js, one page at a time, [details](PDF.md)): paths → lines, polylines, circles and arcs
(from their Béziers), splines, fills (solid; pattern fills as pattern hatches); text with its
position, size, angle, width, colour and layer; line widths and dashes; colours from every colour
space (spot colours too); optional content as layers (off ones hidden), annotation appearances;
form XObjects, `/Rotate`, crop and media box offsets; pictures and gradients as one picture of
the page under the drawing; units mm or inches (paper). Not supported: OCR, password-protected
PDFs (owner-password-only PDFs open), clipping of vector items, writing PDF.

Coordinates far from the origin (state-plane style millions) are rendered with a local origin, so
millimetre detail stays crisp at deep zoom.

## Performance (measured)

From the Playwright suite (`tests/e2e/out/perf.json`), headless Microsoft Edge 154, software
rendering, 1440×900, on the development laptop. Real GPUs do better.

| | |
|---|---|
| Startup code (index.html, app.css, `src/app.js` and the parse worker with their static imports, gzip) | **≈149 KB** (31 files; budget 150 KB) — no dependencies |
| Everything precached for offline use (lazily loaded tools, writers, icons, manifest; not the samples) | **≈272 KB** gzip, 781 KB raw (53 files; budget 320 KB) |
| DWG reader (only when a DWG is opened) | 9.4 MB WebAssembly, **≈2.1 MB gzip** (≈1.1 MB brotli) + 12 KB `dwg.js`; cached for offline use |
| PDF reader (only when a PDF is opened) | pdf.js 2.2 MB, **≈0.66 MB gzip** (incl. its JPEG 2000 / JBIG2 decoders) + 14 KB `pdf.js` + 2 KB `pdf-ui.js`; cached for offline use |
| First open (DOMContentLoaded, local server) | ≈0.4 s |
| 53,100-entity stress drawing: generate + parse + index | ≈0.6–1.3 s, in a Web Worker with a progress bar |
| Main-thread long tasks while that drawing loads | **0** (UI never freezes) |
| Pan the 53k drawing at "fit all" | median **16.7 ms**/frame (60 fps), p95 ≈17 ms |
| Wheel zoom / pan zoomed in on the 53k drawing | median 16.7 ms, p95 16.8 ms |
| Normal drawings (house plan) | 0.1 ms to draw, 60 fps |
| Edit, 53k drawing: box-select 554 items | ≈3 ms to select; 60 fps while dragging the box |
| Edit, 53k drawing: drag those 554 items | median **16.7 ms**/frame, p95 16.8 ms (60 fps) |
| Edit, 53k drawing: commit the move / undo it | ≈36 ms / ≈11 ms (no re-parse, no rebuild); next frame ≈2 ms |
| Trace, 53k drawing: find the connections / trace a net (3,600 lines) | ≈0.26 s (best of three, measured while the laptop was busy with other work; the first time it runs in 12 ms slices, no long task); ≈6 ms per trace |
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
  fails if any external URL appears in the app shell. The DWG and PDF readers are among those
  files: they come from the same site, only when a DWG or a PDF is opened, and run in the browser
  like the rest (pdf.js installs no fonts and fetches nothing else; see [PDF.md](PDF.md)).
* Drawings are read with `FileReader`/`File.arrayBuffer` and parsed in a Web Worker in the same
  browser tab. The service worker caches only the app's own files and never sees your drawings.
* Markups stay in the sidecar file you save and in this browser's local storage.
* This browser's IndexedDB keeps the recent drawings list (names, sizes, dates and the browser's
  file handles — never the contents), the history of unsaved edits until they are saved or
  discarded, and the text index of the sheets of sheet sets (their texts and positions). Clear list / Discard remove them; clearing the site's data removes everything.
* Copied drawing items go to the system clipboard as plain text (and stay in the open tab), only
  when you copy; nothing is sent anywhere.
* Saving an edited drawing creates the file in the page and either writes it to the file you
  opened (through the browser's file handle, after you agreed once) or hands it to the browser as
  a download (a `Blob`); it never leaves the device. Compare reads the second file the same way.

## Use as a library (Node)

The readers, scene builder, find, compare, wire tracing, sheet-set helpers, writers and vector (SVG)
builder are plain ES modules that also run in Node. `lib/core.js` gathers them behind one package
export (it is not part of the web app: nothing in `src/` imports it, it is not cached by the service
worker and not deployed):

```js
import { readFileSync } from 'node:fs';
import { parseDrawingAsync, buildScene, findTexts, DWG_WASM_URL } from 'linework/core';
const model = await parseDrawingAsync(readFileSync('site-plan.dgn'), 'site-plan.dgn', { wasmBytes: readFileSync(DWG_WASM_URL) });
const scene = buildScene(model);
console.log(findTexts(scene, 'PUMP').map((m) => m.s));
```

Install it from a tag, e.g. `npm install github:dgreen52/linework#v0.5.2`. `buildSvg` takes
`theme: 'dark'` (colours for a dark background) and `frame: false`; `findTexts` also takes a RegExp.

Since 0.5.2 the entry also has **wire tracing** (`buildNetGraph` / `buildNetGraphAsync` once per
drawing, then `pickWire` and `traceNet` with `{ crossings, throughPins }`; `endText`, `netText`, `ROLE`)
and the **sheet-set helpers** (`indexSheet`: a sheet's texts, title and own sheet number;
`searchSheets` / `searchIndex`; `xrefContext`, `findXrefs`, `resolveRef`, `compilePatterns`,
`XREF_DEFAULT`: references such as "SHEET 2" resolved to a sheet of the set; `isSheetName`, `naturalCmp`).
Tracing works in scene coordinates (add `scene.origin`):

```js
import { parseDrawing, buildScene, buildNetGraph, pickWire, traceNet, endText } from 'linework/core';
const scene = buildScene(parseDrawing(readFileSync('panel.dxf'), 'panel.dxf'));
const G = buildNetGraph(scene), [ox, oy] = scene.origin;
const net = traceNet(G, pickWire(G, 120 - ox, 80 - oy, 0.5));
console.log(net.length, net.labels.map((l) => l.s), net.ends.map(endText)); // length, wire numbers, ends like "J1 · 4 (CONN)"
```

## Tests

```bash
npm test                                  # 278 Node unit tests (node --test, no dependencies)
NODE_PATH=/path/to/node_modules node tests/e2e/run.mjs   # 63 Playwright end-to-end tests
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
* DGN fidelity (`fidelity.test.mjs`, synthetic `dgn-fidelity.dgn` / `dgn-3d-rot.dgn`): editing a
  cell (retype, delete a text, move, rotate, restyle, duplicate) keeps its text node, empty node,
  point string, blank text, B-spline, enter-data field, linkages and graphic group byte for byte
  (only coordinates, symbology, the edited text and word counts change), top-level text nodes,
  arcs in complex chains (clockwise too), fills, a word count that claims the next element,
  32-bit range errors, 16-bit word count limits, 3D quaternions (a text GDAL wrote at +30° reads
  +30°), Z per vertex, two colour tables, 16-bit text read back by GDAL, "not shown" reports
  (tags, reference files, shared cells, B-splines once); all written files read back by GDAL/OGR.
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
* Files, recovery, compare, print (v0.4): recent list rules (one entry per file, 12 at most,
  nothing but names / sizes / dates / handles), journal of unsaved edits (only while unsaved,
  incremental writes, size cap, at most 6 drawings) and a "crash" after a session with undo /
  redo that restores the same drawing and the same saved DGN bytes, a journal that does not fit
  is refused before anything is applied; compare of every fixture with itself, a DGN revision
  written by the round-trip writer (moved / changed / added / removed, untouched elements matched
  by bytes), a byte-identical element moved in the file, DXF revisions and an edited live scene;
  scale parsing, sheet layout, SVG lines at the right millimetres at 1:1 and 1:2, arcs, text,
  weights, hidden layers, monochrome, markups recorded as vector. End to end (the file pickers
  are given real handles from the origin-private file system): Open with a handle, Save over the
  original (asked once, backup in the folder, untouched DGN bytes kept, read back, changed-on-disk
  question), recent drawings after a reload, Clear list, DXF warning and Download a copy, the
  fallback without the API (plain chooser, downloads); crash + reopen → Restore (same drawing,
  undo) / Discard, Save clears the journal; compare overlay pixels, toggles, stepping and zoom,
  edits while comparing, mixed kinds refused, DXF revisions, 390 px; vector print at A3 1:2 and
  Letter 1"=20' black and white checked in the PDF (page size, one page, paths and text, no images).
* Trace (`trace.test.mjs`, an invented wiring sheet described once in `tools/trace_sheet.json` and
  built as DGN (`dgn-trace.dgn`, read like GDAL/OGR) and as DXF (`trace-sheet.dxf`), every case on both):
  a long net over 26 segments (meander and chained lines), a T-junction to a relay coil, a junction-dot T
  and a four-way dot, wires crossing four nets without joining (and joined with *Crossings connect*), a
  hop arc (exact length), a gap within the tolerance and one beyond it (and a wider tolerance), two
  wires on one pin, *Through pins* across a connector, connector and terminal-strip cells with pin texts
  and pin dots, rotated wire labels, off-sheet notes at open ends, hidden levels, picking a dot or a pin
  stub, edits and undo, the sliced build, the DXF schematic sample, and 50,000 items (build < 300 ms,
  a trace < 50 ms). End to end: click to trace (pixel probes of the lit and unlit wires), the panel,
  stepping, zoom, copy, `Esc`, the options, paper, re-tracing after an edit in Edit mode, a drag that
  pans, a tap at 390 px, *Find on other sheets* in a real sheet set (the find bar opens with the label,
  its matches listed by sheet, a listed match opens that sheet; 1440 and 390 px), and the 53k stress
  drawing (no long task while building). The library entry (`core.test.mjs`) traces and searches a set too.
* Editing tools (`tools.test.mjs`, synthetic wiring sheet `dgn-wiring.dgn`, read like GDAL/OGR):
  find (substring, whole word, case, visible levels, text in cells, reading order), replace one / all
  as one change list with every other element byte-identical and the cell rebuilt from its bytes,
  shared block text skipped, no empty texts; key-in parsing and points; mirror (readable text), scale,
  array; scale / rotate keep DGN bytes (in place), a mirror is noted, array copies are moved original
  bytes; GDAL/OGR reads the result; select same and match attributes (DGN and DXF); element info (type
  number, offset, justification, components); level-name files. End to end: find in View and Edit,
  replace / replace all / undo / save / reopen, the find bar at 390 px; key-ins in the draw tools and
  on a selection (move, copy, rotate, AA= text); mirror, mirror about a point, scale, array, select
  same, match attributes, element info; level names (panel, import, filter, Level box, status bar,
  export, kept after a reload, the saved DGN unchanged).
* DWG: every DWG fixture is one of the synthetic DXF files converted to DWG R2000, and must read
  exactly like its DXF (entity counts, layers, blocks, insert transforms, extents, every drawn
  item and text) — through the direct mapping and through LibreDWG's DXF fallback; version
  detection, friendly errors, fuzzed/truncated files, saving a DWG as DXF, the vendored reader's
  hashes and its lack of run-time code generation. End to end: the reader loads only for DWG,
  measuring, editing and saving as DXF, offline re-open, the read time limit, and the real CSP
  (plus a negative control without `'wasm-unsafe-eval'`).
* Sheet sets (`sheets.test.mjs`, synthetic five-sheet set in `tests/fixtures/sheets/`: three DGN,
  two DXF, repeated wire numbers, references between sheets): which files a set takes, the text
  index (drawing coordinates, cell paths), titles from title blocks and attributes, own sheet
  numbers, the worker job, search by sheet in reading order with options and a cap, references
  (numbers, drawing numbers, file names, never itself, ambiguous ones not linked, own patterns),
  the LRU bounds, the index cache store. End to end: a folder from the directory picker (OPFS
  handles; backups and other files left out), titles, Page Up / Page Down with each sheet's view
  and hidden layers kept, Find in all sheets (grouped counts, Enter across sheets with zoom, a
  listed match), reference links (hover, click), the unsaved-edits question, Recent drawings after
  a reload with the index from this browser; the plain chooser with several files, dropped files
  (a sheet that does not read is marked and skipped), the panel and find at 390 px, and a
  120-sheet set (all read, at most three drawings kept, small index, heap growth bounded).
* PDF: pdf.js runs in the Node tests too: every PDF fixture is read with exact coordinates (a 100 mm
  line is 100 mm; circles, arcs, colours, spot colours, dashes, fills, a turned form XObject,
  optional content layers, page labels, an offset media box, a `/Rotate` page, invisible OCR text,
  passwords and damaged files), the operator-list conversion is tested on hand-built operator
  lists, Linework's own vector print reads back at 1:100, and saves as DXF / DGN read back. End to
  end: pdf.js loads only for PDFs and once; no CSP violation in the page **or the parse worker**
  (the test server collects CSP reports, with a negative control without `'wasm-unsafe-eval'`);
  measure, find, colour layers, the page picker, markups per page, the scanned page (picture,
  note, hidden OCR layer, print), Save as DXF, offline re-open. See [PDF.md](PDF.md).
* **All test drawings are synthetic**, generated by `tools/make_fixtures.mjs` (DXF),
  `tools/make_dgn_fixtures.py` (DGN, via GDAL), `tools/make_dwg_fixtures.mjs` (DWG, from the
  synthetic DXF files) and `tools/make_pdf_fixtures.mjs` (PDF: hand-written by
  `tools/pdf-writer.mjs`, plus Linework's own print of the synthetic samples). No real drawings,
  manuals or documents are used or committed.

## Project layout

```
index.html, app.css, sw.js, manifest.webmanifest   app shell (installable PWA)
src/model.js            common drawing model
src/formats/            dxf.js, dgn.js, detect.js (format detection); dwg.js (DWG via LibreDWG,
                        loaded only for DWG); pdf.js (PDF pages via pdf.js, loaded only for PDF);
                        dxf-write.js, dgn-write.js (+ dgn-seed.js) — loaded only when saving
vendor/libredwg/        LibreDWG WebAssembly + glue (GPL-3.0-or-later; provenance in its README)
vendor/pdfjs/           pdf.js legacy build + image decoders (Apache-2.0 etc.; provenance in its README)
deploy/_headers         HTTP headers for the static host (CSP etc.)
src/scene.js            blocks → flat primitives, colours, local origin, spatial grid
src/edit/               edit operations, edit document (changes, undo, selection), live scene,
                        find / replace, key-ins, transforms, attributes + element info, level names
src/view/               viewport, Canvas2D renderer (WebGL-replaceable interface), batches, colours
src/tools/              snaps, measurement, revision compare (compare.js), wire tracing (trace.js),
                        sheet sets: text index, search, references, LRU (sheets.js)
src/markup/             markup model, revision clouds, sidecar format, undo history, drawing
src/app.js, src/app/    UI, input, tools, Edit mode (edit-ui.js), layers panel, PNG export; loaded
                        after start-up or on first use: files.js + store.js (file picker, save
                        over the original, recent drawings, unsaved-edit journal), compare.js
                        (compare overlay + panel), print-svg.js (vector print to scale),
                        tools-ui.js (editing tools: find, key-ins, More menu, info, level names),
                        trace-ui.js (the Trace tool and its panel)
                        sheets.js (sheet sets: navigator, background index, find in all sheets)
                        pdf-ui.js (PDF page picker, app.pages; loaded with the first PDF)
src/worker.js           parse worker
samples/                synthetic sample drawings (+ generators in samples/gen/)
tools/                  fixture generators (DXF, DGN, DWG, PDF; fonts/: DejaVu Sans for the printed
                        PDF fixtures), DWG / PDF reader vendoring scripts,
                        palette extraction, icon rendering, static server, dist builder
tests/unit, tests/e2e   tests
```

## Licence

**GPL-3.0** (see `LICENSE`; credits in `NOTICE`). The DWG reader, GNU LibreDWG
(GPL-3.0-or-later), is distributed with the app (`vendor/libredwg/`), so the app stays GPL-3.0.
The PDF reader, Mozilla pdf.js (`vendor/pdfjs/`), is Apache-2.0 (with core-js, MIT, and the
OpenJPEG / PDFium image decoders, BSD), all compatible with GPL-3.0.

Trade-offs, for the owner to decide before the first public release:

* **GPL-3.0 (current):** anyone may use, host, change and share it for free, including at work;
  people who distribute modified versions must share their source under the same licence. It is
  compatible with LibreDWG. Some companies avoid embedding GPL code in their own closed products.
* **MIT or Apache-2.0:** maximum reuse (including in closed products), simpler for companies to
  adopt — but DWG support via LibreDWG would then have to live in a separate, optional GPL
  component (see [DWG.md](DWG.md)), and others could ship closed forks.

## Roadmap

* **v0.2** — Edit mode and saving as DXF / DGN v7.
* **v0.3** — DWG (R13–2018) via LibreDWG compiled to WebAssembly, lazy-loaded
  ([details](DWG.md)); copy / paste between drawings, duplicate and line weights.
* **v0.4** — editing tools (find / replace text, MicroStation key-ins, mirror,
  scale, array, element information, select same, match attributes, DGN level names); save over
  the original file (backup copy), recent drawings, unsaved-edit recovery, revision compare,
  vector print to scale.
* **v0.5** — wire tracing (View › Trace), sheet sets (navigator, find in all sheets, sheet links),
  PDF pages as drawings via pdf.js, lazy-loaded ([details](PDF.md)): vector import with layers, text,
  pages, scanned pages as pictures, saved as DXF / DGN.
* **0.5.2 (this version)** — tracing and the sheet-set helpers in the `linework/core` library entry;
  Trace › *Find on other sheets* opens *Find in all sheets* with the net's label.
* **Next** — DWG reader rebuilt from pinned sources and R2004+ DWG test fixtures; measurement
  export (CSV); editing the geometry inside blocks/cells and shared block-definition text; true
  linetype scaling; hatch patterns; layouts / paper space tabs; markup resize handles and markup
  list panel.
* **Later** — binary DXF, DGN v8 (if a permissively licensed reader becomes viable), shared
  markup review (still file-based, no server).

Deliberately **not** in v0.4: writing DWG, editing geometry inside blocks (text inside cells
and block attributes can be edited since 0.2.2).

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
* Printing to scale relies on the browser printing at 100 %; text uses the system sans-serif
  font on paper too. Browsers without the File System Access API cannot save over the original
  file or reopen recent files by themselves (they download / open the chooser instead).
* Compare matches top-level items: a cell or block with one changed component shows as changed as
  a whole. Edited items compare by geometry, not bytes.
* DWG: R12 and older are refused; 3D solids, images, MLINE/MULTILEADER and proxy objects are
  reported as not shown; only R2000 files are covered by the synthetic tests so far (see DWG.md).
  Very large DWGs need several times their size in browser memory (limit 120 MB per file).
* PDF: no text recognition (scans are pictures); measurements are in paper units (no scale
  calibration yet); password-protected PDFs need an unprotected copy; clipping is not applied to
  vector items; pictures are drawn at about 200 dpi; CJK text that relies on external character
  maps may not be extracted (see PDF.md).

Editing and saving (v0.2):

* Saved files are validated against GDAL's readers in the tests but have **not been tested in
  AutoCAD or MicroStation** yet. Please keep the original file.
* Blocks (INSERTs) and DGN cells can be moved, rotated, restyled and deleted, but not edited
  inside. Moving a dimension gives it its own copy of its block in the saved DXF.
* Copy / paste: DXF blocks pasted into a DGN are exploded; DGN cells pasted into a DXF stay cells
  in Linework but are saved as separate items (DXF has no cells). A DGN cell pasted into another
  DGN gets a new header with class 0 and no attribute data of its own (its components keep
  theirs); pasted or duplicated in its own file it is a copy of its original bytes. Hatch pattern
  scales are not changed when a paste is scaled between units.
* The DXF writer writes the drawing model, not the original file: non-graphical data (layouts,
  dimension styles, extended data, plot settings, groups) is not carried over (lineweights are:
  see *Line weights* above). TEXT/MTEXT that you did not edit is written exactly as stored; edited MTEXT
  loses its inline formatting (fonts, colours, stacking).
* DGN: layer names do not exist in DGN v7 (DXF layers become numbered levels); DXF fills are
  written as outlines; DGN curves pasted into another file are written as line strings (in their
  own file they are copied byte for byte); new items in 3D files get Z = 0 (or the Z of the
  original vertices when an item is reshaped). Text longer than DGN v7 allows (255 bytes) is
  shortened, with a note. Retyping a text with enter-data fields keeps the field descriptors as
  they were (a space is added at the end when needed to keep them aligned; the note says so).
  3D rotations (text, arcs, ellipses) follow GDAL's dgnlib quaternion convention.
* Splines can be moved, rotated and deleted but not reshaped; zero-size ellipses are left out of
  a saved DXF (they are not valid DXF).

Editing tools (v0.4):

* Find searches the drawn text one line at a time (a match across an MTEXT line break is not found)
  and does not use wildcards or regular expressions; text in a DXF block definition is found but not
  replaced (it is shared by every copy of the block).
* Key-ins take master units (no `master:sub` form) and plan X, Y (a Z is ignored); `AA=` is used by
  new text and by rotating a selection.
* Mirrored DGN items other than text are written from what Linework shows (DGN v7 has no mirrored
  text or arcs); a mirrored cell keeps its components but gets a new cell header.
* Level names live in this browser (per drawing file name): export them to share them or to use them
  on another device.
