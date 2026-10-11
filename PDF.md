# PDF support

Many maintenance manuals, wiring diagrams and drawing sets only exist as PDF. Linework opens a PDF
page as a drawing: the same view, measure, snap, mark up, find, edit and save tools work on it.
PDFs are read with **Mozilla pdf.js** inside the parse worker of this browser tab: the file never
leaves the device, and nothing is fetched from anywhere but the app's own origin. Linework does
**not** write PDF: a PDF page is saved as DXF (default) or DGN v7, and the save dialog says so.

## How it works

| Piece | What |
|---|---|
| `vendor/pdfjs/` | pdf.js 6.3.289 (npm `pdfjs-dist`, **legacy build**: it also runs on older Safari / iPadOS and Chromium), its worker code, and the JPEG 2000 and JBIG2/CCITT image decoders (WebAssembly) that scanned pages use. 2.2 MB raw, **≈0.66 MB gzip**. Installed unchanged by `tools/vendor_pdfjs.mjs` (provenance and SHA-256 in `vendor/pdfjs/README.md`). |
| `src/formats/pdf.js` | Loads pdf.js (once per worker), reads one page, turns it into the drawing model. Imported lazily by `detect.js` (`parseDrawingAsync`); ≈14 KB gzip. |
| `src/app/pdf-ui.js` | The page picker in the status bar, Page Up / Page Down, and `app.pages`. Loaded with the first PDF; ≈2 KB gzip. |
| `sw.js` | DXF/DGN/DWG users never download pdf.js. After the first PDF, `pdf.js` and `pdf-ui.js` are in the app cache and pdf.js (with its decoders) in its own cache (`PDF_READER_CACHE`), which survives app updates; PDFs then open offline. |

**pdf.js runs in-thread in the parse worker** (`globalThis.pdfjsWorker`), so it starts no worker
of its own, and Cancel or the time limit stop it with the parse worker. It is configured for a
worker without a `document`: canvases are `OffscreenCanvas`, no fonts are installed
(`disableFontFace`; text comes from pdf.js's text content), no SVG filters, and the only binary
data it may fetch are its WebAssembly image decoders from `vendor/pdfjs/` (`wasmUrl`). Character
maps, standard font files and the ICC colour module are not vendored (see Limitations).

**One page at a time.** `parsePdf(bytes, { page })` reads page `page` (1-based, clamped). The
page is a drawing of its own: the worker gives it the file's hash plus `-pN` (pages after the
first), so **markups, the unsaved-edits journal and recent work are kept per page**. The file
stays on the main thread as a `Blob` (`app.doc.blob`; for a file from the disk, the `File` itself),
and another page is read from it again.

### Vector pages → drawing items

The page's operator list (pdf.js `getOperatorList`) is walked with the graphics state
(`q`/`Q`, `cm`, form XObjects, transparency groups, annotations' own transforms):

* **Units**: the paper. Pages whose sides are whole or half inches (Letter, Legal, Tabloid, ANSI,
  ARCH) are in **inches**, all others in **millimetres** (1 pt = 1/72 in). The page, as displayed
  (`/Rotate`, crop box), is the drawing's extent: origin at its lower-left corner, its edge drawn
  as a thin frame, Fit shows the whole page. A line drawn 100 mm long measures **100.00 mm**.
* **Paths**: straight subpaths → `line` / `polyline` (closed for `h` and `re`); curves that are
  circular arcs (how PDF writers draw circles and arcs: up to 16 Béziers on one circle, control
  points on the tangents) → `circle` / `arc` with exact centres (centre snaps); other curves →
  `spline` (flattened within 0.01 mm), mixed subpaths are split into straight and curved runs.
  Zero-length subpaths are points.
* **Fills**: one straight loop or a circle → that item with its fill (corner and centre snaps,
  e.g. junction dots); several loops (holes, glyph outlines) → a solid `hatch`; pattern fills →
  a pattern hatch. White fills are the paper and fills that cover the page are its background:
  neither becomes an item.
* **Colours**: pdf.js converts every colour space (grey, CMYK, spot colours with their tint
  functions, ICC) to RGB; black and near black (also CMYK black, e.g. `#231f20`) become the
  foreground colour (white on the dark background, black on paper), others true colour.
* **Line widths** (`w`, scaled by the transform) become lineweights; **dashes** become line types
  (`PDF-DASH-n`, in drawing units).
* **Layers**: optional content (PDF layers, as CAD programs export them) gives each item the
  layer's name, and layers that are off in the PDF's default view start hidden; everything else
  is grouped as `Lines` (black), `Lines (red)`, `Lines (blue)`… by colour name, `Fills`, `Text`,
  `Annotations` (markups made in a PDF viewer, drawn from their appearance) and
  `Text (invisible)`.
* **Text** comes from pdf.js's text content (strings with their position, size and direction,
  unicode, spaces between words restored): one `text` item per run, **fitted to its width**
  (DXF "fit" alignment), cap height 0.7 × the font size, any angle, mirrored text kept. To give a
  run its colour, layer and render mode, the operator list's text-showing operators are followed
  (text matrix, leading, character / word spacing, horizontal scaling, rise, glyph widths, `TJ`
  adjustments — as pdf.js's canvas renderer advances text) and each run is matched to the shown
  text it starts on. **Invisible text** (render mode 3, as scanners' OCR leaves it) goes to the
  hidden layer `Text (invisible)`: show it to search it.

### Pictures and scanned pages (raster fallback)

Images, image masks and gradients cannot become vectors. When they cover more than 0.2 % of the
page (or there is a gradient), pdf.js draws **only them** (its `operationsFilter` skips painted
paths and text, which are drawing items already; clipping paths stay) into an `OffscreenCanvas`
at about 200 dpi (at most 10 Mpixel), which travels to the page as an `ImageBitmap`
(`scene.underlay`) and is drawn **under** the drawing at its true place and scale. Greyscale
pictures (scans) also get an inverted copy, used on the dark background; colour pictures (photos)
are shown as they are. Print and PNG export include the picture.

A page whose pictures cover at least half of it and that has fewer than 40 painted paths is a
**scanned page**: the open note says so — *shown as a picture; measure and markups work; its
lines cannot be snapped to and there is no text recognition in this version* — and points to the
scanner's hidden text layer when there is one. Tiny pictures (logos) are counted in "N items not
shown".

### Pages API (for sheet sets)

`model.page` / `scene.page` = `{ n, count, label, labels (the PDF's page labels, or null),
box (the sheet), rotate, size (points), raster }`. On the page, `app.pages` (from
`src/app/pdf-ui.js`) offers `count`, `current`, `label(n)` and `await goto(n)` (true when page n
is shown; asks first when the page has unsaved edits). Page Up / Page Down and the status-bar
picker use the same `goto`.

## Guard rails

* **Size**: PDFs over 300 MB are refused up front.
* **Time**: one page may take 2 minutes (`PAGE_TIME_LIMIT_MS`); pdf.js yields while it reads, so a
  timer stops it (*"This PDF took too long to read…"*) and the reading task is destroyed. Cancel
  on the progress card stops the parse worker as for any file.
* **Items**: at most 600,000 items per page; the rest are counted as not shown, with a note.
* **Passwords**: a PDF that needs a password to open gets *"This PDF is protected by a
  password…"* (no password prompt yet); PDFs encrypted with only an owner password (permissions)
  open normally.
* **Damaged files**: *"This PDF could not be read (the file may be damaged or incomplete)."*; the
  drawing already open stays.

## Content-Security-Policy

The deployed policy is unchanged (`script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`,
`font-src 'self'`, no `'unsafe-eval'`). pdf.js 6 has no `eval` / `new Function` (it compiles
PostScript functions to **WebAssembly**); the only run-time code site in the files is core-js's
global-object lookup (`…||Function("return this")()`), never reached where `globalThis` exists —
`tools/vendor_pdfjs.mjs` allows exactly that pattern and refuses anything else, and a unit test
checks the vendored files. No fonts are installed and nothing is fetched from elsewhere.

The e2e tests prove it with a server that adds `report-uri` to the policy: reports arrive (the
page's own refused `eval` is reported), **no report** is sent while reading vector, printed and
scanned PDFs, and under a policy **without** `'wasm-unsafe-eval'` the parse worker's refused
WebAssembly (a spot colour's PostScript function) **is** reported while the PDF still opens —
so violations inside the worker would be seen.

## Updating pdf.js

Change `PIN` in `tools/vendor_pdfjs.mjs` (version, tarball URL and the registry's `integrity`),
run `node tools/vendor_pdfjs.mjs` (or pass a tarball downloaded by other means), then bump
`PDF_READER_REV` (`src/formats/pdf.js`) together with `PDF_READER_CACHE` (`sw.js`) and run the
unit and e2e tests. The script checks the tarball's SHA-512 against the pin, the package name,
version and licence, the WebAssembly magic, and the absence of run-time code generation, and
writes `vendor/pdfjs/README.md`.

## Testing (synthetic only)

* **Fixtures** (`tools/make_pdf_fixtures.mjs`, deterministic, written by the test-only writer
  `tools/pdf-writer.mjs` from the public PDF 1.7 reference): `pdf-plan.pdf` (A4 in mm through a
  `cm`: a 100 mm line, circle, arc, red / dashed blue / spot-colour lines, fills, a form turned
  30°, an annotation, text incl. `Ø ± °`), `pdf-schematic.pdf` (Tabloid wiring diagram: 137 texts,
  optional content layers one of which is off, junction dots), `pdf-multipage.pdf` (page labels,
  an offset media box, a `/Rotate 90` page), `pdf-scan.pdf` (a greyscale picture covering the page
  plus invisible OCR text), `pdf-password.pdf`, `pdf-owner.pdf`, `pdf-broken.pdf`. With `--print`
  (Playwright) it also writes `pdf-print-house-plan.pdf` and `pdf-print-schematic.pdf`: Linework's
  own vector print of the synthetic samples, saved as PDF by Chromium (real producer output:
  a subset of the open font DejaVu Sans embedded — `tools/fonts/`, loaded with @font-face so no
  system font is used — page background, colours).
* **Unit** (`tests/unit/pdf.test.mjs`, pdf.js running in Node): vendored files and vendoring,
  detection, units, colours, Bézier arcs, path splitting, operator list → model (transforms,
  forms, widths, dashes, fills, patterns, optional content, annotations, pictures, limits),
  text runs (position, size, angle, fit, colour, layer, invisible), every fixture read through
  pdf.js with exact coordinates, Linework's own print read back at 1:100, scene extents, find and
  snaps, DXF and DGN saves read back, per-page hashes.
* **End to end**: lazy loading (pdf.js only for PDFs, once), the CSP reports above, measure 100.00
  mm and 120.00 mm (the printed house plan), find, colour layers (pixel check), the page picker
  (labels, keys, list, buttons, markups per page, rotated page, `app.pages`, 390 px), the
  scanned page (note, picture inverted / as scanned, measure, markups, hidden OCR layer, print),
  passwords and damaged files, Edit + Save as DXF and reopen, offline after the first PDF.

## Limitations

* No text recognition (OCR): a scan's lines are a picture; only text the PDF already has (also an
  invisible OCR layer) is searchable.
* Character maps (`cmaps/`) are not vendored: CJK text in fonts that rely on an external CMap may
  not be extracted. Standard (non-embedded) fonts are measured from pdf.js's built-in metrics;
  their outlines are not needed because text is drawn by Linework.
* Pictures are drawn at about 200 dpi (at most 10 Mpixel per page); very large sheets get less.
* Measurements are in paper units; a drawing's own scale (e.g. 1:50) is not applied yet (a
  calibrate tool would be next), and PDF measure dictionaries (geospatial / viewport scales) are
  not read.
* Clipping paths are not applied to vector items (content clipped away in the PDF can show), fill
  order is Linework's (fills under lines), and transparency / blend modes are ignored.
* Password-protected PDFs need an unprotected copy (no password prompt yet).
* Saved DXF/DGN copies keep the page's lines, fills and text, not its pictures or fonts.
